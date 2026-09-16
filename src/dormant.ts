// mu — dormant-workstream detection for `mu doctor`.
//
// The question this answers: "which workstreams can I tear down?" The
// operator had to answer it by eye, from `mu workstream list`, which
// prints row counts and no dates — so the two workstreams that had been
// untouched for three months looked exactly like the one worked on an
// hour ago. Teardown is reversible (tombstone ops + `mu undo`), so the
// cost of the missing surface was not risk, it was that nobody ever
// tore anything down and the list grew forever.
//
// TWO BUCKETS, NEVER ONE NUMBER
// -----------------------------
// "Stale-ish and/or no open tasks" is two different findings and
// merging them gives actively bad advice:
//
//   FINISHED  every task CLOSED, and idle a while. Nothing is at
//             stake. Safe to tear down, and that is what the
//             remediation says.
//   ABANDONED idle for a long time WITH unclosed tasks. Tearing this
//             down discards open work. The remediation is to LOOK
//             first, and the count of what would be lost is the whole
//             point of the row.
//
// On the box this was written against the split is the entire value:
// `mu` / `dash-search` / `dash-shortcuts` / `goto-murmur-dash` are
// finished (0 unclosed), while `infer-rs` (95 days, 19 unclosed) and
// `modelbridge` (89 days, 8 unclosed) are abandoned. One combined
// "dormant" list would have invited `--empty`-style sweeping of 27 open
// tasks.
//
// WHY NOT `teardown --empty`
// --------------------------
// That verb already exists and is deliberately narrower: ZERO tasks,
// agents and workspaces — test litter. Every workstream here has real
// history, so `--empty` never matches one. This check reports; it never
// sweeps. Same posture as src/disk-recon.ts: each finding names its own
// command and mu runs none of them.
//
// IDLE IS DERIVED, NOT STORED
// ---------------------------
// There is no `workstreams.last_activity` column and this does not add
// one. Activity is `MAX(tasks.updated_at)`, falling back to the
// workstream's own `created_at` when it has no tasks at all — a column
// would be a second source of truth that can disagree with the rows it
// summarises, which is the `provenance` reasoning in
// docs/VOCABULARY.md applied to a cheaper case.

import type { Db } from "./db.js";
import type { FleetHazard } from "./fleet-hazards.js";
import { isScratchWorkstream } from "./workstream.js";

/**
 * Idle threshold, in days, before a fully-closed workstream is called
 * **finished**.
 *
 * Two weeks, because the failure mode of a low value is a doctor that
 * nags about the thing you finished yesterday and will reopen tomorrow.
 * A workstream whose every task is closed is not *suspicious* — that is
 * the success state — so the row has to earn its place by the work also
 * being cold.
 */
export const FINISHED_IDLE_DAYS = 14;

/**
 * Idle threshold, in days, before a workstream with unclosed tasks is
 * called **abandoned**.
 *
 * Deliberately much higher than FINISHED_IDLE_DAYS: open tasks mean
 * "not done", and a fortnight away from a project is a holiday, not
 * abandonment. 60 days is roughly "two months of not touching it",
 * which on the dogfood box catches the two genuinely-dead workstreams
 * and nothing that is merely paused.
 */
export const ABANDONED_IDLE_DAYS = 60;

/** Neither threshold is an env var. They are display cutoffs on a
 *  report the operator then judges — the same call
 *  `PEER_STALE_MS` (src/sync.ts) makes, for the same reason: a knob
 *  implies a behaviour change downstream, and nothing downstream reads
 *  these. */

export interface DormantWorkstream {
  name: string;
  /** Whole days since the newest task update (or the workstream's own
   *  creation, when it has no tasks). */
  idleDays: number;
  /** Tasks in the workstream, total. */
  tasks: number;
  /** Tasks not CLOSED. Zero for `finished`, non-zero for `abandoned`. */
  unclosed: number;
  /** Which bucket, and therefore which remediation applies. */
  kind: "finished" | "abandoned";
}

interface DormantRow {
  name: string;
  tasks: number;
  unclosed: number;
  idle_days: number | null;
}

/**
 * Workstreams that look torn-down-able, newest-idle last.
 *
 * EXCLUDES:
 *   - the current workstream, passed in by the caller. Telling someone
 *     the thing they are working in right now is dormant is noise, and
 *     the caller is the only layer that knows which it is.
 *   - `scratch`, which is ephemeral BY DESIGN (see
 *     `isScratchWorkstream`). Its whole contract is "off-the-cuff
 *     helpers, no ceremony", so a report that it has been quiet for a
 *     fortnight is telling the operator the feature works.
 *   - workstreams with live agents or registered workspaces. Those are
 *     not dormant regardless of task dates: something is running, or a
 *     checkout is on disk holding uncommitted work. `mu doctor`'s disk
 *     section owns the workspace story.
 *
 * One indexed GROUP BY over `tasks`; no filesystem and no mux calls, so
 * it is cheap enough for the default doctor tier.
 */
export function findDormantWorkstreams(
  db: Db,
  opts: { currentWorkstream?: string | null } = {},
): DormantWorkstream[] {
  const rows = db
    .prepare(
      `SELECT w.name                                        AS name,
              COUNT(t.id)                                   AS tasks,
              COALESCE(SUM(t.status <> 'CLOSED'), 0)        AS unclosed,
              CAST(julianday('now')
                   - julianday(MAX(COALESCE(t.updated_at, w.created_at)))
                   AS INTEGER)                              AS idle_days
         FROM workstreams w
         LEFT JOIN tasks t ON t.workstream_id = w.id
        WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.workstream_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM vcs_workspaces v WHERE v.workstream_id = w.id)
        GROUP BY w.id, w.name
        ORDER BY idle_days DESC, w.name`,
    )
    .all() as DormantRow[];

  const dormant: DormantWorkstream[] = [];
  for (const row of rows) {
    if (row.name === opts.currentWorkstream) continue;
    if (isScratchWorkstream(row.name)) continue;
    // A workstream with no tasks at all is `teardown --empty`'s job,
    // not this one. Reporting it here would give the same row two
    // different remediations in one doctor run.
    if (row.tasks === 0) continue;
    // julianday() returns NULL on an unparsable timestamp; treat that
    // as "cannot judge" rather than as 0 days (which would silently
    // hide the row) or a huge number (which would invent a finding).
    if (row.idle_days === null) continue;
    const idleDays = row.idle_days;
    const kind =
      row.unclosed === 0
        ? idleDays >= FINISHED_IDLE_DAYS
          ? ("finished" as const)
          : null
        : idleDays >= ABANDONED_IDLE_DAYS
          ? ("abandoned" as const)
          : null;
    if (kind === null) continue;
    dormant.push({
      name: row.name,
      idleDays,
      tasks: row.tasks,
      unclosed: row.unclosed,
      kind,
    });
  }
  return dormant;
}

/** `95d` / `3d`. Doctor rows are narrow and the unit is always days
 *  here, so this stays a suffix rather than growing a duration
 *  formatter (src/cli/tui/format-helpers.ts owns that job for the TUI). */
function days(n: number): string {
  return `${n}d`;
}

/**
 * The doctor row + remediation for both buckets.
 *
 * Severity is `ok`, never `warn`. A dormant workstream is not a fault —
 * it is a housekeeping opportunity — and `warn` would make
 * `mu doctor` print "at least one finding needs attention" forever on a
 * box that is working perfectly. Same choice `ws-empty` makes in
 * src/disk-recon.ts, for the same reason.
 */
export function checkDormantWorkstreams(
  db: Db,
  opts: { currentWorkstream?: string | null } = {},
): FleetHazard {
  const dormant = findDormantWorkstreams(db, opts);
  if (dormant.length === 0) {
    return { name: "ws-dormant", severity: "ok", detail: "no dormant workstreams" };
  }

  const finished = dormant.filter((d) => d.kind === "finished");
  const abandoned = dormant.filter((d) => d.kind === "abandoned");
  const parts: string[] = [];
  if (finished.length > 0) parts.push(`${finished.length} finished`);
  if (abandoned.length > 0) parts.push(`${abandoned.length} with open tasks`);

  const remediation: string[] = [];
  if (finished.length > 0) {
    remediation.push(
      `Every task CLOSED and untouched for ${FINISHED_IDLE_DAYS}+ days — safe to tear down:`,
      ...finished.map(
        (d) => `  ${d.name.padEnd(24)} ${days(d.idleDays).padStart(5)} idle, ${d.tasks} closed`,
      ),
      "",
      "Teardown is reversible: it writes tombstone ops, so `mu undo <group>` puts",
      "the rows back, and `mu workstream list --torn-down` finds the group later.",
      ...finished.slice(0, 3).map((d) => `  mu workstream teardown ${d.name} --yes`),
    );
  }
  if (abandoned.length > 0) {
    if (remediation.length > 0) remediation.push("");
    remediation.push(
      `Idle ${ABANDONED_IDLE_DAYS}+ days but still holding UNCLOSED tasks — look before tearing down:`,
      ...abandoned.map(
        (d) =>
          `  ${d.name.padEnd(24)} ${days(d.idleDays).padStart(5)} idle, ${d.unclosed} of ${d.tasks} unclosed`,
      ),
      "",
      // "a teardown here discards open work" was the first wording, and it
      // was wrong twice: it contradicted the `finished` block above (which
      // correctly calls teardown reversible), and "work" reads as "my code"
      // when what teardown removes here is the PLAN — task rows and notes.
      //
      // "no checkout is touched" is true only because this list EXCLUDES
      // workstreams with registered workspaces; teardown does free real
      // checkouts when they exist (`freedWorkspaces` in teardownWorkstream).
      // The exclusion in findDormantWorkstreams is what makes this sentence
      // safe, so the two must not drift apart.
      "Removes the task rows and notes — the plan, not the code (no checkout",
      "is touched, and `mu undo <group>` puts the rows back). The risk is",
      "losing sight of what was left to do, so read it first:",
      ...abandoned.slice(0, 3).map((d) => `  mu task list -w ${d.name} --status OPEN`),
    );
  }

  return {
    name: "ws-dormant",
    severity: "ok",
    detail: `${dormant.length} dormant workstream(s): ${parts.join(", ")}`,
    remediation,
  };
}
