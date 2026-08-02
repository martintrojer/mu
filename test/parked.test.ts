// Tests for src/parked.ts — the "presumed parked on another machine"
// heuristic surfaced in `mu workstream list` and the TUI tab strip.
//
// The detection key is the latest op in the workstream being a
// `db export` event (no local activity since export). mu removed
// `mu db export` itself, and v2-retire-log-shim removed the untyped
// prose emitEvent that could stand in for it, so these tests insert the
// marker op with raw SQL — the only remaining way to produce the shape
// parkedStatus looks for. NOTE: that means parkedStatus is currently
// unreachable in production; v2-sync re-grounds the heuristic on
// watermarks and should delete or rebuild it. Tests
// drive both the positive path (parked) and the disqualifiers
// (recent local activity, alive agent, IN_PROGRESS task, threshold
// not yet elapsed).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { WORKSTREAM_PARKED_THRESHOLD_DAYS, parkedStatus } from "../src/parked.js";
import { addTask } from "../src/tasks.js";
import { setTaskStatus } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let dbPath: string;
let db: Db;

/** Insert the marker op parkedStatus keys off.
 *
 *  v2-log-verb re-keyed the heuristic on `intent = 'workstream.export'`
 *  instead of a `db export ` payload PREFIX — nothing may decide what an
 *  op is by string-matching its text. Still raw SQL: `mu workstream
 *  export` does emit this intent, but arranging for it to be the LATEST
 *  op (with no agents and an aged timestamp) is more setup than the
 *  heuristic is worth. See the header note on why this is dormant. */
function insertExportMarker(database: Db, workstream: string, payload: string): void {
  database
    .prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (?, 'test-machine', ?, 'system', 'workstream.export', 'workstream', ?, 'put', ?, ?)`,
    )
    .run(
      `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      `grp-${Math.random().toString(36).slice(2)}`,
      workstream,
      payload,
      new Date().toISOString(),
    );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-parked-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// The marker op's `created_at` is the real wall clock,
// so tests compute the simulated "now" relative to the actual export
// time rather than against a hard-coded ISO string.
function daysAfterExport(localDb: Db, days: number): Date {
  const row = localDb
    .prepare(
      "SELECT created_at FROM ops WHERE payload LIKE 'db export %' ORDER BY seq DESC LIMIT 1",
    )
    .get() as { created_at: string } | undefined;
  if (row === undefined) throw new Error("no db export event found");
  return new Date(Date.parse(row.created_at) + days * 24 * 60 * 60 * 1000);
}

describe("parkedStatus", () => {
  it("returns parked: false for a workstream that does not exist", () => {
    expect(parkedStatus(db, "nope")).toEqual({ parked: false });
  });

  it("returns parked: false for a freshly initialised workstream (no db export event)", () => {
    ensureWorkstream(db, "alpha");
    expect(parkedStatus(db, "alpha")).toEqual({ parked: false });
  });

  it("returns parked: true after mu db export when 1+ days have elapsed", () => {
    ensureWorkstream(db, "alpha");
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({
      parked: true,
      sinceDays: 2,
    });
  });

  it("returns parked: false within the threshold window (same-session export)", () => {
    ensureWorkstream(db, "alpha");
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    // "Now" is right after the export — well under the 1-day threshold.
    expect(parkedStatus(db, "alpha")).toEqual({ parked: false });
  });

  it("local activity after export disqualifies (task add supersedes the marker)", () => {
    ensureWorkstream(db, "alpha");
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    const now = daysAfterExport(db, 2);
    addTask(db, {
      localId: "later",
      workstream: "alpha",
      title: "later",
      impact: 50,
      effortDays: 1,
    });
    expect(parkedStatus(db, "alpha", { now })).toEqual({ parked: false });
  });

  it("IN_PROGRESS task disqualifies even if the marker is the latest event", () => {
    ensureWorkstream(db, "alpha");
    addTask(db, {
      localId: "wip",
      workstream: "alpha",
      title: "wip",
      impact: 50,
      effortDays: 1,
    });
    setTaskStatus(db, "wip", "IN_PROGRESS", { workstream: "alpha" });
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    // The export event is now the latest agent_logs row, but the
    // in-progress task means the workstream is presumably mid-flight.
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({ parked: false });
  });

  it("a dead agent row (terminated) does not disqualify parked", () => {
    ensureWorkstream(db, "alpha");
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get("alpha") as { id: number }
    ).id;
    // A `terminated` agent row is dead, not alive: closeAgent/deleteAgent
    // normally DELETE the row, but a stale dead row must not keep the
    // workstream out of parked state.
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at) VALUES (?, ?, 'pi', '%0', 'terminated', ?, ?)",
    ).run(wsId, "dead", ts, ts);
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({
      parked: true,
      sinceDays: 2,
    });
  });

  it("an alive agent row (free) disqualifies parked", () => {
    ensureWorkstream(db, "alpha");
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get("alpha") as { id: number }
    ).id;
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at) VALUES (?, ?, 'pi', '%0', 'free', ?, ?)",
    ).run(wsId, "live", ts, ts);
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({ parked: false });
  });

  it("respects a custom thresholdDays override", () => {
    ensureWorkstream(db, "alpha");
    insertExportMarker(db, "alpha", `db export ${join(dir, "out.db")}`);
    const now = daysAfterExport(db, 0);
    // Threshold 0 with same-instant `now` trips immediately.
    expect(parkedStatus(db, "alpha", { now, thresholdDays: 0 }).parked).toBe(true);
    // Default threshold (1d) does not.
    expect(parkedStatus(db, "alpha", { now }).parked).toBe(false);
  });

  it("the default threshold is 1 day (single-day no-trip discipline)", () => {
    expect(WORKSTREAM_PARKED_THRESHOLD_DAYS).toBe(1);
  });
});
