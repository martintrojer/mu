// mu — `mu archive` verbs (create / list / show / add / restore / remove / delete).
//
// Phase 2 of the v0.3 archive feature (workstream_archive_verb).
// Phase 1 landed the schema (v6) + SDK (src/archives.ts); this file
// is the thin commander glue that surfaces them.
//
// Archive verbs:
//
//   mu archive create <label> [--description "..."]
//   mu archive list
//   mu archive show <label>
//   mu archive add <label> -w <workstream> [--destroy]
//   mu archive restore <label> --as <new-ws> [--source <orig-ws>]
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
  type ArchiveSearchHit,
  ArchiveSourceAmbiguousError,
  type ArchiveSummary,
  type RestoreArchiveResult,
  addToArchive,
  createArchive,
  deleteArchive,
  getArchive,
  listArchives,
  removeFromArchive,
  restoreArchive,
  searchArchives,
} from "../archives.js";
import {
  UsageError,
  emitJson,
  emitJsonCollection,
  relTime,
  resolveWorkstream,
  truncate,
} from "../cli.js";
import type { Db } from "../db.js";
import { exportArchive } from "../exporting.js";
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
    emitJsonCollection(rows);
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
        ? "Restore the archived workstream under a fresh name"
        : "Destroy the source workstream now that its memory is preserved",
      command: opts.destroy
        ? `mu archive restore ${label} --as <new-workstream> --source ${workstream}`
        : `mu archive add ${label} -w ${workstream} --destroy`,
    },
    ...(opts.destroy
      ? [
          {
            intent: "Undo the destroy (DB only; tmux NOT rolled back)",
            command: "mu undo --yes",
          },
        ]
      : []),
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

// ─── restore ────────────────────────────────────────────────────────

export async function cmdArchiveRestore(
  db: Db,
  label: string,
  opts: { as?: string; source?: string; json?: boolean } = {},
): Promise<void> {
  if (!opts.as || opts.as.trim().length === 0) {
    throw new UsageError("--as <new-ws-name> is required for `mu archive restore`");
  }
  const result: RestoreArchiveResult = restoreArchive(db, label, opts.as, {
    sourceWorkstream: opts.source,
  });
  const nextSteps: NextStep[] = [
    { intent: "Inspect restored tasks", command: `mu task list -w ${result.workstreamName}` },
    { intent: "Undo (a snapshot was taken before the restore)", command: "mu undo --yes" },
  ];

  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    `Restored archive ${pc.bold(label)} source ${pc.bold(result.sourceWorkstream)} as workstream ${pc.bold(
      result.workstreamName,
    )} ${pc.dim(
      `(tasks=${result.restoredTasks}, edges=${result.restoredEdges}, notes=${result.restoredNotes})`,
    )}`,
  );
  console.log(
    pc.dim(
      "agents, workspace_path, and agent_logs are not restored (archives preserve task graph rows, not live panes or the live event log).",
    ),
  );
  printNextSteps(nextSteps);
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
          {
            intent: "Recover a source before deleting the archive",
            command: `mu archive restore ${label} --as <new-workstream> --source <workstream>`,
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
        intent: "Recover a source before deleting the archive",
        command: `mu archive restore ${label} --as <new-workstream> --source <workstream>`,
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
          intent: "Recover the deleted archive (a snapshot was taken before the delete)",
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
      intent: "Recover the deleted archive (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
  ]);
}

// ─── search ───────────────────────────────────────────────────────
//
// `mu archive search <pattern>` — LIKE-search across archived task
// titles AND archived note content. The SDK (searchArchives) does
// the heavy lifting; this is a thin formatter. Empty patterns are
// rejected at the CLI boundary with UsageError so the SDK doesn't
// have to embed CLI-flavoured error messages.

export async function cmdArchiveSearch(
  db: Db,
  pattern: string,
  opts: { label?: string; limit?: string; json?: boolean } = {},
): Promise<void> {
  if (pattern.trim().length === 0) {
    throw new UsageError("search pattern is required");
  }
  const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    throw new UsageError(`--limit must be a positive integer (got ${JSON.stringify(opts.limit)})`);
  }
  const hits: ArchiveSearchHit[] = searchArchives(db, {
    pattern,
    label: opts.label,
    limit,
  });

  if (opts.json) {
    emitJsonCollection(hits);
    return;
  }

  const nextSteps: NextStep[] = [
    {
      intent: "Inspect a specific archive by label",
      command: "mu archive show <label>",
    },
    {
      intent: "Pull raw archived rows directly",
      command:
        "mu sql \"SELECT * FROM archived_tasks t JOIN archives a ON a.id=t.archive_id WHERE LOWER(t.title) LIKE '%PATTERN%'\"",
    },
  ];

  if (hits.length === 0) {
    console.log(pc.dim("(no matches)"));
    printNextSteps(nextSteps);
    return;
  }

  // Snippet column gets the bulk of the table; archive label / id
  // are short fixed-shape values. The snippet itself is already
  // capped at ~120 chars by the SDK; truncate further to keep the
  // table readable on standard 80–120 col terminals.
  const SNIPPET_BUDGET = 60;
  const TITLE_BUDGET = 32;
  const table = muTable({
    head: ["archive", "source-ws", "id", "kind", "title", "snippet"].map((h) => pc.bold(h)),
    colWidths: [20, 20, 16, 8, TITLE_BUDGET, SNIPPET_BUDGET],
  });
  for (const h of hits) {
    table.push([
      h.archiveLabel,
      h.sourceWorkstream,
      h.originalLocalId,
      h.matchKind === "title" ? pc.cyan("title") : pc.dim("note"),
      truncate(h.title, TITLE_BUDGET - 2),
      pc.dim(truncate(h.matchSnippet, SNIPPET_BUDGET - 2)),
    ]);
  }
  console.log(table.toString());
  console.log(pc.dim(`(${hits.length} hit(s))`));
  printNextSteps(nextSteps);
}

// ─── export ───────────────────────────────────────────────────────
//
// `mu archive export <label> --out <bucket>` — render every source
// workstream in an archive to a bucket directory using the unified
// renderer in src/exporting.ts. Same disk shape as `mu workstream
// export`, just with N source-ws subdirs (one per archived source).

export async function cmdArchiveExport(
  db: Db,
  label: string,
  opts: { out?: string; json?: boolean } = {},
): Promise<void> {
  if (!opts.out || opts.out.trim().length === 0) {
    throw new UsageError("--out <dir> is required for `mu archive export`");
  }
  // exportArchive throws ArchiveNotFoundError (via listArchivedTasks)
  // before any disk I/O — classifyError maps it the same way for
  // both the JSON and prose error paths.
  const result = exportArchive(db, { label, outDir: opts.out });
  const totalTasks = Object.values(result.manifest.sources).reduce(
    (acc, s) => acc + s.tasks.length,
    0,
  );
  const nextSteps: NextStep[] = [
    { intent: "Browse the read-only human/git/docs bucket", command: `ls ${result.outDir}` },
    {
      intent: "Restore losslessly from the archive (not from this bucket)",
      command: `mu archive restore ${label} --as <new-workstream> --source <workstream>`,
    },
    {
      intent: "Re-export to refresh (additive; existing source-ws subdirs untouched)",
      command: `mu archive export ${label} --out ${result.outDir}`,
    },
    {
      intent: "Track in git",
      command: `(cd ${result.outDir} && git init && git add . && git commit -m '${label} export')`,
    },
  ];
  if (opts.json) {
    emitJson({
      archiveLabel: label,
      outDir: result.outDir,
      sourceCount: result.sourceCount,
      totalTasks,
      written: result.written,
      unchanged: result.unchanged,
      preserved: result.preserved,
      manifestPath: result.manifestPath,
      manifest: result.manifest,
      nextSteps,
    });
    return;
  }
  console.log(
    `Exported archive ${pc.bold(label)} → ${pc.bold(result.outDir)} ${pc.dim(
      `(sources=${result.sourceCount}, tasks=${totalTasks}, written=${result.written}, unchanged=${result.unchanged}, preserved=${result.preserved})`,
    )}`,
  );
  console.log(
    pc.dim(
      "This bucket is a read-only artifact for humans/git/docs; use `mu archive restore` for lossless un-archive.",
    ),
  );
  printNextSteps(nextSteps);
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
export {
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  ArchiveSourceAmbiguousError,
};

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
      return handle((db) => cmdArchiveCreate(db, label, opts), this as Command)();
    });

  archive
    .command("list")
    .description("List every archive on this machine, with per-source-workstream summary.")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdArchiveList(db, opts), this as Command)();
    });

  archive
    .command("show <label>")
    .description(
      "Detail card for one archive: description, timestamps, total task count, per-source-workstream breakdown.",
    )
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdArchiveShow(db, label, opts), this as Command)();
    });

  archive
    .command("add <label>")
    .description(
      "Snapshot a workstream's task graph (tasks + edges + notes + events) into an existing archive. Idempotent at (archive, source_workstream) granularity. With --destroy, cascades to `mu workstream destroy --yes` after the archive succeeds; reverse with `mu archive restore <label> --as <new>`.",
    )
    .option(...WORKSTREAM_OPT)
    .option(
      "--destroy",
      "After a successful archive, also destroy the source workstream (kills tmux + frees workspaces + cascade-deletes DB rows). Recover later with `mu archive restore <label> --as <new>`.",
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
      return handle((db) => cmdArchiveAdd(db, label, opts), this as Command)();
    });

  archive
    .command("restore <label>")
    .description(
      "Restore one archived source workstream into a fresh workstream directly from archived_* tables. This is the lossless un-archive path; does not restore agents, workspace_path, or agent_logs (archives do not snapshot live panes or the live event log).",
    )
    .requiredOption("--as <new-ws-name>", "fresh workstream name to create; refuses collisions")
    .option(
      "--source <orig-ws-name>",
      "required when the archive contains multiple source workstreams",
    )
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as { as?: string; source?: string; json?: boolean };
      return handle((db) => cmdArchiveRestore(db, label, opts), this as Command)();
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
      return handle((db) => cmdArchiveRemove(db, label, opts), this as Command)();
    });

  archive
    .command("search <pattern>")
    .description(
      "LIKE-search archived task titles AND archived note content across every archive (or a single one with --label). Pattern is bound as a SQL parameter; SQL-injection-safe.",
    )
    .option("--label <label>", "restrict to one archive (throws ArchiveNotFoundError on miss)")
    .option("--limit <n>", "cap on results (default 50)")
    .option(...JSON_OPT)
    .action(function (pattern: string) {
      const opts = (this as Command).opts() as {
        label?: string;
        limit?: string;
        json?: boolean;
      };
      return handle((db) => cmdArchiveSearch(db, pattern, opts), this as Command)();
    });

  archive
    .command("export <label>")
    .description(
      "Render every source workstream in an archive to a READ-ONLY bucket directory of markdown for humans/git/docs. Idempotent + additive: re-running refreshes only changed task files. For lossless un-archive, use `mu archive restore`.",
    )
    .option("--out <dir>", "output directory (the bucket); required")
    .option(...JSON_OPT)
    .action(function (label: string) {
      const opts = (this as Command).opts() as { out?: string; json?: boolean };
      return handle((db) => cmdArchiveExport(db, label, opts), this as Command)();
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
      return handle((db) => cmdArchiveDelete(db, label, opts), this as Command)();
    });
}
