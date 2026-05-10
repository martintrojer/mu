// Read-side query tests for src/tasks.ts: ready / blocked / goals
// views, searchTasks (title + notes scopes), listTasksByOwner +
// listTasksByOwnerCrossWorkstream, listTasks --status filter
// (single + array form, with workstream scoping).
//
// Split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — see test/tasks-crud.test.ts
// for the full split rationale.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  addNote,
  addTask,
  claimTask,
  closeTask,
  listBlocked,
  listGoals,
  listReady,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
  searchTasks,
} from "../src/tasks.js";
import { resetTmuxExecutor } from "../src/tmux.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-views-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── View reads ────────────────────────────────────────────────────────

describe("listReady / listBlocked / listGoals", () => {
  beforeEach(() => {
    // Build the MVP acceptance graph (10 tasks with one diamond).
    addTask(db, {
      localId: "specs",
      workstream: "test",
      title: "Specs",
      impact: 90,
      effortDays: 1,
    });
    addTask(db, {
      localId: "api",
      workstream: "test",
      title: "API",
      impact: 80,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "ui",
      workstream: "test",
      title: "UI",
      impact: 70,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "lib",
      workstream: "test",
      title: "Lib",
      impact: 80,
      effortDays: 3,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "backend",
      workstream: "test",
      title: "Backend",
      impact: 80,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "frontend",
      workstream: "test",
      title: "Frontend",
      impact: 70,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "tests",
      workstream: "test",
      title: "Tests",
      impact: 60,
      effortDays: 3,
      blockedBy: ["backend", "frontend"],
    });
    addTask(db, {
      localId: "docs",
      workstream: "test",
      title: "Docs",
      impact: 50,
      effortDays: 2,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "deploy",
      workstream: "test",
      title: "Deploy",
      impact: 70,
      effortDays: 1,
      blockedBy: ["tests"],
    });
    addTask(db, {
      localId: "launch",
      workstream: "test",
      title: "Launch",
      impact: 100,
      effortDays: 1,
      blockedBy: ["deploy", "docs"],
    });
  });

  it("ready: only `specs` is initially actionable", () => {
    expect(listReady(db, "test").map((t) => t.name)).toEqual(["specs"]);
  });

  it("ready promotes after a blocker closes", () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='specs'").run();
    expect(
      listReady(db, "test")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["api", "ui"]);
  });

  it("blocked: every non-specs task is initially blocked", () => {
    const blockedIds = listBlocked(db, "test")
      .map((t) => t.name)
      .sort();
    expect(blockedIds).toEqual([
      "api",
      "backend",
      "deploy",
      "docs",
      "frontend",
      "launch",
      "lib",
      "tests",
      "ui",
    ]);
  });

  it("goals: only launch (no outgoing edges) is a goal", () => {
    expect(listGoals(db, "test").map((t) => t.name)).toEqual(["launch"]);
  });

  it("goals view excludes CLOSED tasks (a finished leaf is no longer a goal)", () => {
    expect(listGoals(db, "test").map((t) => t.name)).toEqual(["launch"]);
    closeTask(db, "launch", { workstream: "test" });
    expect(listGoals(db, "test")).toEqual([]);
  });
});

// ─── listTasksByOwner ─────────────────────────────────────────────────

describe("listTasksByOwner", () => {
  it("listTasksByOwnerCrossWorkstream returns tasks owned across workstreams", async () => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "billing", title: "C", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "worker-2", workstream: "billing", paneId: "%2", status: "busy" });
    await claimTask(db, "a", { agentName: "worker-1", workstream: "auth" });
    // Construct the cross-workstream owner state directly. The verb
    // path (claimTask --for) correctly rejects cross-workstream owner
    // assignment, but listTasksByOwnerCrossWorkstream still has to
    // surface rows whose owner string matches across workstreams
    // (e.g. operator hand-edits via `mu sql` migrating tasks).
    const setOwner = db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = ? LIMIT 1),
              status = 'IN_PROGRESS'
        WHERE local_id = ?`,
    );
    setOwner.run("worker-1", "c");
    setOwner.run("worker-2", "b");

    // Assert on full (localId, workstream) pairs — the cross-ws helper
    // returns every row whose owner.name matches, regardless of
    // workstream. Pins the contract of the cross-workstream alias.
    const ownedByW1 = listTasksByOwnerCrossWorkstream(db, "worker-1")
      .map((t) => ({ name: t.name, workstreamName: t.workstreamName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(ownedByW1).toEqual([
      { name: "a", workstreamName: "auth" },
      { name: "c", workstreamName: "billing" },
    ]);
    const ownedByW2 = listTasksByOwnerCrossWorkstream(db, "worker-2").map((t) => ({
      name: t.name,
      workstreamName: t.workstreamName,
    }));
    expect(ownedByW2).toEqual([{ name: "b", workstreamName: "auth" }]);
  });

  it("returns empty for an agent with no claims (or unknown agent)", () => {
    expect(listTasksByOwner(db, "auth", "ghost")).toEqual([]);
    insertAgent(db, { name: "idle", workstream: "auth", paneId: "%1", status: "free" });
    expect(listTasksByOwner(db, "auth", "idle")).toEqual([]);
  });

  it("excludes CLOSED tasks by default; --include-closed surfaces them", async () => {
    // Real bug found in real use: `mu task owned-by worker-1` was
    // returning closed tasks alongside live ones, defeating the
    // verb's purpose ("what is X currently working on?").
    addTask(db, { localId: "live", workstream: "auth", title: "Live", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done", workstream: "auth", title: "Done", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", status: "busy" });
    await claimTask(db, "live", { agentName: "w1", workstream: "auth" });
    await claimTask(db, "done", { agentName: "w1", workstream: "auth" });
    closeTask(db, "done", { workstream: "auth" }); // closeTask preserves owner intentionally

    const defaultOwned = listTasksByOwner(db, "auth", "w1").map((t) => t.name);
    expect(defaultOwned).toEqual(["live"]);

    const allOwned = listTasksByOwner(db, "auth", "w1", { includeClosed: true })
      .map((t) => t.name)
      .sort();
    expect(allOwned).toEqual(["done", "live"]);
  });
});

// ─── searchTasks ───────────────────────────────────────────────────────────

describe("searchTasks", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design_auth",
      workstream: "auth",
      title: "Design the JWT auth flow",
      impact: 80,
      effortDays: 2,
    });
    addTask(db, {
      localId: "build_auth",
      workstream: "auth",
      title: "Implement",
      impact: 80,
      effortDays: 5,
    });
    addTask(db, {
      localId: "design_billing",
      workstream: "billing",
      title: "Design invoice schema",
      impact: 50,
      effortDays: 1,
    });
    addNote(db, "build_auth", "DECISION: chose JWT; refresh via cookie", { workstream: "auth" });
    addNote(db, "design_billing", "FILES: src/billing/invoice.rs", { workstream: "billing" });
  });

  it("matches title substring (case-insensitive), scoped to a workstream", () => {
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
    expect(searchTasks(db, "DESIGN", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
  });

  it("matches local_id substring", () => {
    expect(
      searchTasks(db, "_auth", { workstream: "auth" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["build_auth", "design_auth"]);
  });

  it("with no workstream, spans every workstream", () => {
    expect(
      searchTasks(db, "design")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["design_auth", "design_billing"]);
  });

  it("--in-notes also matches note content", () => {
    // 'jwt' appears in design_auth's title AND build_auth's note.
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.name,
    );
    expect(ids.sort()).toEqual(["build_auth", "design_auth"]);

    // Without --in-notes, only design_auth matches (notes ignored).
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
  });

  it("DISTINCTs the result when a task has multiple matching notes", () => {
    addNote(db, "build_auth", "DECISION: also JWT for refresh", { workstream: "auth" });
    addNote(db, "build_auth", "VERIFIED: jwt expiry tests pass", { workstream: "auth" });
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.name,
    );
    expect(ids.sort()).toEqual(["build_auth", "design_auth"]); // build_auth appears once despite 3 notes
  });

  it("empty result on no match", () => {
    expect(searchTasks(db, "nothing-matches-this", { workstream: "auth" })).toEqual([]);
  });
});

// ─── listTasks --status filter ─────────────────────────────────

describe("listTasks --status filter", () => {
  beforeEach(() => {
    addTask(db, { localId: "open1", workstream: "auth", title: "x", impact: 50, effortDays: 1 });
    addTask(db, { localId: "open2", workstream: "auth", title: "y", impact: 50, effortDays: 1 });
    addTask(db, { localId: "ip1", workstream: "auth", title: "z", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done1", workstream: "auth", title: "w", impact: 50, effortDays: 1 });
    db.prepare("UPDATE tasks SET status='IN_PROGRESS' WHERE local_id='ip1'").run();
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='done1'").run();
  });

  it("returns all tasks when status omitted (existing behaviour)", () => {
    expect(
      listTasks(db, "auth")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["done1", "ip1", "open1", "open2"]);
  });

  it("filters to a single status (string form)", () => {
    expect(
      listTasks(db, "auth", { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2"]);
    expect(listTasks(db, "auth", { status: "IN_PROGRESS" }).map((t) => t.name)).toEqual(["ip1"]);
    expect(listTasks(db, "auth", { status: "CLOSED" }).map((t) => t.name)).toEqual(["done1"]);
  });

  it("filters to multiple statuses (array form)", () => {
    expect(
      listTasks(db, "auth", { status: ["OPEN", "IN_PROGRESS"] })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["ip1", "open1", "open2"]);
  });

  it("respects workstream + status combined", () => {
    addTask(db, {
      localId: "other_open",
      workstream: "other",
      title: "x",
      impact: 50,
      effortDays: 1,
    });
    expect(
      listTasks(db, "auth", { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2"]);
    // Other workstream's OPEN task isn't included when filtered to 'auth'.
    expect(
      listTasks(db, undefined, { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2", "other_open"]);
  });
});
