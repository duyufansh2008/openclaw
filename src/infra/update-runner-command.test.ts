import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as updateGlobal from "./update-global.js";
import { buildUpdateCommandRunner, runStep } from "./update-runner-command.js";

describe("weak-network update downloads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("survives repeated disconnects and reports transfer progress before completion", async () => {
    const messages: string[] = [];
    let attempts = 0;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      attempts += 1;
      expect(argv).toContain("--progress");
      if (typeof options === "number") {
        throw new Error("Expected streaming command options");
      }
      const output = options.onOutputChunk!;
      output(
        Buffer.from("remote: private diagnostic token=fixture-secret\nReceiving obj"),
        "stderr",
      );
      output(Buffer.from("ects:  25% (1/4), 64.00 KiB | 8.00 KiB/s\r"), "stderr");
      expect(messages.at(-1)).toBe("Receiving objects: 25% (1/4), 64.00 KiB | 8.00 KiB/s");
      return createCommandResult({
        code: attempts < 3 ? 128 : 0,
        termination: "exit",
        stdout: "",
        stderr:
          attempts < 3 ? "error: RPC failed; curl 56 GnuTLS recv error (-9)\nfatal: early EOF" : "",
      });
    });
    const { runCommand } = await buildUpdateCommandRunner();
    const pending = runStep({
      name: "git-target-inspection-fetch",
      argv: ["git", "-C", "/fixture", "fetch", "origin", "--", "main"],
      cwd: "/fixture",
      runCommand,
      stepIndex: 0,
      totalSteps: 1,
      progress: { onStepProgress: ({ message }) => messages.push(message) },
    });
    await vi.runAllTimersAsync();
    expect((await pending).exitCode).toBe(0);
    expect(attempts).toBe(3);
    expect(messages.join("\n")).toContain("attempt 3/4");
    expect(messages.join("\n")).not.toContain("fixture-secret");
  });

  it.each([
    { label: "recovery after two disconnects", failures: 2, expected: 0, attempts: 3 },
    { label: "bounded attempts", failures: 5, expected: 128, attempts: 4 },
    {
      label: "shared explicit deadline",
      failures: 5,
      timeoutMs: 2_000,
      expected: 128,
      attempts: 2,
    },
  ])("preserves $label without a progress display", async (testCase) => {
    let attempts = 0;
    const execute = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () =>
      createCommandResult({
        code: ++attempts <= testCase.failures ? 128 : 0,
        termination: "exit",
        stdout: "",
        stderr: "error: RPC failed; curl 56 GnuTLS recv error (-9)\nfatal: early EOF",
      }),
    );
    const { runCommand } = await buildUpdateCommandRunner();
    const pending = runCommand(["git", "fetch", "origin"], { timeoutMs: testCase.timeoutMs });
    await vi.runAllTimersAsync();
    expect((await pending).code).toBe(testCase.expected);
    expect(attempts).toBe(testCase.attempts);
    if (testCase.timeoutMs) {
      expect(
        execute.mock.calls.map(([, options]) =>
          typeof options === "number" ? options : options.timeoutMs,
        ),
      ).toEqual([2_000, 1_000]);
    }
  });

  it("keeps downloading when progress rendering fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (_, options) => {
      if (typeof options === "number") {
        throw new Error("Expected streaming command options");
      }
      for (let i = 0; i < 2; i++) {
        expect(
          options.onOutputChunk?.(Buffer.from("Receiving objects: 50% (1/2)\r"), "stderr"),
        ).toBeUndefined();
      }
      return createCommandResult();
    });
    const { runCommand } = await buildUpdateCommandRunner();
    expect(
      (
        await runCommand(["git", "fetch", "origin"], {
          onUpdateProgress: () => {
            throw new Error("terminal closed");
          },
        })
      ).code,
    ).toBe(0);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe("update command failure diagnostics", () => {
  it.each(["stderr", "stdout"] as const)(
    "keeps the sanitized child cause below a package-manager banner in %s",
    async (stream) => {
      const diagnostic = `\u001b[31mError: Candidate build refused; token=fixture-private-token ${"detail ".repeat(50)}\u001b[0m`;
      const result = await runStep({
        name: "preflight-build",
        argv: ["pnpm", "build"],
        cwd: "/fixture",
        timeoutMs: 1000,
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async () => ({
          code: 17,
          stdout: stream === "stdout" ? diagnostic : "",
          stderr:
            stream === "stderr"
              ? `$ node scripts/build-all.mts\n${diagnostic}\n`
              : "$ node scripts/build-all.mts\n",
        }),
      });
      expect(result.exitCode).toBe(17);
      expect(result.failureFacts?.[0]?.message).toContain("Candidate build refused");
      expect(result.failureFacts?.[0]?.message).not.toContain("fixture-private-token");
      expect(result.failureFacts?.[0]?.message).not.toContain("\u001b");
      expect(result.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
    },
  );
  it.each([
    {
      name: "non-banner",
      stderr: "Compiler rejected candidate\nError: secondary context",
      stdout: "Error: later output",
      expected: "Compiler rejected candidate",
    },
    {
      name: "banner without an error header",
      stderr: "$ node scripts/build-all.mts\ncompiler status: failed",
      stdout: "",
      expected: "$ node scripts/build-all.mts",
    },
  ])("preserves the $name diagnostic fallback", async ({ stderr, stdout, expected }) => {
    const result = await runStep({
      name: "preflight-build",
      argv: ["pnpm", "build"],
      cwd: "/fixture",
      timeoutMs: 1000,
      stepIndex: 0,
      totalSteps: 1,
      runCommand: async () => ({ code: 17, stderr, stdout }),
    });
    expect(result.failureFacts?.[0]?.message).toBe(expected);
  });
});
