// mu — every `mu agent ...` verb + spawn / send / read / list / show /
// close / free / adopt / attach + whoami.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  type AdoptAgentOptions,
  type AdoptAgentResult,
  AgentNotFoundError,
  adoptAgent,
  closeAgent,
  freeAgent,
  getAgent,
  listLiveAgents,
  readAgent,
  refreshAgentTitle,
  resolveCliCommand,
  sendToAgent,
  shouldOverwriteAgentStatus,
  spawnAgent,
  updateAgentStatus,
} from "../agents.js";
import {
  UsageError,
  assertAgentInWorkstream,
  emitJson,
  formatAgentsTable,
  formatTaskListTable,
  resolveSelf,
  resolveWorkstream,
  statusIcon,
} from "../cli.js";
import type { Db } from "../db.js";
import { detectPiStatus } from "../detect.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import { listTasksByOwner } from "../tasks.js";
import {
  capturePane,
  enableMuPaneBordersForPane,
  listPanesInSession,
  sessionExists,
} from "../tmux.js";
import { type VcsBackendName, detectBackend } from "../vcs.js";
import { getWorkspaceForAgent } from "../workspace.js";

interface SpawnOpts {
  cli?: string;
  command?: string;
  tab?: string;
  role?: string;
  cwd?: string;
  workstream?: string;
  workspace?: boolean;
  workspaceBackend?: VcsBackendName;
  workspaceFrom?: string;
  workspaceProjectRoot?: string;
  json?: boolean;
}
export async function cmdSpawn(db: Db, name: string, opts: SpawnOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);

  // Preflight: when --workspace is set, resolve+announce the backend
  // and projectRoot BEFORE the long-running git-worktree-add /
  // jj-workspace-add / cp -a, so the operator can ctrl-c if the
  // detected backend is wrong (e.g. cp -a falling through to a
  // 60GB project tree because --workspace-project-root pointed at a
  // non-VCS dir; surfaced by bug_agent_spawn_workspace_aborts_without_status).
  // Skipped on --json so machine consumers get a single structured
  // output, not preflight chatter.
  if (opts.workspace && !opts.json) {
    const projectRoot = opts.workspaceProjectRoot ?? process.cwd();
    const backend: VcsBackendName =
      opts.workspaceBackend ?? (await detectBackend(projectRoot)).name;
    const warn =
      backend === "none"
        ? pc.yellow(
            " — WARNING: 'none' backend will cp -a the entire projectRoot. Verify --workspace-project-root.",
          )
        : "";
    console.log(
      pc.dim(
        `[mu] workspace preflight: backend=${pc.bold(backend)} projectRoot=${pc.bold(projectRoot)}${warn}`,
      ),
    );
  }

  const agent = await spawnAgent(db, {
    name,
    workstream,
    ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    ...(opts.workspaceBackend !== undefined ? { workspaceBackend: opts.workspaceBackend } : {}),
    ...(opts.workspaceFrom !== undefined ? { workspaceFrom: opts.workspaceFrom } : {}),
    ...(opts.workspaceProjectRoot !== undefined
      ? { workspaceProjectRoot: opts.workspaceProjectRoot }
      : {}),
  });
  const workspace = opts.workspace ? getWorkspaceForAgent(db, name, workstream) : undefined;
  // Resolve the actual command that landed in the pane, so the operator
  // can confirm `--command 'pi-meta --no-solo'` (etc.) took effect.
  // Mirrors the resolution chain in spawnAgent: explicit --command >
  // $MU_<UPPER_CLI>_COMMAND > the cli value itself. Surfaced from
  // mufeedback note #159: 'Spawned ... (pi)' was misleading when
  // --command overrode the binary.
  const resolvedCommand = opts.command ?? resolveCliCommand(agent.cli);
  const commandOverridden = resolvedCommand !== agent.cli;
  const nextSteps: NextStep[] = [
    { intent: "Send work", command: `mu agent send ${name} "..." -w ${workstream}` },
    { intent: "Read pane", command: `mu agent read ${name} -w ${workstream}` },
    { intent: "Watch live events", command: `mu log -w ${workstream} --tail` },
    {
      intent: "Close (drops registry row, kills pane)",
      command: `mu agent close ${name} -w ${workstream}`,
    },
  ];
  if (opts.json) {
    emitJson({
      agent,
      workspace: workspace ?? null,
      resolvedCommand,
      commandOverridden,
      nextSteps,
    });
    return;
  }
  const wsBit = opts.workspace ? pc.dim(" with auto-workspace") : "";
  // Show 'pi (cmd: pi-meta --no-solo)' when overridden; just '(pi)'
  // when running the default binary for the cli key. Avoids the
  // misleading 'Spawned X (pi)' for pi-meta workers.
  const cliDisplay = commandOverridden
    ? `${agent.cli} ${pc.dim(`(cmd: ${resolvedCommand})`)}`
    : agent.cli;
  console.log(
    `Spawned ${pc.bold(agent.name)} (${cliDisplay}) in window ${pc.bold(agent.tab ?? agent.name)} of ${pc.bold(`mu-${workstream}`)}, pane ${pc.dim(agent.paneId)}${wsBit}`,
  );
  if (workspace) console.log(pc.dim(`  workspace: ${workspace.path} (${workspace.backend})`));
  printNextSteps(nextSteps);
}

export async function cmdSend(
  db: Db,
  name: string,
  text: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  await sendToAgent(db, name, text, { workstream: ws });
  const nextSteps: NextStep[] = [
    { intent: "Read response", command: `mu agent read ${name} -n 50 -w ${ws}` },
    { intent: "Watch live events", command: `mu log -w ${ws} --tail` },
  ];
  if (opts.json) {
    emitJson({ agent: name, sentBytes: text.length, nextSteps });
    return;
  }
  console.log(pc.dim(`sent ${text.length} bytes to ${name}`));
  printNextSteps(nextSteps);
}

export async function cmdRead(
  db: Db,
  name: string,
  opts: { lines?: number; workstream?: string; json?: boolean },
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const text = await readAgent(db, name, {
    workstream: ws,
    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
  });
  if (opts.json) {
    emitJson({
      agent: name,
      lines: opts.lines ?? null,
      scrollback: text,
      scrollbackLines: text.split("\n").length,
    });
    return;
  }
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

export async function cmdList(
  db: Db,
  opts: { workstream?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const view = await listLiveAgents(db, { workstream });
  if (opts.json) {
    emitJson({ workstream, agents: view.agents, orphans: view.orphans });
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    console.log("");
    console.log(pc.yellow(`Orphan panes (${view.orphans.length})`));
    console.log(pc.dim("  Panes that look like agents but aren't in the registry."));
    console.log(
      pc.dim(
        "  Run `mu adopt <pane-id>` to register one as a managed agent (e.g. `mu adopt %15`).",
      ),
    );
    for (const orphan of view.orphans) {
      console.log(
        `  ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
}

export async function cmdAgentShow(
  db: Db,
  name: string,
  opts: { lines?: number; json?: boolean; workstream?: string },
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  // v5: agents.name is per-workstream unique. Resolve the operator's
  // workstream up front so the lookup scopes correctly.
  const ws = await resolveWorkstream(opts.workstream);
  const agent = getAgent(db, name, ws);
  if (!agent) throw new AgentNotFoundError(name);
  const lines = opts.lines ?? 20;
  let scrollback: string;
  try {
    scrollback = await capturePane(agent.paneId, { lines });
  } catch {
    scrollback = "";
  }

  // Fresh-status reconciliation. The persisted `agents.status` is
  // whatever the last reconcile pass wrote (typically via
  // `mu agent list` or `mu state`). For `mu agent show <name>` the
  // operator's expectation is "give me the *current* picture," so we
  // re-run the detector against the scrollback we just captured and
  // update the row if status changed. Same shouldOverwrite rules as
  // listLiveAgents (free is sticky until real activity, etc).
  // Real bug found in real use: status was reading stale, especially
  // bad with custom --command wrappers where the orchestrator never noticed needs_input.
  let displayed = agent;
  if (scrollback.trim() !== "") {
    const detected = detectPiStatus(scrollback);
    if (detected !== agent.status && shouldOverwriteAgentStatus(agent.status, detected)) {
      updateAgentStatus(db, agent.name, detected, agent.workstream);
      const refreshed = getAgent(db, name, agent.workstream);
      if (refreshed) displayed = refreshed;
    }
  }

  if (opts.json) {
    emitJson({ agent: displayed, scrollback, scrollbackLines: lines });
    return;
  }

  console.log(pc.bold(`${displayed.name}  ${statusIcon(displayed.status)} ${displayed.status}`));
  console.log(`  workstream : ${agent.workstream}`);
  console.log(`  cli        : ${agent.cli}`);
  console.log(`  pane       : ${pc.dim(agent.paneId)}`);
  console.log(`  window     : ${agent.tab ?? agent.name}`);
  console.log(`  role       : ${agent.role}`);
  console.log(`  created    : ${pc.dim(agent.createdAt)}`);
  console.log(`  updated    : ${pc.dim(agent.updatedAt)}`);

  console.log("");
  console.log(pc.bold(`Recent scrollback (last ${lines} lines)`));
  if (scrollback.trim() === "") {
    console.log(pc.dim("  (pane gone or empty)"));
    return;
  }
  for (const line of scrollback.replace(/\n+$/, "").split("\n")) {
    console.log(`  ${line}`);
  }
}

export async function cmdWhoami(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const owned = listTasksByOwner(db, self.workstream, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });

  if (opts.json) {
    emitJson({ agent: self, ownedTasks: owned });
    return;
  }

  console.log(pc.bold(`${self.name}  ${statusIcon(self.status)} ${self.status}`));
  console.log(`  workstream : ${self.workstream}`);
  console.log(`  cli        : ${self.cli}`);
  console.log(`  pane       : ${pc.dim(self.paneId)}`);
  console.log(`  role       : ${self.role}`);
  console.log("");
  if (owned.length === 0) {
    console.log(pc.dim("Currently owns no tasks. Try `mu my-next` for a recommendation."));
    return;
  }
  console.log(pc.bold(`Currently owns ${owned.length} task${owned.length === 1 ? "" : "s"}`));
  console.log(formatTaskListTable(owned));
}

export async function cmdClose(
  db: Db,
  name: string,
  opts: { workstream?: string; json?: boolean; discardWorkspace?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const result = await closeAgent(db, name, {
    workstream: ws,
    ...(opts.discardWorkspace === true ? { discardWorkspace: true } : {}),
  });
  const next: NextStep[] = [];
  if (result.workspaceFreed) {
    next.push({
      intent: "Workspace was freed alongside the agent (--discard-workspace)",
      command: "cd /  # the workspace dir is gone",
    });
  }
  next.push({
    intent: "Re-spawn under the same name",
    command: `mu agent spawn ${name} -w <workstream>`,
  });
  if (opts.json) {
    emitJson({ agent: name, ...result, nextSteps: next });
    return;
  }
  if (!result.killedPane && !result.deletedRow) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    printNextSteps(next);
    return;
  }
  const wsBit = result.workspaceFreed ? pc.dim(" (workspace discarded)") : "";
  console.log(`Closed ${pc.bold(name)}${wsBit}`);
  printNextSteps(next);
}

interface AdoptCliOpts {
  workstream?: string;
  name?: string;
  cli?: string;
  role?: string;
  json?: boolean;
}

export async function cmdAdopt(db: Db, paneOrTitle: string, opts: AdoptCliOpts): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);

  // Allow `mu adopt <pane-id>` (literal '%15') OR `mu adopt <pane-title>`
  // (a string that looks like an agent name; we look it up in the
  // workstream's tmux session). Pane-id form is preferred for scripting;
  // pane-title form is the ergonomic form for interactive use.
  let paneId: string;
  if (paneOrTitle.startsWith("%")) {
    paneId = paneOrTitle;
  } else {
    const session = `mu-${ws}`;
    const panes = await listPanesInSession(session);
    const match = panes.find((p) => p.title === paneOrTitle);
    if (!match) {
      throw new UsageError(
        `no pane with title '${paneOrTitle}' in tmux session ${session} (try \`mu agent list -w ${ws}\` and pass the pane id)`,
      );
    }
    paneId = match.paneId;
  }

  const adoptOpts: AdoptAgentOptions = {
    paneId,
    workstream: ws,
    name: opts.name,
    cli: opts.cli,
    role: opts.role,
  };
  const result: AdoptAgentResult = await adoptAgent(db, adoptOpts);
  // Refresh title with composed state. Adopt may have set it to just
  // the agent name; this re-renders with status emoji etc.
  await refreshAgentTitle(db, result.agent.name, ws);

  // Window-scoped border for the adopted pane's window. (cmdInit set
  // it on _mu but adopted panes can be in any window.) Self-checks
  // MU_BANNER_QUIET; best-effort.
  await enableMuPaneBordersForPane(paneId);

  const nextSteps: NextStep[] = [
    { intent: "Send work", command: `mu agent send ${result.agent.name} "..." -w ${ws}` },
    { intent: "Read pane", command: `mu agent read ${result.agent.name} -w ${ws}` },
    { intent: "Verify in agent list", command: `mu agent list -w ${ws}` },
  ];

  if (opts.json) {
    emitJson({
      adopted: !result.alreadyAdopted,
      alreadyAdopted: result.alreadyAdopted,
      agent: result.agent,
      previousTitle: result.previousTitle,
      paneTitleSetTo: result.paneTitleSetTo,
      nextSteps,
    });
    return;
  }

  if (result.alreadyAdopted) {
    console.log(pc.dim(`already adopted: ${result.agent.name} (pane ${result.agent.paneId})`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(
    `Adopted ${pc.bold(result.agent.name)} ${pc.dim(`(pane ${result.agent.paneId}, workstream ${result.agent.workstream})`)}`,
  );
  if (result.previousTitle !== null && result.previousTitle !== result.paneTitleSetTo) {
    console.log(pc.dim(`  pane title: '${result.previousTitle}' -> '${result.paneTitleSetTo}'`));
  }
  printNextSteps(nextSteps);
}

export async function cmdFree(
  db: Db,
  name: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = freeAgent(db, name, ws);
  if (r.changed) await refreshAgentTitle(db, name, ws);
  const nextSteps: NextStep[] = [
    { intent: "Send work to the freed agent", command: `mu agent send ${name} '...' -w ${ws}` },
    { intent: "Close the agent", command: `mu agent close ${name} -w ${ws}` },
    { intent: "See workstream state", command: `mu state -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ agent: name, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${name} already free (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Freed ${pc.bold(name)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  printNextSteps(nextSteps);
}

export async function cmdAttach(
  db: Db,
  name: string,
  opts: { workstream?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const sessionName = `mu-${workstream}`;
  if (!(await sessionExists(sessionName))) {
    throw new UsageError(`workstream "${workstream}" has no tmux session yet`);
  }
  // mu agent attach prints scrollback + an attach hint; it has no
  // business pruning the registry. status-only so the operator still
  // sees fresh agent status when they run it interactively.
  const view = await listLiveAgents(db, { workstream, mode: "status-only" });
  const agent = view.agents.find((a) => a.name === name);
  if (!agent) {
    throw new AgentNotFoundError(name);
  }
  // Capture and print its scrollback.
  const text = await capturePane(agent.paneId);
  process.stdout.write(text);
  console.log("");
  console.log(
    pc.dim(
      `Attach with: tmux a -t ${sessionName} && tmux select-window -t ${agent.tab ?? agent.name}`,
    ),
  );
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireAgentCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle, parseLines } from "../cli.js";
// wireSelfCommands needs cmdMyTasks / cmdMyNext which live in cli/tasks.ts
// (they're task queries scoped to the resolved-self agent). Lateral
// cluster→cluster import documented as the single intentional edge.
import { cmdMyNext, cmdMyTasks } from "./tasks.js";

export function wireAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent-level commands");

  agent
    .command("spawn <name>")
    .description("Spawn a new agent in a tmux pane")
    .option(
      "--cli <cli>",
      "agent CLI key (default: pi); also used as the lookup key for $MU_<UPPER_CLI>_COMMAND, e.g. --cli pi_big resolves $MU_PI_BIG_COMMAND",
      "pi",
    )
    .option(
      "--command <cmd>",
      "executable to run in the pane (defaults to $MU_<CLI>_COMMAND or the cli value)",
    )
    .option("--tab <tab>", "tmux window name to group under (defaults to agent name)")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option("--cwd <cwd>", "initial working directory (ignored when --workspace is set)")
    .option("--workspace", "auto-create a VCS workspace for this agent and use its path as cwd")
    .option(
      "--workspace-backend <name>",
      "force a specific VCS backend for --workspace (jj | sl | git | none)",
    )
    .option(
      "--workspace-from <ref>",
      "base the workspace on a specific commit / branch / changeset",
    )
    .option(
      "--workspace-project-root <path>",
      "override the project root the workspace branches from (default: cwd)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        cli?: string;
        command?: string;
        tab?: string;
        role?: string;
        cwd?: string;
        workstream?: string;
        workspace?: boolean;
        workspaceBackend?: VcsBackendName;
        workspaceFrom?: string;
        workspaceProjectRoot?: string;
        json?: boolean;
      };
      return handle((db) => cmdSpawn(db, name, opts))();
    });

  agent
    .command("send <name> <text>")
    .description("Send text to an agent's pane (bracketed-paste protocol)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, text: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdSend(db, name, text, opts))();
    });

  agent
    .command("read <name>")
    .description("Read an agent's pane scrollback")
    .option("-n, --lines <n>", "show last N lines (default: full scrollback)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdRead(db, name, opts))();
    });

  agent
    .command("list")
    .description("List agents in the current workstream (reconciled with tmux)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdList(db, opts))();
    });

  agent
    .command("show <name>")
    .description("Show an agent: registry row + recent scrollback (last N lines, default 20)")
    .option("-n, --lines <n>", "how many scrollback lines to show (default 20)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        json?: boolean;
        workstream?: string;
      };
      return handle((db) => cmdAgentShow(db, name, opts))();
    });

  agent
    .command("close <name>")
    .description(
      "Kill an agent's pane and remove its registry row. If the agent has a workspace, refuses by default (would orphan the on-disk dir); pass --discard-workspace to free both, or run `mu workspace free <agent>` first.",
    )
    .option(
      "--discard-workspace",
      "free the agent's workspace alongside close (lossy: pending changes are gone)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        discardWorkspace?: boolean;
      };
      return handle((db) => cmdClose(db, name, opts))();
    });

  agent
    .command("free <name>")
    .description(
      "Mark an agent's status as 'free' (idempotent). Pane untouched; reconcile flips back to busy on real activity.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdFree(db, name, opts))();
    });

  agent
    .command("attach <name>")
    .description("Print an agent's full scrollback and the tmux command to attach")
    .option(...WORKSTREAM_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      // Routed through handle() like every other verb — errorNextSteps
      // fire on typed errors, exit codes classify uniformly
      // (review_code_attach_bypasses_handle).
      return handle((db) => cmdAttach(db, name, opts))();
    });

  // `mu adopt` is intentionally TOP-LEVEL, not nested under `mu agent`,
  // matching the original e20af89 design and every doc/skill/orphan-hint
  // reference (`mu adopt %15`, not `mu agent adopt %15`). It was dropped
  // on the floor in the f42e86d wireXxxCommands split — bug_adopt_verb_unwired.
  program
    .command("adopt <pane-or-title>")
    .description(
      "Register an existing tmux pane as a managed mu agent (the inverse of `mu agent list`'s 'orphan' state). Pane id form '%15' or pane title form 'worker-2'.",
    )
    .option("--name <name>", "agent name (defaults to the pane's current title)")
    .option("--cli <cli>", "agent CLI key (default: pi)")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (paneOrTitle: string) {
      // optsWithGlobals so the top-level -w / --json flags propagate.
      const opts = (this as Command).optsWithGlobals() as AdoptCliOpts;
      return handle((db) => cmdAdopt(db, paneOrTitle, opts))();
    });

  // ─── task ───────────────────────────────────────────────────────────
}

export function wireSelfCommands(program: Command): void {
  program
    .command("whoami")
    .description(
      "Identify the agent running this process (via $TMUX_PANE) plus its currently-owned tasks (excludes CLOSED by default)",
    )
    .option("--include-closed", "include CLOSED tasks in the owned-tasks list")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdWhoami(db, opts))();
    });

  program
    .command("my-tasks")
    .description(
      "List tasks owned by the current agent (alias for `task owned-by <self>`). Excludes CLOSED by default.",
    )
    .option("--include-closed", "include CLOSED tasks in the list")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdMyTasks(db, opts))();
    });

  program
    .command("my-next")
    .description(
      "Top-K ready tasks in the current agent's workstream (alias for `task next -w <self.workstream>`)",
    )
    .option("-n, --lines <k>", "how many top-K tasks to return (default 1)", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { lines?: number; json?: boolean };
      return handle((db) => cmdMyNext(db, opts))();
    });
}
