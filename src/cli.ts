#!/usr/bin/env node
// mu — command-line interface.
//
// 10 verbs + mission control, each registered via commander as a thin
// wrapper around the corresponding programmatic function in src/. The
// real work happens in agents.ts, tasks.ts, tracks.ts, db.ts, tmux.ts;
// this file is just argument parsing, output formatting, and error-to-
// exit-code translation.
//
// Exit codes (from VOCABULARY.md / ARCHITECTURE.md):
//   0 = success
//   1 = generic error
//   2 = usage error (commander default)
//   3 = not found (no such agent / task / pane)
//   4 = conflict (name collision, double-claim, cycle, etc.)
//   5 = substrate unavailable (tmux not running, DB locked)

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Table from "cli-table3";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  type AgentRow,
  type AgentStatus,
  closeAgent,
  freeAgent,
  getAgent,
  getAgentByPane,
  listLiveAgents,
  readAgent,
  sendToAgent,
  spawnAgent,
  updateAgentStatus,
} from "./agents.js";
import {
  type AddApprovalOptions,
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
  type ApprovalRow,
  type ApprovalStatus,
  addApproval,
  denyApproval,
  getApproval,
  grantApproval,
  listApprovals,
  waitApproval,
} from "./approvals.js";
import { type Db, defaultDbPath, openDb } from "./db.js";
import { detectPiStatus } from "./detect.js";
import { type ListLogsOptions, type LogRow, appendLog, latestSeq, listLogs } from "./logs.js";
import {
  CrossWorkstreamEdgeError,
  CycleError,
  type SearchTasksOptions,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  type TaskNoteRow,
  type TaskRow,
  type UpdateTaskOptions,
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  closeTask,
  deleteTask,
  getTask,
  getTaskEdges,
  idFromTitle,
  listBlocked,
  listGoals,
  listNotes,
  listReady,
  listTasks,
  listTasksByOwner,
  openTask,
  releaseTask,
  removeBlockEdge,
  reparentTask,
  searchTasks,
  updateTask,
} from "./tasks.js";
import { TmuxError, capturePane, newSession, sessionExists, tmux } from "./tmux.js";
import { type Track, getParallelTracks } from "./tracks.js";
import type { VcsBackendName } from "./vcs.js";
import {
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  type WorkspaceRow,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaces,
} from "./workspace.js";
import {
  WorkstreamNameInvalidError,
  type WorkstreamSummary,
  destroyWorkstream,
  ensureWorkstream,
  listWorkstreams,
  summarizeWorkstream,
} from "./workstream.js";

// ─── Workstream resolution ─────────────────────────────────────────────

/**
 * Resolve the active workstream. Order:
 *   1. --workstream <name> flag
 *   2. $MU_SESSION env var
 *   3. Current tmux session name (with `mu-` prefix stripped)
 *
 * Throws UsageError if none of the above produce a name.
 */
async function resolveWorkstream(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.MU_SESSION) return process.env.MU_SESSION;
  if (process.env.TMUX) {
    try {
      const name = (await tmux(["display-message", "-p", "#S"])).trim();
      if (name.startsWith("mu-")) return name.slice(3);
    } catch {
      // fall through
    }
  }
  throw new UsageError(
    "workstream required: pass --workstream <name>, set $MU_SESSION, or run inside an mu-<name> tmux session",
  );
}

// ─── Error handling ────────────────────────────────────────────────────

class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Wrap an async handler so typed errors become specific exit codes. */
function handle(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    let db: Db | undefined;
    try {
      db = openDb();
      await fn(db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UsageError || err instanceof WorkstreamNameInvalidError) {
        console.error(pc.red(`error: ${message}`));
        process.exit(2);
      }
      if (
        err instanceof AgentNotFoundError ||
        err instanceof TaskNotFoundError ||
        err instanceof WorkspaceNotFoundError ||
        err instanceof ApprovalNotFoundError
      ) {
        console.error(pc.red(`not found: ${message}`));
        process.exit(3);
      }
      if (
        err instanceof AgentExistsError ||
        err instanceof TaskExistsError ||
        err instanceof TaskAlreadyOwnedError ||
        err instanceof TaskNotInWorkstreamError ||
        err instanceof AgentNotInWorkstreamError ||
        err instanceof ApprovalNotInWorkstreamError ||
        err instanceof CycleError ||
        err instanceof CrossWorkstreamEdgeError ||
        err instanceof WorkspaceExistsError ||
        err instanceof ApprovalAlreadyDecidedError
      ) {
        console.error(pc.red(`conflict: ${message}`));
        process.exit(4);
      }
      if (err instanceof AgentDiedOnSpawnError) {
        // Surface the rich message (already includes the captured
        // scrollback). Exit 1 (generic) since this is a substrate-level
        // failure of the agent CLI, not a usage / not-found / conflict.
        console.error(pc.red(`spawn failed: ${message}`));
        process.exit(1);
      }
      if (err instanceof TmuxError) {
        console.error(pc.red(`tmux: ${message}`));
        process.exit(5);
      }
      console.error(pc.red(`error: ${message}`));
      process.exit(1);
    } finally {
      try {
        db?.close();
      } catch {
        // best effort
      }
    }
  };
}

// ─── Output helpers ────────────────────────────────────────────────────

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "spawning":
      return pc.yellow("⏳");
    case "busy":
      return pc.cyan("⚙️ ");
    case "needs_input":
      return pc.dim("💤");
    case "needs_permission":
      return pc.magenta("🔐");
    case "free":
      return pc.green("✓");
    case "unreachable":
      return pc.red("❓");
    case "terminated":
      return pc.dim("✕");
  }
}

function formatAgentsTable(agents: readonly AgentRow[]): string {
  if (agents.length === 0) return pc.dim("  (no agents)");
  const table = new Table({
    head: [
      pc.bold(""),
      pc.bold("name"),
      pc.bold("cli"),
      pc.bold("status"),
      pc.bold("window"),
      pc.bold("role"),
    ],
    style: { head: [] },
  });
  for (const a of agents) {
    table.push([
      statusIcon(a.status),
      a.name,
      a.cli,
      a.status,
      a.tab ?? a.name,
      a.role === "read-only" ? pc.yellow("read-only") : "",
    ]);
  }
  return table.toString();
}

function formatReadyTable(tasks: readonly TaskRow[]): string {
  if (tasks.length === 0) return pc.dim("  (no ready tasks)");
  const table = new Table({
    head: [
      pc.bold("id"),
      pc.bold("title"),
      pc.bold("impact"),
      pc.bold("effort"),
      pc.bold("ROI"),
      pc.bold("owner"),
    ],
    style: { head: [] },
  });
  // Sort by ROI descending.
  const sorted = [...tasks].sort((a, b) => b.impact / b.effortDays - a.impact / a.effortDays);
  for (const t of sorted) {
    const roi = (t.impact / t.effortDays).toFixed(1);
    table.push([t.localId, t.title, String(t.impact), String(t.effortDays), roi, t.owner ?? ""]);
  }
  return table.toString();
}

function formatTracks(tracks: readonly Track[]): string {
  if (tracks.length === 0) return pc.dim("  (no open tracks)");
  const lines: string[] = [];
  tracks.forEach((track, i) => {
    const rootNames = track.roots.map((r) => r.localId).join(", ");
    const verb = track.roots.length > 1 ? "merged" : "track";
    lines.push(
      `  Track ${i + 1}: ${pc.bold(rootNames)} ${pc.dim(`(${track.taskIds.size} tasks, ${track.readyCount} ready, ${verb})`)}`,
    );
  });
  return lines.join("\n");
}

// ─── Verb implementations ──────────────────────────────────────────────

async function cmdInit(db: Db, name: string): Promise<void> {
  const sessionName = `mu-${name}`;
  // Always register the DB row — this is what makes `mu workstream list`
  // see the workstream and what the agents/tasks FKs need.
  const dbCreated = ensureWorkstream(db, name);
  const tmuxAlready = await sessionExists(sessionName);
  if (tmuxAlready && !dbCreated) {
    console.log(
      pc.dim(
        `workstream "${name}" already exists (tmux session ${sessionName}, DB row registered)`,
      ),
    );
    return;
  }
  if (!tmuxAlready) {
    await newSession(sessionName, { detached: true, windowName: "_mu" });
  }
  console.log(`Created workstream ${pc.bold(name)} (tmux session ${pc.bold(sessionName)})`);
  console.log(pc.dim(`  Attach with: tmux a -t ${sessionName}`));
  console.log(pc.dim(`  Spawn agents with: mu agent spawn <name> -w ${name}`));
}

async function cmdWorkstreamList(db: Db, opts: { json?: boolean } = {}): Promise<void> {
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

function formatWorkstreamsTable(rows: WorkstreamSummary[]): string {
  const table = new Table({
    head: ["name", "tmux", "agents", "tasks", "edges", "notes"].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const r of rows) {
    table.push([
      r.workstream,
      r.tmuxAlive ? pc.green("alive") : pc.dim("—"),
      String(r.agents),
      String(r.tasks),
      String(r.edges),
      String(r.notes),
    ]);
  }
  return table.toString();
}

async function cmdDestroy(db: Db, opts: { workstream?: string; yes?: boolean }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const summary = await summarizeWorkstream(db, { workstream });
  const nothingToDo =
    !summary.tmuxAlive && summary.agents === 0 && summary.tasks === 0 && summary.notes === 0;

  if (nothingToDo) {
    console.log(
      pc.dim(`workstream "${workstream}" has no tmux session and no DB rows; nothing to destroy`),
    );
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

  if (!opts.yes) {
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually destroy)"));
    return;
  }

  const result = await destroyWorkstream(db, { workstream });
  console.log("");
  console.log(
    `Destroyed ${pc.bold(workstream)}: killed tmux=${result.killedTmux}, agents=${result.deletedAgents}, tasks=${result.deletedTasks}, edges=${result.deletedEdges}, notes=${result.deletedNotes}`,
  );
}

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
}
async function cmdSpawn(db: Db, name: string, opts: SpawnOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
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
  const wsBit = opts.workspace ? pc.dim(" with auto-workspace") : "";
  console.log(
    `Spawned ${pc.bold(agent.name)} (${agent.cli}) in window ${pc.bold(agent.tab ?? agent.name)} of ${pc.bold(`mu-${workstream}`)}, pane ${pc.dim(agent.paneId)}${wsBit}`,
  );
  if (opts.workspace) {
    const ws = getWorkspaceForAgent(db, name);
    if (ws) console.log(pc.dim(`  workspace: ${ws.path} (${ws.backend})`));
  }
}

async function cmdSend(
  db: Db,
  name: string,
  text: string,
  opts: { workstream?: string } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  await sendToAgent(db, name, text);
  console.log(pc.dim(`sent ${text.length} bytes to ${name}`));
}

async function cmdRead(
  db: Db,
  name: string,
  opts: { lines?: number; workstream?: string },
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const text = await readAgent(db, name, opts.lines !== undefined ? { lines: opts.lines } : {});
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

async function cmdList(
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
      pc.dim("  Run `mu sql 'INSERT INTO agents ...'` to adopt (mu adopt verb is on the roadmap)."),
    );
    for (const orphan of view.orphans) {
      console.log(
        `  ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
}

/**
 * Same shouldOverwrite policy as `reconcile.ts` (kept private there to
 * encapsulate the periodic-reconcile path). Re-implemented here for
 * `mu agent show` which reconciles a single agent inline using the
 * scrollback it just captured. `free` is sticky until real activity;
 * everything else is auto-derived.
 */
function shouldOverwriteAgentStatus(
  current: AgentRow["status"],
  detected: AgentRow["status"],
): boolean {
  if (current === "free") return detected === "busy" || detected === "needs_permission";
  return true;
}

async function cmdAgentShow(
  db: Db,
  name: string,
  opts: { lines?: number; json?: boolean; workstream?: string },
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const agent = getAgent(db, name);
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
      updateAgentStatus(db, agent.name, detected);
      const refreshed = getAgent(db, name);
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

/**
 * Resolve "the agent running this process" by reading `$TMUX_PANE` and
 * looking up the matching agent row. Throws UsageError with a helpful
 * message if either step fails. Used by `mu whoami` / `my-tasks` /
 * `my-next` to give an LLM-in-a-pane zero-config self-identification.
 */
function resolveSelf(db: Db): AgentRow {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) {
    throw new UsageError(
      "$TMUX_PANE is not set; this verb only works inside an mu-spawned tmux pane (or any tmux pane, but the pane has to be a managed agent)",
    );
  }
  const agent = getAgentByPane(db, paneId);
  if (!agent) {
    throw new UsageError(
      `pane ${paneId} is not a managed agent. Use \`mu agent list\` to see managed panes, or \`mu agent spawn\` to register a new one.`,
    );
  }
  return agent;
}

async function cmdWhoami(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const owned = listTasksByOwner(db, self.name, {
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

async function cmdMyTasks(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const tasks = listTasksByOwner(db, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(${self.name} owns no tasks)`));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

async function cmdMyNext(db: Db, opts: { lines?: number; json?: boolean }): Promise<void> {
  const self = resolveSelf(db);
  const k = opts.lines ?? 1;
  const tasks = listReady(db, self.workstream).sort(byRoiDesc).slice(0, k);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no ready tasks in ${self.workstream})`));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

// ─── mu workspace (create/list/free/path) ────────────────────────

async function cmdWorkspaceCreate(
  db: Db,
  agent: string,
  opts: {
    workstream?: string;
    backend?: VcsBackendName;
    from?: string;
    projectRoot?: string;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const createOpts: Parameters<typeof createWorkspace>[1] = { agent, workstream };
  if (opts.backend !== undefined) createOpts.backend = opts.backend;
  if (opts.from !== undefined) createOpts.parentRef = opts.from;
  if (opts.projectRoot !== undefined) createOpts.projectRoot = opts.projectRoot;
  const ws = await createWorkspace(db, createOpts);
  console.log(
    `Created workspace ${pc.bold(ws.path)} ${pc.dim(`(backend=${ws.backend}, agent=${ws.agent}, parent=${ws.parentRef ?? "—"})`)}`,
  );
}

async function cmdWorkspaceList(
  db: Db,
  opts: { workstream?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const workstream = opts.all ? undefined : await resolveWorkstream(opts.workstream);
  const rows = listWorkspaces(db, workstream);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim(workstream ? `(no workspaces in ${workstream})` : "(no workspaces)"));
    return;
  }
  console.log(formatWorkspacesTable(rows));
}

async function cmdWorkspaceFree(
  db: Db,
  agent: string,
  opts: { commit?: boolean; workstream?: string },
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false });
  if (!r.removed && !r.rowDeleted) {
    console.log(pc.dim(`no workspace for ${agent} (already gone?)`));
    return;
  }
  const committed = r.committedRef
    ? pc.dim(` (auto-committed: ${r.committedRef.slice(0, 12)})`)
    : "";
  console.log(`Freed workspace for ${pc.bold(agent)}${committed}`);
}

async function cmdWorkspacePath(
  db: Db,
  agent: string,
  opts: { workstream?: string } = {},
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = getWorkspaceForAgent(db, agent);
  if (!ws) throw new WorkspaceNotFoundError(agent);
  // Print just the path, no decoration: usable for `cd $(mu workspace path X)`.
  console.log(ws.path);
}

function formatWorkspacesTable(rows: readonly WorkspaceRow[]): string {
  const table = new Table({
    head: ["agent", "workstream", "backend", "path", "parent_ref", "created"].map((h) =>
      pc.bold(h),
    ),
    style: { head: [], border: [] },
  });
  for (const r of rows) {
    table.push([
      r.agent,
      r.workstream,
      r.backend,
      r.path,
      r.parentRef ? pc.dim(r.parentRef.slice(0, 12)) : pc.dim("—"),
      pc.dim(r.createdAt),
    ]);
  }
  return table.toString();
}

async function cmdClose(db: Db, name: string, opts: { workstream?: string } = {}): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const result = await closeAgent(db, name);
  if (!result.killedPane && !result.deletedRow) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    return;
  }
  console.log(`Closed ${pc.bold(name)}`);
  if (result.workspaceKept) {
    console.log(
      pc.dim(
        `  Workspace kept on disk. Run \`mu workspace free ${name}\` to remove it (or \`--commit\` to commit pending changes first).`,
      ),
    );
  }
}

async function cmdFree(db: Db, name: string, opts: { workstream?: string } = {}): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const r = freeAgent(db, name);
  if (!r.changed) {
    console.log(pc.dim(`${name} already free (no-op)`));
    return;
  }
  console.log(`Freed ${pc.bold(name)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
}

async function cmdTaskAdd(
  db: Db,
  localId: string | undefined,
  opts: {
    title: string;
    impact: number;
    effortDays: number;
    blocks?: string;
    workstream?: string;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Derive the id from the title if the user didn't provide one. The
  // CLI's `<id>` positional is now optional; idFromTitle handles
  // collisions with `_2`, `_3`, … suffixes.
  const id = localId ?? idFromTitle(db, workstream, opts.title);
  const blocks = opts.blocks
    ? opts.blocks
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const task = addTask(db, {
    localId: id,
    workstream,
    title: opts.title,
    impact: opts.impact,
    effortDays: opts.effortDays,
    ...(blocks ? { blocks } : {}),
  });
  const idHint = localId === undefined ? pc.dim(" (id derived from title)") : "";
  console.log(
    `Added task ${pc.bold(task.localId)}${idHint} ${pc.dim(
      `(workstream=${workstream}, impact=${task.impact}, effort=${task.effortDays})`,
    )}`,
  );
  if (blocks) console.log(pc.dim(`  blocked by: ${blocks.join(", ")}`));
}

async function cmdTaskList(db: Db, opts: { workstream?: string; json?: boolean }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listTasks(db, workstream);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  console.log(formatTaskListTable(tasks));
}

// ROI = impact / effort_days. Higher first. Tasks with effortDays=0
// (would divide by zero) sort to the top by treating their ROI as Infinity.
function roiOf(t: TaskRow): number {
  return t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
}

function byRoiDesc(a: TaskRow, b: TaskRow): number {
  return roiOf(b) - roiOf(a);
}

/**
 * Decorate a TaskRow (or array of them) with a computed `roi` field for
 * JSON output. ROI is a CLI-rendering concern (the table view computes
 * it inline; see formatTaskListTable) but JSON consumers were getting
 * raw rows with no ROI at all, which broke `mu task next --json | jq
 * 'sort_by(.roi)'` and similar. We keep `TaskRow` itself ROI-free so
 * the SDK contract stays minimal; the decorator lives only in the JSON
 * emit path.
 *
 * `roi` is a plain JSON number when finite; for effortDays=0 the field
 * is omitted (JSON has no Infinity literal and `null` would be a lie).
 * Callers can detect the infinity case via `effortDays === 0`.
 */
function withRoi<T extends TaskRow>(task: T): T & { roi?: number } {
  if (task.effortDays > 0) {
    return { ...task, roi: task.impact / task.effortDays };
  }
  return task;
}

function withRoiAll<T extends TaskRow>(tasks: T[]): (T & { roi?: number })[] {
  return tasks.map(withRoi);
}

async function cmdTaskNext(
  db: Db,
  opts: { workstream?: string; lines?: number; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const k = opts.lines ?? 1;
  const tasks = listReady(db, workstream).sort(byRoiDesc).slice(0, k);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

async function cmdTaskReady(db: Db, opts: { workstream?: string; json?: boolean }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listReady(db, workstream).sort(byRoiDesc);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

async function cmdTaskBlocked(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listBlocked(db, workstream);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no blocked tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

async function cmdTaskGoals(db: Db, opts: { workstream?: string; json?: boolean }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listGoals(db, workstream);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no goals — every task has a dependent)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

async function cmdTaskOwnedBy(
  db: Db,
  agent: string,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const tasks = listTasksByOwner(db, agent, {
    includeClosed: opts.includeClosed ?? false,
  });
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no tasks owned by ${agent})`));
    return;
  }
  // owned-by is cross-workstream by design (agent names are global)
  // so always show the workstream column.
  console.log(formatTaskListTable(tasks, { withWorkstream: true }));
}

async function cmdTaskSearch(
  db: Db,
  pattern: string,
  opts: { workstream?: string; all?: boolean; inNotes?: boolean; json?: boolean },
): Promise<void> {
  const searchOpts: SearchTasksOptions = {};
  if (opts.inNotes) searchOpts.includeNotes = true;
  if (!opts.all) searchOpts.workstream = await resolveWorkstream(opts.workstream);

  const tasks = searchTasks(db, pattern, searchOpts);
  if (opts.json) {
    emitJson(tasks);
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no matches for "${pattern}")`));
    return;
  }
  console.log(formatTaskListTable(tasks, { withWorkstream: opts.all === true }));
}

function formatTaskListTable(
  tasks: readonly TaskRow[],
  opts: { withWorkstream?: boolean } = {},
): string {
  if (tasks.length === 0) return pc.dim("  (no tasks)");
  const head = opts.withWorkstream
    ? ["id", "workstream", "status", "title", "impact", "effort", "ROI", "owner"]
    : ["id", "status", "title", "impact", "effort", "ROI", "owner"];
  const table = new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const t of tasks) {
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    const row = opts.withWorkstream
      ? [
          t.localId,
          t.workstream,
          colorStatus(t.status),
          t.title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.owner ?? pc.dim("—"),
        ]
      : [
          t.localId,
          colorStatus(t.status),
          t.title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.owner ?? pc.dim("—"),
        ];
    table.push(row);
  }
  return table.toString();
}

function colorStatus(status: TaskRow["status"]): string {
  switch (status) {
    case "OPEN":
      return pc.cyan(status);
    case "IN_PROGRESS":
      return pc.yellow(status);
    case "CLOSED":
      return pc.green(status);
  }
}

/**
 * Translate the conventional shell escapes \n / \t / \r / \\ in note text
 * into their literal characters. Lets shell callers pass multi-line
 * notes without bash-only $'\n' or printf gymnastics:
 *
 *   mu task note auth "FILES: a.rs:45\nDECISION: chose JWT"
 *
 * Backslashes are protected via a NUL placeholder so `\\n` stays as
 * a literal `\n` in the output rather than being processed twice.
 */
function unescapeNoteText(s: string): string {
  // Two-pass: first protect literal backslashes by swapping every `\\`
  // for an unlikely placeholder, then translate the remaining shell
  // escapes, then restore the placeholder as a single backslash.
  // Without the placeholder, `\\n` would yield a newline (wrong) instead
  // of a literal `\n`.
  const PLACEHOLDER = "\u{1F511}backslash\u{1F511}";
  return s
    .split("\\\\")
    .join(PLACEHOLDER)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .split(PLACEHOLDER)
    .join("\\");
}

/**
 * Optional `-w/--workstream <name>` scope check for verbs that target
 * a single task by ID. Globally-unique task IDs mean these verbs
 * could ignore the flag, but accepting it gives the operator a
 * sanity check ("yes, I think this task is in that workstream") and
 * raises a clear `TaskNotInWorkstreamError` instead of silently
 * acting on the task they didn't mean. No-op when `workstream` is
 * undefined or the task doesn't exist (downstream handler raises
 * `TaskNotFoundError` for the latter).
 */
function assertTaskInWorkstream(db: Db, taskId: string, workstream: string | undefined): void {
  if (!workstream) return;
  const task = getTask(db, taskId);
  if (task && task.workstream !== workstream) {
    throw new TaskNotInWorkstreamError(taskId, workstream, task.workstream);
  }
}

/**
 * Sister of `assertTaskInWorkstream` for verbs that target an agent
 * by name. Agent names are globally unique today (PK on agents.name),
 * so the `-w` flag is purely a scope check: operators think workstream-
 * first and `-w` turns silent wrong-target acts into clear
 * `AgentNotInWorkstreamError` (exit 4). No-op when `workstream` is
 * undefined or the agent doesn't exist (downstream handler raises
 * `AgentNotFoundError`).
 */
function assertAgentInWorkstream(db: Db, agentName: string, workstream: string | undefined): void {
  if (!workstream) return;
  const agent = getAgent(db, agentName);
  if (agent && agent.workstream !== workstream) {
    throw new AgentNotInWorkstreamError(agentName, workstream, agent.workstream);
  }
}

/**
 * Sister helper for verbs targeting an approval by slug. Slugs are
 * globally unique (PK on approvals.slug); `-w` lets operators assert
 * the workstream the approval was opened against. Mismatch raises
 * `ApprovalNotInWorkstreamError` (exit 4).
 */
function assertApprovalInWorkstream(db: Db, slug: string, workstream: string | undefined): void {
  if (!workstream) return;
  const approval = getApproval(db, slug);
  if (approval && approval.workstream !== workstream) {
    throw new ApprovalNotInWorkstreamError(slug, workstream, approval.workstream);
  }
}

async function cmdTaskNote(
  db: Db,
  localId: string,
  content: string,
  opts: { workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const note = addNote(db, localId, unescapeNoteText(content));
  console.log(pc.dim(`note #${note.id} appended to ${localId}`));
}

async function cmdTaskClose(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  const r = closeTask(db, localId, sdkOpts);
  if (!r.changed) {
    console.log(pc.dim(`${localId} already CLOSED (no-op)`));
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Closed ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
}

async function cmdTaskOpen(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  const r = openTask(db, localId, sdkOpts);
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN (no-op)`));
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Reopened ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
}

interface TreeOpts {
  /** Show dependents (what this task blocks) instead of blockers. */
  down?: boolean;
  json?: boolean;
  workstream?: string;
}

/** JSON shape: each node carries its full TaskRow plus a recursive
 *  `children` array (whose contents depend on direction — blockers if
 *  --no-down, dependents if --down). Diamond-recurrent nodes carry
 *  `recurrence: true` and an empty `children` (instead of expanding). */
interface TreeJsonNode {
  task: TaskRow;
  recurrence?: true;
  children: TreeJsonNode[];
}

async function cmdTaskTree(db: Db, rootId: string, opts: TreeOpts): Promise<void> {
  assertTaskInWorkstream(db, rootId, opts.workstream);
  const root = getTask(db, rootId);
  if (!root) throw new TaskNotFoundError(rootId);
  const down = opts.down ?? false;
  const seen = new Set<string>([rootId]);

  if (opts.json) {
    const node: TreeJsonNode = { task: root, children: buildJsonTree(db, rootId, down, seen) };
    emitJson({ direction: down ? "dependents" : "blockers", root: node });
    return;
  }

  const direction = down ? "dependents" : "blockers";
  const swapHint = down ? "swap to --no-down for blockers" : "--down for dependents";
  console.log(pc.bold(`Tree of ${rootId}  ${pc.dim(`(${direction} below; ${swapHint})`)}`));
  console.log(formatTreeNodeLabel(root));
  // Global "already rendered" set: a node visited once gets its full
  // subtree drawn; subsequent visits (in a DAG diamond) print a one-line
  // recurrence marker and don't recurse. Schema forbids cycles, so this
  // only fires on diamonds in practice; double-edged as defence against
  // future bugs.
  renderTree(db, rootId, "", down, seen);
}

function buildJsonTree(db: Db, taskId: string, down: boolean, seen: Set<string>): TreeJsonNode[] {
  const edges = getTaskEdges(db, taskId);
  const childIds = down ? edges.dependents : edges.blockers;
  const out: TreeJsonNode[] = [];
  for (const childId of childIds) {
    const child = getTask(db, childId);
    if (!child) continue;
    if (seen.has(childId)) {
      out.push({ task: child, recurrence: true, children: [] });
      continue;
    }
    seen.add(childId);
    out.push({ task: child, children: buildJsonTree(db, childId, down, seen) });
  }
  return out;
}

function renderTree(
  db: Db,
  taskId: string,
  prefix: string,
  down: boolean,
  seen: Set<string>,
): void {
  const edges = getTaskEdges(db, taskId);
  const children = down ? edges.dependents : edges.blockers;
  if (children.length === 0) return;

  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    if (childId === undefined) continue;
    const isLast = i === children.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    const child = getTask(db, childId);
    if (!child) {
      // Defensive: schema FKs prevent this, but the cascade-on-delete
      // could in theory race a sibling read. Render a clear marker.
      console.log(`${prefix}${branch}${pc.red(`${childId}  (missing!)`)}`);
      continue;
    }

    if (seen.has(childId)) {
      console.log(
        `${prefix}${branch}${formatTreeNodeLabel(child)}  ${pc.dim("(↻ already shown above)")}`,
      );
      continue;
    }

    console.log(`${prefix}${branch}${formatTreeNodeLabel(child)}`);
    seen.add(childId);
    renderTree(db, childId, childPrefix, down, seen);
  }
}

function formatTreeNodeLabel(t: TaskRow): string {
  return `${pc.bold(t.localId)}  ${colorStatus(t.status)}  ${pc.dim(t.title)}`;
}

async function cmdTaskShow(
  db: Db,
  localId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const task = getTask(db, localId);
  if (!task) throw new TaskNotFoundError(localId);
  const edges = getTaskEdges(db, localId);
  const notes = listNotes(db, localId);

  if (opts.json) {
    emitJson({
      task: withRoi(task),
      blockers: edges.blockers,
      dependents: edges.dependents,
      notes,
    });
    return;
  }

  const roi = task.effortDays > 0 ? (task.impact / task.effortDays).toFixed(1) : "∞";
  console.log(pc.bold(`${task.localId}  —  ${task.title}`));
  console.log(`  workstream : ${task.workstream}`);
  console.log(`  status     : ${task.status}`);
  console.log(`  owner      : ${task.owner ?? pc.dim("(unowned)")}`);
  console.log(`  impact     : ${task.impact}`);
  console.log(`  effort     : ${task.effortDays}  ${pc.dim(`(ROI ${roi})`)}`);
  console.log(`  created    : ${pc.dim(task.createdAt)}`);
  console.log(`  updated    : ${pc.dim(task.updatedAt)}`);

  console.log("");
  console.log(pc.bold("Edges"));
  console.log(
    `  blocked by : ${edges.blockers.length === 0 ? pc.dim("—") : edges.blockers.join(", ")}`,
  );
  console.log(
    `  blocks     : ${edges.dependents.length === 0 ? pc.dim("—") : edges.dependents.join(", ")}`,
  );

  console.log("");
  console.log(pc.bold(`Notes (${notes.length})`));
  if (notes.length === 0) {
    console.log(pc.dim("  (no notes)"));
  } else {
    for (const n of notes) printNote(n);
  }
}

async function cmdTaskNotes(
  db: Db,
  localId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  if (!getTask(db, localId)) throw new TaskNotFoundError(localId);
  const notes = listNotes(db, localId);
  if (opts.json) {
    emitJson(notes);
    return;
  }
  if (notes.length === 0) {
    console.log(pc.dim(`(no notes on ${localId})`));
    return;
  }
  for (const n of notes) printNote(n);
}

function printNote(n: TaskNoteRow): void {
  const author = n.author ?? "<orchestrator>";
  console.log(`  ${pc.dim(`#${n.id} ${n.createdAt}`)}  ${pc.bold(author)}`);
  for (const line of n.content.split("\n")) {
    console.log(`    ${line}`);
  }
}

async function cmdTaskRelease(
  db: Db,
  localId: string,
  opts: { reopen?: boolean; evidence?: string; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts: { reopen: boolean; evidence?: string } = { reopen: opts.reopen ?? false };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = releaseTask(db, localId, sdkOpts);
  if (!r.changed) {
    console.log(pc.dim(`${localId} already unowned (no-op)`));
    return;
  }
  const ownerBit = r.previousOwner ? `was ${pc.bold(r.previousOwner)}` : "was unowned";
  const statusBit = r.previousStatus !== r.status ? ` (${r.previousStatus} → ${r.status})` : "";
  console.log(`Released ${pc.bold(localId)} ${pc.dim(`(${ownerBit})${statusBit}`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
}

async function cmdClaim(
  db: Db,
  localId: string,
  opts: { for?: string; evidence?: string; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts: { agentName?: string; evidence?: string } = {};
  if (opts.for) sdkOpts.agentName = opts.for;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const result = await claimTask(db, localId, sdkOpts);
  console.log(
    `Claimed ${pc.bold(localId)} for ${pc.bold(result.owner)} ${pc.dim(`(${result.previousStatus} → ${result.status})`)}`,
  );
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
}

async function cmdTaskBlock(
  db: Db,
  blocked: string,
  opts: { by: string; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = addBlockEdge(db, blocked, opts.by);
  if (!r.added) {
    console.log(pc.dim(`${opts.by} → ${blocked}: edge already exists (no-op)`));
    return;
  }
  console.log(`Added edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
}

async function cmdTaskUnblock(
  db: Db,
  blocked: string,
  opts: { by: string; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = removeBlockEdge(db, blocked, opts.by);
  if (!r.removed) {
    console.log(pc.dim(`${opts.by} → ${blocked}: no such edge (no-op)`));
    return;
  }
  console.log(`Removed edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
}

async function cmdTaskDelete(
  db: Db,
  localId: string,
  opts: { workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const r = deleteTask(db, localId);
  if (!r.deleted) {
    console.log(pc.dim(`no task named ${localId} (already deleted?)`));
    return;
  }
  console.log(
    `Deleted ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
  );
}

async function cmdTaskUpdate(
  db: Db,
  localId: string,
  opts: { title?: string; impact?: number; effortDays?: number; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const updateOpts: UpdateTaskOptions = {};
  if (opts.title !== undefined) updateOpts.title = opts.title;
  if (opts.impact !== undefined) updateOpts.impact = opts.impact;
  if (opts.effortDays !== undefined) updateOpts.effortDays = opts.effortDays;
  if (Object.keys(updateOpts).length === 0) {
    throw new UsageError(
      "nothing to update; pass at least one of --title, --impact, --effort-days",
    );
  }
  const r = updateTask(db, localId, updateOpts);
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
}

async function cmdTaskReparent(
  db: Db,
  localId: string,
  opts: { blocks: string; workstream?: string },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const blockers = opts.blocks
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = reparentTask(db, localId, blockers);
  console.log(
    `Reparented ${pc.bold(localId)} ${pc.dim(`(removed ${r.removedEdges} edges, added ${r.addedEdges})`)}`,
  );
}

// ─── mu log (write + read + tail) ───────────────────────────────────

interface LogReadOpts {
  workstream?: string;
  allWorkstreams?: boolean;
  since?: number;
  lines?: number;
  source?: string;
  kind?: string;
  json?: boolean;
  tail?: boolean;
}

interface LogWriteOpts {
  workstream?: string;
  as?: string;
  kind?: string;
}

/**
 * The `mu log` verb is overloaded: with a positional <text>, write
 * an entry; without, read the log (optionally tailing).
 */
async function cmdLog(
  db: Db,
  text: string | undefined,
  opts: LogReadOpts & LogWriteOpts,
): Promise<void> {
  if (text !== undefined && text.length > 0) {
    await cmdLogWrite(db, text, opts);
    return;
  }
  await cmdLogRead(db, opts);
}

/**
 * Resolve who/where this log entry belongs to:
 *   --as <name>      explicit override; workstream still resolved below
 *   $TMUX_PANE       agent name + workstream from the agent row
 *   else             source = 'user', workstream from -w / $MU_SESSION /
 *                    tmux session, or null if none of those resolve
 */
async function resolveLogContext(
  db: Db,
  opts: { as?: string; workstream?: string },
): Promise<{ source: string; workstream: string | null }> {
  if (opts.as) {
    const workstream = opts.workstream ? opts.workstream : await resolveOptionalWorkstream();
    return { source: opts.as, workstream };
  }
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    const agent = getAgentByPane(db, paneId);
    if (agent) {
      return {
        source: agent.name,
        workstream: opts.workstream ?? agent.workstream,
      };
    }
  }
  const workstream = opts.workstream ?? (await resolveOptionalWorkstream());
  return { source: "user", workstream };
}

/** Like resolveWorkstream but returns null instead of throwing on miss. */
async function resolveOptionalWorkstream(): Promise<string | null> {
  try {
    return await resolveWorkstream(undefined);
  } catch {
    return null;
  }
}

async function cmdLogWrite(db: Db, text: string, opts: LogWriteOpts): Promise<void> {
  const ctx = await resolveLogContext(db, opts);
  const row = appendLog(db, {
    workstream: ctx.workstream,
    source: ctx.source,
    kind: opts.kind ?? "message",
    payload: text,
  });
  console.log(
    pc.dim(
      `seq ${row.seq}  workstream=${row.workstream ?? "—"}  source=${row.source}  kind=${row.kind}`,
    ),
  );
}

async function cmdLogRead(db: Db, opts: LogReadOpts): Promise<void> {
  const workstream = await logReadWorkstream(opts);
  const listOpts: ListLogsOptions = {};
  if (workstream !== undefined) listOpts.workstream = workstream;
  if (opts.source !== undefined) listOpts.source = opts.source;
  if (opts.kind !== undefined) listOpts.kind = opts.kind;

  if (opts.tail) {
    await cmdLogTail(db, listOpts, opts);
    return;
  }

  if (opts.since !== undefined) listOpts.since = opts.since;
  if (opts.lines !== undefined) listOpts.limit = opts.lines;
  // Default cap: latest 50 entries when no `since` and no `--lines`.
  if (opts.since === undefined && opts.lines === undefined) listOpts.limit = 50;

  const rows = listLogs(db, listOpts);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("(no log entries)"));
    return;
  }
  for (const row of rows) printLogRow(row);
}

/**
 * Resolve the `--workstream` filter for log reads:
 *   --all            → undefined (every workstream + machine-wide)
 *   --workstream X   → X
 *   $MU_SESSION etc. → the current workstream (default behaviour)
 *   none             → undefined (be permissive in read mode)
 */
async function logReadWorkstream(opts: LogReadOpts): Promise<string | undefined> {
  if (opts.allWorkstreams) return undefined;
  if (opts.workstream) return opts.workstream;
  const ws = await resolveOptionalWorkstream();
  return ws ?? undefined;
}

async function cmdLogTail(db: Db, baseOpts: ListLogsOptions, cliOpts: LogReadOpts): Promise<void> {
  // If --since wasn't given, start at "now" so the subscriber only sees
  // NEW entries. Pass `--since 0` to replay from the beginning.
  let cursor = cliOpts.since ?? latestSeq(db);
  if (!cliOpts.json) {
    console.log(
      pc.dim(
        `(tailing log; cursor=${cursor}; ${baseOpts.workstream ? `workstream=${baseOpts.workstream}` : "all workstreams"}; ctrl-c to exit)`,
      ),
    );
  }
  const intervalMs = Number(process.env.MU_LOG_TAIL_INTERVAL_MS ?? 1000);
  for (;;) {
    const rows = listLogs(db, { ...baseOpts, since: cursor });
    for (const row of rows) {
      if (cliOpts.json) emitJson(row);
      else printLogRow(row);
      cursor = row.seq;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function printLogRow(row: LogRow): void {
  const ws = row.workstream ?? pc.dim("—");
  const time = row.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const kindColor =
    row.kind === "event" ? pc.cyan : row.kind === "broadcast" ? pc.yellow : (s: string) => s;
  console.log(
    `${pc.dim(`#${row.seq}`)} ${pc.dim(time)}  ${pc.bold(row.source)}  ${kindColor(row.kind)}  [${ws}]  ${row.payload}`,
  );
}

// ─── mu doctor ───────────────────────────────────────────────────────────────────
async function cmdDoctor(db: Db): Promise<void> {
  console.log(pc.bold("mu doctor"));

  // ─ Environment
  console.log(pc.bold("\nenvironment"));
  try {
    const version = (await tmux(["-V"])).trim();
    console.log(`  tmux             : ${pc.green("ok")} (${version})`);
  } catch {
    console.log(`  tmux             : ${pc.red("NOT FOUND")} — install tmux ≥ 3.0`);
  }
  console.log(`  $TMUX            : ${process.env.TMUX ? pc.green("set") : pc.yellow("not set")}`);
  console.log(
    `  $TMUX_PANE       : ${process.env.TMUX_PANE ? pc.green(process.env.TMUX_PANE) : pc.dim("not set")}`,
  );
  console.log(
    `  $MU_SESSION      : ${process.env.MU_SESSION ? pc.green(process.env.MU_SESSION) : pc.dim("not set")}`,
  );

  // ─ DB + schema
  console.log(pc.bold("\ndb"));
  console.log(`  path             : ${pc.dim(defaultDbPath())}`);
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const expected = [
      "agent_logs",
      "agents",
      "approvals",
      "task_edges",
      "task_notes",
      "tasks",
      "vcs_workspaces",
      "workstreams",
    ];
    const missing = expected.filter((t) => !tables.includes(t));
    if (missing.length === 0) {
      console.log(`  schema           : ${pc.green("ok")} (${expected.length} tables)`);
    } else {
      console.log(`  schema           : ${pc.red("missing")} — ${missing.join(", ")}`);
    }
    const journal = db.pragma("journal_mode", { simple: true });
    console.log(
      `  journal_mode     : ${journal === "wal" ? pc.green(String(journal)) : pc.yellow(String(journal))}`,
    );
    const fk = db.pragma("foreign_keys", { simple: true });
    console.log(`  foreign_keys     : ${fk === 1 ? pc.green("on") : pc.red(`off (${fk})`)}`);
  } catch (err) {
    console.log(
      `  schema           : ${pc.red("FAIL")} — ${err instanceof Error ? err.message : err}`,
    );
  }

  // ─ Workstream auto-detect
  console.log(pc.bold("\nworkstream"));
  let currentWorkstream: string | null = null;
  try {
    currentWorkstream = await resolveWorkstream();
    console.log(`  current          : ${pc.green(currentWorkstream)}`);
  } catch {
    console.log(
      `  current          : ${pc.yellow("none")} (set $MU_SESSION, cd into an mu-<name> tmux session, or pass -w to a subcommand)`,
    );
  }

  // ─ Per-workstream stats (current only; --all stretch)
  if (currentWorkstream) {
    const ws = currentWorkstream;
    console.log(pc.bold(`\nstate (workstream=${ws})`));
    const counts = {
      agents: countWhere(db, "agents", "workstream", ws),
      tasks: countWhere(db, "tasks", "workstream", ws),
      ready: countReady(db, ws),
      blocked: countBlocked(db, ws),
      inProgress: (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks WHERE workstream = ? AND status = 'IN_PROGRESS'",
          )
          .get(ws) as { n: number }
      ).n,
      logs: (
        db.prepare("SELECT COUNT(*) AS n FROM agent_logs WHERE workstream = ?").get(ws) as {
          n: number;
        }
      ).n,
    };
    console.log(`  agents           : ${counts.agents}`);
    console.log(
      `  tasks            : ${counts.tasks} (ready ${counts.ready}, blocked ${counts.blocked}, in-progress ${counts.inProgress})`,
    );
    console.log(`  agent_logs rows  : ${counts.logs}`);

    // Reconciliation: ghost detection (DB rows with dead panes) + orphans.
    try {
      const view = await listLiveAgents(db, { workstream: ws });
      const ghostNote =
        view.report.prunedGhosts > 0
          ? pc.yellow(`pruned ${view.report.prunedGhosts} during this check`)
          : pc.green("none");
      console.log(`  ghosts           : ${ghostNote}`);
      const orphanColor = view.orphans.length > 0 ? pc.yellow : pc.green;
      console.log(
        `  orphan panes     : ${orphanColor(String(view.orphans.length))}${view.orphans.length > 0 ? pc.dim(" (run `mu agent list` to see them)") : ""}`,
      );
    } catch (err) {
      console.log(
        `  reconcile        : ${pc.dim("skipped")} (${err instanceof Error ? err.message : err})`,
      );
    }
  }
}

function countWhere(db: Db, table: string, column: string, value: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
      n: number;
    }
  ).n;
}
function countReady(db: Db, workstream: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM ready WHERE workstream = ?").get(workstream) as {
      n: number;
    }
  ).n;
}
function countBlocked(db: Db, workstream: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM blocked WHERE workstream = ?").get(workstream) as {
      n: number;
    }
  ).n;
}

// ─── mu approve (add / list / grant / deny / wait) ───────────────────
//
// Human-in-the-loop gate. An agent script that's about to do
// something irreversible:
//
//   slug=$(mu approve add --reason "delete the design task" --json | jq -r .slug)
//   if mu approve wait "$slug" --timeout 600; then
//     mu task delete design
//   else
//     echo "approval denied or timed out"; exit 1
//   fi
//
// The human grants/denies in another shell:
//   mu approve list                    # see pending
//   mu approve grant app_a1b2c3d4      # green-light it
//   mu approve deny  app_a1b2c3d4      # block it

async function cmdApprovalAdd(
  db: Db,
  opts: {
    slug?: string;
    reason: string;
    requestedBy?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const ws = opts.workstream ?? (await resolveOptionalWorkstream());
  const requestedBy = opts.requestedBy ?? (await resolveSelfNameOrUser(db));
  const addOpts: AddApprovalOptions = {
    workstream: ws,
    reason: opts.reason,
    requestedBy,
  };
  if (opts.slug !== undefined) addOpts.slug = opts.slug;
  const row = addApproval(db, addOpts);
  if (opts.json) {
    emitJson(row);
    return;
  }
  console.log(
    `Requested approval ${pc.bold(row.slug)} ${pc.dim(`(workstream=${row.workstream ?? "—"}, by ${row.requestedBy})`)}`,
  );
  console.log(pc.dim(`  reason: ${row.reason}`));
  console.log(pc.dim(`  next:   mu approve grant ${row.slug}   |   mu approve deny ${row.slug}`));
}

async function cmdApprovalList(
  db: Db,
  opts: { workstream?: string; status?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const listOpts: { workstream?: string; status?: ApprovalStatus } = {};
  if (!opts.all) {
    const ws = opts.workstream ?? (await resolveOptionalWorkstream());
    if (ws) listOpts.workstream = ws;
  }
  if (opts.status !== undefined) {
    if (!isApprovalStatus(opts.status)) {
      throw new UsageError(
        `--status must be one of pending|granted|denied|timeout (got ${JSON.stringify(opts.status)})`,
      );
    }
    listOpts.status = opts.status;
  }
  const rows = listApprovals(db, listOpts);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("(no approvals)"));
    return;
  }
  console.log(formatApprovalsTable(rows));
}

async function cmdApprovalGrant(
  db: Db,
  slug: string,
  opts: { by?: string; workstream?: string },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  const decidedBy = opts.by ?? (await resolveSelfNameOrUser(db));
  const row = grantApproval(db, slug, { decidedBy });
  console.log(`Granted ${pc.bold(slug)} ${pc.dim(`(by ${row.decidedBy})`)}`);
}

async function cmdApprovalDeny(
  db: Db,
  slug: string,
  opts: { by?: string; workstream?: string },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  const decidedBy = opts.by ?? (await resolveSelfNameOrUser(db));
  const row = denyApproval(db, slug, { decidedBy });
  console.log(`Denied ${pc.bold(slug)} ${pc.dim(`(by ${row.decidedBy})`)}`);
}

async function cmdApprovalWait(
  db: Db,
  slug: string,
  opts: { timeout?: number; json?: boolean; workstream?: string },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  // --timeout in seconds for shell ergonomics; SDK takes ms.
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : 600_000;
  const row = await waitApproval(db, slug, { timeoutMs });
  if (opts.json) {
    emitJson(row);
  } else {
    console.log(
      `${pc.bold(slug)}: ${approvalStatusColor(row.status)} ${pc.dim(`(by ${row.decidedBy ?? "—"})`)}`,
    );
  }
  // Exit codes wire approval outcomes into shell control flow without
  // forcing the caller to parse output:
  //   0 = granted, 4 = denied (conflict semantically), 5 = timeout.
  if (row.status === "granted") return;
  if (row.status === "denied") process.exit(4);
  process.exit(5);
}

function isApprovalStatus(s: string): s is ApprovalStatus {
  return s === "pending" || s === "granted" || s === "denied" || s === "timeout";
}

function approvalStatusColor(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return pc.yellow(status);
    case "granted":
      return pc.green(status);
    case "denied":
      return pc.red(status);
    case "timeout":
      return pc.dim(status);
  }
}

function formatApprovalsTable(rows: readonly ApprovalRow[]): string {
  const table = new Table({
    head: ["slug", "workstream", "status", "requested_by", "decided_by", "reason", "created"].map(
      (h) => pc.bold(h),
    ),
    style: { head: [], border: [] },
  });
  for (const r of rows) {
    table.push([
      r.slug,
      r.workstream ?? pc.dim("—"),
      approvalStatusColor(r.status),
      r.requestedBy,
      r.decidedBy ?? pc.dim("—"),
      r.reason,
      pc.dim(r.createdAt),
    ]);
  }
  return table.toString();
}

/** Like resolveSelf but falls back to 'user' (no throw) when not in
 *  a managed pane. Used by approve add / grant / deny so an external
 *  shell caller doesn't have to pass --by/--requested-by every time. */
async function resolveSelfNameOrUser(db: Db): Promise<string> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return "user";
  const agent = getAgentByPane(db, paneId);
  return agent ? agent.name : "user";
}

async function cmdSql(db: Db, query: string): Promise<void> {
  // Read OR write — `mu sql` is the explicit escape hatch.
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("select") || lower.startsWith("with") || lower.startsWith("explain")) {
    const rows = db.prepare(trimmed).all();
    if (rows.length === 0) {
      console.log(pc.dim("(no rows)"));
      return;
    }
    // Pretty-print as a table.
    const first = rows[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    const table = new Table({ head: keys.map((k) => pc.bold(k)), style: { head: [] } });
    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      table.push(keys.map((k) => formatCell(obj[k])));
    }
    console.log(table.toString());
    console.log(pc.dim(`(${rows.length} row${rows.length === 1 ? "" : "s"})`));
  } else {
    const result = db.prepare(trimmed).run();
    console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
  }
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "string") return v;
  return String(v);
}

async function cmdMission(db: Db, opts: { workstream?: string; json?: boolean }): Promise<void> {
  // Bare `mu` with no resolvable workstream is a discovery moment, not
  // an error. Show what workstreams exist (or the empty-state hint) and
  // exit 0 so the user gets oriented instead of a stack-trace-shaped
  // failure. Explicit `mu -w <bad-name>` still errors via the path below.
  const workstream = opts.workstream ?? (await resolveOptionalWorkstream());
  if (workstream === null) {
    await cmdMissionNoWorkstream(db, opts);
    return;
  }
  // From here on, workstream is a string — explicit or resolved.
  const view = await listLiveAgents(db, { workstream });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream);

  if (opts.json) {
    emitJson({
      workstream,
      agents: view.agents,
      orphans: view.orphans,
      tracks,
      ready: withRoiAll(ready),
    });
    return;
  }

  console.log(pc.bold(`mu-${workstream}`));
  console.log("");
  console.log(pc.bold(`Agents (${view.agents.length})`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    console.log("");
    console.log(pc.yellow(`Orphan panes (${view.orphans.length})`));
    for (const orphan of view.orphans) {
      console.log(
        `  ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
  console.log("");
  console.log(pc.bold(`Tracks (${tracks.length})`));
  console.log(formatTracks(tracks));
  console.log("");
  console.log(pc.bold(`Ready (${ready.length})`));
  console.log(formatReadyTable(ready));
}

/**
 * Fallback when bare `mu` runs but no workstream resolves — not in a
 * tmux session, no `$MU_SESSION`, no `-w` flag. Show what workstreams
 * exist on this machine and a hint at next steps. Exit 0 (orientation,
 * not failure). For `--json`, emit a structured "unresolved" doc so
 * scripts can detect the case without parsing prose.
 */
async function cmdMissionNoWorkstream(db: Db, opts: { json?: boolean }): Promise<void> {
  const summaries = await listWorkstreams(db);
  if (opts.json) {
    emitJson({ workstream: null, workstreams: summaries });
    return;
  }
  console.log(pc.dim("(no workstream resolved from $MU_SESSION or current tmux session)"));
  console.log("");
  if (summaries.length === 0) {
    console.log("No workstreams exist yet.");
    console.log("");
    console.log("Create one with:");
    console.log(`  ${pc.bold("mu workstream init <name>")}`);
    console.log("");
    console.log(
      `Then ${pc.bold("tmux a -t mu-<name>")} to attach, or pass ${pc.bold("-w <name>")}`,
    );
    console.log("to subsequent commands.");
    return;
  }
  console.log(pc.bold(`Workstreams on this machine (${summaries.length})`));
  console.log(formatWorkstreamsTable(summaries));
  console.log("");
  console.log("Pick one with any of:");
  console.log(`  ${pc.bold("tmux a -t mu-<name>")}        # attach to its tmux session`);
  console.log(`  ${pc.bold("export MU_SESSION=<name>")}    # then bare \`mu\` resolves it`);
  console.log(
    `  ${pc.bold("mu -w <name>")} (and similarly: ${pc.bold("mu state -w <name>")}, etc.)`,
  );
}

// ─── Attach (helper, not in MVP §"9 verbs" but trivially useful) ──────

// ─── mu state ── canonical state card ───────────────────────────────
//
// One canonical document answering "what does an LLM look at first?".
// Composes existing reads into named slices so the LLM (or operator)
// has one place to look instead of running 6 separate verbs and
// stitching the output together.
//
// Designed JSON-first per Ilya's council critique: state cards as
// the default attention surface; SQL/raw verbs as the escape hatch
// underneath. The pretty-print form is a richer mission control —
// useful for humans, not authoritative.

async function cmdState(
  db: Db,
  opts: { workstream?: string; json?: boolean; events?: number },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const view = await listLiveAgents(db, { workstream });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream).sort(byRoiDesc);
  const blocked = listBlocked(db, workstream);
  const inProgress = (
    db
      .prepare(
        "SELECT * FROM tasks WHERE workstream = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC",
      )
      .all(workstream) as RawTaskRowForState[]
  ).map(rawTaskRowToTask);
  const recentClosed = (
    db
      .prepare(
        "SELECT * FROM tasks WHERE workstream = ? AND status = 'CLOSED' ORDER BY updated_at DESC LIMIT 5",
      )
      .all(workstream) as RawTaskRowForState[]
  ).map(rawTaskRowToTask);
  const workspaces = listWorkspaces(db, workstream);
  const eventLimit = opts.events ?? 20;
  const recentEvents = listLogs(db, { workstream, kind: "event", limit: eventLimit });

  // Flatten agents into a top-level array (matches `mu --json`
  // mission-control shape so callers can use `.agents | length`
  // without surprise). Orphans get their own top-level key. Real
  // footgun discovered in real use: an earlier shape was
  // `agents: { active, orphans }` so `.agents | length` returned 2
  // (the number of object keys) regardless of agent count.
  const card = {
    workstream,
    agents: view.agents,
    orphans: view.orphans,
    tracks,
    tasks: {
      ready: withRoiAll(ready),
      blocked: withRoiAll(blocked),
      in_progress: withRoiAll(inProgress),
      recent_closed: withRoiAll(recentClosed),
    },
    workspaces,
    recent_events: recentEvents,
  };

  if (opts.json) {
    emitJson(card);
    return;
  }

  console.log(pc.bold(`State of mu-${workstream}`));
  console.log("");
  console.log(pc.bold(`Agents (${view.agents.length} active, ${view.orphans.length} orphan)`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    for (const orphan of view.orphans) {
      console.log(
        `  ${pc.yellow("orphan")} ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
  console.log("");
  console.log(pc.bold(`Tracks (${tracks.length})`));
  console.log(formatTracks(tracks));
  console.log("");
  console.log(pc.bold(`Ready (${ready.length})`));
  console.log(ready.length === 0 ? pc.dim("  (none)") : formatTaskListTable(ready));
  console.log("");
  console.log(pc.bold(`In progress (${inProgress.length})`));
  console.log(inProgress.length === 0 ? pc.dim("  (none)") : formatTaskListTable(inProgress));
  console.log("");
  console.log(pc.bold(`Blocked (${blocked.length})`));
  console.log(blocked.length === 0 ? pc.dim("  (none)") : formatTaskListTable(blocked));
  console.log("");
  console.log(pc.bold(`Recent closed (${recentClosed.length})`));
  console.log(recentClosed.length === 0 ? pc.dim("  (none)") : formatTaskListTable(recentClosed));
  console.log("");
  console.log(pc.bold(`Workspaces (${workspaces.length})`));
  if (workspaces.length === 0) {
    console.log(pc.dim("  (none)"));
  } else {
    console.log(formatWorkspacesTable(workspaces));
  }
  console.log("");
  console.log(pc.bold(`Recent events (last ${recentEvents.length} of kind=event)`));
  if (recentEvents.length === 0) {
    console.log(pc.dim("  (none)"));
  } else {
    for (const row of recentEvents) printLogRow(row);
  }
}

// Helper types/converters for state's IN_PROGRESS / recent_closed slices.
// We re-query the tasks table directly (with status + ordering not exposed
// by listTasks) so the column-name conversion lives here.
interface RawTaskRowForState {
  local_id: string;
  workstream: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  owner: string | null;
  created_at: string;
  updated_at: string;
}
function rawTaskRowToTask(r: RawTaskRowForState): TaskRow {
  return {
    localId: r.local_id,
    workstream: r.workstream,
    title: r.title,
    status: r.status as TaskRow["status"],
    impact: r.impact,
    effortDays: r.effort_days,
    owner: r.owner,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function cmdAttach(name: string, opts: { workstream?: string }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const sessionName = `mu-${workstream}`;
  if (!(await sessionExists(sessionName))) {
    throw new UsageError(`workstream "${workstream}" has no tmux session yet`);
  }
  // Verify the agent exists (open DB just for this).
  const db = openDb();
  try {
    const view = await listLiveAgents(db, { workstream });
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
  } finally {
    db.close();
  }
}

// ─── Numeric arg parser (for --impact, --effort-days) ────────────────

function parsePositiveNumber(value: string): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseImpact(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || n > 100) {
    throw new InvalidArgumentError(`expected 1..100, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseLines(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Parses a non-negative integer (0 is valid). Used for --since which
// uses 0 as the "replay everything" cursor.
function parseNonNegativeInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// ─── Program definition ───────────────────────────────────────────────
//
// Three namespaces (`workstream`, `agent`, `task`) plus three top-level
// utilities (`sql`, `doctor`, and the bare `mu` mission-control default).
//
// Every flag is declared on the subcommand that consumes it — there is
// NO root --workstream that subcommands inherit via optsWithGlobals(),
// which previously was the source of "flag at the wrong level" bugs.
//
// Bare `mu` (mission control) takes no flags. To target a different
// workstream than the one the current shell is in, use `MU_SESSION=foo
// mu` or `cd` into that workstream's tmux session.

// Reusable workstream flag declaration. Each subcommand that needs it
// gets its own copy via `.option(...WORKSTREAM_OPT)` so there is no
// cross-command leakage.
const WORKSTREAM_OPT = [
  "-w, --workstream <name>",
  "workstream (defaults to $MU_SESSION or the current tmux session minus mu- prefix)",
] as const;

// Reusable --json flag for every read verb. Output shape is documented
// per-verb but follows a consistent pattern: collections → JSON arrays;
// single entities → JSON objects. Empty results print `[]` (collections)
// or `null` (single-entity reads with no match — currently none, since
// every "single" verb errors on miss). Pretty-printing is OFF; one
// document per line so output is grep/jq friendly.
const JSON_OPT = ["--json", "emit machine-readable JSON instead of a table"] as const;

/** Stable JSON output: one line, no trailing newline beyond console.log's. */
function emitJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

/**
 * Read the package version from the shipped package.json. Works for
 * both source mode (src/cli.ts → ../package.json) and bundled mode
 * (dist/cli.js → ../package.json), since both layouts have package.json
 * exactly one directory up. Avoids hand-bumping a string literal in
 * code on every release.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("mu")
    .description(
      "Persistent crew of AI agents in tmux panes coordinated through a built-in task DAG.",
    )
    .version(readPackageVersion())
    .helpOption("-h, --help")
    .showHelpAfterError()
    // Without this, `mu task list --json` would bind --json to the
    // program (where we declare it for the bare `mu --json` mission-
    // control case) instead of the `list` subcommand. With it,
    // options before a subcommand bind to the program; options after
    // bind to the subcommand. Subcommands inherit it automatically.
    .enablePositionalOptions()
    // Default action when no subcommand is given: mission control.
    // Workstream resolves via the standard chain (-w > $MU_SESSION >
    // current tmux session); when none of those resolve, falls back
    // to a workstreams-discovery view instead of erroring. Accepts
    // --json so scripts can drive the same picture programmatically.
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdMission(db, opts))();
    });

  // ─── workstream ─────────────────────────────────────────────────────

  const workstream = program.command("workstream").description("Workstream-level commands");

  workstream
    .command("init <name>")
    .description("Create the workstream's tmux session and register it in the DB")
    .action((name: string) => handle((db) => cmdInit(db, name))());

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
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; yes?: boolean };
      return handle((db) => cmdDestroy(db, opts))();
    });

  // ─── agent ──────────────────────────────────────────────────────────

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
    .action(function (name: string) {
      const opts = (this as Command).opts() as SpawnOpts;
      return handle((db) => cmdSpawn(db, name, opts))();
    });

  agent
    .command("send <name> <text>")
    .description("Send text to an agent's pane (bracketed-paste protocol)")
    .option(...WORKSTREAM_OPT)
    .action(function (name: string, text: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdSend(db, name, text, opts))();
    });

  agent
    .command("read <name>")
    .description("Read an agent's pane scrollback")
    .option("-n, --lines <n>", "show last N lines (default: full scrollback)", parseLines)
    .option(...WORKSTREAM_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { lines?: number; workstream?: string };
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
      "Kill an agent's pane and remove its registry row. Does NOT touch the workspace; run `mu workspace free <agent>` separately to remove the on-disk dir.",
    )
    .option(...WORKSTREAM_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdClose(db, name, opts))();
    });

  agent
    .command("free <name>")
    .description(
      "Mark an agent's status as 'free' (idempotent). Pane untouched; reconcile flips back to busy on real activity.",
    )
    .option(...WORKSTREAM_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdFree(db, name, opts))();
    });

  agent
    .command("attach <name>")
    .description("Print an agent's full scrollback and the tmux command to attach")
    .option(...WORKSTREAM_OPT)
    .action(async function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      try {
        await cmdAttach(name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof AgentNotFoundError) {
          console.error(pc.red(`not found: ${msg}`));
          process.exit(3);
        }
        console.error(pc.red(`error: ${msg}`));
        process.exit(1);
      }
    });

  // ─── task ───────────────────────────────────────────────────────────

  // ─── workspace ──────────────────────────────────────────────────────────

  const workspace = program
    .command("workspace")
    .description("VCS workspace commands (per-agent isolated working copies)");

  workspace
    .command("create <agent>")
    .description(
      "Create a fresh isolated working copy for an agent. Backend auto-detected (jj > sl > git > none) unless --backend overrides.",
    )
    .option("--backend <name>", "force a backend instead of auto-detecting (jj | sl | git | none)")
    .option("--from <ref>", "base the workspace on a specific commit / branch / changeset")
    .option("--project-root <path>", "override the project root to branch from (default: cwd)")
    .option(...WORKSTREAM_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        backend?: VcsBackendName;
        from?: string;
        projectRoot?: string;
        workstream?: string;
      };
      return handle((db) => cmdWorkspaceCreate(db, agent, opts))();
    });

  workspace
    .command("list")
    .description("List workspaces in the current workstream (--all spans every workstream)")
    .option("--all", "list workspaces across every workstream")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceList(db, opts))();
    });

  workspace
    .command("free <agent>")
    .description(
      "Tear down an agent's workspace. With --commit, attempt to auto-commit pending changes first; without it, pending changes are lost.",
    )
    .option("--commit", "auto-commit pending changes before removing the workspace")
    .option(...WORKSTREAM_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { commit?: boolean; workstream?: string };
      return handle((db) => cmdWorkspaceFree(db, agent, opts))();
    });

  workspace
    .command("path <agent>")
    .description(
      "Print the on-disk path of an agent's workspace. Usable as `cd $(mu workspace path foo)`.",
    )
    .option(...WORKSTREAM_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdWorkspacePath(db, agent, opts))();
    });

  const task = program.command("task").description("Task graph commands");

  task
    .command("add [id]")
    .description(
      "Add a task to the graph. The id positional is optional — if omitted, derived from --title via slugify (collisions get _2, _3, … suffixes).",
    )
    .requiredOption("-t, --title <title>", "task title")
    .requiredOption("-i, --impact <n>", "impact 1..100", parseImpact)
    .requiredOption("-e, --effort-days <days>", "effort in days (>0)", parsePositiveNumber)
    .option("-b, --blocks <ids>", "comma-separated list of blocker task ids")
    .option(...WORKSTREAM_OPT)
    .action(function (id: string | undefined) {
      const opts = (this as Command).opts() as {
        title: string;
        impact: number;
        effortDays: number;
        blocks?: string;
        workstream?: string;
      };
      return handle((db) => cmdTaskAdd(db, id, opts))();
    });

  task
    .command("list")
    .description("List every task in the current workstream (id, status, ROI, owner)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskList(db, opts))();
    });

  task
    .command("next")
    .description(
      "Show the next ready task(s) by ROI (impact / effort_days). The 'what should I do?' verb.",
    )
    .option("-n, --lines <k>", "how many top-K tasks to return (default 1)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
      };
      return handle((db) => cmdTaskNext(db, opts))();
    });

  task
    .command("ready")
    .description("List ready tasks (OPEN with all blockers CLOSED), sorted by ROI")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskReady(db, opts))();
    });

  task
    .command("blocked")
    .description("List blocked tasks (OPEN with at least one non-CLOSED blocker)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlocked(db, opts))();
    });

  task
    .command("goals")
    .description("List tasks with no dependents (graph endpoints; excludes CLOSED)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskGoals(db, opts))();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks currently owned by an agent (cross-workstream; agent names are global). Excludes CLOSED by default — pass --include-closed for the full historical owner list.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdTaskOwnedBy(db, agent, opts))();
    });

  task
    .command("search <pattern>")
    .description(
      "Substring search on task title and id (case-insensitive). Use --in-notes to also search note content; --all to span all workstreams.",
    )
    .option("--in-notes", "also search task_notes.content")
    .option("--all", "search across all workstreams (default: current)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (pattern: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        all?: boolean;
        inNotes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdTaskSearch(db, pattern, opts))();
    });

  task
    .command("note <id> <text>")
    .description("Append a note to a task")
    .option(...WORKSTREAM_OPT)
    .action(function (id: string, text: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdTaskNote(db, id, text, opts))();
    });

  task
    .command("show <id>")
    .description("Show a task: row + edges (blockers/dependents) + notes")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskShow(db, id, opts))();
    });

  task
    .command("tree <id>")
    .description(
      "ASCII tree of a task's blockers (default) or dependents (--down). Diamonds collapse to one render with an arrow marker.",
    )
    .option("--down", "render dependents (what this task blocks) instead of blockers")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as TreeOpts;
      return handle((db) => cmdTaskTree(db, id, opts))();
    });

  task
    .command("notes <id>")
    .description("List the notes attached to a task (oldest first)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskNotes(db, id, opts))();
    });

  // --evidence <text> on the four lifecycle verbs records what the
  // caller relied on (test output, command exit, observed file change)
  // in the auto-emitted event payload. The verb still trusts the
  // caller; the audit trail records what they said. First inch of
  // the "observed vs claimed state" distinction.
  const EVIDENCE_OPT = [
    "--evidence <text>",
    "record what the caller observed (e.g. 'tests pass: npm test exit 0'); appears verbatim in the event log",
  ] as const;

  task
    .command("close <id>")
    .description("Mark a task CLOSED (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { evidence?: string; workstream?: string };
      return handle((db) => cmdTaskClose(db, id, opts))();
    });

  task
    .command("open <id>")
    .description("Mark a task OPEN — e.g. to reopen something closed by mistake (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { evidence?: string; workstream?: string };
      return handle((db) => cmdTaskOpen(db, id, opts))();
    });

  task
    .command("release <id>")
    .description(
      "Clear a task's owner; pass --reopen to also flip status back to OPEN (idempotent)",
    )
    .option("--reopen", "also flip status back to OPEN")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        reopen?: boolean;
        evidence?: string;
        workstream?: string;
      };
      return handle((db) => cmdTaskRelease(db, id, opts))();
    });

  task
    .command("claim <id>")
    .description("Claim a task for the current agent (derived from pane title via $TMUX_PANE)")
    .option("-f, --for <agent>", "claim on behalf of an agent (overrides pane title)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .action(function (taskId: string) {
      const opts = (this as Command).opts() as {
        for?: string;
        evidence?: string;
        workstream?: string;
      };
      return handle((db) => cmdClaim(db, taskId, opts))();
    });

  task
    .command("block <blocked>")
    .description(
      "Add a blocking edge: <blocker> --by <id> blocks <blocked>. Validates same-workstream + cycle.",
    )
    .requiredOption("-b, --by <blocker>", "the task that should block <blocked>")
    .option(...WORKSTREAM_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string };
      return handle((db) => cmdTaskBlock(db, blocked, opts))();
    });

  task
    .command("unblock <blocked>")
    .description("Remove a single blocking edge (idempotent)")
    .requiredOption("-b, --by <blocker>", "the task whose blocker edge to remove")
    .option(...WORKSTREAM_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string };
      return handle((db) => cmdTaskUnblock(db, blocked, opts))();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task. Cascades to task_edges and task_notes via FK. Idempotent on missing.",
    )
    .option(...WORKSTREAM_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      return handle((db) => cmdTaskDelete(db, id, opts))();
    });

  task
    .command("update <id>")
    .description(
      "Update scalar fields on a task. Pass at least one of --title, --impact, --effort-days. Use close/open/release for status/owner changes.",
    )
    .option("-t, --title <title>", "new title")
    .option("-i, --impact <n>", "new impact 1..100", parseImpact)
    .option("-e, --effort-days <days>", "new effort in days (>0)", parsePositiveNumber)
    .option(...WORKSTREAM_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        title?: string;
        impact?: number;
        effortDays?: number;
        workstream?: string;
      };
      return handle((db) => cmdTaskUpdate(db, id, opts))();
    });

  task
    .command("reparent <id>")
    .description(
      "Atomically replace every incoming edge of <id> with the new --blocks list. Pass --blocks '' to clear all blockers.",
    )
    .requiredOption("-b, --blocks <ids>", "comma-separated blockers (empty string clears all)")
    .option(...WORKSTREAM_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { blocks: string; workstream?: string };
      return handle((db) => cmdTaskReparent(db, id, opts))();
    });

  // ─── self-identification (for agents inside panes) ───────────────────

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

  // ─── global utilities ───────────────────────────────────────────────

  // mu log — overloaded:
  //   mu log "text"            → write
  //   mu log                    → read latest 50
  //   mu log --tail             → blocking subscription (poll every 1s)
  //   mu log --since <seq>      → cursor read (everything after seq)
  program
    .command("log [text]")
    .description(
      "Write a log entry (with text) or read the log (without). --tail blocks and prints new entries as they land.",
    )
    .option("--as <name>", "override the source name (default: agent via $TMUX_PANE, else 'user')")
    .option("--kind <kind>", "kind tag (default: 'message' on write)")
    .option("--tail", "block and print entries as they're appended")
    .option(
      "--since <seq>",
      "return entries with seq strictly greater than this (use 0 to replay everything)",
      parseNonNegativeInt,
    )
    .option(
      "-n, --lines <n>",
      "cap to the latest N entries (default 50, no cap with --since)",
      parseLines,
    )
    .option("--source <name>", "filter by source")
    .option("--all", "read across every workstream (and machine-wide entries)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (text: string | undefined) {
      const raw = (this as Command).opts() as {
        as?: string;
        kind?: string;
        tail?: boolean;
        since?: number;
        lines?: number;
        source?: string;
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      const opts: LogReadOpts & LogWriteOpts = {};
      if (raw.as !== undefined) opts.as = raw.as;
      if (raw.kind !== undefined) opts.kind = raw.kind;
      if (raw.tail !== undefined) opts.tail = raw.tail;
      if (raw.since !== undefined) opts.since = raw.since;
      if (raw.lines !== undefined) opts.lines = raw.lines;
      if (raw.source !== undefined) opts.source = raw.source;
      if (raw.all !== undefined) opts.allWorkstreams = raw.all;
      if (raw.workstream !== undefined) opts.workstream = raw.workstream;
      if (raw.json !== undefined) opts.json = raw.json;
      return handle((db) => cmdLog(db, text, opts))();
    });

  // ─── mu approve (human-in-the-loop gate) ──────────────────────────

  const approve = program
    .command("approve")
    .description("Human-in-the-loop approvals for risky agent actions");

  approve
    .command("add")
    .description(
      "Request approval. Returns the slug (use --json for scripting). Default workstream is auto-detected; default requester is the calling agent (via $TMUX_PANE) or 'user'.",
    )
    .requiredOption("-r, --reason <text>", "what is being approved")
    .option("--slug <slug>", "override the auto-generated slug")
    .option("--requested-by <name>", "override the requester name")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        reason: string;
        slug?: string;
        requestedBy?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdApprovalAdd(db, opts))();
    });

  approve
    .command("list")
    .description(
      "List approvals in the current workstream. --status filters; --all spans every workstream.",
    )
    .option("--status <s>", "pending | granted | denied | timeout")
    .option("--all", "span every workstream")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        status?: string;
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdApprovalList(db, opts))();
    });

  approve
    .command("grant <slug>")
    .description("Grant a pending approval (sets status='granted')")
    .option("--by <name>", "override decider name (default: agent via $TMUX_PANE, else 'user')")
    .option(...WORKSTREAM_OPT)
    .action(function (slug: string) {
      const opts = (this as Command).opts() as { by?: string; workstream?: string };
      return handle((db) => cmdApprovalGrant(db, slug, opts))();
    });

  approve
    .command("deny <slug>")
    .description("Deny a pending approval (sets status='denied')")
    .option("--by <name>", "override decider name (default: agent via $TMUX_PANE, else 'user')")
    .option(...WORKSTREAM_OPT)
    .action(function (slug: string) {
      const opts = (this as Command).opts() as { by?: string; workstream?: string };
      return handle((db) => cmdApprovalDeny(db, slug, opts))();
    });

  approve
    .command("wait <slug>")
    .description("Block until the approval is decided. Exits 0 (granted), 4 (denied), 5 (timeout).")
    .option("--timeout <seconds>", "max seconds to wait (0 = forever, default 600)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (slug: string) {
      const opts = (this as Command).opts() as {
        timeout?: number;
        json?: boolean;
        workstream?: string;
      };
      return handle((db) => cmdApprovalWait(db, slug, opts))();
    });

  program
    .command("state")
    .description(
      "Canonical state card: agents + tracks + ready/in-progress/blocked/recent-closed tasks + workspaces + recent events. The 'what does an LLM look at first?' verb. JSON-first.",
    )
    .option(...WORKSTREAM_OPT)
    .option(
      "--events <n>",
      "how many recent kind=event log entries to include (default 20)",
      parseLines,
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        events?: number;
        json?: boolean;
      };
      return handle((db) => cmdState(db, opts))();
    });

  program
    .command("sql <query>")
    .description("Run a SQL query against the live mu DB (SELECT / UPDATE / DELETE all allowed)")
    .action((query: string) => handle((db) => cmdSql(db, query))());

  program
    .command("doctor")
    .description("Environment + state health check")
    .action(() => handle((db) => cmdDoctor(db))());

  return program;
}

// ─── Entry point ───────────────────────────────────────────────────────

// When invoked as `mu …` from the shell, parse argv. When imported (e.g.
// from tests), do nothing — buildProgram() is exported for direct use.
//
// Symlink-safe: when installed via `npm install -g .` the `mu` binary
// is a symlink (`/opt/homebrew/bin/mu → .../dist/cli.js`). `process.argv[1]`
// is the symlink path as given; `import.meta.url` is Node's resolved
// path (symlinks followed). Compare resolved-to-resolved by realpath-
// ing argv[1] first — otherwise the entry-point check fails silently
// and `mu --version` produces no output.
if (isMainEntrypoint()) {
  await buildProgram().parseAsync(process.argv);
}

function isMainEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = realpathSync(argv1);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    // realpath can fail for non-file argv[1]. Fall back to the naive
    // check, which works when no symlink is involved.
    return import.meta.url === pathToFileURL(argv1).href;
  }
}
