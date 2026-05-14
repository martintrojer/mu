// mu — `mu db` verbs (whole-machine DB sync).

import type { Command } from "commander";
import { JSON_OPT, emitJson, handle } from "../cli.js";
import {
  type DbImportSummaryItem,
  type DbReplayResult,
  type ExportDbResult,
  type ImportDbResult,
  exportDb,
  importDb,
  replayDb,
} from "../db-sync.js";
import type { Db } from "../db.js";
import { type NextStep, muTable, pc, printNextSteps } from "../output.js";

interface DbExportCliOptions {
  force?: boolean;
  json?: boolean;
}

interface DbImportCliOptions {
  apply?: boolean;
  forceSource?: boolean;
  onlyWs?: string[];
  json?: boolean;
}

interface DbReplayCliOptions {
  apply?: boolean;
  task?: string[];
  note?: string[];
  all?: boolean;
  json?: boolean;
}

function exportNextSteps(file: string): NextStep[] {
  return [
    { intent: "Ship the DB copy", command: `scp ${file} <other-machine>:/tmp/mu.db` },
    { intent: "Ship the manifest too", command: `scp ${file}.manifest.json <other-machine>:/tmp/` },
    { intent: "Import on the other side", command: "mu db import /tmp/mu.db" },
  ];
}

function importNextSteps(result: ImportDbResult): NextStep[] {
  if (result.dryRun) {
    const hasConflict = result.summary.some((s) => s.decision === "CONFLICT");
    const hasStale = result.summary.some((s) => s.decision === "LOCAL_AHEAD");
    return [
      ...(hasStale
        ? [{ intent: "Source is stale", command: "re-export from this machine before importing" }]
        : []),
      ...(hasConflict
        ? [
            {
              intent: "Clobber source after parking local",
              command: `mu db import ${result.sourceFile} --apply --force-source`,
            },
          ]
        : []),
      ...(!hasConflict && !hasStale
        ? [{ intent: "Apply this plan", command: `mu db import ${result.sourceFile} --apply` }]
        : []),
    ];
  }
  return [
    { intent: "Undo if needed", command: "mu undo --yes" },
    { intent: "Inspect workstreams", command: "mu state --json" },
  ];
}

function replayNextSteps(result: DbReplayResult): NextStep[] {
  if (result.dryRun) {
    const firstTask = result.tasks[0]?.localId;
    return [
      ...(firstTask
        ? [
            {
              intent: "Replay one parked task",
              command: `mu db replay ${result.sourceFile} --task ${firstTask} --apply`,
            },
          ]
        : []),
      {
        intent: "Replay all parked rows",
        command: `mu db replay ${result.sourceFile} --all --apply`,
      },
    ];
  }
  return [
    { intent: "Undo if needed", command: "mu undo --yes" },
    { intent: "Inspect the workstream", command: `mu task list -w ${result.workstream}` },
  ];
}

export async function cmdDbExport(
  db: Db,
  file: string,
  opts: DbExportCliOptions = {},
): Promise<void> {
  const result: ExportDbResult = exportDb(db, file, opts);
  const nextSteps = exportNextSteps(result.file);
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    `Exported whole mu DB → ${pc.bold(result.file)} ${pc.dim(
      `(schema=v${result.manifest.schemaVersion}, workstreams=${result.manifest.workstreams.length}, manifest=${result.manifestPath})`,
    )}`,
  );
  if (result.overwritten) console.log(pc.dim("Overwrote existing target due to --force."));
  printNextSteps(nextSteps);
}

export async function cmdDbImport(
  db: Db,
  file: string,
  opts: DbImportCliOptions = {},
): Promise<void> {
  const result = importDb(db, file, {
    apply: opts.apply,
    forceSource: opts.forceSource,
    onlyWorkstreams: opts.onlyWs,
  });
  const nextSteps = importNextSteps(result);
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }

  console.log(
    `${result.dryRun ? "Dry-run" : "Applied"} DB import from ${pc.bold(result.sourceFile)} ${pc.dim(
      `(source machine=${result.machineId})`,
    )}`,
  );
  if (result.snapshotId !== undefined) {
    console.log(pc.dim(`Safety snapshot #${result.snapshotId} captured before import.`));
  }
  console.log(renderImportSummary(result.summary));
  printNextSteps(nextSteps);
}

function renderImportSummary(summary: readonly DbImportSummaryItem[]): string {
  const table = muTable({
    head: ["workstream", "decision", "source_seq", "local_seq", "last_synced", "needs"],
  });
  for (const item of summary) {
    const delta = item.delta as { sourceSeq?: unknown; localSeq?: unknown; lastSynced?: unknown };
    table.push([
      item.workstream,
      item.decision,
      String(delta.sourceSeq ?? ""),
      String(delta.localSeq ?? ""),
      String(delta.lastSynced ?? ""),
      item.parkPath ?? item.needs ?? "",
    ]);
  }
  return table.toString();
}

export async function cmdDbReplay(
  db: Db,
  file: string,
  opts: DbReplayCliOptions = {},
): Promise<void> {
  const result = replayDb(db, file, {
    apply: opts.apply,
    tasks: opts.task,
    notes: opts.note,
    all: opts.all,
  });
  const nextSteps = replayNextSteps(result);
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }

  console.log(
    `${result.dryRun ? "Dry-run" : "Applied"} DB replay from ${pc.bold(result.sourceFile)} ${pc.dim(
      `(workstream=${result.workstream})`,
    )}`,
  );
  if (result.snapshotId !== undefined) {
    console.log(pc.dim(`Safety snapshot #${result.snapshotId} captured before replay.`));
  }
  console.log(renderReplaySummary(result));
  for (const warning of result.warnings) console.warn(pc.yellow(`warning: ${warning}`));
  printNextSteps(nextSteps);
}

function renderReplaySummary(result: DbReplayResult): string {
  const table = muTable({ head: ["kind", "count", "details"] });
  table.push([
    "tasks",
    String(result.tasks.length),
    result.tasks.map((t) => `${t.localId} (${t.status})`).join(", "),
  ]);
  table.push([
    "notes",
    String(result.notes.length),
    result.notes.map((n) => `${n.taskLocalId}@${n.createdAt}`).join(", "),
  ]);
  table.push([
    "edges",
    String(result.edges.length),
    result.edges.map((e) => `${e.fromLocalId}->${e.toLocalId}`).join(", "),
  ]);
  table.push([
    "conflicts",
    String(result.conflicts.length),
    result.conflicts
      .map(
        (c) =>
          `${c.localId}: local=${c.local.status}/${c.local.title}; sidecar=${c.sidecar.status}/${c.sidecar.title}`,
      )
      .join(", "),
  ]);
  if (!result.dryRun) {
    table.push([
      "added",
      String(result.added.tasks + result.added.notes + result.added.edges),
      `tasks=${result.added.tasks}, notes=${result.added.notes}, edges=${result.added.edges}`,
    ]);
  }
  return table.toString();
}

function collectOnlyWs(value: string, previous: string[] = []): string[] {
  return collectRepeatedCsv(value, previous);
}

function collectRepeatedCsv(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  ];
}

export function wireDbCommands(program: Command): void {
  const db = program.command("db").description("Whole-machine DB sync commands");

  db.command("export <file>")
    .description(
      "Export the entire mu SQLite DB to <file> via VACUUM INTO and write <file>.manifest.json. Whole-machine by design; no --workstream flag.",
    )
    .option("--force", "overwrite an existing target file")
    .option(...JSON_OPT)
    .action(function (file: string) {
      const opts = (this as Command).opts() as DbExportCliOptions;
      return handle((dbHandle) => cmdDbExport(dbHandle, file, opts), this as Command)();
    });

  db.command("import <file>")
    .description(
      "Import an exported mu DB with per-workstream drift detection. Dry-run by default; pass --apply to commit. Use --force-source to clobber conflicts after parking local divergence.",
    )
    .option("--apply", "actually apply the import plan (default is dry-run)")
    .option(
      "--only-ws <names>",
      "restrict to workstream names; repeat or comma-separate",
      collectOnlyWs,
      [],
    )
    .option("--force-source", "on conflict, park local divergence then replace from source")
    .option(...JSON_OPT)
    .action(function (file: string) {
      const opts = (this as Command).opts() as DbImportCliOptions;
      return handle((dbHandle) => cmdDbImport(dbHandle, file, opts), this as Command)();
    });

  db.command("replay <sidecar-file>")
    .description(
      "Manually cherry-pick tasks, notes, and eligible edges from a divergence sidecar parked by mu db import --force-source. Dry-run by default; pass --apply to write.",
    )
    .option("--apply", "actually apply the replay selection (default is dry-run)")
    .option(
      "--task <id>",
      "replay a missing task plus its notes and eligible edges; repeat or comma-separate",
      collectRepeatedCsv,
      [],
    )
    .option(
      "--note <task-id>",
      "replay missing notes for a task; repeat or comma-separate",
      collectRepeatedCsv,
      [],
    )
    .option("--all", "replay every missing local-only item from the sidecar")
    .option(...JSON_OPT)
    .action(function (file: string) {
      const opts = (this as Command).opts() as DbReplayCliOptions;
      return handle((dbHandle) => cmdDbReplay(dbHandle, file, opts), this as Command)();
    });
}
