// mu — `mu db backup <file>`: the whole survivor of v1's `db` namespace.
//
// v1 had `mu db export / import / replay` — a whole-DB sync mechanism
// with manifests, per-workstream drift detection, and divergence
// sidecars (1500+ LOC). 2.0 deleted all three: sync is ambient over
// segments, and disaster recovery is `mu rebuild`. What survives is the
// one case those verbs were actually used for — "give me one file I can
// scp" — which SQLite already implements as a single statement.
//
// So this is deliberately a one-liner over `VACUUM INTO` and NOT an SDK
// module: there is no policy here to share with another caller. Real DR
// is segments + `mu rebuild`; a backup file is a convenience copy that
// starts going stale the moment it is written.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { JSON_OPT, emitJson, handle } from "../cli.js";
import type { Db } from "../db.js";
import { pc, printNextSteps } from "../output.js";
import { UsageError } from "./handle.js";

export function cmdDbBackup(db: Db, file: string, opts: { json?: boolean } = {}): void {
  const target = resolve(file);
  // VACUUM INTO refuses an existing target itself, but its error is a
  // raw SQLite string; a typed UsageError gets the operator an exit code
  // and a next step instead.
  if (existsSync(target)) {
    throw new UsageError(`${target} already exists: mu db backup never overwrites`);
  }
  mkdirSync(dirname(target), { recursive: true });
  db.prepare("VACUUM INTO ?").run(target);

  const nextSteps = [
    {
      intent: "Inspect the copy without touching the live DB",
      command: `MU_DB_PATH=${target} mu state`,
    },
    { intent: "Disaster recovery is a rebuild, not a copy", command: "mu rebuild <file>" },
  ];
  if (opts.json === true) {
    emitJson({ path: target, nextSteps });
    return;
  }
  console.log(`Backed up to ${pc.bold(target)}`);
  printNextSteps(nextSteps);
}

export function wireDbCommands(program: Command): void {
  const dbCmd = program.command("db").description("Whole-DB file commands");
  dbCmd
    .command("backup <file>")
    .description(
      "VACUUM INTO copy of the whole DB — the 'one file I can scp' convenience. Never overwrites. Real disaster recovery is `mu rebuild`.",
    )
    .option(...JSON_OPT)
    .action(function (file: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle(async (db) => cmdDbBackup(db, file, opts), this as Command)();
    });
}
