// mu — `mu rebuild <file>`: the disaster-recovery verb.
//
// Thin wrapper over `rebuildInto` (src/rebuild.ts). All the human-facing
// reporting lives here, and none of it lives in the SDK, so the
// forthcoming doctor drift check can rebuild into a temp DB and diff
// without a human-shaped summary getting in the way.

import { type Db, defaultDbPath } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import { type RebuildReport, rebuildInto } from "../rebuild.js";

export interface RebuildCmdOptions {
  json?: boolean;
  force?: boolean;
}

/** The swap command, as the operator should run it. First next-step, so
 *  the thing to do next is the first thing they read. */
function swapCommand(targetPath: string): string {
  const live = defaultDbPath();
  return `mv ${targetPath} ${live}`;
}

function nextSteps(report: RebuildReport): NextStep[] {
  const steps: NextStep[] = [
    { intent: "Swap the rebuilt DB into place", command: swapCommand(report.targetPath) },
    {
      intent: "Inspect it first",
      command: `MU_DB_PATH=${report.targetPath} mu state`,
    },
  ];
  if (report.machineLocalLost.length > 0) {
    // Only suggest re-spawning when there was actually something to lose.
    steps.push({
      intent: "Re-spawn agents after the swap (registry is not rebuildable)",
      command: "mu agent spawn <name> -w <workstream>",
    });
  }
  return steps;
}

export async function cmdRebuild(
  db: Db,
  targetPath: string,
  opts: RebuildCmdOptions = {},
): Promise<void> {
  const report = rebuildInto(db, {
    targetPath,
    ...(opts.force === true ? { force: true } : {}),
  });

  if (opts.json === true) {
    emitJson({
      targetPath: report.targetPath,
      machineId: report.machineId,
      opsCopied: report.opsCopied,
      opsProjected: report.opsProjected,
      opsChangedRows: report.opsChangedRows,
      logOnly: report.logOnlyByEntity,
      rebuiltRows: report.rebuiltRows,
      machineLocalLost: report.machineLocalLost,
      swapCommand: swapCommand(report.targetPath),
      nextSteps: nextSteps(report),
    });
    return;
  }

  console.log(`Rebuilt ${pc.bold(report.targetPath)} from ${report.opsCopied} ops`);
  const rows = report.rebuiltRows;
  const shape = ["workstreams", "tasks", "task_edges", "task_notes"]
    .map((t) => `${rows[t] ?? 0} ${t}`)
    .join(", ");
  console.log(pc.dim(`  projected ${report.opsProjected} ops -> ${shape}`));
  const logOnly = Object.entries(report.logOnlyByEntity);
  if (logOnly.length > 0) {
    console.log(
      pc.dim(
        `  copied ${logOnly.map(([e, n]) => `${n} ${e}`).join(", ")} (log-only, no table to project into)`,
      ),
    );
  }
  console.log(pc.dim(`  machine_id preserved: ${report.machineId}`));

  // The part an operator MUST NOT miss: their agent registry is gone.
  // Never silent — see src/rebuild.ts for why these tables cannot be
  // rebuilt and why that is correct rather than a gap.
  if (report.machineLocalLost.length > 0) {
    const lost = report.machineLocalLost.map((l) => `${l.rows} ${l.table}`).join(", ");
    console.log(
      pc.yellow(
        `  NOT rebuilt: ${lost}. These tables have no capture triggers, so they leave no ops.`,
      ),
    );
    console.log(
      pc.dim(
        "  That is expected: pane ids and absolute workspace paths are meaningless after a rebuild.",
      ),
    );
    console.log(pc.dim("  Re-spawn agents once you have swapped the DB in."));
  }

  printNextSteps(nextSteps(report));
}

// ─── commander wiring ────────────────────────────────────────────────

import type { Command } from "commander";
import { JSON_OPT, emitJson, handle } from "../cli.js";

export function wireRebuildCommand(program: Command): void {
  program
    .command("rebuild <file>")
    .description(
      "Replay the ops log into a NEW DB file (disaster recovery); prints the swap command",
    )
    .option(...JSON_OPT)
    .option("--force", "overwrite <file> if it already exists")
    .action(function (file: string) {
      const opts = (this as Command).opts() as RebuildCmdOptions;
      return handle((db) => cmdRebuild(db, file, opts), this as Command)();
    });
}
