// mu — `mu db` verbs (whole-machine DB sync).

import type { Command } from "commander";
import { JSON_OPT, emitJson, handle } from "../cli.js";
import { type ExportDbResult, exportDb } from "../db-sync.js";
import type { Db } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";

interface DbExportCliOptions {
  force?: boolean;
  json?: boolean;
}

function exportNextSteps(file: string): NextStep[] {
  return [
    { intent: "Ship the DB copy", command: `scp ${file} <other-machine>:/tmp/mu.db` },
    { intent: "Ship the manifest too", command: `scp ${file}.manifest.json <other-machine>:/tmp/` },
    { intent: "Import on the other side", command: "mu db import /tmp/mu.db --dry-run" },
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
}
