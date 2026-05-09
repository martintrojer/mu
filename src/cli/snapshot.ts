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

import Table from "cli-table3";

import { emitJson } from "../cli.js";
import { type Db, openDb } from "../db.js";
import { pc, printNextSteps } from "../output.js";
import { reconcile } from "../reconcile.js";
import {
  SnapshotNotFoundError,
  type SnapshotRow,
  listSnapshots,
  restoreSnapshot,
  snapshotFileSize,
} from "../snapshots.js";
import { listWorkstreams } from "../workstream.js";

/** Format a byte count for human-readable display in `mu snapshot list`.
 *  Three levels: bytes / KB / MB. Snapshots beyond a few MB on a real
 *  workstream would be unusual (mu DB rows are TEXT-heavy but small);
 *  no GB level by design. */
function formatBytes(n: number | null): string {
  if (n === null) return pc.red("missing");
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
    const wsLabel = target.workstream ?? pc.dim("<whole-DB>");
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
  // **dryRun: true** is the load-bearing flag. Without it, the
  // reconcile pass would prune any agent row whose pane is no
  // longer in tmux — which is EVERY agent row in a snapshot taken
  // before `mu workstream destroy --yes`, because the destroy
  // killed the panes. The contract `mu undo` advertises is "the
  // restore brings back the snapshot's rows verbatim"; a mutating
  // post-restore reconcile silently breaks that. Dry-run reports
  // drift but doesn't delete (the user can still do a real
  // reconcile later via `mu agent list` once they've decided
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
          workstream: ws.workstream,
          dryRun: true,
        });
        totalGhostsWouldBePruned += report.prunedGhosts;
        totalOrphans += report.orphans.length;
        reconcilePerWorkstream.push({
          workstream: ws.workstream,
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
        dryRun: true,
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
    emitJson(
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
  const table = new Table({
    head: [
      pc.bold("id"),
      pc.bold("label"),
      pc.bold("workstream"),
      pc.bold("created_at"),
      pc.bold("size"),
    ],
    style: { head: [] },
  });
  for (const r of rows) {
    table.push([
      String(r.id),
      r.label,
      r.workstream ?? pc.dim("<whole-DB>"),
      r.createdAt,
      formatBytes(snapshotFileSize(r)),
    ]);
  }
  console.log(table.toString());
  printNextSteps([
    { intent: "Show one snapshot's full metadata", command: "mu snapshot show <id>" },
    { intent: "Restore the latest snapshot", command: "mu undo --yes" },
    { intent: "Restore a specific snapshot", command: "mu undo --to <id> --yes" },
  ]);
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
  console.log(`  workstream     : ${row.workstream ?? pc.dim("<whole-DB>")}`);
  console.log(`  schema_version : ${row.schemaVersion}`);
  console.log(`  db_path        : ${row.dbPath}`);
  console.log(`  size           : ${formatBytes(sizeBytes)}`);
  console.log(`  created_at     : ${row.createdAt}`);
  printNextSteps([
    { intent: "Restore this snapshot", command: `mu undo --to ${row.id} --yes` },
    {
      intent: "Inspect the snapshot's data without restoring",
      command: `sqlite3 ${row.dbPath} "SELECT * FROM tasks"`,
    },
  ]);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireSnapshotCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
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
      "Restore the most recent snapshot (or one selected via --to). Pass --yes to actually restore; otherwise prints a dry-run summary. tmux state is NOT rolled back — the post-restore reconcile prunes ghost agents and surfaces orphan panes; re-spawn or `mu adopt` as needed.",
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
      return handle((db) => cmdUndo(db, opts))();
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
      return handle((db) => cmdSnapshotList(db, opts))();
    });

  snapshot
    .command("show <id>")
    .description("Show one snapshot's full metadata.")
    .option(...JSON_OPT)
    .action(function (idArg: string) {
      const id = parseLines(idArg);
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdSnapshotShow(db, id, opts))();
    });
}
