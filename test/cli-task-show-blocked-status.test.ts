// Regression tests for `mu task show` rendering blockers / dependents
// grouped by status. Surfaced as task_show_blocked_by_renders_closed:
// prior behaviour rendered a comma-joined list of blocker ids regardless
// of status, so a reader could not tell from `mu task show` alone which
// blockers still gated the task vs which were already CLOSED (and thus
// satisfied). The fix groups by status:
//
//   blocked by : <still-gating> [<COLOURED-STATUS>] (one of OPEN /
//                IN_PROGRESS / REJECTED / DEFERRED — REJECTED and
//                DEFERRED still gate downstream work per
//                src/tasks/status.ts)
//   satisfied  : <CLOSED entries> [CLOSED] (dimmed; line omitted when
//                empty)
//   blocks     : <still-blocked dependents> [<STATUS>]
//   no longer  : <CLOSED dependents> [CLOSED] (dimmed; symmetric)
//
// JSON shape: blockers/dependents are now {name, status} objects, so
// scripts can filter by status without a second round-trip.
//
// Drives the CLI via buildProgram() + parseAsync() with stdout captured
// (same pattern as test/json-output.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, closeTask, deferTask, rejectTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

// Strip ANSI escape sequences so assertions can match plain text.
// (cli-table3 + picocolors emit \x1b[...m sequences we don't want
// to bake into test fixtures.)
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("mu task show — blockers/dependents grouped by status", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-show-blockers-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsx");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("all-open blockers: renders 'blocked by' with each entry [STATUS], no 'satisfied' line", async () => {
    addTask(db, { localId: "blocker_a", workstream: "wsx", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "blocker_b", workstream: "wsx", title: "B", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["blocker_a", "blocker_b"],
    });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toMatch(/blocked by : blocker_a \[OPEN\], blocker_b \[OPEN\]/);
    // No 'satisfied' line when nothing is CLOSED.
    expect(plain).not.toMatch(/satisfied/);
  });

  it("all-closed blockers: 'blocked by' shows '—', 'satisfied' lists CLOSED entries", async () => {
    addTask(db, { localId: "done_a", workstream: "wsx", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done_b", workstream: "wsx", title: "B", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["done_a", "done_b"],
    });
    closeTask(db, "done_a", { workstream: "wsx" });
    closeTask(db, "done_b", { workstream: "wsx" });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    // 'blocked by' kept for back-compat; renders '—' (em-dash) when
    // every blocker is satisfied.
    expect(plain).toMatch(/blocked by : —/);
    expect(plain).toMatch(/satisfied {2}: done_a \[CLOSED\], done_b \[CLOSED\]/);
  });

  it("mixed blockers: split into 'blocked by' (OPEN/REJECTED/DEFERRED) + 'satisfied' (CLOSED)", async () => {
    // Set the four blockers' statuses BEFORE wiring `target` against
    // them — rejectTask / deferTask refuse to terminal-park a task
    // with open dependents, and we want a clean mixed-status seed.
    addTask(db, { localId: "open_x", workstream: "wsx", title: "X", impact: 50, effortDays: 1 });
    addTask(db, { localId: "rej_y", workstream: "wsx", title: "Y", impact: 50, effortDays: 1 });
    addTask(db, { localId: "def_z", workstream: "wsx", title: "Z", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done_w", workstream: "wsx", title: "W", impact: 50, effortDays: 1 });
    closeTask(db, "done_w", { workstream: "wsx" });
    rejectTask(db, "rej_y", { workstream: "wsx" });
    deferTask(db, "def_z", { workstream: "wsx" });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["open_x", "rej_y", "def_z", "done_w"],
    });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    // REJECTED + DEFERRED still gate downstream work per
    // src/tasks/status.ts; they live in 'blocked by', not 'satisfied'.
    expect(plain).toMatch(/blocked by : def_z \[DEFERRED\], open_x \[OPEN\], rej_y \[REJECTED\]/);
    expect(plain).toMatch(/satisfied {2}: done_w \[CLOSED\]/);
  });

  it("empty edges: 'blocked by : —' and 'blocks : —'; no extra lines", async () => {
    addTask(db, { localId: "lonely", workstream: "wsx", title: "L", impact: 50, effortDays: 1 });

    const { stdout, exitCode } = await runCli(["task", "show", "lonely", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toMatch(/blocked by : —/);
    expect(plain).toMatch(/blocks {5}: —/);
    expect(plain).not.toMatch(/satisfied/);
    expect(plain).not.toMatch(/no longer/);
  });

  it("dependents side gets the same treatment: CLOSED dependents move to 'no longer'", async () => {
    addTask(db, { localId: "root", workstream: "wsx", title: "R", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "open_dep",
      workstream: "wsx",
      title: "OD",
      impact: 50,
      effortDays: 1,
      blockedBy: ["root"],
    });
    addTask(db, {
      localId: "closed_dep",
      workstream: "wsx",
      title: "CD",
      impact: 50,
      effortDays: 1,
      blockedBy: ["root"],
    });
    closeTask(db, "closed_dep", { workstream: "wsx" });

    const { stdout, exitCode } = await runCli(["task", "show", "root", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toMatch(/blocks {5}: open_dep \[OPEN\]/);
    expect(plain).toMatch(/no longer {2}: closed_dep \[CLOSED\]/);
  });

  it("--json: blockers/dependents are arrays of {name, status} objects", async () => {
    addTask(db, { localId: "b_open", workstream: "wsx", title: "O", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b_done", workstream: "wsx", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b_open", "b_done"],
    });
    closeTask(db, "b_done", { workstream: "wsx" });
    addTask(db, {
      localId: "downstream",
      workstream: "wsx",
      title: "DS",
      impact: 50,
      effortDays: 1,
      blockedBy: ["target"],
    });

    const { stdout, exitCode } = await runCli(
      ["task", "show", "target", "-w", "wsx", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as {
      blockers: Array<{ name: string; status: string }>;
      dependents: Array<{ name: string; status: string }>;
    };
    expect(parsed.blockers).toEqual([
      { name: "b_done", status: "CLOSED" },
      { name: "b_open", status: "OPEN" },
    ]);
    expect(parsed.dependents).toEqual([{ name: "downstream", status: "OPEN" }]);
  });
});
