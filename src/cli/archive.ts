// mu — `mu archive` verbs (create / list / show / add / remove / delete).
//
// Phase 2 of the v0.3 archive feature (workstream_archive_verb).
// Phase 1 landed the schema (v6) + SDK (src/archives.ts); this file
// is the thin commander glue that surfaces them.
//
// Six verbs:
//
//   mu archive create <label> [--description "..."]
//   mu archive list
//   mu archive show <label>
//   mu archive add <label> -w <workstream> [--destroy]
//   mu archive remove <label> -w <workstream>
//   mu archive delete <label> [--yes]
//
// Mirrors src/cli/workspace.ts's wiring shape (one-file-per-verb-
// namespace, with wireArchiveCommands at the bottom).

import {
  type AddToArchiveResult,
  type Archive,
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  type ArchiveSummary,
  addToArchive,
  createArchive,
  deleteArchive,
  getArchive,
  listArchives,
  removeFromArchive,
} from "../archives.js";
import { emitJson, relTime, resolveWorkstream } from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, muTable, pc, printNextSteps } from "../output.js";
import { captureSnapshot } from "../snapshots.js";
import { destroyWorkstream } from "../workstream.js";

// ─── helpers ─────────────────────────────────────────────────────────

/** Render an ISO timestamp as "<rel> ago" relative to now. Empty string
 *  for an unset value. Matches the relative-time idiom used by
 *  `mu task list --sort recency`. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  return `${relTime(ms)} ago`;
}

// ─── create ──────────────────────────────────────────────────────────

export async function cmdArchiveCreate(
  db: Db,
  label: string,
  opts: { description?: string; json?: boolean } = {},
): Promise<void> {
  const archive: Archive = createArchive(db, label, opts.description);
  const nextSteps: NextStep[] = [
    {
      intent: "Add a workstream's task graph to this archive",
      command: `mu archive add ${label} -w <workstream>`,
    },
    { intent: "List every archive on this machine", command: "mu archive list" },
  ];
  if (opts.json) {
    emitJson({ archive, nextSteps });
    return;
  }
  console.log(
    `Created archive ${pc.bold(label)}${
      archive.description ? pc.dim(` — ${archive.description}`) : ""
    }`,
  );
  printNextSteps(nextSteps);
}

// ─── list ────────────────────────────────────────────────────────────

export async function cmdArchiveList(db: Db, opts: { json?: boolean } = {}): Promise<void> {
  const rows = listArchives(db);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("(no archives)"));
    printNextSteps([
      {
        intent: "Create one (operator-named bucket; outlives any workstream)",
        command: 'mu archive create <label> --description "..."',
      },
    ]);
    return;
  }
  // Cap label + sources columns; tasks/created/last_added are short
  // fixed-shape values.
  const LABEL_BUDGET = 32;
  const SOURCES_BUDGET = 40;
  const table = muTable({
    head: ["label", "tasks", "sources", "created", "last_added"].map((h) => pc.bold(h)),
    colWidths: [LABEL_BUDGET, null, SOURCES_BUDGET, null, null],
  });
  for (const r of rows) {
    const sources =
      r.sourceWorkstreams.length === 0
        ? pc.dim("—")
        : r.sourceWorkstreams.map((s) => s.name).join(", ");
    table.push([
      r.label,
      String(r.totalTasks),
      sources,
      pc.dim(ago(r.createdAt) || r.createdAt),
      pc.dim(ago(r.lastAddedAt) || r.lastAddedAt),
    ]);
  }
  console.log(table.toString());
  printNextSteps([
    { intent: "Inspect one archive's contents", command: "mu archive show <label>" },
    {
      intent: "Append a workstream's task graph (idempotent on re-run)",
      command: "mu archive add <label> -w <workstream>",
    },
  ]);
}

// ─── show ────────────────────────────────────────────────────────────

export async function cmdArchiveShow(
  db: Db,
  label: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const summary: ArchiveSummary = getArchive(db, label);
  if (opts.json) {
    emitJson(summary);
    return;
  }
  console.log(pc.bold(`archive ${summary.label}`));
  if (summary.description) console.log(`  description    : ${summary.description}`);
  console.log(`  created_at     : ${summary.createdAt} ${pc.dim(`(${ago(summary.createdAt)})`)}`);
  console.log(
    `  last_added_at  : ${summary.lastAddedAt} ${pc.dim(`(${ago(summary.lastAddedAt)})`)}`,
  );
  console.log(`  total_tasks    : ${summary.totalTasks}`);
  console.log(`  sources        : ${summary.sourceWorkstreams.length}`);
  if (summary.sourceWorkstreams.length === 0) {
    console.log(pc.dim("  (no source workstreams yet — call `mu archive add` to populate)"));
  } else {
    const table = muTable({
      head: ["source workstream", "tasks", "added_at"].map((h) => pc.bold(h)),
      colWidths: [40, null, null],
    });
    for (const s of summary.sourceWorkstreams) {
      table.push([s.name, String(s.taskCount), pc.dim(`${s.addedAt} (${ago(s.addedAt)})`)]);
    }
    console.log(table.toString());
  }
  printNextSteps([
    {
      intent: "Append another workstream's task graph (additive accumulation)",
      command: `mu archive add ${label} -w <workstream>`,
    },
    {
      intent: "Surgically un-archive one source workstream's contribution",
      command: `mu archive remove ${label} -w <workstream>`,
    },
    {
      intent: "Query the underlying rows directly",
      command: `mu sql "SELECT * FROM archived_tasks WHERE archive_id=(SELECT id FROM archives WHERE label='${label}')"`,
    },
  ]);
}

// ─── add ─────────────────────────────────────────────────────────────

export async function cmdArchiveAdd(
  db: Db,
  label: string,
  opts: { workstream?: string; destroy?: boolean; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);

  // Refuse early if the archive doesn't exist. Phase-2 anti-feature
  // pledge from the task design note: DO NOT auto-create on add.
  // Calling addToArchive throws ArchiveNotFoundError; we still pre-
  // check so the --destroy short-circuit also gets the same loud
  // error before we touch any tmux/workstream state.
  // (addToArchive itself also throws WorkstreamNotFoundError if the
  // source workstream is gone — i.e. you must archive BEFORE
  // destroy.)
  // Note: getArchive throws ArchiveNotFoundError on miss — exactly
  // the precheck we want.
  getArchive(db, label);

  const result: AddToArchiveResult = addToArchive(db, label, workstream);

  // --destroy cascade. Run AFTER the archive add succeeds so a
  // failed add never destroys the source workstream by mistake.
  // We mirror `mu workstream destroy --yes`'s semantics directly via
  // destroyWorkstream(); we deliberately skip the usual auto-export
  // (the archive already preserves the structured state — exporting
  // a second copy to disk would just be noise).
  let destroyed: Awaited<ReturnType<typeof destroyWorkstream>> | undefined;
  if (opts.destroy) {
    destroyed = await destroyWorkstream(db, { workstream });
  }

  if (opts.json) {
    emitJson({
      archiveLabel: label,
      sourceWorkstream: workstream,
      ...result,
      destroyed: opts.destroy ? { ranDestroy: true, ...(destroyed ?? {}) } : { ranDestroy: false },
    });
    return;
  }

  console.log(
    `Added ${pc.bold(workstream)} to archive ${pc.bold(label)} ${pc.dim(
      `(tasks=${result.addedTasks}, edges=${result.addedEdges}, notes=${result.addedNotes}, events=${result.addedEvents}, skipped_existing=${result.skippedTasks})`,
    )}`,
  );
  if (destroyed) {
    console.log(
      `Destroyed source workstream ${pc.bold(workstream)} ${pc.dim(
        `(killed tmux=${destroyed.killedTmux}, agents=${destroyed.deletedAgents}, tasks=${destroyed.deletedTasks}, workspaces=${destroyed.freedWorkspaces})`,
      )}`,
    );
    if (destroyed.failedWorkspaces.length > 0) {
      console.log(
        pc.yellow(
          `WARNING: ${destroyed.failedWorkspaces.length} workspace(s) could not be freed cleanly; see \`mu workspace orphans\` for cleanup.`,
        ),
      );
    }
  }
  printNextSteps([
    { intent: "Inspect the archive", command: `mu archive show ${label}` },
    {
      intent: "Re-running on the same workstream is a no-op (idempotent)",
      command: `mu archive add ${label} -w ${workstream}`,
    },
    {
      intent: opts.destroy
        ? "Undo the destroy (DB only; tmux NOT rolled back)"
        : "Destroy the source workstream now that its memory is preserved",
      command: opts.destroy
        ? "mu undo --yes"
        : `mu archive add ${label} -w ${workstream} --destroy`,
    },
  ]);
}

// ─── remove ──────────────────────────────────────────────────────────

export async function cmdArchiveRemove(
  db: Db,
  label: string,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const result = removeFromArchive(db, label, workstream);
  if (opts.json) {
    emitJson({ archiveLabel: label, sourceWorkstream: workstream, ...result });
    return;
  }
  console.log(
    `Removed ${pc.bold(workstream)} from archive ${pc.bold(label)} ${pc.dim(
      `(tasks=${result.removedTasks}, edges=${result.removedEdges}, notes=${result.removedNotes}, events=${result.removedEvents})`,
    )}`,
  );
  if (result.removedTasks === 0 && result.removedEvents === 0) {
    console.log(pc.dim(`(${workstream} did not contribute to ${label}; no rows removed)`));
  }
  printNextSteps([
    { intent: "Inspect what's left", command: `mu archive show ${label}` },
    {
      intent:
        "Re-add the workstream (rows are gone from the live DB; this requires it still exists)",
      command: `mu archive add ${label} -w ${workstream}`,
    },
  ]);
}

// ─── delete ──────────────────────────────────────────────────────────

export async function cmdArchiveDelete(
  db: Db,
  label: string,
  opts: { yes?: boolean; json?: boolean } = {},
): Promise<void> {
  // Always confirm the archive exists FIRST so dry-run + real-run
  // both raise the same typed error on miss.
  const summary = getArchive(db, label);

  if (!opts.yes) {
    if (opts.json) {
      emitJson({
        archiveLabel: label,
        deleted: false,
        dryRun: true,
        summary,
        nextSteps: [
          {
            intent: "Confirm and actually delete (a snapshot is taken first)",
            command: `mu archive delete ${label} --yes`,
          },
        ],
      });
      return;
    }
    console.log(pc.bold(`About to delete archive ${label}`));
    console.log(`  total_tasks    : ${summary.totalTasks}`);
    console.log(`  sources        : ${summary.sourceWorkstreams.length}`);
    for (const s of summary.sourceWorkstreams) {
      console.log(`    - ${s.name}: ${s.taskCount} task(s) (added ${s.addedAt})`);
    }
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually delete)"));
    console.log(
      pc.dim(
        "A snapshot will be taken before the delete; `mu undo --yes` reverts the DB (archives + every other table).",
      ),
    );
    printNextSteps([
      {
        intent: "Confirm and actually delete",
        command: `mu archive delete ${label} --yes`,
      },
      {
        intent: "Surgically remove a single source workstream instead",
        command: `mu archive remove ${label} -w <workstream>`,
      },
    ]);
    return;
  }

  // Pre-delete snapshot. Mirror of destroyWorkstream's pre-mutation
  // captureSnapshot — gives `mu undo --yes` as the recovery path.
  // workstream=null because archives are machine-wide (not per-ws).
  captureSnapshot(db, `archive delete ${label}`, null);

  deleteArchive(db, label);

  if (opts.json) {
    emitJson({
      archiveLabel: label,
      deleted: true,
      removedSources: summary.sourceWorkstreams.length,
      removedTasks: summary.totalTasks,
      nextSteps: [
        {
          intent: "Undo (a snapshot was taken before the delete)",
          command: "mu undo --yes",
        },
      ],
    });
    return;
  }
  console.log(
    `Deleted archive ${pc.bold(label)} ${pc.dim(
      `(removed ${summary.totalTasks} task(s) across ${summary.sourceWorkstreams.length} source workstream(s))`,
    )}`,
  );
  printNextSteps([
    {
      intent: "Undo (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
  ]);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireArchiveCommands is called by buildProgram() in src/cli.ts. Wired
// here so every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle } from "../cli.js";

// The classifyError() switch in src/cli.ts is the single source of
// truth for typed-error → exit-code mapping; the new Archive*Error
// classes are wired there. This module just throws them via the SDK.
// Re-exports here let test files (and downstream skills) import from
// one consistent place.
export { ArchiveAlreadyExistsError, ArchiveLabelInvalidError, ArchiveNotFoundError };

export function wireArchiveCommands(program: Command): void {
  const archive = program
    .command("archive")
    .description(
      "Cross-workstream preservation of task graphs. An archive is an operator-named bucket that outlives every source workstream and accumulates additively.",
    );

  archive
    .command("create <label>")
    .description(
      "Create a new (empty) archive bucket. Labels are globally unique on this machine; populate via `mu archive add`.",
    )
    .option("--description <text>", "optional one-liner describing what the archive is for")
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as {
        description?: string;
        json?: boolean;
      };
      return handle((db) => cmdArchiveCreate(db, label, opts))();
    });

  archive
    .command("list")
    .description("List every archive on this machine, with per-source-workstream summary.")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdArchiveList(db, opts))();
    });

  archive
    .command("show <label>")
    .description(
      "Detail card for one archive: description, timestamps, total task count, per-source-workstream breakdown.",
    )
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdArchiveShow(db, label, opts))();
    });

  archive
    .command("add <label>")
    .description(
      "Snapshot a workstream's task graph (tasks + edges + notes + events) into an existing archive. Idempotent at (archive, source_workstream) granularity. With --destroy, cascades to `mu workstream destroy --yes` after the archive succeeds.",
    )
    .option(...WORKSTREAM_OPT)
    .option(
      "--destroy",
      "After a successful archive, also destroy the source workstream (kills tmux + frees workspaces + cascade-deletes DB rows).",
    )
    .option(...JSON_OPT)
    .action(function (label: string) {
      // optsWithGlobals so a top-level `-w` (e.g. `mu -w foo archive
      // add bar`) propagates here. opts() alone would only see
      // `-w` when it appears AFTER the subcommand. Mirrors
      // wireSelfCommands' adopt verb in src/cli/agents.ts.
      const opts = (this as Command).optsWithGlobals() as {
        workstream?: string;
        destroy?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdArchiveAdd(db, label, opts))();
    });

  archive
    .command("remove <label>")
    .description(
      "Surgically remove a single source workstream's contribution from an archive (rare; recovery). Other source workstreams' rows are untouched.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (label: string) {
      // optsWithGlobals: see archive add for the rationale.
      const opts = (this as Command).optsWithGlobals() as {
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdArchiveRemove(db, label, opts))();
    });

  archive
    .command("delete <label>")
    .description(
      "Delete an entire archive and every row that references it. Two-phase: bare invocation prints a dry-run summary; --yes captures a snapshot first then deletes.",
    )
    .option("-y, --yes", "actually delete (without this flag, prints a dry-run summary)")
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as { yes?: boolean; json?: boolean };
      return handle((db) => cmdArchiveDelete(db, label, opts))();
    });
}
