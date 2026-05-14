// mu — `mu db` verbs (whole-machine DB sync).

import type { Command } from "commander";
import { JSON_OPT, emitJson, handle } from "../cli.js";
import {
  type DbImportSummaryItem,
  type ExportDbResult,
  type ImportDbResult,
  exportDb,
  importDb,
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

function exportNextSteps(file: string): NextStep[] {
  return [
    { intent: "Ship the DB copy", command: `scp ${file} <other-machine>:/tmp/mu.db` },
    { intent: "Ship the manifest too", command: `scp ${file}.manifest.json <other-machine>:/tmp/` },
    { intent: "Import on the other side", command: "mu db import /tmp/mu.db --dry-run" },
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

function collectOnlyWs(value: string, previous: string[] = []): string[] {
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
}
