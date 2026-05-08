// mu — `mu workstream` verbs (init / list / destroy).
//
// A workstream = one tmux session (`mu-<name>`) + every DB row tagged
// with that name (agents / tasks / edges / notes / workspaces / logs /
// approvals). `init` creates the session + DB row pair; `list` shows
// every workstream on the machine; `destroy` is the symmetric inverse,
// two-phase by default (dry-run; `--yes` commits).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import pc from "picocolors";
import { emitJson, formatWorkstreamsTable, resolveWorkstream } from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, printNextSteps } from "../output.js";
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
  // set-option is idempotent. Opt-out via MU_BANNER_QUIET=1 (covers
  // both this and the spawn-time scrollback banner; see spawnAgent).
  if (process.env.MU_BANNER_QUIET !== "1") {
    await enableMuPaneBordersForSession(sessionName).catch(() => {
      // Older tmux without pane-border-status support is benign here:
      // the cue is a nice-to-have, not load-bearing. Don't fail init.
    });
  }
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
      workstream: name,
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

export async function cmdDestroy(
  db: Db,
  opts: { workstream?: string; yes?: boolean; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const summary = await summarizeWorkstream(db, { workstream });
  // Empty-but-registered workstreams (a row in `workstreams` with no
  // agents/tasks/etc.) ARE worth destroying — otherwise the bare
  // registry row is orphaned forever. nothingToDo is the strict
  // intersection: nothing on disk, in tmux, OR in the DB.
  const nothingToDo =
    !summary.tmuxAlive &&
    !summary.registered &&
    summary.agents === 0 &&
    summary.tasks === 0 &&
    summary.notes === 0 &&
    summary.workspaces === 0;

  if (nothingToDo) {
    if (opts.json) {
      emitJson({ workstream, destroyed: false, reason: "nothing to destroy", summary });
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
        workstream,
        destroyed: false,
        dryRun: true,
        summary,
        nextSteps: [
          {
            intent: "Confirm and actually destroy",
            command: `mu workstream destroy -w ${workstream} --yes`,
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
    console.log(`  agents       : ${summary.agents}`);
    console.log(
      `  tasks        : ${summary.tasks}  (edges: ${summary.edges}, notes: ${summary.notes})`,
    );
    console.log(
      `  workspaces   : ${summary.workspaces}${summary.workspaces > 0 ? pc.dim(" (will be cleaned via per-backend remove)") : ""}`,
    );
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

  const result = await destroyWorkstream(db, { workstream });
  if (opts.json) {
    emitJson({
      workstream,
      destroyed: true,
      ...result,
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
  console.log(`  agents       : ${summary.agents}`);
  console.log(
    `  tasks        : ${summary.tasks}  (edges: ${summary.edges}, notes: ${summary.notes})`,
  );
  console.log(`  workspaces   : ${summary.workspaces}`);
  console.log("");
  console.log(
    `Destroyed ${pc.bold(workstream)}: killed tmux=${result.killedTmux}, agents=${result.deletedAgents}, tasks=${result.deletedTasks}, edges=${result.deletedEdges}, notes=${result.deletedNotes}, workspaces=${result.freedWorkspaces}/${summary.workspaces}`,
  );
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
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        yes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdDestroy(db, opts))();
    });
}
