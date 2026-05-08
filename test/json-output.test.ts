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
    addNote(db, "a", "FILES: src/auth.ts");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("workstream list --json emits a JSON array of summaries", async () => {
    const { stdout } = await runCli(["workstream", "list", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ workstream: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    // listWorkstreams unions DB rows with live mu-* tmux sessions, so a
    // running tmux server may add unrelated entries. Just assert ours is
    // present.
    expect(parsed.some((r) => r.workstream === "auth")).toBe(true);
  });

  it("task list --json emits a JSON array of TaskRows", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ localId: string }>;
    expect(parsed.map((t) => t.localId).sort()).toEqual(["a", "b", "c"]);
  });

  it("task next --json honors -n", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ localId: string }>;
    // Only 'a' is ready (b is blocked by a, c by b). Even with -n 5.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.localId).toBe("a");
  });

  it("task next --json decorates each row with computed roi (impact/effortDays)", async () => {
    // Real bug found in real use (mu task notes #99): JSON output had no
    // roi field at all, so `mu task next --json | jq 'sort_by(.roi)'`
    // returned items in arbitrary order. The table view computed ROI
    // inline; the JSON path didn't. Now both paths agree.
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{
      localId: string;
      impact: number;
      effortDays: number;
      roi?: number;
    }>;
    // Task 'a' has impact=80 effortDays=2 -> roi=40. (Seeded in beforeEach.)
    expect(parsed[0]?.localId).toBe("a");
    expect(parsed[0]?.roi).toBe(40);
  });

  it("task ready --json decorates with roi too", async () => {
    const { stdout } = await runCli(["task", "ready", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{ localId: string; roi?: number }>;
    expect(parsed[0]?.roi).toBe(40);
  });

  it("task list --json decorates with roi too", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as Array<{
      localId: string;
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
    const { stdout } = await runCli(["task", "show", "a", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as { task: { roi?: number } };
    expect(parsed.task.roi).toBe(40);
  });

  it("task ready --json on an empty result emits [] (not '(no ready tasks)')", async () => {
    // Close 'a' so 'b' becomes ready; close 'b' so 'c' becomes ready;
    // close 'c' so nothing is ready.
    const db2 = openDb({ path: dbPath });
    db2.prepare("UPDATE tasks SET status = 'CLOSED'").run();
    db2.close();
    const { stdout } = await runCli(["task", "ready", "-w", "auth", "--json"], dbPath);
    expect(stdout.trim()).toBe("[]");
  });

  it("task show --json emits a composite { task, blockers, dependents, notes }", async () => {
    const { stdout } = await runCli(["task", "show", "a", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      task: { localId: string };
      blockers: string[];
      dependents: string[];
      notes: Array<{ content: string }>;
    };
    expect(parsed.task.localId).toBe("a");
    expect(parsed.blockers).toEqual([]);
    expect(parsed.dependents).toEqual(["b"]);
    expect(parsed.notes.map((n) => n.content)).toEqual(["FILES: src/auth.ts"]);
  });

  it("task tree --json emits a recursive { direction, root: { task, children } } shape", async () => {
    const { stdout } = await runCli(["task", "tree", "c", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      direction: string;
      root: {
        task: { localId: string };
        children: Array<{
          task: { localId: string };
          children: Array<{ task: { localId: string } }>;
        }>;
      };
    };
    expect(parsed.direction).toBe("blockers");
    expect(parsed.root.task.localId).toBe("c");
    // c → b → a
    expect(parsed.root.children).toHaveLength(1);
    expect(parsed.root.children[0]?.task.localId).toBe("b");
    expect(parsed.root.children[0]?.children[0]?.task.localId).toBe("a");
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
    const { stdout } = await runCli(["task", "tree", "f", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      root: {
        children: Array<{
          task: { localId: string };
          children: Array<{ task: { localId: string }; recurrence?: boolean }>;
        }>;
      };
    };
    // f → d, e. d expands to a; e's child a should be marked recurrence.
    const dChild = parsed.root.children.find((c) => c.task.localId === "d");
    const eChild = parsed.root.children.find((c) => c.task.localId === "e");
    expect(dChild?.children[0]?.task.localId).toBe("a");
    expect(dChild?.children[0]?.recurrence).toBeUndefined();
    expect(eChild?.children[0]?.task.localId).toBe("a");
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
      workstream: string;
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
    expect(parsed.workstream).toBe("auth");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(Array.isArray(parsed.tasks.ready)).toBe(true);
    expect(Array.isArray(parsed.workspaces)).toBe(true);
  });

  it("agent list --json emits a { workstream, agents, orphans } shape", async () => {
    // Note: listLiveAgents reconciles against tmux and prunes agents
    // whose panes don't exist. Our seeded pane id %42 is fake, so the
    // reaper removes it. We assert the SHAPE of the JSON, not the
    // agent count — reconciliation behaviour is covered by
    // reconcile.test.ts.
    const { stdout } = await runCli(["agent", "list", "-w", "auth", "--json"], dbPath);
    const parsed = JSON.parse(stdout.trim()) as {
      workstream: string;
      agents: unknown[];
      orphans: unknown[];
    };
    expect(parsed.workstream).toBe("auth");
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

  it("approve verbs accept -w as a scope check; mismatch errors with ApprovalNotInWorkstreamError", async () => {
    // Add an approval scoped to 'auth', then try to grant it via -w infra.
    // Direct DB write to avoid pulling in the full approve namespace SDK
    // here; the helper's behaviour is what we want to assert.
    const db2 = openDb({ path: dbPath });
    db2
      .prepare(
        "INSERT INTO approvals (slug, workstream, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("app_test1234", "auth", "test", "pending", "user", new Date().toISOString());
    db2.close();

    const ok = await runCli(["approve", "deny", "app_test1234", "-w", "auth"], dbPath);
    expect(ok.stderr).not.toMatch(/unknown option/);
    expect(ok.stderr).not.toMatch(/conflict:/);

    // After deny, the approval is decided; re-running via wrong -w hits
    // the scope check BEFORE the already-decided check (assertion runs
    // first in the handler), so we get "conflict: approval ... is in
    // workstream auth, not infra".
    const bad = await runCli(["approve", "grant", "app_test1234", "-w", "infra"], dbPath);
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

  it("whoami --json emits { agent, ownedTasks } for a managed pane", async () => {
    // whoami doesn't reconcile — it just looks the agent up by pane id
    // — so the seeded fake pane id is fine.
    const db2 = openDb({ path: dbPath });
    await claimTask(db2, "a", { agentName: "worker-1" });
    db2.close();
    const originalPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%42";
    try {
      const { stdout } = await runCli(["whoami", "--json"], dbPath);
      const parsed = JSON.parse(stdout.trim()) as {
        agent: { name: string };
        ownedTasks: Array<{ localId: string }>;
      };
      expect(parsed.agent.name).toBe("worker-1");
      expect(parsed.ownedTasks.map((t) => t.localId)).toEqual(["a"]);
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
    const parsed = JSON.parse(stdout.trim()) as Array<{ localId: string }>;
    expect(parsed.map((t) => t.localId)).toEqual(["c"]);
  });

  it("rejects an invalid --status value with exit 2", async () => {
    const { stderr } = await runCli(["task", "list", "-w", "auth", "--status", "RESOLVED"], dbPath);
    expect(stderr).toMatch(/--status must be one of/);
  });
});
