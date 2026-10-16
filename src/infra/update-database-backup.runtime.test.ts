import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

// mock-isolation: Activation removed the parent's cold backup chunk; the retained child uses real code.
vi.mock("./backup-sqlite-snapshot.js", () => {
  throw new Error("Installed backup module was replaced");
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["sqlite", "postgres"] as const)(
  "keeps first-use %s capture in the retained child after runtime replacement",
  async (engine) => {
    const root = dirs.make("update-backup-runtime-");
    const stateDir = path.join(root, "state");
    const source = path.join(
      stateDir,
      engine === "sqlite" ? "state/openclaw.sqlite" : "plugins/workboard/workboard.sqlite",
    );
    await fs.mkdir(path.dirname(source), { recursive: true });
    {
      using db = new DatabaseSync(source);
      if (engine === "sqlite") {
        db.exec(
          "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('preserved');",
        );
      } else {
        db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
        db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
          "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
          "retained_workboard",
        );
      }
    }
    const before = await fs.readFile(source);
    const capture = createUpdateDatabaseBackup({
      backupRoot: path.join(root, "rollback"),
      stateDir,
      config: {
        plugins: {
          load: { paths: [fileURLToPath(new URL("../../extensions/workboard", import.meta.url))] },
          entries: { workboard: { enabled: false } },
        },
      },
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stopped: engine === "sqlite",
    });
    if (engine === "postgres") {
      // Disabled plugin stores still need custody, before contacting PostgreSQL or taking a snapshot.
      await expect(capture).rejects.toThrow(
        "PostgreSQL update capture requires exclusive ownership",
      );
    } else {
      const backup = await capture;
      expect(backup.databases).toHaveLength(1);
      expect(backup.databases[0]?.path).toBe(source);
      using snapshot = new DatabaseSync(backup.databases[0]!.snapshotPath, { readOnly: true });
      expect(snapshot.prepare("SELECT value FROM payload").get()).toEqual({ value: "preserved" });
    }
    expect(await fs.readFile(source)).toEqual(before);
  },
);
