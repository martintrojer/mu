// "Presumed parked on another machine" detection.
//
// When a user runs `mu db export` to ship a workstream off to another
// machine, then leaves the local copy alone for a while, the local
// rows still consume a slot in `mu workstream list` and the TUI tab
// strip. The user gets tempted to `mu workstream destroy` it, which
// works but loses the `workstream_sync` row and degrades drift
// detection on the next round-trip (the workstream re-imports as
// IMPORT-on-clean rather than FAST_FORWARD).
//
// This module exposes a small read-only heuristic: a workstream is
// "parked" iff it has been quiet since its most recent `db export`
// event, has zero alive agents, and has zero IN_PROGRESS tasks. The
// signal is consumed by `mu workstream list` (a `parked` column) and
// the TUI tab strip (dim+prefix). No schema change; no new state.
//
// The detection key is the `db export` agent_logs row emitted by
// `exportDb` in src/db-sync.ts: if the LATEST event in the workstream
// is a `db export`, nothing local has happened since the export ran.
// Any subsequent `task add` / `task note` / `agent spawn` / etc.
// supersedes the marker and the workstream stops being parked.
//
// Threshold: at least one full day (24h) since the export event, so
// "I exported five minutes ago to test" doesn't immediately trip the
// banner. Configurable via WORKSTREAM_PARKED_THRESHOLD_DAYS.

import type { Db } from "./db.js";

/** Days that must have elapsed since the most recent `db export`
 *  event before a workstream is considered parked. Default 1: prevents
 *  a same-session "I exported to verify" from instantly flipping the
 *  TUI tab to dim. Tuning higher would just delay the banner. */
export const WORKSTREAM_PARKED_THRESHOLD_DAYS = 1;

export interface ParkedStatus {
  parked: boolean;
  /** Whole days since the most recent `db export` event. Present iff
   *  `parked === true`. */
  sinceDays?: number;
}

/**
 * Compute the parked status for one workstream. Pure read; no writes.
 *
 * Returns `{ parked: false }` when:
 *  - the workstream has no `db export` event in agent_logs, OR
 *  - any agent_logs row newer than the most recent `db export` exists
 *    (i.e. local activity since export), OR
 *  - the workstream has any alive agents (status != 'closed'), OR
 *  - the workstream has any IN_PROGRESS tasks, OR
 *  - the most recent `db export` is younger than the threshold.
 *
 * Otherwise returns `{ parked: true, sinceDays: <whole days> }`.
 *
 * `now` defaults to wall-clock; tests pass it explicitly to keep the
 * threshold edge deterministic.
 */
export function parkedStatus(
  db: Db,
  workstream: string,
  opts: { now?: Date; thresholdDays?: number } = {},
): ParkedStatus {
  const wsRow = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
    | { id: number }
    | undefined;
  if (wsRow === undefined) return { parked: false };

  // Most recent agent_logs row for this workstream.
  const latest = db
    .prepare(
      "SELECT kind, payload, created_at FROM agent_logs WHERE workstream_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(wsRow.id) as { kind: string; payload: string; created_at: string } | undefined;
  if (latest === undefined) return { parked: false };

  // The marker we look for: the most recent row IS a `db export`
  // event. Any other recent row supersedes it.
  if (latest.kind !== "event") return { parked: false };
  if (!latest.payload.startsWith("db export ")) return { parked: false };

  // Alive agents disqualify (someone is presumably working).
  const aliveAgent = db
    .prepare("SELECT 1 AS x FROM agents WHERE workstream_id = ? AND status != 'closed' LIMIT 1")
    .get(wsRow.id) as { x: number } | undefined;
  if (aliveAgent !== undefined) return { parked: false };

  // IN_PROGRESS tasks disqualify (work is mid-flight even if no agent
  // is currently attached; the parked banner would lie).
  const inProgress = db
    .prepare("SELECT 1 AS x FROM tasks WHERE workstream_id = ? AND status = 'IN_PROGRESS' LIMIT 1")
    .get(wsRow.id) as { x: number } | undefined;
  if (inProgress !== undefined) return { parked: false };

  const threshold = Math.max(0, opts.thresholdDays ?? WORKSTREAM_PARKED_THRESHOLD_DAYS);
  const exportedAt = Date.parse(latest.created_at);
  if (Number.isNaN(exportedAt)) return { parked: false };
  const now = (opts.now ?? new Date()).getTime();
  const deltaMs = now - exportedAt;
  const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
  if (deltaDays < threshold) return { parked: false };
  return { parked: true, sinceDays: deltaDays };
}
