// Tests for the derived 'idle but assigned' agent flag
// (idle_assigned_agent_detection). Pure SDK + render unit tests; the
// listLiveAgents path is exercised separately by test/verbs.test.ts and
// the integration suites.
//
// Predicate (src/agents.ts computeAgentIdle):
//   status === 'needs_input'
//   AND owns >= 1 IN_PROGRESS task in the same workstream
//   AND (now - updated_at) >= MU_IDLE_THRESHOLD_MS (default 300_000)
//
// Render: formatAgentsTable prepends a yellow ⚠ glyph and yellows the
// agent's name when AgentRow.idle === true. JSON: AgentRow round-trips
// the boolean so `mu state --json` consumers see `idle: true`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentRow,
  computeAgentIdle,
  getAgent,
  idleThresholdMs,
  insertAgent,
  listLiveAgents,
} from "../src/agents.js";
import { IDLE_GLYPH, formatAgentsTable } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { setTaskStatus } from "../src/tasks/lifecycle.js";
import {
  type TmuxExecResult,
  type TmuxExecutor,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";

const originalNoColor = process.env.NO_COLOR;

// Force colorless output so literal-substring assertions vs ANSI escapes
// are stable. Mirrors test/state-render.integration.test.ts.
process.env.NO_COLOR = "1";

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-agent-idle-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  const key = "MU_IDLE_THRESHOLD_MS";
  delete process.env[key];
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_IDLE_THRESHOLD_MS";
  delete process.env[key];
  resetTmuxExecutor();
});

/** Insert an agent and immediately back-date its updated_at by `ageMs`
 *  ms, so the predicate has something to chew on without us having to
 *  inject a clock seam. updated_at is the only DB column the predicate
 *  reads; back-dating is the cheapest path to deterministic test data. */
function insertAgedAgent(
  db: Db,
  name: string,
  workstream: string,
  status: AgentRow["status"],
  ageMs: number,
): AgentRow {
  insertAgent(db, { name, workstream, paneId: `%${name}`, status });
  const past = new Date(Date.now() - ageMs).toISOString();
  db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(past, name);
  const row = getAgent(db, name, workstream);
  if (!row) throw new Error("insertAgedAgent: row missing after insert");
  return row;
}

/** Minimal tmux mock that pretends every registered agent's pane is
 *  alive with empty scrollback. Just enough for `reconcile` (and thus
 *  `listLiveAgents`) to run without touching the real tmux server.
 *
 *  Only three verbs are exercised on the listLiveAgents → reconcile
 *  path under our test setup (no ghosts, no orphans, empty
 *  scrollback): `list-panes -s` (pane survival), `capture-pane`
 *  (status detector input), and `select-pane -T` (refreshAgentTitle).
 *  Anything else is a test-bug and should fail loudly. */
function installFakePiPanes(
  db: Db,
  workstream: string,
  panes: Array<{ paneId: string; title?: string; scrollback?: string }>,
): void {
  const sessionName = `mu-${workstream}`;
  const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const fail = (stderr: string): TmuxExecResult => ({
    stdout: "",
    stderr,
    exitCode: 1,
  });
  const byPane = new Map(panes.map((p, i) => [p.paneId, { ...p, windowId: `@${i + 1}` }]));

  const executor: TmuxExecutor = async (args) => {
    const verb = args[0];

    if (verb === "list-panes" && args[1] === "-s") {
      const tFlag = args.indexOf("-t");
      const target = tFlag >= 0 ? args[tFlag + 1] : "";
      if (target !== sessionName) return ok(""); // unknown session → no panes
      const lines: string[] = [];
      for (const p of byPane.values()) {
        lines.push(`${p.windowId}\t${p.paneId}\t${p.title ?? ""}\tpi`);
      }
      return ok(lines.join("\n"));
    }

    if (verb === "capture-pane") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const p = byPane.get(paneId ?? "");
      if (!p) return fail(`can't find pane: ${paneId}`);
      return ok(p.scrollback ?? "");
    }

    if (verb === "select-pane") return ok();
    if (verb === "display-message") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const p = byPane.get(paneId ?? "");
      return p ? ok(`${paneId}\n`) : fail(`can't find pane: ${paneId}`);
    }

    throw new Error(`installFakePiPanes: unmocked tmux call: ${args.join(" ")}`);
  };
  setTmuxExecutor(executor);
  // Quiet unused-param warning when caller only wants the executor side-effect.
  void db;
}

/** End-to-end fixture: register an agent in `workstream` whose pane
 *  is alive in our fake tmux, optionally owning a single IN_PROGRESS
 *  task, with `updated_at` back-dated by `ageMs`. Returns the
 *  registered paneId for assertions. */
function setupAgentOwningTask(
  db: Db,
  opts: {
    name: string;
    workstream: string;
    status: AgentRow["status"];
    ageMs: number;
    ownsTask: boolean;
  },
): void {
  const paneId = `%${100 + opts.name.length}`;
  insertAgent(db, {
    name: opts.name,
    workstream: opts.workstream,
    paneId,
    status: opts.status,
  });
  if (opts.ownsTask) {
    addTask(db, {
      localId: "t1",
      workstream: opts.workstream,
      title: "T1",
      impact: 1,
      effortDays: 1,
    });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: opts.workstream });
    db.prepare(
      `UPDATE tasks SET owner_id =
         (SELECT id FROM agents WHERE name = ? AND workstream_id =
            (SELECT id FROM workstreams WHERE name = ?))
        WHERE local_id = ?`,
    ).run(opts.name, opts.workstream, "t1");
  }
  // Back-date AFTER all task-status writes so the agent row's
  // updated_at reflects our intended age. (setTaskStatus / addTask
  // touch tasks.updated_at, not agents.updated_at, so this is safe
  // — but we still want this last so insertAgent's now-stamp is
  // overwritten.)
  const past = new Date(Date.now() - opts.ageMs).toISOString();
  db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(past, opts.name);
  installFakePiPanes(db, opts.workstream, [{ paneId, title: opts.name }]);
}

describe("computeAgentIdle — predicate", () => {
  it("alive + needs_input + owns IN_PROGRESS + updated_at older than threshold → idle=true", () => {
    const a = insertAgedAgent(db, "alice", "ws", "needs_input", 600_000);
    addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'alice') WHERE local_id = 't1'",
    ).run();
    expect(computeAgentIdle(db, a)).toBe(true);
  });

  it("alive + needs_input + owns IN_PROGRESS + updated_at recent → idle=false", () => {
    const a = insertAgedAgent(db, "alice", "ws", "needs_input", 1_000); // 1s old
    addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'alice') WHERE local_id = 't1'",
    ).run();
    expect(computeAgentIdle(db, a)).toBe(false);
  });

  it("alive + needs_input + does NOT own a task → idle=false (idle requires assignment)", () => {
    const a = insertAgedAgent(db, "alice", "ws", "needs_input", 600_000);
    expect(computeAgentIdle(db, a)).toBe(false);
  });

  it("alive + busy + owns task → idle=false (busy is the right state)", () => {
    const a = insertAgedAgent(db, "alice", "ws", "busy", 600_000);
    addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'alice') WHERE local_id = 't1'",
    ).run();
    expect(computeAgentIdle(db, a)).toBe(false);
  });

  it("MU_IDLE_THRESHOLD_MS env var honored (lower threshold flips a fresher row to idle)", () => {
    const a = insertAgedAgent(db, "alice", "ws", "needs_input", 5_000); // 5s old
    addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'alice') WHERE local_id = 't1'",
    ).run();
    // Default 300_000ms threshold → not idle.
    expect(computeAgentIdle(db, a)).toBe(false);
    // Lower threshold via env var → idle.
    process.env.MU_IDLE_THRESHOLD_MS = "1000";
    expect(idleThresholdMs()).toBe(1000);
    expect(computeAgentIdle(db, a)).toBe(true);
  });

  it("MU_IDLE_THRESHOLD_MS=0 disables the check (predicate never fires)", () => {
    const a = insertAgedAgent(db, "alice", "ws", "needs_input", 600_000);
    addTask(db, { localId: "t1", workstream: "ws", title: "T1", impact: 1, effortDays: 1 });
    setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "ws" });
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'alice') WHERE local_id = 't1'",
    ).run();
    process.env.MU_IDLE_THRESHOLD_MS = "0";
    expect(computeAgentIdle(db, a)).toBe(false);
  });
});

describe("listLiveAgents — idle enrichment wiring", () => {
  // These tests guard the wiring, not the predicate. A regression where
  // listLiveAgents simply forgets to call computeAgentIdle (or only
  // calls it under one mode) would silently pass every predicate-only
  // test above. So we drive listLiveAgents end-to-end with a fake
  // tmux executor and assert on the returned `idle` field.

  it("enriches idle:true on a stale-needs_input + IN_PROGRESS-owning agent", async () => {
    setupAgentOwningTask(db, {
      name: "alice",
      workstream: "ws",
      status: "needs_input",
      ageMs: 600_000,
      ownsTask: true,
    });
    const view = await listLiveAgents(db, { workstream: "ws" });
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.name).toBe("alice");
    expect(view.agents[0]?.idle).toBe(true);
  });

  it("leaves idle absent on a fresh-needs_input + IN_PROGRESS-owning agent", async () => {
    setupAgentOwningTask(db, {
      name: "alice",
      workstream: "ws",
      status: "needs_input",
      ageMs: 1_000,
      ownsTask: true,
    });
    const view = await listLiveAgents(db, { workstream: "ws" });
    expect(view.agents).toHaveLength(1);
    // Predicate didn't fire → the field must be absent (not `false`),
    // so JSON consumers don't see `idle: false` noise. This is the
    // `mu state --json` contract documented on AgentRow.
    expect(view.agents[0]?.idle).toBeUndefined();
    expect(JSON.stringify(view.agents[0])).not.toContain('"idle"');
  });

  it("leaves idle absent when a stale-needs_input agent owns NO task", async () => {
    setupAgentOwningTask(db, {
      name: "alice",
      workstream: "ws",
      status: "needs_input",
      ageMs: 600_000,
      ownsTask: false,
    });
    const view = await listLiveAgents(db, { workstream: "ws" });
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.idle).toBeUndefined();
  });

  // Mode propagation: status-pollers (`mu state`, `mu agent attach`) use
  // full mode; read-only diagnostic verbs (`mu doctor`, `mu undo`) use
  // report-only. The idle enrichment runs after `reconcile` returns and is
  // therefore mode-independent — these tests pin that contract so a future
  // refactor that gates enrichment on `mode === 'full'` (or skips it on
  // report-only because "no mutation") gets caught here.
  for (const mode of ["full", "report-only"] as const) {
    it(`enriches idle on mode:'${mode}'`, async () => {
      setupAgentOwningTask(db, {
        name: "alice",
        workstream: "ws",
        status: "needs_input",
        ageMs: 600_000,
        ownsTask: true,
      });
      const view = await listLiveAgents(db, { workstream: "ws", mode });
      expect(view.agents[0]?.idle).toBe(true);
      expect(view.report.mode).toBe(mode);
    });
  }
});

describe("formatAgentsTable + JSON shape — idle surface", () => {
  it("idle=true rows render the ⚠ glyph in the agents table", () => {
    insertAgent(db, { name: "alice", workstream: "ws", paneId: "%1", status: "needs_input" });
    const row = getAgent(db, "alice", "ws");
    if (!row) throw new Error("row missing");
    const idleRow: AgentRow = { ...row, idle: true };
    const rendered = formatAgentsTable([idleRow]);
    expect(rendered).toContain(IDLE_GLYPH);
    // Status column stays the truth, NOT idle (idle is the supplement).
    expect(rendered).toContain("needs_input");
  });

  it("idle=false (or absent) rows do NOT render the ⚠ glyph", () => {
    insertAgent(db, { name: "bob", workstream: "ws", paneId: "%2", status: "needs_input" });
    const row = getAgent(db, "bob", "ws");
    if (!row) throw new Error("row missing");
    expect(formatAgentsTable([row])).not.toContain(IDLE_GLYPH);
  });

  it("AgentRow with idle=true round-trips through JSON.stringify (mu state --json contract)", () => {
    insertAgent(db, { name: "alice", workstream: "ws", paneId: "%1", status: "needs_input" });
    const row = getAgent(db, "alice", "ws");
    if (!row) throw new Error("row missing");
    const idleRow: AgentRow = { ...row, idle: true };
    const json = JSON.stringify(idleRow);
    const parsed = JSON.parse(json) as AgentRow;
    expect(parsed.idle).toBe(true);
  });

  it("AgentRow without idle stays absent in JSON (consumers do `if (a.idle)`)", () => {
    insertAgent(db, { name: "bob", workstream: "ws", paneId: "%2", status: "needs_input" });
    const row = getAgent(db, "bob", "ws");
    if (!row) throw new Error("row missing");
    const json = JSON.stringify(row);
    expect(json).not.toContain('"idle"');
  });
});
