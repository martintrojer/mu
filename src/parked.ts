// "Presumed parked on another machine" detection.
//
// When a user ships a workstream off to another machine and then
// leaves the local copy alone for a while, the local rows still
// consume a slot in `mu workstream list` and the TUI tab strip. The
// user gets tempted to `mu workstream destroy` it, which works but
// degrades drift detection on the next round-trip.
//
// This module exposes a small read-only heuristic: a workstream is
// "parked" iff it has been quiet since its most recent export-style
// marker op, has zero alive agents, and has zero IN_PROGRESS tasks.
// The signal is consumed by `mu workstream list` (a `parked` column)
// and the TUI tab strip (dim+prefix). No schema change; no new state.
//
// DORMANT. The heuristic keys on the LATEST op being a marker that no
// in-tree code path emits any more: `mu db export` went away when sync
// became ambient over segments, and `mu workstream export` was deleted
// with the rest of the markdown-bucket surface. So this reports
// `parked: false` for every workstream until it is re-grounded on peer
// watermarks, which is the honest signal anyway. Kept keyed on an
// intent (rather than a payload prefix) so it cannot silently mis-fire
// in the meantime; it is a deletion candidate if the re-grounding never
// happens.
// Any `task add` / `task note` / `agent spawn` / etc. supersedes the
// marker and the workstream stops being parked.
//
// Threshold: at least one full day (24h) since the export event, so
// "I exported five minutes ago to test" doesn't immediately trip the
// banner. Configurable via WORKSTREAM_PARKED_THRESHOLD_DAYS.

import type { Db } from "./db.js";

/** The op intent that marks a workstream as shipped-elsewhere.
 *
 *  Nothing in-tree emits this any more (see the module comment), so the
 *  heuristic is dormant rather than wrong: no op carries this intent, so
 *  the marker branch below never matches on a freshly written log. Ops
 *  recorded by older versions still classify correctly, which is why the
 *  constant stays rather than the branch being deleted outright. */
const PARKED_MARKER_INTENT = "workstream.export";

/** Days that must have elapsed since the most recent marker
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
 *  - the workstream has no marker event in the ops log, OR
 *  - any op newer than the most recent marker exists
 *    (i.e. local activity since export), OR
 *  - the workstream has any alive agents (status not in
 *    terminated/unreachable), OR
 *  - the workstream has any IN_PROGRESS tasks, OR
 *  - the most recent marker is younger than the threshold.
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

  // Most recent op for this workstream. `ops.key` is the NATURAL key,
  // so workstream-level rows are keyed 'alpha' but everything inside it
  // is qualified ('alpha/t1', 'alpha/t1#1', 'alpha/a->alpha/b').
  // Matching `key = 'alpha'` alone therefore missed every task, note,
  // and edge op — i.e. exactly the "local activity" that is supposed to
  // supersede the export marker. Before v2-retire-log-shim this was
  // masked: each of those verbs ALSO wrote a prose event keyed on the
  // bare workstream name, so the bare-key query happened to see them.
  const escaped = workstream.replace(/[\\%_]/g, (c) => `\\${c}`);
  const latest = db
    .prepare(
      `SELECT intent, created_at FROM ops
        WHERE key = ? OR key LIKE ? ESCAPE '\\'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(workstream, `${escaped}/%`) as { intent: string | null; created_at: string } | undefined;
  if (latest === undefined) return { parked: false };

  // The marker: the most recent op IS an export. Any newer op
  // supersedes it. Keyed on the structured `intent`, not on a payload
  // prefix — v2-log-verb's rule is that nothing decides what an op IS by
  // string-matching its text.
  if (latest.intent !== PARKED_MARKER_INTENT) return { parked: false };

  // Alive agents disqualify (someone is presumably working). Dead
  // agents — `terminated` or `unreachable` — do not count as alive;
  // there is no `closed` agent status (closeAgent/deleteAgent DELETE
  // the row), so listing the dead statuses explicitly is the only
  // meaningful filter.
  const aliveAgent = db
    .prepare(
      "SELECT 1 AS x FROM agents WHERE workstream_id = ? AND status NOT IN ('terminated', 'unreachable') LIMIT 1",
    )
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
