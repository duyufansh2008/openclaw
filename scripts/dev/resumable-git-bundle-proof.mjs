#!/usr/bin/env node
// Local protocol experiment for docs/reference/resumable-git-downloads.md.
// Run: node scripts/dev/resumable-git-bundle-proof.mjs
// This is a synthetic transport proof, not an OpenClaw update entrypoint.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const checkpointBytes = 64 * 1024;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// The parent supplies a trusted digest/size and owns this private fixture path.
// Production needs the update owner's lock, deadlines, URL policy and progress.
async function download({ url, digest, size, directory }) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.protocol, "http:");
  const partial = path.join(directory, `${digest}.part`);
  const complete = path.join(directory, `${digest}.bundle`);
  const file = await fs.open(partial, "a+", 0o600);
  let response;
  try {
    let offset = (await file.stat()).size;
    if (offset > size) {
      await file.truncate(0);
      offset = 0;
    }
    if (offset < size) {
      response = await fetch(url, {
        headers: {
          "Accept-Encoding": "identity",
          ...(offset ? { Range: `bytes=${offset}-` } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const encoding = response.headers.get("content-encoding");
      assert.ok(!encoding || encoding === "identity", "encoded response cannot use byte offsets");
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(
          response.headers.get("content-range") ?? "",
        );
        assert.ok(
          range &&
            Number(range[1]) === offset &&
            Number(range[2]) === size - 1 &&
            Number(range[3]) === size,
          "Content-Range must match the requested offset and pinned size",
        );
      } else {
        assert.equal(response.status, 200, "download requires 200 or matching 206");
        // A server can ignore Range. Discard the prefix before writing its full body.
        await file.truncate(0);
        offset = 0;
      }
      assert.ok(response.body, "missing response body");
      for await (const chunk of response.body) {
        assert.ok(offset + chunk.length <= size, "response exceeds pinned size");
        await file.writeFile(chunk);
        offset += chunk.length;
        process.send?.({ type: "checkpoint", bytes: offset });
      }
      assert.equal(offset, size, "incomplete response");
    }
    if ((await sha256(partial)) !== digest) {
      await file.close();
      await fs.rm(partial);
      throw new Error("SHA-256 mismatch; corrupt partial discarded");
    }
  } finally {
    await response?.body?.cancel().catch(() => {});
    await file.close();
  }
  await fs.rename(partial, complete);
  return complete;
}

function worker(input, onCheckpoint = () => {}) {
  const child = fork(self, ["--worker", JSON.stringify(input)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.on("message", (message) => {
    if (message.type === "checkpoint") {
      onCheckpoint(message, child);
    }
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function proof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundle-proof-"));
  const repository = path.join(directory, "source");
  const received = [];
  const openResponses = new Map();
  let bundle;
  const server = http.createServer((request, response) => {
    const scenario = request.url.slice(1);
    const range = request.headers.range;
    const offset = Number(/^bytes=(\d+)-$/u.exec(range ?? "")?.[1] ?? 0);
    received.push({ scenario, range, offset, encoding: request.headers["accept-encoding"] });
    if (["disconnect", "restart"].includes(scenario) && !range) {
      response.writeHead(200, { "Content-Length": bundle.length });
      response.write(bundle.subarray(0, checkpointBytes));
      openResponses.set(scenario, response);
      return;
    }
    if (scenario === "unsatisfiable-range") {
      response.writeHead(416, { "Content-Range": `bytes */${bundle.length}` });
      response.end();
      return;
    }
    const ignoreRange = scenario === "ignored-range";
    const start = ignoreRange ? 0 : offset;
    const body = Buffer.from(bundle.subarray(start));
    const headers = { "Content-Length": body.length };
    if (range && !ignoreRange) {
      headers["Content-Range"] =
        `bytes ${start + (scenario === "invalid-range" ? 1 : 0)}-${bundle.length - 1}/${bundle.length}`;
    }
    if (scenario === "changed-content") {
      body[0] ^= 0xff;
    }
    if (scenario === "encoded-response") {
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(range && !ignoreRange ? 206 : 200, headers);
    response.end(body);
  });
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      ["-C", cwd, "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LC_ALL: "C",
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      },
    );
  try {
    await fs.mkdir(repository);
    git(repository, "init", "--quiet");
    git(repository, "config", "user.name", "OpenClaw Fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    await fs.writeFile(path.join(repository, "base.txt"), "retained installation\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "fixture baseline");
    git(repository, "tag", "proof-base");
    const payload = Buffer.concat(
      Array.from({ length: 8192 }, (_, index) =>
        createHash("sha256").update(`synthetic payload ${index}`).digest(),
      ),
    );
    await fs.writeFile(path.join(repository, "payload.bin"), payload);
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "fixture target");
    git(repository, "tag", "proof-target");
    const sourceBundle = path.join(directory, "source.bundle");
    git(repository, "bundle", "create", sourceBundle, "proof-target", "^proof-base");
    const baseBundle = path.join(directory, "base.bundle");
    git(repository, "bundle", "create", baseBundle, "proof-base");
    bundle = await fs.readFile(sourceBundle);
    assert.ok(bundle.length > checkpointBytes);
    const digest = await sha256(sourceBundle);
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const results = [];

    for (const scenario of ["disconnect", "restart"]) {
      const cache = path.join(directory, scenario);
      await fs.mkdir(cache);
      const input = { url: `${origin}/${scenario}`, digest, size: bundle.length, directory: cache };
      let interrupted = false;
      const first = await worker(input, (message, child) => {
        if (!interrupted && message.bytes >= checkpointBytes) {
          interrupted = true;
          if (scenario === "restart") {
            child.kill("SIGKILL");
          } else {
            openResponses.get(scenario).destroy();
          }
        }
      });
      assert.ok(interrupted);
      assert.ok(first.code !== 0 || first.signal, "first transfer must be interrupted");
      const retained = (await fs.stat(path.join(cache, `${digest}.part`))).size;
      assert.equal(retained, checkpointBytes);
      const resumed = await worker(input);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(received.findLast((entry) => entry.scenario === scenario).offset, retained);
      assert.deepEqual(await fs.readFile(path.join(cache, `${digest}.bundle`)), bundle);
      results.push({ scenario, retainedBytes: retained, resumedFrom: retained });
    }

    for (const scenario of [
      "ignored-range",
      "invalid-range",
      "unsatisfiable-range",
      "changed-content",
      "encoded-response",
      "already-complete",
    ]) {
      const cache = path.join(directory, scenario);
      await fs.mkdir(cache);
      const partial = path.join(cache, `${digest}.part`);
      const prefix = scenario === "already-complete" ? bundle : bundle.subarray(0, checkpointBytes);
      await fs.writeFile(partial, prefix);
      const completed = ["ignored-range", "already-complete"].includes(scenario);
      const result = await worker({
        url: `${origin}/${scenario}`,
        digest,
        size: bundle.length,
        directory: cache,
      });
      assert.equal(result.code, completed ? 0 : 1, result.stderr);
      if (completed) {
        assert.deepEqual(await fs.readFile(path.join(cache, `${digest}.bundle`)), bundle);
      } else {
        await assert.rejects(fs.access(path.join(cache, `${digest}.bundle`)));
        if (scenario === "changed-content") {
          await assert.rejects(fs.access(partial));
          assert.match(result.stderr, /SHA-256 mismatch/u);
        } else {
          assert.deepEqual(await fs.readFile(partial), prefix);
          assert.match(result.stderr, /Content-Range|download requires|encoded response/u);
        }
      }
      if (scenario === "already-complete") {
        assert.ok(!received.some((entry) => entry.scenario === scenario));
      }
      results.push({ scenario, outcome: completed ? "verified" : "rejected" });
    }

    // The actual Git consumer must accept the reconstructed file, not just its hash.
    const inspection = path.join(directory, "inspection");
    await fs.mkdir(inspection);
    git(inspection, "init", "--quiet", "--bare");
    const downloaded = path.join(directory, "restart", `${digest}.bundle`);
    assert.throws(() => git(inspection, "bundle", "verify", downloaded), /prerequisite/u);
    git(inspection, "fetch", "--quiet", baseBundle, "refs/tags/proof-base:refs/heads/main");
    git(inspection, "bundle", "verify", downloaded);
    git(inspection, "fetch", "--quiet", downloaded, "refs/tags/proof-target:refs/heads/candidate");
    assert.equal(
      git(inspection, "rev-parse", "candidate").toString(),
      git(repository, "rev-parse", "proof-target").toString(),
    );
    assert.deepEqual(git(inspection, "show", "candidate:payload.bin"), payload);
    git(inspection, "fsck", "--strict", "--no-dangling");
    assert.ok(
      received.every((request) =>
        request.encoding.split(",").every((encoding) => encoding.trim() === "identity"),
      ),
    );
    console.log(
      JSON.stringify(
        {
          status: "passed",
          scope: "local protocol experiment; production updater is unchanged",
          bundleBytes: bundle.length,
          results,
          git: {
            missingPrerequisitesRejected: true,
            targetAndPayloadVerified: true,
            fsck: "passed",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  try {
    await download(JSON.parse(process.argv[3]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else {
  await proof();
}
