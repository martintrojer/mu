// Tests for src/parked.ts — the "presumed parked on another machine"
// heuristic surfaced in `mu workstream list` and the TUI tab strip.
//
// The detection key is the latest `agent_logs` row in the workstream
// being a `db export` event (no local activity since export). Tests
// drive both the positive path (parked) and the disqualifiers
// (recent local activity, alive agent, IN_PROGRESS task, threshold
// not yet elapsed).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportDb } from "../src/db-sync.js";
import { type Db, openDb } from "../src/db.js";
import { WORKSTREAM_PARKED_THRESHOLD_DAYS, parkedStatus } from "../src/parked.js";
import { addTask } from "../src/tasks.js";
import { setTaskStatus } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-parked-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// `exportDb` stamps the event's `created_at` with the real wall clock,
// so tests compute the simulated "now" relative to the actual export
// time rather than against a hard-coded ISO string.
function daysAfterExport(localDb: Db, days: number): Date {
  const row = localDb
    .prepare(
      "SELECT created_at FROM agent_logs WHERE payload LIKE 'db export %' ORDER BY seq DESC LIMIT 1",
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
    exportDb(db, join(dir, "out.db"), { force: true });
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({
      parked: true,
      sinceDays: 2,
    });
  });

  it("returns parked: false within the threshold window (same-session export)", () => {
    ensureWorkstream(db, "alpha");
    exportDb(db, join(dir, "out.db"), { force: true });
    // "Now" is right after the export — well under the 1-day threshold.
    expect(parkedStatus(db, "alpha")).toEqual({ parked: false });
  });

  it("local activity after export disqualifies (task add supersedes the marker)", () => {
    ensureWorkstream(db, "alpha");
    exportDb(db, join(dir, "out.db"), { force: true });
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
    exportDb(db, join(dir, "out.db"), { force: true });
    // The export event is now the latest agent_logs row, but the
    // in-progress task means the workstream is presumably mid-flight.
    expect(parkedStatus(db, "alpha", { now: daysAfterExport(db, 2) })).toEqual({ parked: false });
  });

  it("respects a custom thresholdDays override", () => {
    ensureWorkstream(db, "alpha");
    exportDb(db, join(dir, "out.db"), { force: true });
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
