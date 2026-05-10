// mu — `mu workstream` verbs (init / list / destroy).
//
// A workstream = one tmux session (`mu-<name>`) + every DB row tagged
// with that name (agents / tasks / edges / notes / workspaces / logs /
// approvals). `init` creates the session + DB row pair; `list` shows
// every workstream on the machine; `destroy` is the symmetric inverse,
// two-phase by default (dry-run; `--yes` commits).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { join } from "node:path";
import { type AddToArchiveResult, addToArchive, getArchive } from "../archives.js";
import { emitJson, formatWorkstreamsTable, resolveWorkstream } from "../cli.js";
import { type Db, defaultStateDir } from "../db.js";
import { type ImportBucketResult, importBucket } from "../importing.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import {
  enableMuPaneBordersForSession,
  listWindows,
  newSession,
  newWindow,
  sessionExists,
} from "../tmux.js";
import {
  destroyWorkstream,
  ensureWorkstream,
  exportWorkstream,
  listWorkstreams,
  summarizeWorkstream,
} from "../workstream.js";

export async function cmdInit(db: Db, name: string, opts: { json?: boolean } = {}): Promise<void> {
  const sessionName = `mu-${name}`;
  const dbCreated = ensureWorkstream(db, name);
  const tmuxAlready = await sessionExists(sessionName);
  let muWindowRepaired = false;
  if (!tmuxAlready) {
    await newSession(sessionName, { detached: true, windowName: "_mu" });
  } else {
    // Session already exists — check whether the placeholder `_mu`
    // window is still there. Common reason for it being missing:
    // operator killed it manually after spawning the first agent.
    // Without it, tmux a -t mu-<ws> lands on the most recent agent's
    // pane, which surprises the operator who expects an empty
    // orchestration shell. Recreate idempotently.
    // (review_bug_workstream_init_does_not_repair_missing_mu_window)
    const windows = await listWindows(sessionName).catch(() => []);
    const hasMuWindow = windows.some((w) => w.name === "_mu");
    if (!hasMuWindow) {
      await newWindow({
        session: sessionName,
        name: "_mu",
        command: process.env.SHELL ?? "/bin/sh",
        detached: true,
      });
      muWindowRepaired = true;
    }
  }
  // Always (re)apply the pane-border-status options so re-init or
  // upgrade-from-pre-banner-mu sessions both pick up the cue. tmux
  // set-option is idempotent. enableMuPaneBordersForSession self-checks
  // MU_BANNER_QUIET=1 (covers this and the spawn-time decoration; see
  // spawnAgent). Older tmux without pane-border-status support is benign
  // here: the cue is a nice-to-have, not load-bearing. Don't fail init.
  await enableMuPaneBordersForSession(sessionName).catch(() => {});
  const created = !tmuxAlready || dbCreated;
  const nextSteps: NextStep[] = [
    { intent: "Attach the tmux session", command: `tmux a -t ${sessionName}` },
    {
      intent: "Plan tasks",
      command: `mu task add -w ${name} --title "..." --impact 50 --effort-days 1`,
    },
    { intent: "Spawn an agent", command: `mu agent spawn <name> -w ${name}` },
    { intent: "See state", command: `mu state -w ${name}` },
  ];
  if (opts.json) {
    emitJson({
      workstreamName: name,
      sessionName,
      created,
      tmuxSessionAlreadyExisted: tmuxAlready,
      dbRowAlreadyExisted: !dbCreated,
      muWindowRepaired,
      nextSteps,
    });
    return;
  }
  if (tmuxAlready && !dbCreated) {
    const repaired = muWindowRepaired ? ` — ${pc.yellow("repaired missing _mu window")}` : "";
    console.log(
      pc.dim(
        `workstream "${name}" already exists (tmux session ${sessionName}, DB row registered)${repaired}`,
      ),
    );
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Created workstream ${pc.bold(name)} (tmux session ${pc.bold(sessionName)})`);
  printNextSteps(nextSteps);
}

export async function cmdWorkstreamList(db: Db, opts: { json?: boolean } = {}): Promise<void> {
  const summaries = await listWorkstreams(db);
  if (opts.json) {
    emitJson(summaries);
    return;
  }
  if (summaries.length === 0) {
    console.log(pc.dim("no workstreams found (no DB rows, no mu-* tmux sessions)"));
    return;
  }
  console.log(formatWorkstreamsTable(summaries));
}

export async function cmdWorkstreamExport(
  db: Db,
  opts: { workstream?: string; out?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const result = exportWorkstream(db, { workstream, outDir: opts.out });
  const nextSteps: NextStep[] = [
    { intent: "Browse the bucket", command: `ls ${result.outDir}` },
    {
      intent: "Append another workstream to the same bucket (additive)",
      command: `mu workstream export -w <other-ws> --out ${result.outDir}`,
    },
    {
      intent: "Track in git",
      command: `(cd ${result.outDir} && git init && git add . && git commit -m '${workstream} export')`,
    },
  ];
  if (opts.json) {
    emitJson({
      workstreamName: workstream,
      outDir: result.outDir,
      bucketLayoutVersion: result.manifest.bucketVersion,
      written: result.written,
      unchanged: result.unchanged,
      preserved: result.preserved,
      manifestPath: result.manifestPath,
      tasks: result.source.tasks,
      sourceCount: Object.keys(result.manifest.sources).length,
      nextSteps,
    });
    return;
  }
  console.log(
    `Exported ${pc.bold(workstream)} → ${pc.bold(result.outDir)} ${pc.dim(
      `(written=${result.written}, unchanged=${result.unchanged}, preserved=${result.preserved}; bucket sources=${Object.keys(result.manifest.sources).length})`,
    )}`,
  );
  printNextSteps(nextSteps);
}

export async function cmdWorkstreamImport(
  db: Db,
  bucketDir: string,
  opts: { workstream?: string; dryRun?: boolean; json?: boolean },
): Promise<void> {
  const result: ImportBucketResult = importBucket(db, {
    bucketDir,
    workstreamOverride: opts.workstream,
    dryRun: opts.dryRun,
  });
  const totalTasks = result.sources.reduce((acc, s) => acc + s.tasksImported, 0);
  const totalEdges = result.sources.reduce((acc, s) => acc + s.edgesImported, 0);
  const totalNotes = result.sources.reduce((acc, s) => acc + s.notesImported, 0);
  const totalTombstones = result.sources.reduce((acc, s) => acc + s.tombstonesSkipped, 0);
  const importedNames = result.sources.map((s) => s.workstreamName);
  const nextSteps: NextStep[] = [];
  if (!opts.dryRun) {
    for (const name of importedNames) {
      nextSteps.push({
        intent: `Inspect ${name}`,
        command: `mu task tree -w ${name}`,
      });
    }
    nextSteps.push({
      intent: "Re-export to verify the round trip is byte-stable",
      command: `mu workstream export -w ${importedNames[0] ?? "<ws>"} --out <new-dir>`,
    });
  } else {
    nextSteps.push({
      intent: "Run the import for real",
      command: `mu workstream import ${bucketDir}${opts.workstream ? ` --workstream ${opts.workstream}` : ""}`,
    });
  }
  if (opts.json) {
    emitJson({
      ...result,
      bucketDir,
      dryRun: opts.dryRun === true,
      totals: {
        tasks: totalTasks,
        edges: totalEdges,
        notes: totalNotes,
        tombstones: totalTombstones,
      },
      nextSteps,
    });
    return;
  }
  const verb = opts.dryRun ? "Would import" : "Imported";
  console.log(
    `${verb} ${pc.bold(String(result.sources.length))} source-ws from ${pc.bold(bucketDir)} ${pc.dim(
      `(bucketVersion=${result.bucketVersion}${result.bucketLabel ? `, label=${result.bucketLabel}` : ""}; tasks=${totalTasks}, edges=${totalEdges}, notes=${totalNotes}, tombstones_skipped=${totalTombstones})`,
    )}`,
  );
  for (const s of result.sources) {
    console.log(
      `  ${pc.bold(s.workstreamName)}: tasks=${s.tasksImported}, edges=${s.edgesImported}, notes=${s.notesImported}, tombstones=${s.tombstonesSkipped}`,
    );
  }
  printNextSteps(nextSteps);
}

/** Default auto-export path used by `mu workstream destroy`'s
 *  pre-destroy hook. Lives under the state directory so it survives
 *  the destroy itself; the timestamp is suffixed so back-to-back
 *  destroy/recreate cycles don't clobber prior exports. */
function autoExportDir(workstream: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(defaultStateDir(), "exports", `${workstream}-${ts}`);
}

export async function cmdDestroy(
  db: Db,
  opts: {
    workstream?: string;
    yes?: boolean;
    json?: boolean;
    export?: boolean;
    archive?: string;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Validate --archive label FIRST so an unknown label refuses the
  // destroy entirely (anti-feature: no auto-create — operators run
  // `mu archive create <label>` themselves). getArchive throws
  // ArchiveNotFoundError on miss; classifyError maps that to exit 3.
  if (opts.archive !== undefined) {
    getArchive(db, opts.archive);
  }
  const summary = await summarizeWorkstream(db, { workstream });
  // Empty-but-registered workstreams (a row in `workstreams` with no
  // agents/tasks/etc.) ARE worth destroying — otherwise the bare
  // registry row is orphaned forever. nothingToDo is the strict
  // intersection: nothing on disk, in tmux, OR in the DB.
  const nothingToDo =
    !summary.tmuxAlive &&
    !summary.registered &&
    summary.agentCount === 0 &&
    summary.taskCount === 0 &&
    summary.noteCount === 0 &&
    summary.workspaceCount === 0;

  if (nothingToDo) {
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        destroyed: false,
        reason: "nothing to destroy",
        summary,
      });
      return;
    }
    console.log(
      pc.dim(`workstream "${workstream}" has no tmux session and no DB rows; nothing to destroy`),
    );
    return;
  }

  if (!opts.yes) {
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        destroyed: false,
        dryRun: true,
        summary,
        archive:
          opts.archive !== undefined
            ? { label: opts.archive, wouldArchiveTasks: summary.taskCount }
            : undefined,
        nextSteps: [
          {
            intent: "Confirm and actually destroy",
            command: `mu workstream destroy -w ${workstream} --yes${opts.archive !== undefined ? ` --archive ${opts.archive}` : ""}`,
          },
          {
            intent: "After destroying, undo if you regret it (DB only; tmux NOT rolled back)",
            command: "mu undo --yes",
          },
        ],
      });
      return;
    }
    console.log(pc.bold(`Workstream ${workstream} (tmux session ${summary.tmuxSession})`));
    console.log(
      `  tmux session : ${summary.tmuxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
    );
    console.log(`  agents       : ${summary.agentCount}`);
    console.log(
      `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount})`,
    );
    console.log(
      `  workspaces   : ${summary.workspaceCount}${summary.workspaceCount > 0 ? pc.dim(" (will be cleaned via per-backend remove)") : ""}`,
    );
    if (opts.archive !== undefined) {
      console.log(
        `  archive      : ${pc.yellow(`would archive ${summary.taskCount} tasks to ${opts.archive}`)}`,
      );
    }
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually destroy)"));
    console.log(
      pc.dim(
        "A snapshot will be taken before the destroy; `mu undo --yes` reverts it (DB only — tmux panes / on-disk workspace dirs are NOT rolled back).",
      ),
    );
    printNextSteps([
      {
        intent: "Confirm and actually destroy",
        command: `mu workstream destroy -w ${workstream} --yes`,
      },
      {
        intent: "After destroying, undo if you regret it",
        command: "mu undo --yes",
      },
    ]);
    return;
  }

  // Auto-export to the state dir BEFORE killing tmux / dropping rows.
  // Opt-out via --no-export. Per the originating design note: a failed
  // export must NOT block the destroy (warn + proceed) — operators
  // running destroy in a CI cleanup script should not be silently
  // gated by a transient disk error in an artifact dir.
  const autoExport = opts.export !== false;
  let autoExportOutDir: string | undefined;
  let autoExportError: string | undefined;
  if (autoExport) {
    const dir = autoExportDir(workstream);
    try {
      const exp = exportWorkstream(db, { workstream, outDir: dir });
      autoExportOutDir = exp.outDir;
    } catch (err) {
      autoExportError = err instanceof Error ? err.message : String(err);
      if (!opts.json) {
        console.log(
          pc.yellow(
            `WARNING: auto-export to ${dir} failed: ${autoExportError}; proceeding with destroy anyway`,
          ),
        );
      }
    }
  }

  // Archive BEFORE destroy: if the archive add fails, abort. We
  // already validated the label up top so the only reasons for a
  // throw here are transient (DB lock / disk error) — surface them
  // and leave the workstream untouched. No rollback needed (we
  // haven't destroyed yet).
  let archiveResult: AddToArchiveResult | undefined;
  if (opts.archive !== undefined) {
    archiveResult = addToArchive(db, opts.archive, workstream);
  }

  const result = await destroyWorkstream(db, { workstream });
  if (opts.json) {
    emitJson({
      workstreamName: workstream,
      destroyed: true,
      ...result,
      archive:
        opts.archive !== undefined && archiveResult !== undefined
          ? { label: opts.archive, ...archiveResult }
          : undefined,
      autoExport: autoExport
        ? { outDir: autoExportOutDir, error: autoExportError }
        : { skipped: true },
      // snap_destroy_safety: machine-readable hint that the destroy is
      // reversible (DB-only) via mu undo. Suppressed when there are
      // workspace failures so the cleanup steps stay the headline.
      nextSteps:
        result.failedWorkspaces.length === 0
          ? [
              {
                intent:
                  "Undo (a snapshot was taken before the destroy; DB only, tmux not rolled back)",
                command: "mu undo --yes",
              },
            ]
          : undefined,
    });
    return;
  }
  console.log(pc.bold(`Workstream ${workstream} (tmux session ${summary.tmuxSession})`));
  console.log(
    `  tmux session : ${summary.tmuxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
  );
  console.log(`  agents       : ${summary.agentCount}`);
  console.log(
    `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount})`,
  );
  console.log(`  workspaces   : ${summary.workspaceCount}`);
  console.log("");
  if (archiveResult !== undefined && opts.archive !== undefined) {
    console.log(
      `Archived ${pc.bold(workstream)} to ${pc.bold(opts.archive)} ${pc.dim(
        `(tasks=${archiveResult.addedTasks}, edges=${archiveResult.addedEdges}, notes=${archiveResult.addedNotes}, events=${archiveResult.addedEvents}, skipped_existing=${archiveResult.skippedTasks})`,
      )}`,
    );
  }
  console.log(
    `Destroyed ${pc.bold(workstream)}: killed tmux=${result.killedTmux}, agents=${result.deletedAgents}, tasks=${result.deletedTasks}, edges=${result.deletedEdges}, notes=${result.deletedNotes}, workspaces=${result.freedWorkspaces}/${summary.workspaceCount}${result.alreadyGoneWorkspaces > 0 ? ` (${result.alreadyGoneWorkspaces} already gone on disk)` : ""}`,
  );
  if (autoExportOutDir !== undefined) {
    console.log(pc.dim(`Pre-destroy export: ${autoExportOutDir}`));
  }
  // snap_destroy_safety: advertise the undo path that destroyWorkstream
  // gave us via captureSnapshot. Suppressed when there are workspace
  // failures so the WARNING + cleanup steps below stay the headline.
  if (result.failedWorkspaces.length === 0) {
    printNextSteps([
      {
        intent: "Undo (a snapshot was taken before the destroy; DB only, tmux not rolled back)",
        command: "mu undo --yes",
      },
    ]);
  }
  if (result.failedWorkspaces.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `WARNING: ${result.failedWorkspaces.length} workspace(s) could not be freed cleanly. The DB rows are gone (FK cascade); the on-disk paths remain and need manual cleanup:`,
      ),
    );
    for (const f of result.failedWorkspaces) {
      console.log(`  - ${f.agent} (${f.backend}): ${f.path}`);
      console.log(`    error: ${f.error}`);
    }
    printNextSteps([
      {
        intent: "For each git worktree above, run",
        command: "git worktree remove --force <path>",
      },
      { intent: "For each jj workspace above, run", command: "jj workspace forget <name>" },
      { intent: "As a last resort", command: "rm -rf <path>" },
    ]);
  }
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireWorkstreamCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle } from "../cli.js";

export function wireWorkstreamCommands(program: Command): void {
  const workstream = program.command("workstream").description("Workstream-level commands");

  workstream
    .command("init <name>")
    .description("Create the workstream's tmux session and register it in the DB")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdInit(db, name, opts))();
    });

  workstream
    .command("list")
    .description("List every workstream on this machine (DB rows + mu-* tmux sessions)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdWorkstreamList(db, opts))();
    });

  workstream
    .command("destroy")
    .description(
      "Tear down a workstream: kill its tmux session and cascade-delete every DB row tagged with its name. Pass --yes to actually destroy; otherwise prints a dry-run summary.",
    )
    .option(...WORKSTREAM_OPT)
    .option("-y, --yes", "actually destroy (without this flag, prints a dry-run summary)")
    .option("--no-export", "skip the pre-destroy markdown export to <state-dir>/exports/<ws>-<ts>/")
    .option(
      "--archive <label>",
      "in-DB archive label to add this workstream's contents to BEFORE destroy (atomic; if archive add fails, destroy aborts)",
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        yes?: boolean;
        json?: boolean;
        export?: boolean;
        archive?: string;
      };
      return handle((db) => cmdDestroy(db, opts))();
    });

  workstream
    .command("import <bucket-dir>")
    .description(
      "Rebuild a workstream (or a multi-source bucket of workstreams) from a v0.3 markdown export. Per source-ws transactional: each source-ws is imported in its own SQLite transaction; siblings are unaffected by a sibling's failure. Refuses to merge silently into an existing workstream — pass --workstream <name> (single-source buckets only) or destroy the existing one first.",
    )
    .option(
      "--workstream <name>",
      "override the imported workstream's name (single-source buckets only)",
    )
    .option("--dry-run", "walk + parse + validate; report what WOULD be created; no DB writes")
    .option(...JSON_OPT)
    .action(function (bucketDir: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        dryRun?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdWorkstreamImport(db, bucketDir, opts))();
    });

  workstream
    .command("export")
    .description(
      "Render a workstream's task graph + notes to a bucket directory of markdown. Bucket layout: <out>/README.md + INDEX.md + manifest.json (bucketVersion 2) + <ws>/{README.md,INDEX.md,tasks/<id>.md}. Idempotent + additive: re-export refreshes only changed task files; passing -w with a different workstream into the same --out appends a sibling source-ws subdir; deleted tasks are preserved with a banner. Pre-0.3 export dirs are not migrated in place.",
    )
    .option(...WORKSTREAM_OPT)
    .option("--out <dir>", "output directory (the bucket; defaults to ./<workstream>/)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        out?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkstreamExport(db, opts))();
    });
}
