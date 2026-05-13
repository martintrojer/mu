// CLI tests for `mu task close --if-ready` (fb_umbrella_no_auto_close).
//
// The dogfood report: built a wave umbrella with 18 blockers; after
// every blocker reached CLOSED/DEFERRED, the umbrella stayed OPEN
// (had to remember to close manually). `--if-ready` is the cheap
// fix: bare `mu task close` is unchanged, `--if-ready` no-ops unless
// every direct blocker is in a terminal status (CLOSED / REJECTED /
// DEFERRED) and lists the still-blocking ids when it skips.
//
// We exercise the wired CLI via runCli (real SQLite + buildProgram)
// so the assertions cover the JSON shape the orchestrator depends on
// + the human card the operator sees.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, closeTask, getTask, setTaskStatus } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task close --if-ready", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-close-if-ready-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("closes a task with zero blockers", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
    });
    seed.close();

    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as {
      changed: boolean;
      status: string;
      skipped?: string;
    };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("closes when every blocker is in a terminal status (CLOSED / REJECTED / DEFERRED)", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    // a CLOSED, b REJECTED, c DEFERRED: every terminal status counts.
    // setTaskStatus is the no-guards path — it skips the
    // open-dependent check that rejectTask / deferTask enforce. We
    // exercise that guard separately; here we just want the umbrella
    // to face three different terminal blocker statuses.
    closeTask(seed, "a", { workstream: "test" });
    setTaskStatus(seed, "b", "REJECTED", { workstream: "test" });
    setTaskStatus(seed, "c", "DEFERRED", { workstream: "test" });
    seed.close();

    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as { changed: boolean; status: string; skipped?: string };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("CLOSED");
    check.close();
  });

  it("no-ops + lists still-blocking ids when any blocker is OPEN/IN_PROGRESS", async () => {
    const seed = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) {
      addTask(seed, {
        localId: id,
        workstream: "test",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
      });
    }
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b", "c"],
    });
    // a CLOSED, b/c still OPEN.
    closeTask(seed, "a", { workstream: "test" });
    seed.close();

    const r = await runCli(
      ["task", "close", "umbrella", "-w", "test", "--if-ready", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as {
      taskName: string;
      changed: boolean;
      skipped?: string;
      previousStatus: string;
      status: string;
      blockingIds?: string[];
      nextSteps: { intent: string; command: string }[];
    };
    expect(payload.changed).toBe(false);
    expect(payload.skipped).toBe("not_ready");
    expect(payload.previousStatus).toBe("OPEN");
    expect(payload.status).toBe("OPEN");
    expect(payload.blockingIds).toEqual(["b", "c"]);
    // Next: hint points at `mu task wait` over the still-blocking set.
    expect(payload.nextSteps.some((s) => s.command.startsWith("mu task wait b c"))).toBe(true);

    const check = openDb({ path: dbPath });
    expect(getTask(check, "umbrella", "test")?.status).toBe("OPEN");
    check.close();
  });

  it("bare `mu task close` (no --if-ready) closes regardless of blockers", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as {
      changed: boolean;
      status: string;
      skipped?: string;
    };
    expect(payload.changed).toBe(true);
    expect(payload.status).toBe("CLOSED");
    expect(payload.skipped).toBeUndefined();
  });

  it("human card prints the skip reason + still-blocking ids", async () => {
    const seed = openDb({ path: dbPath });
    addTask(seed, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    addTask(seed, {
      localId: "umbrella",
      workstream: "test",
      title: "Umbrella",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    seed.close();

    const r = await runCli(["task", "close", "umbrella", "-w", "test", "--if-ready"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
    expect(r.stdout).toContain("umbrella");
    expect(r.stdout).toContain("blocked by 1 task");
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("mu task wait a");
  });
});
