// mu — `mu workstream` verbs (init / list / destroy / export).
//
// A workstream = one tmux session (`mu-<name>`) + every DB row tagged
// with that name (agents / tasks / edges / notes / workspaces / logs).
// `init` creates the session + DB row pair; `list` shows
// every workstream on the machine; `destroy` is the symmetric inverse,
// two-phase by default (dry-run; `--yes` commits); `export` renders a
// read-only markdown bucket.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { join } from "node:path";
import { addArchiveMarker } from "../archives.js";
import {
  UsageError,
  emitJson,
  emitJsonCollection,
  formatWorkstreamsTable,
  resolveWorkstream,
} from "../cli.js";
import { type Db, defaultStateDir } from "../db.js";
import { type NextStep, muTable, pc, printNextSteps } from "../output.js";
import { resolveActorIdentity } from "../tasks.js";
import {
  enableMuPaneBordersForSession,
  listWindows,
  newSession,
  newWindow,
  sessionExists,
} from "../tmux.js";
import {
  assertWorkstreamInitable,
  destroyWorkstream,
  ensureWorkstream,
  exportWorkstream,
  listEmptyWorkstreams,
  listWorkstreams,
  summarizeWorkstream,
} from "../workstream.js";

export async function cmdInit(db: Db, name: string, opts: { json?: boolean } = {}): Promise<void> {
  assertWorkstreamInitable(name);
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
    emitJsonCollection(summaries);
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

/** Default auto-export path used by `mu workstream destroy`'s
 *  pre-destroy hook. Lives under the state directory so it survives
 *  the destroy itself; the timestamp is suffixed so back-to-back
 *  destroy/recreate cycles don't clobber prior exports. */
function autoExportDir(workstream: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(defaultStateDir(), "exports", `${workstream}-${ts}`);
}

function destroyConfirmCommand(workstream: string, opts: { export?: boolean }): string {
  const parts = [`mu workstream destroy -w ${workstream} --yes`];
  if (opts.export === false) parts.push("--no-export");
  return parts.join(" ");
}

export async function cmdDestroy(
  db: Db,
  opts: {
    workstream?: string;
    yes?: boolean;
    json?: boolean;
    export?: boolean;
    empty?: boolean;
    /** Pin the workstream under this archive label BEFORE destroying it,
     *  so the ops stay recoverable by name. */
    archive?: string;
  },
): Promise<void> {
  if (opts.empty) {
    await cmdDestroyEmpty(db, opts);
    return;
  }
  const workstream = await resolveWorkstream(opts.workstream);
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
    const confirmCommand = destroyConfirmCommand(workstream, opts);
    const dryRunNextSteps: NextStep[] = [
      {
        intent: "Confirm and actually destroy",
        command: confirmCommand,
      },
    ];
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        destroyed: false,
        dryRun: true,
        summary,
        nextSteps: dryRunNextSteps,
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
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually destroy)"));
    printNextSteps(dryRunNextSteps);
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

  // --archive <label>: pin the log BEFORE the destroy. Ordering is
  // load-bearing only for tidiness — destroy writes TOMBSTONES rather
  // than erasing history, so a marker added afterwards would still
  // restore — but pinning first means the marker's hlc sits above the
  // last real op and below the tombstones, which is exactly the point
  // an operator means by "archive this, then destroy it".
  let archived: { label: string; hlc: string } | undefined;
  if (opts.archive !== undefined && opts.archive !== "") {
    const marker = addArchiveMarker(db, {
      label: opts.archive,
      workstream,
      actor: await resolveActorIdentity(),
    });
    archived = { label: marker.label, hlc: marker.hlc };
    if (!opts.json) {
      console.log(
        pc.dim(
          `archived ${workstream} under ${marker.label} (restore: mu archive restore ${marker.label} --as <new>)`,
        ),
      );
    }
  }

  const result = await destroyWorkstream(db, { workstream });
  if (opts.json) {
    emitJson({
      workstreamName: workstream,
      destroyed: true,
      ...result,
      ...(archived === undefined ? {} : { archived }),
      autoExport: autoExport
        ? { outDir: autoExportOutDir, error: autoExportError }
        : { skipped: true },
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
  console.log(
    `Destroyed ${pc.bold(workstream)}: killed tmux=${result.killedTmux}, agents=${result.deletedAgents}, tasks=${result.deletedTasks}, edges=${result.deletedEdges}, notes=${result.deletedNotes}, workspaces=${result.freedWorkspaces}/${summary.workspaceCount}${result.alreadyGoneWorkspaces > 0 ? ` (${result.alreadyGoneWorkspaces} already gone on disk)` : ""}`,
  );
  if (autoExportOutDir !== undefined) {
    console.log(pc.dim(`Pre-destroy export: ${autoExportOutDir}`));
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
// user-meaningful state (zero tasks, agents, vcs_workspaces).
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
    archive?: string;
    workstream?: string;
    yes?: boolean;
    json?: boolean;
  },
): Promise<void> {
  // --empty is a sweep verb; -w (target a single workstream)
  // contradicts it. Fail loud with exit 2 (UsageError) so a typo
  // (`--empty -w foo`) doesn't silently sweep instead of targeting
  // `foo`.
  if (opts.workstream !== undefined) {
    throw new UsageError(
      "--empty is mutually exclusive with a named target (positional <name> or -w/--workstream): the sweep targets every empty workstream, so naming one contradicts it",
    );
  }
  // An archive LABEL pins one workstream at one point. --empty sweeps
  // every empty workstream, so a single label cannot describe the result —
  // and empty workstreams have nothing to archive anyway.
  if (opts.archive !== undefined && opts.archive !== "") {
    throw new UsageError(
      "--empty is mutually exclusive with --archive: the sweep covers every empty workstream, so one archive label cannot describe it (and an empty workstream has nothing to pin). Archive named workstreams individually: mu archive add <label> -w <ws>",
    );
  }
  const empties = await listEmptyWorkstreams(db);

  if (!opts.yes) {
    if (opts.json) {
      emitJsonCollection(empties);
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
    printNextSteps([
      {
        intent: "Confirm and actually destroy every empty workstream",
        command: "mu workstream destroy --empty --yes",
      },
    ]);
    return;
  }

  // --yes path. No-op early if there's nothing to do.
  if (empties.length === 0) {
    if (opts.json) {
      emitJson({ destroyed: 0, results: [], failed: [] });
      return;
    }
    console.log(pc.dim("no empty workstreams found; nothing to destroy"));
    return;
  }

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

/** Fold an optional positional workstream name into the opts bag.
 *
 *  dogfood-destroy-w-flag: `workstream init` takes its target
 *  POSITIONALLY while `destroy` / `export` only took `-w`, so
 *  `mu workstream destroy v2 --yes` printed help ("too many
 *  arguments") instead of destroying. The positional is now an
 *  additive ALIAS for -w on both verbs; -w keeps working unchanged.
 *  Supplying both is a usage error rather than a silent pick-one.
 *
 *  Codifies the CLI's flag-vs-positional rule: the primary entity a
 *  verb acts on is positional; everything else is a flag. See
 *  docs/VOCABULARY.md § Naming conventions. */
export function withPositionalWorkstream<T extends { workstream?: string }>(
  opts: T,
  name: string | undefined,
): T {
  if (name === undefined) return opts;
  if (opts.workstream !== undefined && opts.workstream !== name) {
    throw new UsageError(
      `workstream given twice and they disagree: positional ${JSON.stringify(name)} vs -w ${JSON.stringify(opts.workstream)}; pass it once`,
    );
  }
  return { ...opts, workstream: name };
}

export function wireWorkstreamCommands(program: Command): void {
  const workstream = program.command("workstream").description("Workstream-level commands");

  workstream
    .command("init <name>")
    .description("Create the workstream's tmux session and register it in the DB")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdInit(db, name, opts), this as Command)();
    });

  workstream
    .command("list")
    .description("List every workstream on this machine (DB rows + mu-* tmux sessions)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdWorkstreamList(db, opts), this as Command)();
    });

  workstream
    .command("destroy [name]")
    .description(
      "Tear down a workstream: kill its tmux session and cascade-delete every DB row tagged with its name. The target may be given positionally (matching `workstream init <name>`) or via -w. Pass --yes to actually destroy; otherwise prints a dry-run summary. With --empty, sweeps every empty workstream (zero tasks/agents/workspaces) in one call.",
    )
    .option(...WORKSTREAM_OPT)
    .option("-y, --yes", "actually destroy (without this flag, prints a dry-run summary)")
    .option("--no-export", "skip the pre-destroy markdown export to <state-dir>/exports/<ws>-<ts>/")
    .option(
      "--empty",
      "sweep every empty workstream (zero tasks, agents, vcs_workspaces); mutually exclusive with -w",
    )
    .option(
      "--archive <label>",
      "pin this workstream under an archive label before destroying, so it can be restored by name later",
    )
    .option(...JSON_OPT)
    .action(function (name: string | undefined) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        yes?: boolean;
        json?: boolean;
        export?: boolean;
        empty?: boolean;
        archive?: string;
      };
      return handle(
        (db) => cmdDestroy(db, withPositionalWorkstream(opts, name)),
        this as Command,
      )();
    });

  workstream
    .command("export [name]")
    .description(
      "Render a workstream's task graph + notes to a bucket directory of markdown. The source workstream may be given positionally (matching `workstream init <name>`) or via -w. Bucket layout: <out>/README.md + INDEX.md + manifest.json (bucketVersion 2) + <ws>/{README.md,INDEX.md,tasks/<id>.md}. Idempotent + additive: re-export refreshes only changed task files; passing -w with a different workstream into the same --out appends a sibling source-ws subdir; deleted tasks are preserved with a banner. Pre-0.3 export dirs are not migrated in place.",
    )
    .option(...WORKSTREAM_OPT)
    .option("--out <dir>", "output directory (the bucket; defaults to ./<workstream>/)")
    .option(...JSON_OPT)
    .action(function (name: string | undefined) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        out?: string;
        json?: boolean;
      };
      return handle(
        (db) => cmdWorkstreamExport(db, withPositionalWorkstream(opts, name)),
        this as Command,
      )();
    });
}
