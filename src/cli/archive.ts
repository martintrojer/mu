// mu — `mu archive add / list / restore / export`.
//
// Pre-1.0 mu had seven verbs over five tables: create, list, show, add, restore,
// remove, delete (+ search, export). Three survive, and the deletions are
// consequences of the marker model rather than scope cuts:
//
//   create   GONE. A label with no markers pins nothing. Labels come into
//            existence by first use — `mu archive add` IS the create.
//   remove   GONE. Markers are ops: append-only by construction. Removing
//            one would mean rewriting history, which is exactly what an
//            append-only log exists to prevent.
//   delete   GONE. Same reason. To stop caring about an archive, ignore
//            the label; nothing is consuming storage but one row.
//   show     Folded into `list <label>` — one less verb for the same
//            information.
//
// Conventions matched: `--json` + a `Next:` block on every path, dry-run
// by default for the one destructive-ish verb (restore writes a new
// workstream), typed errors mapped by handle().

import type { Command } from "commander";
import { exportArchive } from "../archives/export.js";
import { restoreArchive } from "../archives/restore.js";
import { type ArchiveSummary, addArchiveMarker, getArchive, listArchives } from "../archives.js";
import {
  emitJson,
  emitJsonCollection,
  handle,
  JSON_OPT,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { muTable, type NextStep, pc, printNextSteps } from "../output.js";
import { resolveActorIdentity } from "../tasks.js";

// ─── add ──────────────────────────────────────────────────────────────

export async function cmdArchiveAdd(
  db: Db,
  label: string,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);
  const actor = await resolveActorIdentity();
  const marker = addArchiveMarker(db, { label, workstream: ws, actor });
  const nextSteps: NextStep[] = [
    { intent: "Inspect this archive", command: `mu archive list ${label}` },
    {
      intent: "Restore it under a new name",
      command: `mu archive restore ${label} --as ${ws}-restored`,
    },
    {
      intent: "Add another workstream to the same label",
      command: `mu archive add ${label} -w <ws>`,
    },
  ];
  if (opts.json === true) {
    emitJson({ ...marker, nextSteps });
    return;
  }
  console.log(
    `Pinned ${pc.bold(ws)} under archive ${pc.bold(label)} ${pc.dim(`(hlc ${marker.hlc.slice(0, 18)}…)`)}`,
  );
  printNextSteps(nextSteps);
}

// ─── list ─────────────────────────────────────────────────────────────

export function cmdArchiveList(db: Db, label: string | undefined, opts: { json?: boolean }): void {
  if (label !== undefined) {
    const summary = getArchive(db, label);
    const nextSteps: NextStep[] = [
      {
        intent: "Restore this archive",
        command: `mu archive restore ${label} --as ${summary.workstreams[0] ?? "<ws>"}-restored`,
      },
      { intent: "Export it as markdown", command: `mu archive export ${label} --out ./out` },
    ];
    if (opts.json === true) {
      emitJson({ ...summary, nextSteps });
      return;
    }
    console.log(pc.bold(`Archive ${label}`));
    const table = muTable({ head: ["workstream", "pinned at", "by"] });
    for (const m of summary.markers) {
      table.push([
        m.workstream,
        m.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z"),
        m.actor ?? "—",
      ]);
    }
    console.log(table.toString());
    printNextSteps(nextSteps);
    return;
  }

  const archives = listArchives(db);
  const nextSteps: NextStep[] = [
    { intent: "Pin the current workstream", command: "mu archive add <label> -w <ws>" },
    { intent: "Inspect one archive", command: "mu archive list <label>" },
  ];
  if (opts.json === true) {
    emitJsonCollection(archives.map(withCounts));
    return;
  }
  if (archives.length === 0) {
    console.log(pc.dim("(no archives)"));
    printNextSteps(nextSteps);
    return;
  }
  const table = muTable({ head: ["label", "workstreams", "markers", "last added"] });
  for (const a of archives) {
    table.push([a.label, a.workstreams.join(", "), String(a.markers.length), lastAddedDisplay(a)]);
  }
  console.log(table.toString());
  printNextSteps(nextSteps);
}

function withCounts(a: ArchiveSummary): ArchiveSummary & { markerCount: number } {
  return { ...a, markerCount: a.markers.length };
}

/** `lastAddedAt` is MAX(hlc) — additive needs no stored column — but an
 *  HLC is not a date, so show the wall time of that marker. */
function lastAddedDisplay(a: ArchiveSummary): string {
  const newest = a.markers.reduce<string | null>(
    (acc, m) => (acc === null || m.hlc > a.lastAddedAt ? m.createdAt : acc),
    null,
  );
  const at = a.markers.find((m) => m.hlc === a.lastAddedAt)?.createdAt ?? newest ?? "";
  return at.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// ─── restore ──────────────────────────────────────────────────────────

export function cmdArchiveRestore(
  db: Db,
  label: string,
  opts: { as?: string; workstream?: string; yes?: boolean; json?: boolean },
): void {
  if (opts.as === undefined || opts.as === "") {
    // Deliberately not defaulting to the source name: restoring onto the
    // original would either collide or silently merge into live work.
    throw new UsageError(
      "mu archive restore requires --as <new-workstream>: restore creates a NEW workstream",
    );
  }
  const restoreOpts: Parameters<typeof restoreArchive>[1] = {
    label,
    as: opts.as,
    dryRun: opts.yes !== true,
  };
  if (opts.workstream !== undefined) restoreOpts.workstream = opts.workstream;
  const report = restoreArchive(db, restoreOpts);

  const nextSteps: NextStep[] = report.dryRun
    ? [
        {
          intent: "Apply this restore",
          command: `mu archive restore ${label} --as ${opts.as} --yes`,
        },
      ]
    : [
        { intent: "See the restored tasks", command: `mu task list -w ${report.restoredAs}` },
        { intent: "Open the restored workstream", command: `mu state -w ${report.restoredAs}` },
      ];
  if (opts.json === true) {
    emitJson({ ...report, nextSteps });
    return;
  }
  const verb = report.dryRun ? "Would restore" : "Restored";
  const destroyed = report.sourceDestroyed
    ? pc.dim(" (source workstream no longer exists — recovered from the log)")
    : "";
  console.log(
    `${verb} ${pc.bold(label)} → ${pc.bold(report.restoredAs)}: ${report.tasks} tasks, ${report.edges} edges, ${report.notes} notes ${pc.dim(`from ${report.opsReplayed} ops`)}${destroyed}`,
  );
  if (report.dryRun) console.log(pc.dim("(dry run; pass --yes to apply)"));
  printNextSteps(nextSteps);
}

// ─── export ───────────────────────────────────────────────────────────

export function cmdArchiveExport(
  db: Db,
  label: string,
  opts: { out?: string; workstream?: string; json?: boolean },
): void {
  if (opts.out === undefined || opts.out === "") {
    throw new UsageError("mu archive export requires --out <dir>");
  }
  const exportOpts: Parameters<typeof exportArchive>[1] = { label, outDir: opts.out };
  if (opts.workstream !== undefined) exportOpts.workstream = opts.workstream;
  const result = exportArchive(db, exportOpts);
  const nextSteps: NextStep[] = [
    { intent: "Read the bucket index", command: `cat ${result.manifestPath}` },
    { intent: "Restore it into mu instead", command: `mu archive restore ${label} --as <new-ws>` },
  ];
  if (opts.json === true) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    `Exported ${pc.bold(label)} → ${pc.bold(result.outDir)} ${pc.dim(`(${result.written} written, ${result.unchanged} unchanged)`)}`,
  );
  printNextSteps(nextSteps);
}

// ─── wiring ───────────────────────────────────────────────────────────

export function wireArchiveCommands(program: Command): void {
  const archive = program
    .command("archive")
    .description(
      "Named markers pinning points in the ops log. An archive outlives `workstream destroy`, because destroy writes tombstones rather than erasing history.",
    );

  archive
    .command("add <label>")
    .description(
      "Pin a workstream at the current point in the log under <label>. Creates the label on first use; markers are append-only, so adding twice pins two moments.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).optsWithGlobals() as { workstream?: string; json?: boolean };
      return handle((db) => cmdArchiveAdd(db, label, opts), this as Command)();
    });

  archive
    .command("list [label]")
    .description("List archives, or one archive's markers. Replaces the old separate `show`.")
    .option(...JSON_OPT)
    .action(function (label: string | undefined) {
      const opts = (this as Command).optsWithGlobals() as { json?: boolean };
      return handle(async (db) => cmdArchiveList(db, label, opts), this as Command)();
    });

  archive
    .command("restore <label>")
    .description(
      "Replay the archived workstream's ops up to its marker, under a NEW name. Dry-run by default; --yes applies. Works even if the original was destroyed.",
    )
    .requiredOption(
      "--as <name>",
      "new workstream name (restore never writes onto an existing one)",
    )
    .option("--yes", "actually apply the restore (default is a dry run)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).optsWithGlobals() as {
        as?: string;
        workstream?: string;
        yes?: boolean;
        json?: boolean;
      };
      return handle(async (db) => cmdArchiveRestore(db, label, opts), this as Command)();
    });

  archive
    .command("export <label>")
    .description(
      "Render the archived workstream as markdown, through the same renderer `mu workstream export` uses.",
    )
    .requiredOption("--out <dir>", "output directory")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).optsWithGlobals() as {
        out?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle(async (db) => cmdArchiveExport(db, label, opts), this as Command)();
    });
}
