// Verifies --json on every read verb emits parseable JSON of the
// expected shape. Drives the program directly via buildProgram() +
// parseAsync() with stdout captured, instead of shell-subprocessing
// the built CLI, so we exercise the same code path the user sees but
// without the build dependency.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, claimTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("--json output on read verbs", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-json-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%42",
      status: "busy",
    });
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, {
      localId: "b",
      workstream: "auth",
      title: "B",
      impact: 70,
      effortDays: 3,
      blockedBy: ["a"],
    });
    addTask(db, {
      localId: "c",
      workstream: "auth",
      title: "C",
      impact: 95,
      effortDays: 1,
      blockedBy: ["b"],
    });
    addNote(db, "a", "FILES: src/auth.ts", { workstream: "auth" });
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("workstream list --json emits a JSON array of summaries", async () => {
    const { stdout } = await runCli(["workstream", "list", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    // listWorkstreams unions DB rows with live mu-* tmux sessions, so a
    // running tmux server may add unrelated entries. Just assert ours is
    // present.
    expect(parsed.some((r) => r.name === "auth")).toBe(true);
  });

  it("task list --json emits a JSON array of TaskRows", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("task next --json honors -n", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    // Only 'a' is ready (b is blocked by a, c by b). Even with -n 5.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("a");
  });

  it("task next --json decorates each row with computed roi (impact/effortDays)", async () => {
    // Real bug found in real use (mu task notes #99): JSON output had no
    // roi field at all, so `mu task next --json | jq 'sort_by(.roi)'`
    // returned items in arbitrary order. The table view computed ROI
    // inline; the JSON path didn't. Now both paths agree.
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{
      name: string;
      impact: number;
      effortDays: number;
      roi?: number;
    }>;
    // Task 'a' has impact=80 effortDays=2 -> roi=40. (Seeded in beforeEach.)
    expect(parsed[0]?.name).toBe("a");
    expect(parsed[0]?.roi).toBe(40);
  });

  it("task next -n 0 --json (the merged-in `task ready` shape) decorates with roi too", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "0", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string; roi?: number }>;
    expect(parsed[0]?.roi).toBe(40);
  });

  it("task list --json decorates with roi too", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{
      name: string;
      impact: number;
      effortDays: number;
      roi?: number;
    }>;
    for (const t of parsed) {
      // roi field present iff effortDays > 0; in this seed every task has
      // a positive effort so roi must equal impact/effortDays.
      expect(t.roi).toBe(t.impact / t.effortDays);
    }
  });

  it("task show --json decorates the inner task with roi", async () => {
    const { stdout } = await runCli(["task", "show", "a", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as { task: { roi?: number } };
    expect(parsed.task.roi).toBe(40);
  });

  it("task next -n 0 --json on an empty result emits [] (not '(no ready tasks)')", async () => {
    // Close 'a' so 'b' becomes ready; close 'b' so 'c' becomes ready;
    // close 'c' so nothing is ready.
    const db2 = openDb({ path: dbPath });
    db2.prepare("UPDATE tasks SET status = 'CLOSED'").run();
    db2.close();
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "0", "--json"], dbPath);
    expect(stdout.trim()).toBe("[]");
  });

  it("task show --json emits a composite { task, blockers, dependents, notes }", async () => {
    const { stdout } = await runCli(["task", "show", "a", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      task: { name: string };
      blockers: string[];
      dependents: string[];
      notes: Array<{ content: string }>;
    };
    expect(parsed.task.name).toBe("a");
    expect(parsed.blockers).toEqual([]);
    expect(parsed.dependents).toEqual(["b"]);
    expect(parsed.notes.map((n) => n.content)).toEqual(["FILES: src/auth.ts"]);
  });

  it("task tree --json emits a recursive { direction, root: { task, children } } shape", async () => {
    const { stdout } = await runCli(["task", "tree", "c", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      direction: string;
      root: {
        task: { name: string };
        children: Array<{
          task: { name: string };
          children: Array<{ task: { name: string } }>;
        }>;
      };
    };
    expect(parsed.direction).toBe("blockers");
    expect(parsed.root.task.name).toBe("c");
    // c → b → a
    expect(parsed.root.children).toHaveLength(1);
    expect(parsed.root.children[0]?.task.name).toBe("b");
    expect(parsed.root.children[0]?.children[0]?.task.name).toBe("a");
  });

  it("task tree --json marks diamond recurrences without expanding", async () => {
    // Build a diamond: a blocks both d and e, both block f.
    const db2 = openDb({ path: dbPath });
    db2.close();
    const db3 = openDb({ path: dbPath });
    addTask(db3, {
      localId: "d",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    addTask(db3, {
      localId: "e",
      workstream: "auth",
      title: "E",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    addTask(db3, {
      localId: "f",
      workstream: "auth",
      title: "F",
      impact: 50,
      effortDays: 1,
      blockedBy: ["d", "e"],
    });
    db3.close();
    const { stdout } = await runCli(["task", "tree", "f", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      root: {
        children: Array<{
          task: { name: string };
          children: Array<{ task: { name: string }; recurrence?: boolean }>;
        }>;
      };
    };
    // f → d, e. d expands to a; e's child a should be marked recurrence.
    const dChild = parsed.root.children.find((c) => c.task.name === "d");
    const eChild = parsed.root.children.find((c) => c.task.name === "e");
    expect(dChild?.children[0]?.task.name).toBe("a");
    expect(dChild?.children[0]?.recurrence).toBeUndefined();
    expect(eChild?.children[0]?.task.name).toBe("a");
    expect(eChild?.children[0]?.recurrence).toBe(true);
  });

  it("state --json emits agents as a top-level array (not { active, orphans })", async () => {
    // Real footgun discovered in real use: state used to wrap agents in
    // `{ active, orphans }` so `.agents | length` returned 2 (the
    // number of object keys) regardless of agent count. The fix
    // matches mission-control's flat shape: agents is the array,
    // orphans is its own top-level key.
    const { stdout } = await runCli(["state", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      workstreamName: string;
      agents: unknown[];
      orphans: unknown[];
      tasks: {
        ready: unknown[];
        in_progress: unknown[];
        blocked: unknown[];
        recent_closed: unknown[];
      };
      workspaces: unknown[];
      recent_events: unknown[];
    };
    expect(parsed.workstreamName).toBe("auth");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(Array.isArray(parsed.tasks.ready)).toBe(true);
    expect(Array.isArray(parsed.workspaces)).toBe(true);
  });

  it("agent list --json emits a { workstreamName, agents, orphans } shape", async () => {
    // Note: listLiveAgents reconciles against tmux and prunes agents
    // whose panes don't exist. Our seeded pane id %42 is fake, so the
    // reaper removes it. We assert the SHAPE of the JSON, not the
    // agent count — reconciliation behaviour is covered by
    // reconcile.test.ts.
    const { stdout } = await runCli(["agent", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      workstreamName: string;
      agents: unknown[];
      orphans: unknown[];
    };
    expect(parsed.workstreamName).toBe("auth");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
  });

  it("agent verbs accept -w as a scope check; mismatch errors with AgentNotInWorkstreamError", async () => {
    // Same pattern as task verbs: agent names are globally unique
    // (PK on agents.name) so -w is purely a scope check that catches
    // typos before they silently act on the wrong agent.
    //
    // worker-1 was seeded in workstream 'auth' by beforeEach.
    const ok = await runCli(["agent", "show", "worker-1", "-w", "auth"], dbPath);
    // Reconcile may have pruned the fake pane; what matters is no
    // "unknown option" / no "conflict" prefix.
    expect(ok.stderr).not.toMatch(/unknown option/);
    expect(ok.stderr).not.toMatch(/conflict:/);

    const bad = await runCli(["agent", "show", "worker-1", "-w", "infra"], dbPath);
    expect(bad.stderr).toMatch(/conflict:/);
    expect(bad.stderr).toMatch(/auth/);
    expect(bad.stderr).toMatch(/infra/);
  });

  it("task verbs accept -w as a scope check; mismatch errors with TaskNotInWorkstreamError", async () => {
    // Real bug found in real use: `mu task note <id> -w <name> ...`
    // was rejected with "unknown option '-w'". The fix adds
    // WORKSTREAM_OPT to all task ID-targeted verbs and validates
    // that the named task is in the named workstream. Same task ID
    // in two workstreams could mask the wrong-workstream typo today
    // (IDs are globally unique), but the assertion catches it.
    //
    // Test plan: seed a second workstream + task; assert the same
    // verb works with the correct -w and errors with the wrong -w.
    const db2 = openDb({ path: dbPath });
    ensureWorkstream(db2, "infra");
    addTask(db2, {
      localId: "infra_task",
      workstream: "infra",
      title: "Infra task",
      impact: 50,
      effortDays: 1,
    });
    db2.close();

    // Correct workstream: succeeds.
    const ok = await runCli(["task", "note", "infra_task", "a note", "-w", "infra"], dbPath);
    expect(ok.stderr).toBe("");

    // Wrong workstream: typed conflict error.
    const bad = await runCli(["task", "note", "infra_task", "oops", "-w", "auth"], dbPath);
    expect(bad.stderr).toMatch(/conflict:/);
    expect(bad.stderr).toMatch(/infra/);
    expect(bad.stderr).toMatch(/auth/);

    // Same check on close: correct ok, wrong errors.
    const closeOk = await runCli(["task", "close", "infra_task", "-w", "infra"], dbPath);
    expect(closeOk.stderr).toBe("");
    const closeBad = await runCli(["task", "open", "infra_task", "-w", "auth"], dbPath);
    expect(closeBad.stderr).toMatch(/conflict:/);
  });

  it("`mu me --json` emits { agent, ownedTasks } for a managed pane", async () => {
    // `mu me` doesn't reconcile — it just looks the agent up by pane id
    // — so the seeded fake pane id is fine.
    const db2 = openDb({ path: dbPath });
    await claimTask(db2, "a", { agentName: "worker-1", workstream: "auth" });
    db2.close();
    const originalPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%42";
    try {
      const { stdout } = await runCli(["me", "--json"], dbPath);
      const parsed = JSON.parse(stdout.trim()) as {
        agent: { name: string };
        ownedTasks: Array<{ name: string }>;
      };
      expect(parsed.agent.name).toBe("worker-1");
      expect(parsed.ownedTasks.map((t) => t.name)).toEqual(["a"]);
    } finally {
      if (originalPane === undefined) {
        const key = "TMUX_PANE";
        delete process.env[key];
      } else {
        process.env.TMUX_PANE = originalPane;
      }
    }
  });
});

// ─── Table-rendering ergonomics (non-JSON output path) ──────────

describe("table rendering", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-tbl-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function withTerminalWidth<T>(cols: number, fn: () => Promise<T> | T): Promise<T> | T {
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
    }
  }

  it("truncates the title column to fit the terminal but never the id column", async () => {
    // Make 'a' have a very long title so we can observe truncation.
    const db2 = openDb({ path: dbPath });
    db2
      .prepare("UPDATE tasks SET title = ? WHERE local_id = 'a'")
      .run(
        "Some absurdly long title that will definitely exceed the title-column budget for an 80-column terminal and would otherwise blow the whole table out to two-hundred-plus characters wide",
      );
    db2.close();

    const { stdout } = await withTerminalWidth(80, () =>
      runCli(["task", "list", "-w", "auth"], dbPath),
    );

    // Per-line guard: every rendered line ≤ a generous bound around the
    // 80-col target. cli-table3 plus borders pushes a bit, hence the
    // looseness; the point is the previous behaviour produced 200+
    // columns which this assertion catches.
    const lines = stdout.split("\n");
    for (const line of lines) {
      // strip ANSI for length measurement
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
      const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
      expect(visible.length).toBeLessThanOrEqual(120);
    }
    // The full id 'a' must appear verbatim in the output (never
    // truncated), because users copy IDs to issue follow-up commands.
    // Match it framed by the table cell (whitespace either side) so we
    // don't accidentally hit a substring of 'auth' or similar.
    expect(stdout).toMatch(/[\s│] a [\s│]/);
    // The title must show evidence of truncation (ellipsis).
    expect(stdout).toMatch(/Some absurdly long title.*…/);
  });

  it("renders all task ids in full even when titles are tiny (id column is the contract)", async () => {
    const { stdout } = await withTerminalWidth(80, () =>
      runCli(["task", "list", "-w", "auth"], dbPath),
    );
    expect(stdout).toContain("a");
    expect(stdout).toContain("b");
    expect(stdout).toContain("c");
  });
});

// ─── mu task list --status filter (CLI integration) ─────────────

describe("task list --status", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-status-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("filters to OPEN tasks (case-insensitive, lowercase form works)", async () => {
    // Mark 'a' as CLOSED and 'b' as IN_PROGRESS so all three statuses
    // are represented.
    const db2 = openDb({ path: dbPath });
    db2.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='a'").run();
    db2.prepare("UPDATE tasks SET status='IN_PROGRESS' WHERE local_id='b'").run();
    db2.close();

    const { stdout } = await runCli(
      ["task", "list", "-w", "auth", "--status", "open", "--json"],
      dbPath,
    );
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name)).toEqual(["c"]);
  });

  it("rejects an invalid --status value with exit 2", async () => {
    const { stderr } = await runCli(["task", "list", "-w", "auth", "--status", "RESOLVED"], dbPath);
    expect(stderr).toMatch(/--status must be one of/);
  });
});

// ─── mu task list / next / ready --sort (CLI integration) ───────

describe("task list/next/ready --sort", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sort-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // Seed three tasks with distinct impact/effort so ROI ordering
    // is unambiguous: a (5), b (90), c (20). All ready (no edges).
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 10, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 90, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 40, effortDays: 2 });
    // Pin updated_at so 'recency' sort is deterministic. addTask
    // stamps NOW for both columns; we rewrite updated_at to a strict
    // chronological sequence (a oldest, c newest).
    db.prepare("UPDATE tasks SET updated_at='2026-05-01T00:00:00.000Z' WHERE local_id='a'").run();
    db.prepare("UPDATE tasks SET updated_at='2026-05-02T00:00:00.000Z' WHERE local_id='b'").run();
    db.prepare("UPDATE tasks SET updated_at='2026-05-03T00:00:00.000Z' WHERE local_id='c'").run();
    db.prepare("UPDATE tasks SET created_at='2026-01-01T00:00:00.000Z' WHERE local_id='a'").run();
    db.prepare("UPDATE tasks SET created_at='2026-02-01T00:00:00.000Z' WHERE local_id='b'").run();
    db.prepare("UPDATE tasks SET created_at='2026-03-01T00:00:00.000Z' WHERE local_id='c'").run();
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--sort recency orders by updated_at DESC (most recent first)", async () => {
    const { stdout } = await runCli(
      ["task", "list", "-w", "auth", "--sort", "recency", "--json"],
      dbPath,
    );
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name)).toEqual(["c", "b", "a"]);
  });

  it("--sort age orders by created_at ASC (oldest first)", async () => {
    const { stdout } = await runCli(
      ["task", "list", "-w", "auth", "--sort", "age", "--json"],
      dbPath,
    );
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("--sort roi (default for `next`) — highest ROI first", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    // b (90) > c (20) > a (5).
    expect(parsed.map((t) => t.name)).toEqual(["b", "c", "a"]);
  });

  it("`mu task next -n 0 --sort recency` re-sorts (overrides ROI default)", async () => {
    const { stdout } = await runCli(
      ["task", "next", "-w", "auth", "-n", "0", "--sort", "recency", "--json"],
      dbPath,
    );
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    expect(parsed.map((t) => t.name)).toEqual(["c", "b", "a"]);
  });

  it("renders an extra `updated` column under --sort recency (table mode)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--sort", "recency"], dbPath);
    // Header gains the column; the timestamp basis tag matches the sort.
    expect(stdout).toContain("updated");
    expect(stdout).not.toMatch(/\bcreated\b/);
  });

  it("renders an extra `created` column under --sort age (table mode)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--sort", "age"], dbPath);
    expect(stdout).toContain("created");
  });

  it("does NOT render the time column under default sort (id) or roi", async () => {
    const { stdout: stdoutDefault } = await runCli(["task", "list", "-w", "auth"], dbPath);
    expect(stdoutDefault).not.toContain("updated");
    expect(stdoutDefault).not.toContain("created");
    const { stdout: stdoutRoi } = await runCli(
      ["task", "next", "-w", "auth", "-n", "0", "--sort", "roi"],
      dbPath,
    );
    expect(stdoutRoi).not.toContain("updated");
    expect(stdoutRoi).not.toContain("created");
  });

  it("rejects an unknown --sort key with exit 2 and a helpful message", async () => {
    const { stderr } = await runCli(["task", "list", "-w", "auth", "--sort", "priority"], dbPath);
    expect(stderr).toMatch(/--sort must be one of/);
  });

  it("JSON shape is unchanged (no extra fields when --sort is active)", async () => {
    const { stdout } = await runCli(
      ["task", "list", "-w", "auth", "--sort", "recency", "--json"],
      dbPath,
    );
    const parsed = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;
    // Same fields as without --sort: rows already include createdAt /
    // updatedAt; nothing computed gets added (consumers can sort).
    for (const row of parsed) {
      expect(row).toHaveProperty("createdAt");
      expect(row).toHaveProperty("updatedAt");
      expect(row).not.toHaveProperty("relTime");
      expect(row).not.toHaveProperty("ago");
    }
  });
});
