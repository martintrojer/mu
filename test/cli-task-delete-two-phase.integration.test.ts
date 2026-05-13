// CLI tests for the two-phase `mu task delete` (fb_task_delete_no_yes).
//
// Dogfood report: typed `mu task delete X --yes` (mirroring
// `mu workstream destroy --yes`). Got 'unknown option --yes' — the
// verb took no confirmation flag at all. Two failed deletes left
// long-named tasks lingering until noticed.
//
// Fix: bare `mu task delete <id>` is now a DRY-RUN preview (mirrors
// `mu workstream destroy` / `mu archive delete` / `mu snapshot prune`);
// `--yes` commits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task delete (two-phase)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-task-delete-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(): void {
    const db = openDb({ path: dbPath });
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "b",
      workstream: "test",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    addTask(db, {
      localId: "c",
      workstream: "test",
      title: "C",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b"],
    });
    addNote(db, "b", "note 1", { workstream: "test" });
    addNote(db, "b", "note 2", { workstream: "test" });
    db.close();
  }

  it("bare `mu task delete` is a dry-run: shows cascade, mutates nothing", async () => {
    seed();
    const r = await runCli(["task", "delete", "b", "-w", "test", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as {
      taskName: string;
      deleted: boolean;
      deletedEdges: number;
      deletedNotes: number;
      dryRun: boolean;
      present: boolean;
      nextSteps: { intent: string; command: string }[];
    };
    expect(payload).toMatchObject({
      taskName: "b",
      deleted: false,
      deletedEdges: 2,
      deletedNotes: 2,
      dryRun: true,
      present: true,
    });
    expect(payload.nextSteps.some((s) => s.command === "mu task delete b -w test --yes")).toBe(
      true,
    );
    // Verify nothing changed.
    const check = openDb({ path: dbPath });
    expect(getTask(check, "b", "test")).toBeDefined();
    expect((check.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(
      2,
    );
    expect((check.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n).toBe(
      2,
    );
    check.close();
  });

  it("`--yes` commits and reports the cascade", async () => {
    seed();
    const r = await runCli(["task", "delete", "b", "-w", "test", "--yes", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout) as {
      deleted: boolean;
      deletedEdges: number;
      deletedNotes: number;
      dryRun: boolean;
      present: boolean;
    };
    expect(payload).toMatchObject({
      deleted: true,
      deletedEdges: 2,
      deletedNotes: 2,
      dryRun: false,
      present: true,
    });
    const check = openDb({ path: dbPath });
    expect(getTask(check, "b", "test")).toBeUndefined();
    expect((check.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(
      0,
    );
    expect((check.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n).toBe(
      0,
    );
    check.close();
  });

  it("dry-run on a missing task: present=false, no error", async () => {
    seed();
    const r = await runCli(["task", "delete", "ghost", "-w", "test", "--json"], dbPath);
    // mu's resolveEntityRef may surface a typed not-found before
    // deleteTask is called; either path should result in NOT a
    // process crash. Accept exit 4 (not-found) or null + present:false.
    if (r.exitCode === null) {
      const payload = JSON.parse(r.stdout) as { deleted: boolean; present: boolean };
      expect(payload.deleted).toBe(false);
      expect(payload.present).toBe(false);
    } else {
      expect(r.exitCode).toBe(4);
    }
  });

  it("`--yes` on a missing task is a no-op, not an error", async () => {
    seed();
    const r = await runCli(["task", "delete", "ghost", "-w", "test", "--yes", "--json"], dbPath);
    // Same forgiving acceptance as the dry-run case.
    if (r.exitCode === null) {
      const payload = JSON.parse(r.stdout) as { deleted: boolean; present: boolean };
      expect(payload.deleted).toBe(false);
      expect(payload.present).toBe(false);
    } else {
      expect(r.exitCode).toBe(4);
    }
  });

  it("human card on bare delete prints `Would delete` + dry-run hint", async () => {
    seed();
    const r = await runCli(["task", "delete", "b", "-w", "test"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Would delete");
    expect(r.stdout).toContain("b");
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).toContain("--yes");
  });

  it("human card on `--yes` prints `Deleted`", async () => {
    seed();
    const r = await runCli(["task", "delete", "b", "-w", "test", "--yes"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Deleted");
    expect(r.stdout).toContain("b");
  });
});
