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
import {
  UsageError,
  emitJson,
  formatWorkstreamsTable,
  parseCsvFlag,
  resolveWorkstream,
} from "../cli.js";
import { type Db, defaultStateDir } from "../db.js";
import { type ImportBucketResult, importBucket } from "../importing.js";
import { type NextStep, muTable, pc, printNextSteps } from "../output.js";
import { captureSnapshot } from "../snapshots.js";
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
  listEmptyWorkstreams,
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
  opts: {
    workstream?: string;
    dryRun?: boolean;
    json?: boolean;
    sourceWs?: string[];
  },
): Promise<void> {
  // Canonicalise --source-ws via parseCsvFlag (repeat OR comma-separate
  // OR both, per cli_audit_plurality_uniformity). Distinguish "flag
  // not passed" (undefined) from "passed but every entry is empty"
  // (e.g. --source-ws ',,'): the latter is a UsageError so a typo
  // doesn't silently fall back to importing the entire bucket.
  let sourceWs: string[] | undefined;
  if (opts.sourceWs !== undefined) {
    const canonical = parseCsvFlag(opts.sourceWs);
    if (canonical.length === 0) {
      throw new UsageError(
        "--source-ws was passed but resolved to zero names (empty strings / commas only); pass at least one source-ws name or drop the flag",
      );
    }
    sourceWs = canonical;
  }
  const result: ImportBucketResult = importBucket(db, {
    bucketDir,
    workstreamOverride: opts.workstream,
    sourceWs,
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
    const sourceWsFlag =
      sourceWs !== undefined && sourceWs.length > 0 ? ` --source-ws ${sourceWs.join(",")}` : "";
    nextSteps.push({
      intent: "Run the import for real",
      command: `mu workstream import ${bucketDir}${opts.workstream ? ` --workstream ${opts.workstream}` : ""}${sourceWsFlag}`,
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
    empty?: boolean;
  },
): Promise<void> {
  if (opts.empty) {
    await cmdDestroyEmpty(db, opts);
    return;
  }
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

// ─── cmdDestroyEmpty ─────────────────────────────────────────────────
//
// `mu workstream destroy --empty` sweeps every workstream with no
// user-meaningful state (zero tasks, agents, vcs_workspaces, approvals).
// One snapshot covers the whole sweep; per-workstream destroy errors
// are accumulated into a `failed` array so a single bad pane doesn't
// abort the rest of the cleanup. See workstream_destroy_empty_sweep.

interface EmptyDestroyResult {
  workstreamName: string;
  killedTmux: boolean;
  deletedAgents: number;
  deletedTasks: number;
  deletedNotes: number;
  deletedEdges: number;
  freedWorkspaces: number;
  alreadyGoneWorkspaces: number;
}

interface EmptyDestroyFailure {
  workstreamName: string;
  error: string;
}

/** Read created_at for a registered workstream. Returns the empty
 *  string for tmux-only rows that listEmptyWorkstreams won't surface
 *  anyway (the predicate requires a workstreams row), keeping the
 *  signature total. */
function workstreamCreatedAt(db: Db, name: string): string {
  const row = db.prepare("SELECT created_at FROM workstreams WHERE name = ?").get(name) as
    | { created_at: string }
    | undefined;
  return row?.created_at ?? "";
}

async function cmdDestroyEmpty(
  db: Db,
  opts: {
    workstream?: string;
    yes?: boolean;
    json?: boolean;
    archive?: string;
  },
): Promise<void> {
  // --empty is a sweep verb; -w (target a single workstream) and
  // --archive (snapshot one workstream INTO an archive) both contradict
  // it. Fail loud with exit 2 (UsageError) so a typo (`--empty -w foo`)
  // doesn't silently sweep instead of targeting `foo`.
  if (opts.workstream !== undefined) {
    throw new UsageError(
      "--empty is mutually exclusive with -w/--workstream (the sweep targets every empty workstream; -w would contradict that)",
    );
  }
  if (opts.archive !== undefined) {
    throw new UsageError(
      "--empty is mutually exclusive with --archive (an empty workstream has nothing to archive; if you wanted to archive a single workstream's contents, drop --empty and use -w <name> --archive <label>)",
    );
  }

  const empties = await listEmptyWorkstreams(db);

  if (!opts.yes) {
    if (opts.json) {
      emitJson(empties);
      return;
    }
    if (empties.length === 0) {
      console.log(pc.dim("no empty workstreams found"));
      return;
    }
    const table = muTable({
      head: ["workstream", "created_at", "tmux"].map((h) => pc.bold(h)),
      colWidths: [40, null, null],
    });
    for (const ws of empties) {
      const createdAt = workstreamCreatedAt(db, ws.name);
      // Tmux-only entries have no DB row and so no created_at;
      // render an em-dash placeholder so the column never goes
      // visually empty (matches the tmux column's idiom below).
      const createdCell = createdAt === "" ? pc.dim("\u2014") : pc.dim(createdAt);
      table.push([ws.name, createdCell, ws.tmuxAlive ? pc.green("alive") : pc.dim("\u2014")]);
    }
    console.log(table.toString());
    console.log("");
    console.log(
      pc.dim(
        `${empties.length} empty workstream${empties.length === 1 ? "" : "s"} would be destroyed (dry-run; rerun with --yes to actually destroy).`,
      ),
    );
    console.log(
      pc.dim(
        "A single whole-DB snapshot covers the whole sweep; `mu undo --yes` reverts it (DB only \u2014 tmux NOT rolled back).",
      ),
    );
    printNextSteps([
      {
        intent: "Confirm and actually destroy every empty workstream",
        command: "mu workstream destroy --empty --yes",
      },
    ]);
    return;
  }

  // --yes path. No-op early if there's nothing to do; do NOT take a
  // snapshot for a zero-row sweep (would clutter the snapshot log
  // with empty entries on every CI cleanup).
  if (empties.length === 0) {
    if (opts.json) {
      emitJson({ destroyed: 0, results: [], failed: [] });
      return;
    }
    console.log(pc.dim("no empty workstreams found; nothing to destroy"));
    return;
  }

  // ONE snapshot covers the whole sweep. Per-call destroyWorkstream
  // would otherwise capture N snapshots (one per workstream), which is
  // both noisier and N× more disk for an operation the operator
  // logically thinks of as a single batch.
  captureSnapshot(
    db,
    `workstream destroy --empty sweep (${empties.length} workstream${empties.length === 1 ? "" : "s"})`,
    null,
  );

  const results: EmptyDestroyResult[] = [];
  const failed: EmptyDestroyFailure[] = [];
  for (const ws of empties) {
    try {
      const result = await destroyWorkstream(db, { workstream: ws.name });
      results.push({
        workstreamName: ws.name,
        killedTmux: result.killedTmux,
        deletedAgents: result.deletedAgents,
        deletedTasks: result.deletedTasks,
        deletedNotes: result.deletedNotes,
        deletedEdges: result.deletedEdges,
        freedWorkspaces: result.freedWorkspaces,
        alreadyGoneWorkspaces: result.alreadyGoneWorkspaces,
      });
    } catch (err) {
      // Best-effort sweep: log the failure and keep going. The snapshot
      // captured above is the recovery anchor for the whole batch, so
      // even a half-completed sweep is undoable.
      failed.push({
        workstreamName: ws.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.json) {
    emitJson({ destroyed: results.length, results, failed });
    return;
  }
  for (const r of results) {
    console.log(
      `Destroyed ${pc.bold(r.workstreamName)} ${pc.dim(
        `(killedTmux=${r.killedTmux}, agents=${r.deletedAgents}, tasks=${r.deletedTasks}, notes=${r.deletedNotes}, edges=${r.deletedEdges})`,
      )}`,
    );
  }
  if (failed.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `WARNING: ${failed.length} workstream${failed.length === 1 ? "" : "s"} could not be destroyed cleanly:`,
      ),
    );
    for (const f of failed) {
      console.log(`  - ${f.workstreamName}: ${f.error}`);
    }
  }
  console.log("");
  console.log(pc.dim(`Sweep complete: destroyed=${results.length}, failed=${failed.length}.`));
  if (failed.length === 0) {
    printNextSteps([
      {
        intent: "Undo (a snapshot was taken before the sweep; DB only, tmux not rolled back)",
        command: "mu undo --yes",
      },
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
      "Tear down a workstream: kill its tmux session and cascade-delete every DB row tagged with its name. Pass --yes to actually destroy; otherwise prints a dry-run summary. With --empty, sweeps every empty workstream (zero tasks/agents/workspaces/approvals) in one call.",
    )
    .option(...WORKSTREAM_OPT)
    .option("-y, --yes", "actually destroy (without this flag, prints a dry-run summary)")
    .option("--no-export", "skip the pre-destroy markdown export to <state-dir>/exports/<ws>-<ts>/")
    .option(
      "--archive <label>",
      "in-DB archive label to add this workstream's contents to BEFORE destroy (atomic; if archive add fails, destroy aborts)",
    )
    .option(
      "--empty",
      "sweep every empty workstream (zero tasks, agents, vcs_workspaces, approvals); mutually exclusive with -w and --archive",
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        yes?: boolean;
        json?: boolean;
        export?: boolean;
        archive?: string;
        empty?: boolean;
      };
      return handle((db) => cmdDestroy(db, opts))();
    });

  workstream
    .command("import <bucket-dir>")
    .description(
      "Rebuild a workstream (or a multi-source bucket of workstreams) from a v0.3 markdown export. Accepts EITHER a bucket directory (top-level manifest.json + per-source-ws subdirs) OR a single per-source-ws subdir (auto-detected via README.md + INDEX.md + tasks/, validated against the parent bucket's manifest). Per source-ws transactional: each source-ws is imported in its own SQLite transaction; siblings are unaffected by a sibling's failure. Refuses to merge silently into an existing workstream — pass --workstream <name> (single-source after any --source-ws filter only) or destroy the existing one first.",
    )
    .option(
      "--workstream <name>",
      "override the imported workstream's name (single-source after any --source-ws filter only)",
    )
    .option(
      "--source-ws <names...>",
      "restrict the import to a subset of source-ws subdirs (repeat or comma-separate; or both)",
    )
    .option("--dry-run", "walk + parse + validate; report what WOULD be created; no DB writes")
    .option(...JSON_OPT)
    .action(function (bucketDir: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        dryRun?: boolean;
        json?: boolean;
        sourceWs?: string[];
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
