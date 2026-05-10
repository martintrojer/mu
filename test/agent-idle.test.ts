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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentRow,
  computeAgentIdle,
  getAgent,
  idleThresholdMs,
  insertAgent,
} from "../src/agents.js";
import { IDLE_GLYPH, formatAgentsTable } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { setTaskStatus } from "../src/tasks/lifecycle.js";

// Force colorless output so literal-substring assertions vs ANSI escapes
// are stable. Mirrors test/state-render.test.ts.
process.env.NO_COLOR = "1";

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
