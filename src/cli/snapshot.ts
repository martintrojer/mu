// mu — `mu undo` / `mu snapshot list` / `mu snapshot show`.
//
// Snapshots are taken automatically by every destructive verb
// (snap_schema commit ab82a11). These three CLI verbs surface them:
//
//   mu undo [--yes] [--to <id>]      restore the latest (or a specific)
//   mu snapshot list [-n N] [--json]  list newest-first, with size
//   mu snapshot show <id> [--json]    one snapshot's full metadata
//
// `mu redo` was deliberately NOT shipped: snap_design (note #293)
// rejected it because mu verbs have side effects (tmux pane kills,
// `git worktree remove`, etc.) that aren't replayable. "Undo of undo"
// works for free — every restore takes a pre-restore snapshot first,
// so re-running `mu undo` after `mu undo` rolls forward to that
// snapshot.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { UsageError, emitJson, emitJsonCollection, truncate } from "../cli.js";
import { type Db, openDb } from "../db.js";
import { muTable, pc, printNextSteps } from "../output.js";
import { reconcile } from "../reconcile.js";
import {
  type PruneMode,
  type PruneResult,
  SnapshotNotFoundError,
  type SnapshotRow,
  deleteSnapshot,
  isStaleVersion,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  snapshotFileSize,
} from "../snapshots.js";
import { listWorkstreams } from "../workstream.js";

/** Format a byte count for human-readable display in `mu snapshot list`.
 *  Four levels: bytes / KB / MB / GB. We added a GB level after
 *  snapshot_gc_caps_too_lax_no_cleanup_verb — the bug report's
 *  evidence was a 731MB snapshots dir, well within the bytes → MB
 *  domain, but a `mu snapshot prune --all` summary may legitimately
 *  hit GB on neglected installs. */
export function formatBytes(n: number | null): string {
  if (n === null) return pc.red("missing");
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Render a schema_version cell. Stale rows render dimmed in tables
 *  via the caller (see cmdSnapshotList); this helper just shapes the
 *  string. Always `v<N>` for a non-zero version; `v?` for the
 *  defensive 0 case (shouldn't happen — every row is stamped at
 *  capture time). Exported for tests. */
export function formatSchemaVersion(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "v?";
  return `v${v}`;
}

/** Parse the value of `mu snapshot prune --older-than`. Accepts a
 *  bare integer (treated as days) or `<N>d` (e.g. `7d`, `30d`).
 *  Throws commander's `InvalidArgumentError` on bad input so the CLI
 *  exits with the same usage-error code as other parsers.
 *  Exported for tests. */
export function parseOlderThanDays(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)d?$/);
  if (!match || match[1] === undefined) {
    throw new InvalidArgumentError(
      `expected a number of days (e.g. '7' or '7d'), got ${JSON.stringify(value)}`,
    );
  }
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(
      `expected a non-negative number of days, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

export async function cmdUndo(
  db: Db,
  opts: { to?: number; yes?: boolean; json?: boolean } = {},
): Promise<void> {
  // Resolve target snapshot. Default = latest by id; --to picks one.
  let target: SnapshotRow | undefined;
  if (opts.to !== undefined) {
    const all = listSnapshots(db);
    target = all.find((r) => r.id === opts.to);
    if (!target) throw new SnapshotNotFoundError(opts.to);
  } else {
    const latest = listSnapshots(db, { limit: 1 });
    target = latest[0];
  }

  if (!target) {
    // Empty snapshots table: nothing to undo. Friendly because this
    // is the common state right after install.
    if (opts.json) {
      emitJson({
        restored: false,
        reason: "no snapshots",
        nextSteps: [
          {
            intent: "Take an action that snapshots first",
            command: "mu task close <id>  (any destructive verb auto-snapshots)",
          },
        ],
      });
      return;
    }
    console.log(pc.dim("no snapshots to undo"));
    printNextSteps([
      {
        intent: "Snapshots are taken by destructive verbs",
        command: "mu task close <id>  /  mu agent close <name>  /  mu workstream destroy ...",
      },
      { intent: "List snapshots once they exist", command: "mu snapshot list" },
    ]);
    return;
  }

  // Dry-run mode: print what would happen, exit clean.
  if (!opts.yes) {
    if (opts.json) {
      emitJson({
        restored: false,
        dryRun: true,
        snapshot: target,
        sizeBytes: snapshotFileSize(target),
        nextSteps: [
          {
            intent: "Confirm and actually restore",
            command: opts.to !== undefined ? `mu undo --to ${opts.to} --yes` : "mu undo --yes",
          },
        ],
      });
      return;
    }
    const wsLabel = target.workstreamName ?? pc.dim("<whole-DB>");
    console.log(pc.bold(`About to restore snapshot #${target.id}`));
    console.log(`  label        : ${target.label}`);
    console.log(`  workstream   : ${wsLabel}`);
    console.log(`  taken at     : ${target.createdAt}`);
    console.log(`  size         : ${formatBytes(snapshotFileSize(target))}`);
    console.log("");
    console.log(
      pc.yellow(
        "This will REPLACE the live mu.db with the snapshot. tmux state\nwill NOT be rolled back: agents in DB whose panes are gone will\nbe pruned by reconcile; tmux panes whose DB rows are gone will\nsurface as orphans on the next `mu agent list`.",
      ),
    );
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually restore)"));
    printNextSteps([
      {
        intent: "Confirm and actually restore",
        command: opts.to !== undefined ? `mu undo --to ${opts.to} --yes` : "mu undo --yes",
      },
      { intent: "Inspect the snapshot first", command: `mu snapshot show ${target.id}` },
    ]);
    return;
  }

  // Capture identity BEFORE restore — restoreSnapshot closes the
  // live handle, so reading off `target` afterwards is fine but
  // reading off `db` is not.
  const restored = restoreSnapshot(db, target.id);

  // Re-open and reconcile every workstream so the post-restore output
  // can honestly say how much DB-vs-tmux drift exists. We open a fresh
  // handle here; handle()'s finally `db?.close()` will silently fail on
  // the old (now-closed) handle, which is the documented behaviour.
  //
  // **mode: "report-only"** is the load-bearing flag. Without it,
  // the reconcile pass would prune any agent row whose pane is no
  // longer in tmux — which is EVERY agent row in a snapshot taken
  // before `mu workstream destroy --yes`, because the destroy
  // killed the panes. The contract `mu undo` advertises is "the
  // restore brings back the snapshot's rows verbatim"; a mutating
  // post-restore reconcile silently breaks that. report-only
  // reports drift but doesn't delete (the user can still do a
  // real reconcile later via `mu agent list` once they've decided
  // which would-be-pruned rows to re-spawn vs let go).
  // (snap_undo_reconcile_destroys_recovered_agents.)
  const fresh = openDb({ path: restored.restoredTo });
  let totalGhostsWouldBePruned = 0;
  let totalOrphans = 0;
  const reconcilePerWorkstream: Array<{
    workstream: string;
    wouldBePrunedGhosts: number;
    orphans: number;
  }> = [];
  try {
    const workstreams = await listWorkstreams(fresh);
    for (const ws of workstreams) {
      // reconcile() shells out to tmux and may throw on substrate
      // failures (tmux not running). Per-workstream try/catch so a
      // single bad workstream doesn't poison the post-restore
      // summary.
      try {
        const report = await reconcile(fresh, {
          workstream: ws.name,
          mode: "report-only",
        });
        totalGhostsWouldBePruned += report.prunedGhosts;
        totalOrphans += report.orphans.length;
        reconcilePerWorkstream.push({
          workstream: ws.name,
          wouldBePrunedGhosts: report.prunedGhosts,
          orphans: report.orphans.length,
        });
      } catch {
        // Best-effort; the restore itself succeeded.
      }
    }
  } finally {
    try {
      fresh.close();
    } catch {
      // best effort
    }
  }

  if (opts.json) {
    emitJson({
      restored: true,
      snapshot: target,
      restoredTo: restored.restoredTo,
      schemaVersion: restored.schemaVersion,
      reconcile: {
        // Renamed from `ghostsPruned` because we no longer prune
        // during restore. The shape is informational — callers
        // wanting to actually prune should run `mu agent list`
        // (which still mutates) after deciding which rows to keep.
        wouldBePrunedGhosts: totalGhostsWouldBePruned,
        orphansSurfaced: totalOrphans,
        // Reconcile mode: "report-only" preserves the snapshot's
        // restored rows verbatim. (Was `dryRun: true` before the
        // status-only/report-only split — BREAKING for SDK consumers
        // reading this field; see CHANGELOG.)
        mode: "report-only",
        perWorkstream: reconcilePerWorkstream,
      },
      nextSteps: [
        {
          intent: "See orphan panes (DB doesn't know about them)",
          command: "mu agent list -w '*' --json | jq '.[].orphans'",
        },
        {
          intent: "Confirm + actually prune dead-pane rows you don't want to re-spawn",
          command: "mu agent list -w <ws>  (a normal list reconciles + prunes)",
        },
        { intent: "Roll forward (undo the undo)", command: "mu undo --yes" },
      ],
    });
    return;
  }
  console.log(
    `Restored snapshot ${pc.bold(`#${target.id}`)} (${target.label}, taken ${target.createdAt})`,
  );
  console.log("");
  console.log(pc.bold("Reconcile (tmux NOT rolled back; rows NOT pruned):"));
  console.log(
    `  would-be-pruned (DB row → dead pane) : ${pc.yellow(String(totalGhostsWouldBePruned))} ${pc.dim("(suppressed: rows preserved as restored)")}`,
  );
  console.log(`  orphan panes surfaced                 : ${pc.yellow(String(totalOrphans))}`);
  printNextSteps([
    {
      intent: "See orphan panes (DB doesn't know about them)",
      command: "mu agent list -w '*' --json | jq '.[].orphans'",
    },
    {
      intent: "Confirm + actually prune dead-pane rows you don't want to re-spawn",
      command: "mu agent list -w <ws>  (a normal list reconciles + prunes)",
    },
    { intent: "Re-spawn an agent the DB now lacks", command: "mu agent spawn <name> -w <ws>" },
    { intent: "Roll forward (undo the undo)", command: "mu undo --yes" },
  ]);
}

export async function cmdSnapshotList(
  db: Db,
  opts: { lines?: number; json?: boolean } = {},
): Promise<void> {
  const limit = opts.lines ?? 20;
  const rows = listSnapshots(db, { limit });
  if (opts.json) {
    emitJsonCollection(
      rows.map((r) => ({
        ...r,
        sizeBytes: snapshotFileSize(r),
      })),
    );
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("no snapshots"));
    printNextSteps([
      {
        intent: "Snapshots are taken automatically by destructive verbs",
        command: "mu task close <id>  /  mu agent close <name>  /  mu workstream destroy ...",
      },
    ]);
    return;
  }
  // Snapshot labels are free-text (e.g. "task close <id> evidence=..."
  // can run dozens of chars). Cap the label column so a long label
  // can't push id/created_at off-screen
  // (tables_truncate_long_cols_audit).
  const LABEL_BUDGET = 50;
  // "ver" column added in snapshot_gc_caps_too_lax_no_cleanup_verb so
  // operators can see at a glance which snapshots are stale (schema
  // bumped past their stamp — unrestorable; pure dead weight on disk).
  // Stale rows render dimmed via pc.dim, mirroring the satisfied-blockers
  // bucket in `mu task show` (task_show_blocked_by_renders_closed).
  const table = muTable({
    head: [
      pc.bold("id"),
      pc.bold("ver"),
      pc.bold("label"),
      pc.bold("workstream"),
      pc.bold("created_at"),
      pc.bold("size"),
    ],
    colWidths: [null, null, LABEL_BUDGET, null, null, null],
    style: { head: [] },
  });
  let staleCount = 0;
  for (const r of rows) {
    const stale = isStaleVersion(r);
    if (stale) staleCount += 1;
    const ver = formatSchemaVersion(r.schemaVersion);
    const cells = [
      String(r.id),
      ver,
      truncate(r.label, LABEL_BUDGET - 2),
      r.workstreamName ?? "<whole-DB>",
      r.createdAt,
      formatBytes(snapshotFileSize(r)),
    ];
    // Dim every cell on a stale row so the row reads as a single
    // "don't bother trying to restore this" hint. Match the
    // task_show satisfied-bucket pattern: pc.dim each piece.
    if (stale) {
      table.push(cells.map((c) => pc.dim(c)));
    } else {
      // Apply the dim to <whole-DB> on non-stale rows for the
      // historical look-and-feel.
      cells[3] = r.workstreamName ?? pc.dim("<whole-DB>");
      table.push(cells);
    }
  }
  console.log(table.toString());
  const nextSteps = [
    { intent: "Show one snapshot's full metadata", command: "mu snapshot show <id>" },
    { intent: "Restore the latest snapshot", command: "mu undo --yes" },
    { intent: "Restore a specific snapshot", command: "mu undo --to <id> --yes" },
  ];
  if (staleCount > 0) {
    nextSteps.push({
      intent: `Drop ${staleCount} stale-version row${staleCount === 1 ? "" : "s"} (unrestorable; pure disk weight)`,
      command: "mu snapshot prune --stale-version --yes",
    });
  }
  printNextSteps(nextSteps);
}

// ─── mu snapshot prune ──────────────────────────────────────────────
//
// Two-phase: dry-run by default, --yes to commit. Mode is determined
// by the supplied flag (mutually exclusive); exactly one is required
// EXCEPT the bare `mu snapshot prune` form which runs the GC policy.
// snapshot_gc_caps_too_lax_no_cleanup_verb introduces this verb.

export interface PruneCliOptions {
  /** mode='keep-last' selector */
  keepLast?: number;
  /** mode='older-than' selector (already-parsed days) */
  olderThanDays?: number;
  /** mode='stale-version' selector */
  staleVersion?: boolean;
  /** mode='all' selector */
  all?: boolean;
  yes?: boolean;
  json?: boolean;
}

export async function cmdSnapshotPrune(db: Db, opts: PruneCliOptions = {}): Promise<void> {
  // Determine mode + report flag conflicts.
  const flags: Array<{ name: string; on: boolean }> = [
    { name: "--keep-last", on: opts.keepLast !== undefined },
    { name: "--older-than", on: opts.olderThanDays !== undefined },
    { name: "--stale-version", on: opts.staleVersion === true },
    { name: "--all", on: opts.all === true },
  ];
  const on = flags.filter((f) => f.on);
  if (on.length > 1) {
    const names = on.map((f) => f.name).join(", ");
    throw new UsageError(`prune flags are mutually exclusive; got ${names}`);
  }
  let mode: PruneMode = "gc";
  if (opts.keepLast !== undefined) mode = "keep-last";
  else if (opts.olderThanDays !== undefined) mode = "older-than";
  else if (opts.staleVersion === true) mode = "stale-version";
  else if (opts.all === true) mode = "all";

  const dryRun = opts.yes !== true;

  // Compute the would-delete set first (dryRun=true). Even on the
  // commit path we want the same victim shape for the summary; so we
  // do a dry-run, print the summary if applicable, then re-run for
  // real if --yes is set. Single round-trip is fine — victim sets are
  // small (bounded by row count).
  const dry = pruneSnapshots(db, {
    mode,
    keepLast: opts.keepLast,
    olderThanDays: opts.olderThanDays,
    dryRun: true,
  });

  if (dryRun) {
    if (opts.json) {
      emitJson({
        dryRun: true,
        mode,
        wouldDeleteRows: dry.victims.length,
        wouldDeleteFiles: dry.victims.filter((v) => snapshotFileSize(v) !== null).length,
        wouldFreeBytes: dry.freedBytes,
        victims: dry.victims.map((v) => ({
          ...v,
          sizeBytes: snapshotFileSize(v),
          stale: isStaleVersion(v),
        })),
        nextSteps: [
          {
            intent: "Confirm and actually prune",
            command: pruneConfirmCommand(mode, opts),
          },
        ],
      });
      return;
    }
    printPruneSummary(mode, dry, /*dryRun*/ true);
    printNextSteps([
      { intent: "Confirm and actually prune", command: pruneConfirmCommand(mode, opts) },
      { intent: "List snapshots", command: "mu snapshot list" },
    ]);
    return;
  }

  // Commit.
  const result = pruneSnapshots(db, {
    mode,
    keepLast: opts.keepLast,
    olderThanDays: opts.olderThanDays,
    dryRun: false,
  });

  if (opts.json) {
    emitJson({
      dryRun: false,
      mode,
      deletedRows: result.deletedRows,
      deletedFiles: result.deletedFiles,
      freedBytes: result.freedBytes,
      ...(result.safetyNetSnapshotId !== undefined
        ? { safetyNetSnapshotId: result.safetyNetSnapshotId }
        : {}),
      nextSteps: [
        { intent: "List remaining snapshots", command: "mu snapshot list" },
        ...(result.safetyNetSnapshotId !== undefined
          ? [
              {
                intent: "Undo the prune (a safety-net snapshot was captured)",
                command: `mu undo --to ${result.safetyNetSnapshotId} --yes`,
              },
            ]
          : []),
      ],
    });
    return;
  }
  printPruneSummary(mode, result, /*dryRun*/ false);
  if (result.safetyNetSnapshotId !== undefined) {
    console.log(
      pc.dim(
        `Safety-net snapshot #${result.safetyNetSnapshotId} captured before the wipe; restore via mu undo --to ${result.safetyNetSnapshotId} --yes.`,
      ),
    );
  }
  const next: Array<{ intent: string; command: string }> = [
    { intent: "List remaining snapshots", command: "mu snapshot list" },
  ];
  if (result.safetyNetSnapshotId !== undefined) {
    next.push({
      intent: "Undo the prune (a safety-net snapshot was captured)",
      command: `mu undo --to ${result.safetyNetSnapshotId} --yes`,
    });
  }
  printNextSteps(next);
}

function printPruneSummary(mode: PruneMode, r: PruneResult, dryRun: boolean): void {
  const verb = dryRun ? "Would delete" : "Deleted";
  const rowCount = dryRun ? r.victims.length : r.deletedRows;
  const fileCount = dryRun
    ? r.victims.filter((v) => snapshotFileSize(v) !== null).length
    : r.deletedFiles;
  console.log(
    `${pc.bold(`${verb} ${rowCount} snapshot row${rowCount === 1 ? "" : "s"}`)} ${pc.dim(`(${fileCount} on-disk .db file${fileCount === 1 ? "" : "s"}, ${formatBytes(r.freedBytes)})`)}`,
  );
  console.log(`  mode : ${mode}`);
  if (dryRun) console.log(pc.dim("(dry-run; rerun with --yes to actually prune)"));
}

function pruneConfirmCommand(mode: PruneMode, opts: PruneCliOptions): string {
  switch (mode) {
    case "gc":
      return "mu snapshot prune --yes";
    case "keep-last":
      return `mu snapshot prune --keep-last ${opts.keepLast} --yes`;
    case "older-than":
      return `mu snapshot prune --older-than ${opts.olderThanDays}d --yes`;
    case "stale-version":
      return "mu snapshot prune --stale-version --yes";
    case "all":
      return "mu snapshot prune --all --yes";
  }
}

// ─── mu snapshot delete <id> ───────────────────────────────────────
//
// Surgical removal mirroring `mu task delete`. Single row + the
// on-disk .db. Errors with SnapshotNotFoundError on miss.
// snapshot_gc_caps_too_lax_no_cleanup_verb.

export async function cmdSnapshotDelete(
  db: Db,
  id: number,
  opts: { json?: boolean } = {},
): Promise<void> {
  const r = deleteSnapshot(db, id);
  if (opts.json) {
    emitJson({
      snapshotId: id,
      deleted: r.deleted,
      deletedFiles: r.deletedFiles,
      freedBytes: r.freedBytes,
      nextSteps: [{ intent: "List snapshots", command: "mu snapshot list" }],
    });
    return;
  }
  console.log(
    `Deleted snapshot ${pc.bold(`#${id}`)} ${pc.dim(`(${r.deletedFiles === 1 ? "file unlinked" : "file already gone"}, ${formatBytes(r.freedBytes)})`)}`,
  );
  // Note: deleteSnapshot does NOT auto-snapshot first — the point
  // is to delete one snapshot, and the auto-snapshot would defeat
  // that. Other snapshots are unaffected.
  printNextSteps([{ intent: "List remaining snapshots", command: "mu snapshot list" }]);
}

export async function cmdSnapshotShow(
  db: Db,
  id: number,
  opts: { json?: boolean } = {},
): Promise<void> {
  const all = listSnapshots(db);
  const row = all.find((r) => r.id === id);
  if (!row) throw new SnapshotNotFoundError(id);
  const sizeBytes = snapshotFileSize(row);
  if (opts.json) {
    emitJson({ ...row, sizeBytes });
    return;
  }
  console.log(pc.bold(`snapshot #${row.id}`));
  console.log(`  label          : ${row.label}`);
  console.log(`  workstream     : ${row.workstreamName ?? pc.dim("<whole-DB>")}`);
  console.log(`  schema_version : ${row.schemaVersion}`);
  console.log(`  db_path        : ${row.dbPath}`);
  console.log(`  size           : ${formatBytes(sizeBytes)}`);
  console.log(`  created_at     : ${row.createdAt}`);
  // The inspect-without-restoring hint shells out to raw sqlite3 on
  // purpose: the snapshot file is a separate, frozen DB by definition,
  // so the "use mu sql, not sqlite3" convention (which targets the live
  // DB) does not apply. Snapshots are forensic / out-of-band; bypass mu.
  printNextSteps([
    { intent: "Restore this snapshot", command: `mu undo --to ${row.id} --yes` },
    {
      intent: "Inspect the snapshot's data without restoring (snapshot is forensic; bypass mu)",
      command: `sqlite3 ${row.dbPath} "SELECT * FROM tasks"`,
    },
  ]);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireSnapshotCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import { type Command, InvalidArgumentError } from "commander";
import { JSON_OPT, handle, parseLines } from "../cli.js";

export function wireSnapshotCommands(program: Command): void {
  //
  // `mu undo` lives at the top level (not under `mu snapshot`) because
  // it's the user-facing recovery verb — same prominence as `mu state`,
  // `mu doctor`. The list/show inspector verbs nest under `mu snapshot`
  // since they're scoped operations on the snapshots collection.

  program
    .command("undo")
    .description(
      "Restore the most recent snapshot (or one selected via --to). Pass --yes to actually restore; otherwise prints a dry-run summary. tmux state is NOT rolled back — the post-restore reconcile prunes ghost agents and surfaces orphan panes; re-spawn or `mu agent adopt` as needed.",
    )
    .option("--to <id>", "snapshot id to restore (default: most recent)", parseLines)
    .option("-y, --yes", "actually restore (without this flag, prints a dry-run summary)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        to?: number;
        yes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdUndo(db, opts), this as Command)();
    });

  const snapshot = program
    .command("snapshot")
    .description("Snapshot inspection (use `mu undo` to restore one)");

  snapshot
    .command("list")
    .description("List snapshots, newest first.")
    .option("-n, --lines <n>", "cap rows; default 20", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { lines?: number; json?: boolean };
      return handle((db) => cmdSnapshotList(db, opts), this as Command)();
    });

  snapshot
    .command("show <id>")
    .description("Show one snapshot's full metadata.")
    .option(...JSON_OPT)
    .action(function (idArg: string) {
      const id = parseLines(idArg);
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdSnapshotShow(db, id, opts), this as Command)();
    });

  snapshot
    .command("prune")
    .description(
      "Prune snapshots. Bare form runs the GC policy (count + age caps); flags select alternate modes. Two-phase: prints a dry-run summary; rerun with --yes to actually delete. --all auto-captures a safety-net snapshot first.",
    )
    .option("--keep-last <n>", "keep only the N most recent snapshots", (v) => parseLines(v))
    .option("--older-than <days>", "drop snapshots older than this; accepts '7' or '7d'", (v) =>
      parseOlderThanDays(v),
    )
    .option(
      "--stale-version",
      "drop snapshots whose schema_version != current (unrestorable; pure disk weight)",
    )
    .option(
      "--all",
      "drop EVERY snapshot (--yes auto-captures a safety-net snapshot of the live DB first)",
    )
    .option("-y, --yes", "actually prune (without this flag, prints a dry-run summary)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as PruneCliOptions;
      return handle((db) => cmdSnapshotPrune(db, opts), this as Command)();
    });

  snapshot
    .command("delete <id>")
    .description(
      "Delete one snapshot row + its on-disk .db file. Errors with SnapshotNotFoundError on miss. Does NOT auto-snapshot first — deleting one stepping-stone can't break `mu undo`.",
    )
    .option(...JSON_OPT)
    .action(function (idArg: string) {
      const id = parseLines(idArg);
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdSnapshotDelete(db, id, opts), this as Command)();
    });
}
