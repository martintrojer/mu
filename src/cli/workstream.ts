// mu — `mu workstream` verbs (init / list / teardown).
//
// A workstream = one mux session (`mu-<name>`) + every DB row tagged
// with that name (agents / tasks / edges / notes / workspaces / logs).
// `init` creates the session + DB row pair; `list` shows
// every workstream on the machine; `teardown` is the symmetric inverse,
// two-phase by default (dry-run; `--yes` commits).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  emitJson,
  emitJsonCollection,
  formatWorkstreamsTable,
  resolveWorkstream,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import { activeMux } from "../mux.js";
import { muTable, type NextStep, pc, printNextSteps } from "../output.js";
import {
  assertWorkstreamInitable,
  ensureWorkstream,
  listEmptyWorkstreams,
  listWorkstreams,
  summarizeWorkstream,
  teardownWorkstream,
} from "../workstream.js";

export async function cmdInit(db: Db, name: string, opts: { json?: boolean } = {}): Promise<void> {
  assertWorkstreamInitable(name);
  const sessionName = `mu-${name}`;
  const dbCreated = ensureWorkstream(db, name);
  // Load-bearing: `workstream init` IS session creation.
  const mux = await activeMux();
  const sessionAlready = await mux.sessionExists(sessionName);
  let muWindowRepaired = false;
  if (!sessionAlready) {
    await mux.newSession(sessionName, { detached: true, windowName: "_mu" });
  } else {
    // Session already exists — check whether the placeholder `_mu`
    // window is still there. Common reason for it being missing:
    // operator killed it manually after spawning the first agent.
    // Without it, tmux a -t mu-<ws> lands on the most recent agent's
    // pane, which surprises the operator who expects an empty
    // orchestration shell. Recreate idempotently.
    // (review_bug_workstream_init_does_not_repair_missing_mu_window)
    const windows = await mux.listWindows(sessionName).catch(() => []);
    const hasMuWindow = windows.some((w) => w.name === "_mu");
    if (!hasMuWindow) {
      await mux.newWindow({
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
  await mux.enableMuPaneBordersForSession(sessionName).catch(() => {});
  const created = !sessionAlready || dbCreated;
  const nextSteps: NextStep[] = [
    { intent: "Attach the session", command: mux.attachHint({ session: sessionName }) },
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
      muxSession: sessionName,
      created,
      muxSessionAlreadyExisted: sessionAlready,
      dbRowAlreadyExisted: !dbCreated,
      muWindowRepaired,
      nextSteps,
    });
    return;
  }
  if (sessionAlready && !dbCreated) {
    const repaired = muWindowRepaired ? ` — ${pc.yellow("repaired missing _mu window")}` : "";
    console.log(
      pc.dim(
        `workstream "${name}" already exists (mux session ${sessionName}, DB row registered)${repaired}`,
      ),
    );
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Created workstream ${pc.bold(name)} (mux session ${pc.bold(sessionName)})`);
  printNextSteps(nextSteps);
}

export async function cmdWorkstreamList(db: Db, opts: { json?: boolean } = {}): Promise<void> {
  const summaries = await listWorkstreams(db);
  if (opts.json) {
    emitJsonCollection(summaries);
    return;
  }
  if (summaries.length === 0) {
    console.log(pc.dim("no workstreams found (no DB rows, no mu-* mux sessions)"));
    return;
  }
  console.log(formatWorkstreamsTable(summaries));
}

export async function cmdTeardown(
  db: Db,
  opts: {
    workstream?: string;
    yes?: boolean;
    json?: boolean;
    empty?: boolean;
  },
): Promise<void> {
  if (opts.empty) {
    await cmdTeardownEmpty(db, opts);
    return;
  }
  const workstream = await resolveWorkstream(opts.workstream);
  const summary = await summarizeWorkstream(db, { workstream });
  // Empty-but-registered workstreams (a row in `workstreams` with no
  // agents/tasks/etc.) ARE worth tearing down — otherwise the bare
  // registry row is orphaned forever. nothingToDo is the strict
  // intersection: nothing on disk, in mux, OR in the DB.
  const nothingToDo =
    !summary.muxAlive &&
    !summary.registered &&
    summary.agentCount === 0 &&
    summary.taskCount === 0 &&
    summary.noteCount === 0 &&
    summary.workspaceCount === 0;

  if (nothingToDo) {
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        tornDown: false,
        reason: "nothing to tear down",
        summary,
      });
      return;
    }
    console.log(
      pc.dim(`workstream "${workstream}" has no mux session and no DB rows; nothing to tear down`),
    );
    return;
  }

  if (!opts.yes) {
    const dryRunNextSteps: NextStep[] = [
      {
        intent: "Confirm and actually tear down",
        command: `mu workstream teardown -w ${workstream} --yes`,
      },
    ];
    if (opts.json) {
      emitJson({
        workstreamName: workstream,
        tornDown: false,
        dryRun: true,
        summary,
        nextSteps: dryRunNextSteps,
      });
      return;
    }
    console.log(pc.bold(`Workstream ${workstream} (mux session ${summary.muxSession})`));
    console.log(
      `  mux session  : ${summary.muxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
    );
    console.log(`  agents       : ${summary.agentCount}`);
    console.log(
      `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount})`,
    );
    console.log(
      `  workspaces   : ${summary.workspaceCount}${summary.workspaceCount > 0 ? pc.dim(" (will be cleaned via per-backend remove)") : ""}`,
    );
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually tear down)"));
    printNextSteps(dryRunNextSteps);
    return;
  }

  const result = await teardownWorkstream(db, { workstream });
  if (opts.json) {
    emitJson({
      workstreamName: workstream,
      tornDown: true,
      ...result,
    });
    return;
  }
  console.log(pc.bold(`Workstream ${workstream} (mux session ${summary.muxSession})`));
  console.log(
    `  mux session  : ${summary.muxAlive ? pc.yellow("alive (will be killed)") : pc.dim("not running")}`,
  );
  console.log(`  agents       : ${summary.agentCount}`);
  console.log(
    `  tasks        : ${summary.taskCount}  (edges: ${summary.edgeCount}, notes: ${summary.noteCount})`,
  );
  console.log(`  workspaces   : ${summary.workspaceCount}`);
  console.log("");
  console.log(
    `Destroyed ${pc.bold(workstream)}: killed mux=${result.killedMux}, agents=${result.deletedAgents}, tasks=${result.deletedTasks}, edges=${result.deletedEdges}, notes=${result.deletedNotes}, workspaces=${result.freedWorkspaces}/${summary.workspaceCount}${result.alreadyGoneWorkspaces > 0 ? ` (${result.alreadyGoneWorkspaces} already gone on disk)` : ""}`,
  );
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

// ─── cmdTeardownEmpty ─────────────────────────────────────────────────
//
// `mu workstream teardown --empty` sweeps every workstream with no
// user-meaningful state (zero tasks, agents, vcs_workspaces).
// One snapshot covers the whole sweep; per-workstream teardown errors
// are accumulated into a `failed` array so a single bad pane doesn't
// abort the rest of the cleanup. See workstream_destroy_empty_sweep.

interface EmptyTeardownResult {
  workstreamName: string;
  killedMux: boolean;
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
 *  string for mux-only rows that listEmptyWorkstreams won't surface
 *  anyway (the predicate requires a workstreams row), keeping the
 *  signature total. */
function workstreamCreatedAt(db: Db, name: string): string {
  const row = db.prepare("SELECT created_at FROM workstreams WHERE name = ?").get(name) as
    | { created_at: string }
    | undefined;
  return row?.created_at ?? "";
}

async function cmdTeardownEmpty(
  db: Db,
  opts: {
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
      head: ["workstream", "created_at", "mux"].map((h) => pc.bold(h)),
      colWidths: [40, null, null],
    });
    for (const ws of empties) {
      const createdAt = workstreamCreatedAt(db, ws.name);
      // Mux-only entries have no DB row and so no created_at;
      // render an em-dash placeholder so the column never goes
      // visually empty (matches the mux column's idiom below).
      const createdCell = createdAt === "" ? pc.dim("\u2014") : pc.dim(createdAt);
      table.push([ws.name, createdCell, ws.muxAlive ? pc.green("alive") : pc.dim("\u2014")]);
    }
    console.log(table.toString());
    console.log("");
    console.log(
      pc.dim(
        `${empties.length} empty workstream${empties.length === 1 ? "" : "s"} would be torn down (dry-run; rerun with --yes to actually tear down).`,
      ),
    );
    printNextSteps([
      {
        intent: "Confirm and actually tear down every empty workstream",
        command: "mu workstream teardown --empty --yes",
      },
    ]);
    return;
  }

  // --yes path. No-op early if there's nothing to do.
  if (empties.length === 0) {
    if (opts.json) {
      emitJson({ tornDown: 0, results: [], failed: [] });
      return;
    }
    console.log(pc.dim("no empty workstreams found; nothing to tear down"));
    return;
  }

  const results: EmptyTeardownResult[] = [];
  const failed: EmptyDestroyFailure[] = [];
  for (const ws of empties) {
    try {
      const result = await teardownWorkstream(db, { workstream: ws.name });
      results.push({
        workstreamName: ws.name,
        killedMux: result.killedMux,
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
    emitJson({ tornDown: results.length, results, failed });
    return;
  }
  for (const r of results) {
    console.log(
      `Destroyed ${pc.bold(r.workstreamName)} ${pc.dim(
        `(killedMux=${r.killedMux}, agents=${r.deletedAgents}, tasks=${r.deletedTasks}, notes=${r.deletedNotes}, edges=${r.deletedEdges})`,
      )}`,
    );
  }
  if (failed.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `WARNING: ${failed.length} workstream${failed.length === 1 ? "" : "s"} could not be torn down cleanly:`,
      ),
    );
    for (const f of failed) {
      console.log(`  - ${f.workstreamName}: ${f.error}`);
    }
  }
  console.log("");
  console.log(pc.dim(`Sweep complete: tornDown=${results.length}, failed=${failed.length}.`));
  if (failed.length === 0) {
    printNextSteps([
      {
        intent: "Undo (a snapshot was taken before the sweep; DB only, mux not rolled back)",
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
import { handle, JSON_OPT, WORKSTREAM_OPT } from "../cli.js";

/** Fold an optional positional workstream name into the opts bag.
 *
 *  dogfood-destroy-w-flag: `workstream init` takes its target
 *  POSITIONALLY while `teardown` only took `-w`, so
 *  `mu workstream teardown v2 --yes` printed help ("too many
 *  arguments") instead of tearing down. The positional is now an
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
    .description("Create the workstream's mux session and register it in the DB")
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdInit(db, name, opts), this as Command)();
    });

  workstream
    .command("list")
    .description("List every workstream on this machine (DB rows + mu-* mux sessions)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdWorkstreamList(db, opts), this as Command)();
    });

  workstream
    .command("teardown [name]")
    .description(
      "Tear down a workstream: kill its mux session and cascade-delete every DB row tagged with its name. Reversible — tombstone ops are written, so `mu undo <group>` restores the rows. The target may be given positionally (matching `workstream init <name>`) or via -w. Pass --yes to actually tear down; otherwise prints a dry-run summary. With --empty, sweeps every empty workstream (zero tasks/agents/workspaces) in one call.",
    )
    .option(...WORKSTREAM_OPT)
    .option("-y, --yes", "actually tear down (without this flag, prints a dry-run summary)")
    .option(
      "--empty",
      "sweep every empty workstream (zero tasks, agents, vcs_workspaces); mutually exclusive with -w",
    )
    .option(...JSON_OPT)
    .action(function (name: string | undefined) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        yes?: boolean;
        json?: boolean;
        empty?: boolean;
      };
      return handle(
        (db) => cmdTeardown(db, withPositionalWorkstream(opts, name)),
        this as Command,
      )();
    });
}
