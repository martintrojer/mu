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
  type AdoptAgentOptions,
  type AdoptAgentResult,
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  type AgentRow,
  type AgentStatus,
  STATUS_EMOJI,
  WorkspacePreservedError,
  adoptAgent,
  closeAgent,
  freeAgent,
  getAgent,
  getAgentByPane,
  listLiveAgents,
  readAgent,
  refreshAgentTitle,
  resolveCliCommand,
  sendToAgent,
  spawnAgent,
  updateAgentStatus,
} from "./agents.js";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
} from "./approvals.js";
import {
  cmdApprovalAdd,
  cmdApprovalDeny,
  cmdApprovalGrant,
  cmdApprovalList,
  cmdApprovalWait,
} from "./cli/approve.js";
import { type LogReadOpts, type LogWriteOpts, cmdLog } from "./cli/log.js";
import { CURRENT_SCHEMA_VERSION, type Db, EXPECTED_TABLES, defaultDbPath, openDb } from "./db.js";
import { detectPiStatus } from "./detect.js";
import { type LogRow, listLogs } from "./logs.js";
import {
  type NextStep,
  hasNextSteps,
  isJsonMode,
  printNextSteps,
  printNextStepsTo,
} from "./output.js";
import { reconcile } from "./reconcile.js";
import {
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  type SnapshotRow,
  SnapshotVersionMismatchError,
  listSnapshots,
  restoreSnapshot,
  snapshotFileSize,
} from "./snapshots.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  type SearchTasksOptions,
  TASK_STATUS_LIST,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  type TaskNoteRow,
  type TaskRow,
  type TaskStatus,
  type TaskWaitResult,
  type UpdateTaskOptions,
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  closeTask,
  deferTask,
  deleteTask,
  getTask,
  getTaskEdges,
  idFromTitle,
  isTaskStatus,
  listBlocked,
  listGoals,
  listNotes,
  listReady,
  listTasks,
  listTasksByOwner,
  openTask,
  rejectTask,
  releaseTask,
  removeBlockEdge,
  reparentTask,
  resolveActorIdentity,
  searchTasks,
  updateTask,
  waitForTasks,
} from "./tasks.js";
import {
  PaneNotFoundError,
  TmuxError,
  capturePane,
  currentPaneSize,
  enableMuPaneBorders,
  enableMuPaneBordersForSession,
  getWindowIdForPane,
  listPanesInSession,
  listWindows,
  newSession,
  newWindow,
  sessionExists,
  tmux,
} from "./tmux.js";
import { type Track, getParallelTracks } from "./tracks.js";
import { type VcsBackendName, detectBackend } from "./vcs.js";
import {
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaceOrphans,
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
export async function resolveWorkstream(explicit?: string): Promise<string> {
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

/** Like resolveWorkstream but returns null instead of throwing on miss.
 *  Used by the read-permissive verbs (mu log, mu approve list, mu state,
 *  bare mu) where 'no workstream' is a legitimate state to render. */
export async function resolveOptionalWorkstream(): Promise<string | null> {
  try {
    return await resolveWorkstream(undefined);
  } catch {
    return null;
  }
}

// ─── Error handling ────────────────────────────────────────────────────

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Standard --status validation: case-insensitive, returns the
 *  canonical TaskStatus or throws UsageError naming every legal
 *  value. Centralised so adding a status updates every CLI surface
 *  at once (the OPEN | IN_PROGRESS | CLOSED list used to drift
 *  across `mu task list --status`, `mu task wait --status`, the
 *  --help text, and error messages). Source list lives in
 *  src/tasks.ts as TASK_STATUS_LIST. */
function parseStatusOption(raw: string, flag = "--status"): TaskStatus {
  const upper = raw.toUpperCase();
  if (!isTaskStatus(upper)) {
    throw new UsageError(`${flag} must be one of ${TASK_STATUS_LIST} (got ${JSON.stringify(raw)})`);
  }
  return upper;
}

/**
 * Map a typed error to (label, exitCode). The label is the prefix
 * before the message in human output (e.g. "conflict", "not found");
 * the exit code is what the process exits with.
 *
 * Order matters: more-specific classes first. The fallthrough at the
 * end is the generic exit-1 catch-all.
 */
function classifyError(err: unknown): { label: string; exitCode: number } {
  if (err instanceof UsageError || err instanceof WorkstreamNameInvalidError) {
    return { label: "error", exitCode: 2 };
  }
  if (
    err instanceof AgentNotFoundError ||
    err instanceof TaskNotFoundError ||
    err instanceof WorkspaceNotFoundError ||
    err instanceof ApprovalNotFoundError ||
    err instanceof SnapshotNotFoundError
  ) {
    return { label: "not found", exitCode: 3 };
  }
  if (
    err instanceof AgentExistsError ||
    err instanceof TaskExistsError ||
    err instanceof TaskAlreadyOwnedError ||
    err instanceof TaskNotInWorkstreamError ||
    err instanceof AgentNotInWorkstreamError ||
    err instanceof ApprovalNotInWorkstreamError ||
    err instanceof CycleError ||
    err instanceof TaskHasOpenDependentsError ||
    err instanceof CrossWorkstreamEdgeError ||
    err instanceof WorkspaceExistsError ||
    err instanceof WorkspacePathNotEmptyError ||
    err instanceof WorkspacePreservedError ||
    err instanceof ApprovalAlreadyDecidedError ||
    err instanceof ClaimerNotRegisteredError ||
    err instanceof SnapshotVersionMismatchError
  ) {
    return { label: "conflict", exitCode: 4 };
  }
  if (err instanceof AgentDiedOnSpawnError) {
    // Substrate-level failure (CLI exited at spawn). The message is
    // already rich (includes captured scrollback). Generic exit 1.
    return { label: "spawn failed", exitCode: 1 };
  }
  if (err instanceof TmuxError || err instanceof PaneNotFoundError) {
    return { label: "tmux", exitCode: 5 };
  }
  if (err instanceof SnapshotFileMissingError) {
    // Substrate-level: the .db file is gone but the row still says it
    // should be there. Same flavour as `tmux` errors above.
    return { label: "snapshot file missing", exitCode: 5 };
  }
  return { label: "error", exitCode: 1 };
}

/**
 * Emit a typed error to stderr. JSON mode (--json on the invocation)
 * produces a single-line { error, message, nextSteps, exitCode }
 * record so callers can pattern-match without parsing prose. Non-JSON
 * mode produces the prose label + message, then nextSteps as dim
 * indented lines (when the error class implements errorNextSteps()).
 */
/** Render error + nextSteps to stderr and return the resolved exit
 *  code. Returning the exitCode lets `handle` reuse it instead of
 *  re-classifying the same error twice (review_code_classify_error_called_twice). */
function emitError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const { label, exitCode } = classifyError(err);
  const errClass = err instanceof Error ? err.name : "Error";
  const steps: NextStep[] = hasNextSteps(err) ? err.errorNextSteps() : [];

  if (isJsonMode()) {
    process.stderr.write(
      `${JSON.stringify({
        error: errClass,
        message,
        nextSteps: steps,
        exitCode,
      })}\n`,
    );
    return exitCode;
  }

  console.error(pc.red(`${label}: ${message}`));
  if (steps.length > 0) {
    // Dim the next-step block so humans skim past; agents reading the
    // captured error still get them.
    printNextStepsTo(steps, "stderr");
  }
  return exitCode;
}

/** Wrap an async handler so typed errors become specific exit codes. */
function handle(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    let db: Db | undefined;
    try {
      db = openDb();
      await fn(db);
    } catch (err) {
      const exitCode = emitError(err);
      process.exit(exitCode);
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

/** Per-status colour for the table view. The glyph itself comes from
 *  STATUS_EMOJI in src/agents.ts — single source of truth so the
 *  table view and the pane-border / composeAgentTitle never drift
 *  (review_code_status_emoji_two_sources caught a 2-of-7 disagreement). */
const STATUS_COLORS: Record<AgentStatus, (s: string) => string> = {
  spawning: pc.yellow,
  busy: pc.cyan,
  needs_input: pc.dim,
  needs_permission: pc.magenta,
  free: pc.green,
  unreachable: pc.red,
  terminated: pc.dim,
};

function statusIcon(status: AgentStatus): string {
  return STATUS_COLORS[status](STATUS_EMOJI[status]);
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
  // Sort by ROI descending.
  const sorted = [...tasks].sort((a, b) => b.impact / b.effortDays - a.impact / a.effortDays);
  // Same title-truncation treatment as formatTaskListTable so the
  // mission-control table doesn't blow out terminal width.
  let idW = "id".length;
  let impactW = "impact".length;
  let effortW = "effort".length;
  let roiW = "ROI".length;
  let ownerW = "owner".length;
  for (const t of sorted) {
    idW = Math.max(idW, t.localId.length);
    impactW = Math.max(impactW, String(t.impact).length);
    effortW = Math.max(effortW, String(t.effortDays).length);
    const roi = (t.impact / t.effortDays).toFixed(1);
    roiW = Math.max(roiW, roi.length);
    ownerW = Math.max(ownerW, (t.owner ?? "").length);
  }
  const padding = 6 * 3 + 1; // 6 cols
  const titleBudget = Math.max(
    20,
    terminalWidth() - (idW + impactW + effortW + roiW + ownerW) - padding,
  );

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
  for (const t of sorted) {
    const roi = (t.impact / t.effortDays).toFixed(1);
    table.push([
      t.localId,
      truncate(t.title, titleBudget),
      String(t.impact),
      String(t.effortDays),
      roi,
      t.owner ?? "",
    ]);
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

/** One agent_logs row, human-formatted. Used by `mu log` (read + tail)
 *  and by the `recent events` section of `mu state`. Exported so the
 *  cli/log.ts module can reuse it. */
export function printLogRow(row: LogRow): void {
  const ws = row.workstream ?? pc.dim("—");
  const time = row.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const kindColor =
    row.kind === "event" ? pc.cyan : row.kind === "broadcast" ? pc.yellow : (s: string) => s;
  console.log(
    `${pc.dim(`#${row.seq}`)} ${pc.dim(time)}  ${pc.bold(row.source)}  ${kindColor(row.kind)}  [${ws}]  ${row.payload}`,
  );
}

// ─── Verb implementations ──────────────────────────────────────────────

async function cmdInit(db: Db, name: string, opts: { json?: boolean } = {}): Promise<void> {
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

async function cmdDestroy(
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
async function cmdSpawn(db: Db, name: string, opts: SpawnOpts): Promise<void> {
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
  const workspace = opts.workspace ? getWorkspaceForAgent(db, name) : undefined;
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

async function cmdSend(
  db: Db,
  name: string,
  text: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  await sendToAgent(db, name, text);
  const ws = await resolveWorkstream(opts.workstream);
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

async function cmdRead(
  db: Db,
  name: string,
  opts: { lines?: number; workstream?: string; json?: boolean },
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const text = await readAgent(db, name, opts.lines !== undefined ? { lines: opts.lines } : {});
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
    json?: boolean;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const createOpts: Parameters<typeof createWorkspace>[1] = { agent, workstream };
  if (opts.backend !== undefined) createOpts.backend = opts.backend;
  if (opts.from !== undefined) createOpts.parentRef = opts.from;
  if (opts.projectRoot !== undefined) createOpts.projectRoot = opts.projectRoot;
  const ws = await createWorkspace(db, createOpts);
  const nextSteps: NextStep[] = [
    { intent: "cd into the workspace", command: `cd $(mu workspace path ${agent})` },
    {
      intent: "Free it later (with optional --commit)",
      command: `mu workspace free ${agent}  (--commit to commit pending changes first)`,
    },
    {
      intent: "Spawn an agent that uses this workspace as cwd",
      command: `mu agent spawn <name> -w ${workstream} --workspace`,
    },
  ];
  if (opts.json) {
    emitJson({ workspace: ws, nextSteps });
    return;
  }
  console.log(
    `Created workspace ${pc.bold(ws.path)} ${pc.dim(`(backend=${ws.backend}, agent=${ws.agent}, parent=${ws.parentRef ?? "—"})`)}`,
  );
  printNextSteps(nextSteps);
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
  opts: { commit?: boolean; workstream?: string; json?: boolean },
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false });
  if (opts.json) {
    emitJson({ agent, ...r });
    return;
  }
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
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = getWorkspaceForAgent(db, agent);
  if (!ws) throw new WorkspaceNotFoundError(agent);
  if (opts.json) {
    emitJson({ agent, path: ws.path, backend: ws.backend });
    return;
  }
  // Print just the path, no decoration: usable for `cd $(mu workspace path X)`.
  console.log(ws.path);
}

async function cmdWorkspaceOrphans(
  db: Db,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const orphans = listWorkspaceOrphans(db, workstream);
  const nextSteps: NextStep[] =
    orphans.length === 0
      ? []
      : [
          {
            intent: "Remove a specific orphan dir (git: also prunes worktree registry)",
            command: `(cd <project-root> && git worktree remove --force ${orphans[0]?.path}) || rm -rf ${orphans[0]?.path}`,
          },
          {
            intent: "Adopt the dir as a managed workspace",
            command: "mu workspace adopt  (deferred; see roadmap)",
          },
        ];
  if (opts.json) {
    emitJson({ workstream, orphans, nextSteps });
    return;
  }
  if (orphans.length === 0) {
    console.log(pc.dim(`(no orphan workspace dirs in ${workstream})`));
    return;
  }
  console.log(pc.yellow(`${orphans.length} orphan workspace dir(s) in ${pc.bold(workstream)}:`));
  for (const o of orphans) {
    console.log(`  ${pc.bold(o.agent)}  ${pc.dim(o.path)}`);
  }
  printNextSteps(nextSteps);
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

async function cmdClose(
  db: Db,
  name: string,
  opts: { workstream?: string; json?: boolean; discardWorkspace?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const result = await closeAgent(
    db,
    name,
    opts.discardWorkspace === true ? { discardWorkspace: true } : {},
  );
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

async function cmdAdopt(db: Db, paneOrTitle: string, opts: AdoptCliOpts): Promise<void> {
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
  await refreshAgentTitle(db, result.agent.name);

  // Window-scoped border for the adopted pane's window. (cmdInit set
  // it on _mu but adopted panes can be in any window.)
  if (process.env.MU_BANNER_QUIET !== "1") {
    const wid = await getWindowIdForPane(paneId).catch(() => undefined);
    if (wid) await enableMuPaneBorders(wid).catch(() => {});
  }

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

async function cmdFree(
  db: Db,
  name: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, name, opts.workstream);
  const r = freeAgent(db, name);
  if (r.changed) await refreshAgentTitle(db, name);
  const ws = await resolveWorkstream(opts.workstream);
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

async function cmdTaskAdd(
  db: Db,
  localId: string | undefined,
  opts: {
    title: string;
    impact: number;
    effortDays: number;
    blockedBy?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Derive the id from the title if the user didn't provide one. The
  // CLI's `<id>` positional is now optional; idFromTitle handles
  // collisions with `_2`, `_3`, … suffixes.
  const id = localId ?? idFromTitle(db, workstream, opts.title);
  const blockedBy = opts.blockedBy
    ? opts.blockedBy
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
    ...(blockedBy ? { blockedBy } : {}),
  });
  const nextSteps: NextStep[] = [
    { intent: "Show this task", command: `mu task show ${task.localId} -w ${workstream}` },
    {
      // Single-quoted example: shell metachars (`...`, $VAR, $(...))
      // inside a double-quoted string expand in YOUR shell before mu
      // sees the note (mufeedback note #257). Single quotes defer
      // expansion to the agent.
      intent: "Drop a note (single-quote to defer shell expansion)",
      command: `mu task note ${task.localId} '...' -w ${workstream}`,
    },
    {
      intent: "Add a blocker",
      command: `mu task block ${task.localId} --by <other-id> -w ${workstream}`,
    },
    {
      intent: "Claim and start",
      command: `mu task claim ${task.localId} -w ${workstream} --self  (or --for <worker>)`,
    },
  ];
  if (opts.json) {
    emitJson({ task: withRoi(task), blockers: blockedBy ?? [], nextSteps });
    return;
  }
  const idHint = localId === undefined ? pc.dim(" (id derived from title)") : "";
  console.log(
    `Added task ${pc.bold(task.localId)}${idHint} ${pc.dim(
      `(workstream=${workstream}, impact=${task.impact}, effort=${task.effortDays})`,
    )}`,
  );
  if (blockedBy) console.log(pc.dim(`  blocked by: ${blockedBy.join(", ")}`));
  printNextSteps(nextSteps);
}

async function cmdTaskList(
  db: Db,
  opts: { workstream?: string; json?: boolean; status?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const listOpts: Parameters<typeof listTasks>[2] = {};
  if (opts.status !== undefined) {
    listOpts.status = parseStatusOption(opts.status);
  }
  const tasks = listTasks(db, workstream, listOpts);
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

/**
 * Default fallback when stdout isn't a TTY (e.g. output is piped to
 * less/jq) and `process.stdout.columns` is undefined. 100 fits an 80-col
 * terminal with some breathing room; 100 is wide enough to keep most
 * rows on one line.
 */
const DEFAULT_TERMINAL_WIDTH = 100;

/** Truncate `s` to fit `max` columns (counting display width as length;
 *  good enough for ASCII titles, undercount for emoji/CJK — acceptable
 *  trade-off given the terminal will visually clip anyway). Adds an
 *  ellipsis when truncated. */
function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, max);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
}

function formatTaskListTable(
  tasks: readonly TaskRow[],
  opts: { withWorkstream?: boolean } = {},
): string {
  if (tasks.length === 0) return pc.dim("  (no tasks)");
  const head = opts.withWorkstream
    ? ["id", "workstream", "status", "title", "impact", "effort", "ROI", "owner"]
    : ["id", "status", "title", "impact", "effort", "ROI", "owner"];

  // Compute a budget for the title column so the table fits the terminal.
  // Other columns are mostly short fixed-shape values; figure out how
  // wide they actually are, sum them up, and give title the leftover.
  const otherCols = opts.withWorkstream
    ? (["localId", "workstream", "status", "impact", "effortDays", "roi", "owner"] as const)
    : (["localId", "status", "impact", "effortDays", "roi", "owner"] as const);
  const widths = new Map<string, number>();
  for (const col of otherCols) widths.set(col, col.length); // header is the floor
  for (const t of tasks) {
    widths.set("localId", Math.max(widths.get("localId") ?? 0, t.localId.length));
    if (opts.withWorkstream) {
      widths.set("workstream", Math.max(widths.get("workstream") ?? 0, t.workstream.length));
    }
    widths.set("status", Math.max(widths.get("status") ?? 0, t.status.length));
    widths.set("impact", Math.max(widths.get("impact") ?? 0, String(t.impact).length));
    widths.set("effortDays", Math.max(widths.get("effortDays") ?? 0, String(t.effortDays).length));
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    widths.set("roi", Math.max(widths.get("roi") ?? 0, roi.length));
    widths.set("owner", Math.max(widths.get("owner") ?? 0, (t.owner ?? "—").length));
  }
  // cli-table3 adds 2 chars of padding per cell + 1 char border per
  // column. Account for that to find the title budget.
  const numCols = head.length;
  const otherTotal = otherCols.reduce((acc, c) => acc + (widths.get(c) ?? 0), 0);
  const padding = numCols * 3 + 1;
  const titleBudget = Math.max(20, terminalWidth() - otherTotal - padding);

  const table = new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
  });
  for (const t of tasks) {
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    const title = truncate(t.title, titleBudget);
    const row = opts.withWorkstream
      ? [
          t.localId,
          t.workstream,
          colorStatus(t.status),
          title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.owner ?? pc.dim("—"),
        ]
      : [
          t.localId,
          colorStatus(t.status),
          title,
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
    case "REJECTED":
      return pc.red(status);
    case "DEFERRED":
      return pc.dim(status);
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

async function cmdTaskNote(
  db: Db,
  localId: string,
  content: string,
  opts: { workstream?: string; json?: boolean; author?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  // Author resolution: explicit --author wins; otherwise consult
  // MU_AGENT_NAME (env var injected at spawn) > pane title > $USER >
  // 'orchestrator'. Surfaced from mufeedback note #176: notes from
  // spawned agents were appearing as <orchestrator> because the CLI
  // wasn't propagating identity. After this fix, mu-spawned workers'
  // notes are correctly attributed to the agent name.
  const author = opts.author ?? (await resolveActorIdentity());
  const note = addNote(db, localId, unescapeNoteText(content), { author });
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show all notes on this task", command: `mu task notes ${localId} -w ${ws}` },
    { intent: "Show full task state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, note, nextSteps });
    return;
  }
  console.log(pc.dim(`note #${note.id} appended to ${localId}`));
  printNextSteps(nextSteps);
}

async function cmdTaskClose(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  // Capture the owner BEFORE closeTask so we can refresh their title
  // even though closeTask doesn't return owner info. owner won't
  // change as a result of close (FK SET NULL only fires on delete).
  const taskRow = getTask(db, localId);
  const r = closeTask(db, localId, sdkOpts);
  if (r.changed && taskRow?.owner) await refreshAgentTitle(db, taskRow.owner);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Reopen if needed", command: `mu task open ${localId} -w ${ws}` },
    { intent: "Pick the next ready task", command: `mu task next -w ${ws}` },
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already CLOSED (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Closed ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
  printNextSteps(nextSteps);
}

async function cmdTaskOpen(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  const r = openTask(db, localId, sdkOpts);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    {
      intent: "Claim it",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Close again", command: `mu task close ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Reopened ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
  printNextSteps(nextSteps);
}

// ─── reject / defer (terminal-but-blocking transitions) ────────────────

interface RejectDeferOpts {
  evidence?: string;
  cascade?: boolean;
  yes?: boolean;
  workstream?: string;
  json?: boolean;
}

async function cmdTaskReject(db: Db, localId: string, opts: RejectDeferOpts = {}): Promise<void> {
  return cmdTaskRejectOrDefer(db, localId, "reject", opts);
}

async function cmdTaskDefer(db: Db, localId: string, opts: RejectDeferOpts = {}): Promise<void> {
  return cmdTaskRejectOrDefer(db, localId, "defer", opts);
}

async function cmdTaskRejectOrDefer(
  db: Db,
  localId: string,
  verb: "reject" | "defer",
  opts: RejectDeferOpts,
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  if (opts.yes && !opts.cascade) {
    throw new UsageError(
      `--yes requires --cascade (--yes only meaningful when committing a cascade preview; for single-task ${verb}, --yes is a no-op)`,
    );
  }
  const sdkOpts: { evidence?: string; cascade?: boolean; yes?: boolean } = {};
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.cascade) sdkOpts.cascade = true;
  if (opts.yes) sdkOpts.yes = true;
  const r = verb === "reject" ? rejectTask(db, localId, sdkOpts) : deferTask(db, localId, sdkOpts);
  // Title push for every affected task's owner (the verb compresses
  // potentially-multi-task work; refresh each owner once). Skipped
  // on dry-run since nothing changed.
  if (r.changed) {
    const owners = new Set<string>();
    for (const id of r.changedIds) {
      const t = getTask(db, id);
      if (t?.owner) owners.add(t.owner);
    }
    for (const owner of owners) await refreshAgentTitle(db, owner);
  }
  const ws = await resolveWorkstream(opts.workstream);
  const past = verb === "reject" ? "Rejected" : "Deferred";
  const status = verb === "reject" ? "REJECTED" : "DEFERRED";

  // Cascade dry-run: render the affected list with each task's
  // current status + title so the operator can spot 'wait, that
  // dependent has independent merit, I want to keep it'. Surfaced
  // in mufeedback bug_cascade_reject_too_aggressive.
  if (r.dryRun) {
    if (opts.json) {
      emitJson({
        task: localId,
        ...r,
        nextSteps: [
          {
            intent: "Commit the cascade after reviewing the list",
            command: `mu task ${verb} ${localId} --cascade --yes -w ${ws}`,
          },
          {
            intent: "Address one dependent first, then re-preview",
            command: `mu task ${verb} <dep> -w ${ws}`,
          },
        ],
      });
      return;
    }
    console.log(
      `${past === "Rejected" ? "Reject" : "Defer"} ${pc.bold(localId)} would sweep ${r.affectedIds.length} task(s) (root + ${r.affectedIds.length - 1} dependent(s)):`,
    );
    for (const id of r.affectedIds) {
      const t = getTask(db, id);
      const title = t ? (t.title.length > 50 ? `${t.title.slice(0, 49)}…` : t.title) : "?";
      const marker = id === localId ? pc.bold("  *") : "   ";
      console.log(`${marker} ${pc.bold(id)}  ${pc.dim(title)}`);
    }
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually sweep)"));
    printNextSteps([
      {
        intent: "Commit the cascade after reviewing the list",
        command: `mu task ${verb} ${localId} --cascade --yes -w ${ws}`,
      },
      {
        intent: "Address one dependent first, then re-preview",
        command: `mu task ${verb} <dep> -w ${ws}`,
      },
    ]);
    return;
  }

  const nextSteps: NextStep[] = [
    { intent: "Reopen if reconsidered", command: `mu task open ${localId} -w ${ws}` },
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already ${status} (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`${past} ${pc.bold(localId)} ${pc.dim(`(→ ${status})`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  if (r.changedIds.length > 1) {
    const cascaded = r.changedIds.slice(1);
    console.log(
      pc.dim(
        `  cascaded to ${cascaded.length} dependent(s): ${cascaded.slice(0, 8).join(", ")}${cascaded.length > 8 ? ", …" : ""}`,
      ),
    );
  }
  printNextSteps(nextSteps);
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

/**
 * Find the actor of the most recent `task claim <id>` event for a task.
 * Used to surface 'who's working on this' when `tasks.owner IS NULL`
 * (the --self / anonymous-claim case). Returns null when there's been
 * no claim event for this task.
 *
 * Implementation: scan the latest few claim events for this workstream
 * (small bounded N), pattern-match for `task claim <id>` in the payload.
 * Cheap; called only when owner is NULL.
 */
function lastClaimActor(db: Db, workstream: string, localId: string): string | null {
  const recent = listLogs(db, {
    workstream,
    kind: "event",
    limit: 100,
  });
  for (let i = recent.length - 1; i >= 0; i--) {
    const ev = recent[i];
    if (!ev) continue;
    if (ev.payload.startsWith(`task claim ${localId} `)) return ev.source;
  }
  return null;
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

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in agent_logs. Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.owner === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstream, task.localId)
      : null;

  if (opts.json) {
    emitJson({
      task: withRoi(task),
      blockers: edges.blockers,
      dependents: edges.dependents,
      notes,
      lastClaimActor: lastActor,
    });
    return;
  }

  const roi = task.effortDays > 0 ? (task.impact / task.effortDays).toFixed(1) : "∞";
  console.log(pc.bold(`${task.localId}  —  ${task.title}`));
  console.log(`  workstream : ${task.workstream}`);
  console.log(`  status     : ${task.status}`);
  // owner: registered worker name, or '(self: <actor>)' for an anonymous
  // claim, or '(unowned)' for OPEN tasks.
  const ownerLine =
    task.owner !== null
      ? task.owner
      : lastActor !== null
        ? pc.dim(`(self: ${lastActor})`)
        : pc.dim("(unowned)");
  console.log(`  owner      : ${ownerLine}`);
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
  opts: { reopen?: boolean; evidence?: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts: { reopen: boolean; evidence?: string } = { reopen: opts.reopen ?? false };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = releaseTask(db, localId, sdkOpts);
  // Title push for the agent that just lost the task. Prev-owner could
  // be null (anonymous claim release — nothing to refresh).
  if (r.previousOwner) await refreshAgentTitle(db, r.previousOwner);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    {
      intent: "Reclaim",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Show current state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already unowned (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ownerBit = r.previousOwner ? `was ${pc.bold(r.previousOwner)}` : "was unowned";
  const statusBit = r.previousStatus !== r.status ? ` (${r.previousStatus} → ${r.status})` : "";
  console.log(`Released ${pc.bold(localId)} ${pc.dim(`(${ownerBit})${statusBit}`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

async function cmdClaim(
  db: Db,
  localId: string,
  opts: {
    for?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  if (opts.self === true && opts.for !== undefined) {
    throw new UsageError("--self and --for are mutually exclusive");
  }
  if (opts.actor !== undefined && opts.self !== true) {
    throw new UsageError("--actor only meaningful with --self (it overrides the actor name)");
  }
  const sdkOpts: {
    agentName?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
  } = {};
  if (opts.for) sdkOpts.agentName = opts.for;
  if (opts.self) sdkOpts.self = true;
  if (opts.actor !== undefined) sdkOpts.actor = opts.actor;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const result = await claimTask(db, localId, sdkOpts);
  // Title push for the new owner. Anonymous claims (--self) leave
  // owner=null — nothing to refresh.
  if (result.owner) await refreshAgentTitle(db, result.owner);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    {
      // Single-quoted example: shell metachars (`...`, $VAR, $(...))
      // inside a double-quoted string expand in YOUR shell before mu
      // sees the note (mufeedback note #257). Single quotes defer
      // expansion to the agent.
      intent: "Drop a note (single-quote to defer shell expansion)",
      command: `mu task note ${localId} 'FILES: ...\\nDECISION: ...' -w ${ws}`,
    },
    {
      intent: "Close with grounding",
      command: `mu task close ${localId} --evidence "..." -w ${ws}`,
    },
    { intent: "Release if blocked", command: `mu task release ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  if (result.owner === null) {
    console.log(
      `Claimed ${pc.bold(localId)} ${pc.dim(`(--self by ${result.actor}; ${result.previousStatus} → ${result.status}; owner=NULL)`)}`,
    );
  } else {
    console.log(
      `Claimed ${pc.bold(localId)} for ${pc.bold(result.owner)} ${pc.dim(`(${result.previousStatus} → ${result.status})`)}`,
    );
  }
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

async function cmdTaskBlock(
  db: Db,
  blocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = addBlockEdge(db, blocked, opts.by);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show the dependency tree", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Remove this edge", command: `mu task unblock ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blocked, blocker: opts.by, ...r, nextSteps });
    return;
  }
  if (!r.added) {
    console.log(pc.dim(`${opts.by} → ${blocked}: edge already exists (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Added edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
  printNextSteps(nextSteps);
}

async function cmdTaskUnblock(
  db: Db,
  blocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = removeBlockEdge(db, blocked, opts.by);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show what now blocks this task", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Re-add the edge", command: `mu task block ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blocked, blocker: opts.by, ...r, nextSteps });
    return;
  }
  if (!r.removed) {
    console.log(pc.dim(`${opts.by} → ${blocked}: no such edge (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Removed edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
  printNextSteps(nextSteps);
}

async function cmdTaskDelete(
  db: Db,
  localId: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const r = deleteTask(db, localId);
  const nextSteps: NextStep[] = [
    {
      // A snapshot was taken by deleteTask itself before the cascade
      // (snap_schema commit ab82a11). `mu undo` reverts the latest one.
      intent: "Undo (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
    {
      intent: "List remaining tasks",
      command: `mu task list -w ${await resolveWorkstream(opts.workstream)}`,
    },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.deleted) {
    console.log(pc.dim(`no task named ${localId} (already deleted?)`));
    return;
  }
  console.log(
    `Deleted ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
  );
  printNextSteps(nextSteps);
}

async function cmdTaskUpdate(
  db: Db,
  localId: string,
  opts: {
    title?: string;
    impact?: number;
    effortDays?: number;
    workstream?: string;
    json?: boolean;
  },
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
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show updated task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
  printNextSteps(nextSteps);
}

async function cmdTaskReparent(
  db: Db,
  localId: string,
  opts: { blockedBy: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const blockers = opts.blockedBy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = reparentTask(db, localId, blockers);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show the new dependency tree", command: `mu task tree ${localId} -w ${ws}` },
    { intent: "Show the task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, blockers, ...r, nextSteps });
    return;
  }
  console.log(
    `Reparented ${pc.bold(localId)} ${pc.dim(`(removed ${r.removedEdges} edges, added ${r.addedEdges})`)}`,
  );
  printNextSteps(nextSteps);
}

async function cmdTaskWait(
  db: Db,
  ids: readonly string[],
  opts: {
    status?: string;
    any?: boolean;
    timeout?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (ids.length === 0) {
    throw new UsageError("mu task wait: at least one task id is required");
  }
  // Validate status (default CLOSED). Same parser as mu task list --status.
  const statusOpt = opts.status !== undefined ? parseStatusOption(opts.status) : undefined;
  // Scope: every id must be in the workstream we resolved (-w error
  // semantics matching every other task verb).
  for (const id of ids) {
    assertTaskInWorkstream(db, id, opts.workstream);
  }
  const ws = await resolveWorkstream(opts.workstream);

  // --timeout in seconds for shell ergonomics; SDK takes ms.
  // 0 in the SDK = wait forever; same convention here.
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : 600_000;

  const sdkOpts: {
    status?: TaskWaitResult["tasks"][number]["status"];
    any?: boolean;
    timeoutMs: number;
  } = { timeoutMs };
  if (statusOpt !== undefined) sdkOpts.status = statusOpt;
  if (opts.any) sdkOpts.any = true;

  const result = await waitForTasks(db, ids, sdkOpts);

  // Build nextSteps: for each task that DIDN'T reach the target, suggest
  // mu task show so the operator can investigate. Always include
  // 'pick the next ready task' for the unblocked-orchestrator pattern.
  const stuck = result.tasks.filter((t) => !t.reachedTarget);
  const nextSteps: NextStep[] = [];
  for (const t of stuck) {
    nextSteps.push({
      intent: `Investigate ${t.localId} (status=${t.status})`,
      command: `mu task show ${t.localId} -w ${ws}`,
    });
  }
  if (!result.timedOut) {
    nextSteps.push({ intent: "Pick the next ready task", command: `mu task next -w ${ws}` });
  }

  if (opts.json) {
    emitJson({ ...result, nextSteps });
    if (result.timedOut) process.exit(5);
    return;
  }

  // Human output: per-task line with status + reached marker.
  const targetStatus = statusOpt ?? "CLOSED";
  const summary = result.timedOut
    ? pc.yellow(`Timed out after ${result.elapsedMs}ms`)
    : pc.green(
        `${opts.any ? "any-of" : "all-of"} ${ids.length} reached ${targetStatus} in ${result.elapsedMs}ms`,
      );
  console.log(summary);
  for (const t of result.tasks) {
    const marker = t.reachedTarget ? pc.green("✓") : pc.dim("•");
    console.log(`  ${marker} ${pc.bold(t.localId)} ${pc.dim(`(${t.status})`)}`);
  }
  printNextSteps(nextSteps);
  if (result.timedOut) process.exit(5);
}

// ─── mu doctor ───────────────────────────────────────────────────────────────────
// ─── mu undo / mu snapshot list / mu snapshot show ──────────────────
//
// Snapshots are taken automatically by every destructive verb
// (snap_schema commit ab82a11). These three CLI verbs surface them:
//
//   mu undo [--yes] [--to <id>]      restore the latest (or a specific)
//   mu snapshot list [-n N] [--json]  list newest-first, with size
//   mu snapshot show <id> [--json]    one snapshot's full metadata
//
// `mu redo` was deliberately NOT shipped: snap_design (note #293)
// rejected it because mu verbs have side effects (tmux pane kills,
// `git worktree remove`, etc.) that aren't replayable. "Undo of undo"
// works for free — every restore takes a pre-restore snapshot first,
// so re-running `mu undo` after `mu undo` rolls forward to that
// snapshot.

/** Format a byte count for human-readable display in `mu snapshot list`.
 *  Three levels: bytes / KB / MB. Snapshots beyond a few MB on a real
 *  workstream would be unusual (mu DB rows are TEXT-heavy but small);
 *  no GB level by design. */
function formatBytes(n: number | null): string {
  if (n === null) return pc.red("missing");
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function cmdUndo(
  db: Db,
  opts: { to?: number; yes?: boolean; json?: boolean } = {},
): Promise<void> {
  // Resolve target snapshot. Default = latest by id; --to picks one.
  let target: SnapshotRow | undefined;
  if (opts.to !== undefined) {
    const all = listSnapshots(db);
    target = all.find((r) => r.id === opts.to);
    if (!target) throw new SnapshotNotFoundError(opts.to);
  } else {
    const latest = listSnapshots(db, { limit: 1 });
    target = latest[0];
  }

  if (!target) {
    // Empty snapshots table: nothing to undo. Friendly because this
    // is the common state right after install.
    if (opts.json) {
      emitJson({
        restored: false,
        reason: "no snapshots",
        nextSteps: [
          {
            intent: "Take an action that snapshots first",
            command: "mu task close <id>  (any destructive verb auto-snapshots)",
          },
        ],
      });
      return;
    }
    console.log(pc.dim("no snapshots to undo"));
    printNextSteps([
      {
        intent: "Snapshots are taken by destructive verbs",
        command: "mu task close <id>  /  mu agent close <name>  /  mu workstream destroy ...",
      },
      { intent: "List snapshots once they exist", command: "mu snapshot list" },
    ]);
    return;
  }

  // Dry-run mode: print what would happen, exit clean.
  if (!opts.yes) {
    if (opts.json) {
      emitJson({
        restored: false,
        dryRun: true,
        snapshot: target,
        sizeBytes: snapshotFileSize(target),
        nextSteps: [
          {
            intent: "Confirm and actually restore",
            command: opts.to !== undefined ? `mu undo --to ${opts.to} --yes` : "mu undo --yes",
          },
        ],
      });
      return;
    }
    const wsLabel = target.workstream ?? pc.dim("<whole-DB>");
    console.log(pc.bold(`About to restore snapshot #${target.id}`));
    console.log(`  label        : ${target.label}`);
    console.log(`  workstream   : ${wsLabel}`);
    console.log(`  taken at     : ${target.createdAt}`);
    console.log(`  size         : ${formatBytes(snapshotFileSize(target))}`);
    console.log("");
    console.log(
      pc.yellow(
        "This will REPLACE the live mu.db with the snapshot. tmux state\nwill NOT be rolled back: agents in DB whose panes are gone will\nbe pruned by reconcile; tmux panes whose DB rows are gone will\nsurface as orphans on the next `mu agent list`.",
      ),
    );
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually restore)"));
    printNextSteps([
      {
        intent: "Confirm and actually restore",
        command: opts.to !== undefined ? `mu undo --to ${opts.to} --yes` : "mu undo --yes",
      },
      { intent: "Inspect the snapshot first", command: `mu snapshot show ${target.id}` },
    ]);
    return;
  }

  // Capture identity BEFORE restore — restoreSnapshot closes the
  // live handle, so reading off `target` afterwards is fine but
  // reading off `db` is not.
  const restored = restoreSnapshot(db, target.id);

  // Re-open and reconcile every workstream so the post-restore output
  // can honestly say how much DB-vs-tmux drift exists. We open a fresh
  // handle here; handle()'s finally `db?.close()` will silently fail on
  // the old (now-closed) handle, which is the documented behaviour.
  //
  // **dryRun: true** is the load-bearing flag. Without it, the
  // reconcile pass would prune any agent row whose pane is no
  // longer in tmux — which is EVERY agent row in a snapshot taken
  // before `mu workstream destroy --yes`, because the destroy
  // killed the panes. The contract `mu undo` advertises is "the
  // restore brings back the snapshot's rows verbatim"; a mutating
  // post-restore reconcile silently breaks that. Dry-run reports
  // drift but doesn't delete (the user can still do a real
  // reconcile later via `mu agent list` once they've decided
  // which would-be-pruned rows to re-spawn vs let go).
  // (snap_undo_reconcile_destroys_recovered_agents.)
  const fresh = openDb({ path: restored.restoredTo });
  let totalGhostsWouldBePruned = 0;
  let totalOrphans = 0;
  const reconcilePerWorkstream: Array<{
    workstream: string;
    wouldBePrunedGhosts: number;
    orphans: number;
  }> = [];
  try {
    const workstreams = await listWorkstreams(fresh);
    for (const ws of workstreams) {
      // reconcile() shells out to tmux and may throw on substrate
      // failures (tmux not running). Per-workstream try/catch so a
      // single bad workstream doesn't poison the post-restore
      // summary.
      try {
        const report = await reconcile(fresh, {
          workstream: ws.workstream,
          dryRun: true,
        });
        totalGhostsWouldBePruned += report.prunedGhosts;
        totalOrphans += report.orphans.length;
        reconcilePerWorkstream.push({
          workstream: ws.workstream,
          wouldBePrunedGhosts: report.prunedGhosts,
          orphans: report.orphans.length,
        });
      } catch {
        // Best-effort; the restore itself succeeded.
      }
    }
  } finally {
    try {
      fresh.close();
    } catch {
      // best effort
    }
  }

  if (opts.json) {
    emitJson({
      restored: true,
      snapshot: target,
      restoredTo: restored.restoredTo,
      schemaVersion: restored.schemaVersion,
      reconcile: {
        // Renamed from `ghostsPruned` because we no longer prune
        // during restore. The shape is informational — callers
        // wanting to actually prune should run `mu agent list`
        // (which still mutates) after deciding which rows to keep.
        wouldBePrunedGhosts: totalGhostsWouldBePruned,
        orphansSurfaced: totalOrphans,
        dryRun: true,
        perWorkstream: reconcilePerWorkstream,
      },
      nextSteps: [
        {
          intent: "See orphan panes (DB doesn't know about them)",
          command: "mu agent list -w '*' --json | jq '.[].orphans'",
        },
        {
          intent: "Confirm + actually prune dead-pane rows you don't want to re-spawn",
          command: "mu agent list -w <ws>  (a normal list reconciles + prunes)",
        },
        { intent: "Roll forward (undo the undo)", command: "mu undo --yes" },
      ],
    });
    return;
  }
  console.log(
    `Restored snapshot ${pc.bold(`#${target.id}`)} (${target.label}, taken ${target.createdAt})`,
  );
  console.log("");
  console.log(pc.bold("Reconcile (tmux NOT rolled back; rows NOT pruned):"));
  console.log(
    `  would-be-pruned (DB row → dead pane) : ${pc.yellow(String(totalGhostsWouldBePruned))} ${pc.dim("(suppressed: rows preserved as restored)")}`,
  );
  console.log(`  orphan panes surfaced                 : ${pc.yellow(String(totalOrphans))}`);
  printNextSteps([
    {
      intent: "See orphan panes (DB doesn't know about them)",
      command: "mu agent list -w '*' --json | jq '.[].orphans'",
    },
    {
      intent: "Confirm + actually prune dead-pane rows you don't want to re-spawn",
      command: "mu agent list -w <ws>  (a normal list reconciles + prunes)",
    },
    { intent: "Re-spawn an agent the DB now lacks", command: "mu agent spawn <name> -w <ws>" },
    { intent: "Roll forward (undo the undo)", command: "mu undo --yes" },
  ]);
}

async function cmdSnapshotList(
  db: Db,
  opts: { lines?: number; json?: boolean } = {},
): Promise<void> {
  const limit = opts.lines ?? 20;
  const rows = listSnapshots(db, { limit });
  if (opts.json) {
    emitJson(
      rows.map((r) => ({
        ...r,
        sizeBytes: snapshotFileSize(r),
      })),
    );
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("no snapshots"));
    printNextSteps([
      {
        intent: "Snapshots are taken automatically by destructive verbs",
        command: "mu task close <id>  /  mu agent close <name>  /  mu workstream destroy ...",
      },
    ]);
    return;
  }
  const table = new Table({
    head: [
      pc.bold("id"),
      pc.bold("label"),
      pc.bold("workstream"),
      pc.bold("created_at"),
      pc.bold("size"),
    ],
    style: { head: [] },
  });
  for (const r of rows) {
    table.push([
      String(r.id),
      r.label,
      r.workstream ?? pc.dim("<whole-DB>"),
      r.createdAt,
      formatBytes(snapshotFileSize(r)),
    ]);
  }
  console.log(table.toString());
  printNextSteps([
    { intent: "Show one snapshot's full metadata", command: "mu snapshot show <id>" },
    { intent: "Restore the latest snapshot", command: "mu undo --yes" },
    { intent: "Restore a specific snapshot", command: "mu undo --to <id> --yes" },
  ]);
}

async function cmdSnapshotShow(db: Db, id: number, opts: { json?: boolean } = {}): Promise<void> {
  const all = listSnapshots(db);
  const row = all.find((r) => r.id === id);
  if (!row) throw new SnapshotNotFoundError(id);
  const sizeBytes = snapshotFileSize(row);
  if (opts.json) {
    emitJson({ ...row, sizeBytes });
    return;
  }
  console.log(pc.bold(`snapshot #${row.id}`));
  console.log(`  label          : ${row.label}`);
  console.log(`  workstream     : ${row.workstream ?? pc.dim("<whole-DB>")}`);
  console.log(`  schema_version : ${row.schemaVersion}`);
  console.log(`  db_path        : ${row.dbPath}`);
  console.log(`  size           : ${formatBytes(sizeBytes)}`);
  console.log(`  created_at     : ${row.createdAt}`);
  printNextSteps([
    { intent: "Restore this snapshot", command: `mu undo --to ${row.id} --yes` },
    {
      intent: "Inspect the snapshot's data without restoring",
      command: `sqlite3 ${row.dbPath} "SELECT * FROM tasks"`,
    },
  ]);
}

async function cmdDoctor(db: Db, opts: { json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    return cmdDoctorJson(db);
  }
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
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length === 0) {
      console.log(`  schema           : ${pc.green("ok")} (${EXPECTED_TABLES.length} tables)`);
    } else {
      console.log(`  schema           : ${pc.red("missing")} — ${missing.join(", ")}`);
    }
    // Schema version: should match CURRENT_SCHEMA_VERSION after openDb
    // (which runs migrations). Mismatch means either a downgrade
    // attempt or a bug in the migration runner — either way, surface it.
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) {
        console.log(
          `  schema_version   : ${pc.red("missing row")} (expected ${CURRENT_SCHEMA_VERSION})`,
        );
      } else if (v === CURRENT_SCHEMA_VERSION) {
        console.log(`  schema_version   : ${pc.green(String(v))}`);
      } else if (v < CURRENT_SCHEMA_VERSION) {
        console.log(
          `  schema_version   : ${pc.yellow(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; openDb should have migrated)`,
        );
      } else {
        console.log(
          `  schema_version   : ${pc.red(String(v))} (code expects ${CURRENT_SCHEMA_VERSION}; possible downgrade or future-version DB)`,
        );
      }
    } catch {
      console.log(
        `  schema_version   : ${pc.red("unreadable")} (schema_version table missing or wrong shape)`,
      );
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
    // mu doctor is diagnostic — dryRun so it never deletes rows just
    // for being polled (would race in-flight spawns; see
    // bug_agent_spawn_workspace_fk_failure).
    try {
      const view = await listLiveAgents(db, { workstream: ws, dryRun: true });
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

/**
 * JSON form of `mu doctor`. Same checks the human form runs, collected
 * into a single structured record for piping. Surfaces 'ok' / 'warn' /
 * 'fail' for each subsystem so callers can match on a single field.
 */
async function cmdDoctorJson(db: Db): Promise<void> {
  // environment
  let tmuxVersion: string | null = null;
  let tmuxOk = false;
  try {
    tmuxVersion = (await tmux(["-V"])).trim();
    tmuxOk = true;
  } catch {
    tmuxOk = false;
  }
  const env = {
    tmux: { ok: tmuxOk, version: tmuxVersion },
    TMUX: process.env.TMUX ?? null,
    TMUX_PANE: process.env.TMUX_PANE ?? null,
    MU_SESSION: process.env.MU_SESSION ?? null,
  };

  // db / schema
  let dbReport: Record<string, unknown>;
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    let schemaVersion: number | null = null;
    let schemaVersionStatus: "ok" | "missing" | "stale" | "future" | "unreadable";
    try {
      const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const v = row?.version;
      if (v === undefined) schemaVersionStatus = "missing";
      else {
        schemaVersion = v;
        if (v === CURRENT_SCHEMA_VERSION) schemaVersionStatus = "ok";
        else if (v < CURRENT_SCHEMA_VERSION) schemaVersionStatus = "stale";
        else schemaVersionStatus = "future";
      }
    } catch {
      schemaVersionStatus = "unreadable";
    }
    const journal = db.pragma("journal_mode", { simple: true });
    const fk = db.pragma("foreign_keys", { simple: true });
    dbReport = {
      path: defaultDbPath(),
      schema: { ok: missing.length === 0, expected: EXPECTED_TABLES, missing, present: tables },
      schemaVersion: {
        value: schemaVersion,
        expected: CURRENT_SCHEMA_VERSION,
        status: schemaVersionStatus,
      },
      journalMode: journal,
      foreignKeys: fk === 1,
    };
  } catch (err) {
    dbReport = { error: err instanceof Error ? err.message : String(err) };
  }

  // workstream
  let currentWorkstream: string | null = null;
  try {
    currentWorkstream = await resolveWorkstream();
  } catch {
    currentWorkstream = null;
  }

  // per-workstream stats (only when resolvable)
  let workstreamStats: Record<string, unknown> | null = null;
  if (currentWorkstream) {
    const ws = currentWorkstream;
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
    let reconcile: Record<string, unknown> | null = null;
    try {
      // mu doctor --json: dryRun for the same reason as the human path.
      const view = await listLiveAgents(db, { workstream: ws, dryRun: true });
      reconcile = {
        prunedGhosts: view.report.prunedGhosts,
        orphanCount: view.orphans.length,
      };
    } catch (err) {
      reconcile = { skipped: true, reason: err instanceof Error ? err.message : String(err) };
    }
    workstreamStats = { workstream: ws, ...counts, reconcile };
  }

  emitJson({
    environment: env,
    db: dbReport,
    workstream: { current: currentWorkstream },
    state: workstreamStats,
  });
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

async function cmdSql(
  db: Db,
  query: string,
  opts: { json?: boolean; confirmRows?: number } = {},
): Promise<void> {
  // Read OR write — `mu sql` is the explicit escape hatch.
  //
  // Single-statement path uses better-sqlite3's prepare() so we can
  // distinguish read (.all() rows) from write (.run() change count).
  // Multi-statement path uses db.exec() which handles BEGIN/COMMIT and
  // multiple semicolon-separated statements but returns nothing
  // structured. We try prepare() first; if it throws the
  // 'more than one statement' SqliteError, we fall back to exec().
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  const trimmed = query.trim();
  // Probe whether this is a single statement by trying prepare(); if
  // better-sqlite3 throws 'more than one statement', use exec() instead.
  // Capture the prepared statement so the single-statement path below
  // doesn't re-prepare (review_code_sql_double_prepare).
  let stmt: ReturnType<typeof db.prepare> | undefined;
  let isMulti = false;
  try {
    stmt = db.prepare(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/more than one statement/i.test(msg)) {
      isMulti = true;
    } else {
      throw err;
    }
  }

  if (isMulti) {
    // Multi-statement: db.exec() doesn't report a per-statement change
    // count, so for --confirm-rows we wrap the whole script in a manual
    // transaction and diff total_changes() before/after. Note: scripts
    // that contain their own BEGIN/COMMIT will fail under --confirm-rows
    // (sqlite refuses nested transactions); that's the price of an
    // atomic confirm-or-rollback wrapper around an opaque blob.
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      db.exec("BEGIN");
      let actual: number;
      try {
        db.exec(trimmed);
        const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
        actual = after - before;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      if (actual !== expected) {
        db.exec("ROLLBACK");
        throw new UsageError(
          `expected ${expected} rows, would have affected ${actual} (rolled back). Re-run with --confirm-rows ${actual} if intentional.`,
        );
      }
      db.exec("COMMIT");
      const n = countTopLevelStatements(trimmed);
      if (opts.json) {
        emitJson({
          statements: n,
          multiStatement: true,
          confirmRows: expected,
          actualRows: actual,
        });
        return;
      }
      console.log(
        pc.dim(
          `ran ${n} statement${n === 1 ? "" : "s"} (${actual} row${actual === 1 ? "" : "s"} affected)`,
        ),
      );
      return;
    }
    db.exec(trimmed);
    const n = countTopLevelStatements(trimmed);
    if (opts.json) {
      emitJson({ statements: n, multiStatement: true });
      return;
    }
    console.log(pc.dim(`ran ${n} statement${n === 1 ? "" : "s"}`));
    return;
  }

  const lower = trimmed.toLowerCase();
  const isRead =
    lower.startsWith("select") || lower.startsWith("with") || lower.startsWith("explain");
  if (opts.confirmRows !== undefined && isRead) {
    throw new UsageError(
      "--confirm-rows is only meaningful on write statements (UPDATE / DELETE / INSERT / REPLACE)",
    );
  }
  if (isRead) {
    if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
    const rows = stmt.all([]);
    if (opts.json) {
      emitJson(rows);
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim("(no rows)"));
      return;
    }
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
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      db.exec("BEGIN");
      if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
      let result: { changes: number; lastInsertRowid: number | bigint };
      try {
        result = stmt.run([]);
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      if (result.changes !== expected) {
        db.exec("ROLLBACK");
        throw new UsageError(
          `expected ${expected} rows, would have affected ${result.changes} (rolled back). Re-run with --confirm-rows ${result.changes} if intentional.`,
        );
      }
      db.exec("COMMIT");
      if (opts.json) {
        emitJson({
          changes: result.changes,
          lastInsertRowid: Number(result.lastInsertRowid),
          confirmRows: expected,
          actualRows: result.changes,
        });
        return;
      }
      console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
      return;
    }
    if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
    const result = stmt.run([]);
    if (opts.json) {
      emitJson({
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      });
      return;
    }
    console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
  }
}

/**
 * Count top-level SQL statements in `sql`, ignoring semicolons inside
 * single-quoted strings, double-quoted identifiers, line comments
 * (`-- ...`), and block comments (`/* ... *\/`). Used by `mu sql`'s
 * multi-statement path to report 'ran N statements'.
 *
 * Hand-rolled rather than pulling in a SQL parser — mu's escape hatch
 * is for human-typed scripts, not arbitrary SQL. The state machine
 * covers the cases we care about; pathological inputs (nested
 * comments, dollar-quoted strings, etc.) may miscount but won't crash
 * the verb (db.exec already ran successfully by then).
 */
export function countTopLevelStatements(sql: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let sawNonWs = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      // SQL-style escaped single quote: '' inside a string
      if (c === "'" && next === "'") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && next === '"') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ";") {
      if (sawNonWs) {
        count++;
        sawNonWs = false;
      }
      continue;
    }
    if (c !== undefined && /\S/.test(c)) sawNonWs = true;
  }
  if (sawNonWs) count++; // trailing statement without `;`
  return count;
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
  // Bare `mu` (mission control) is read-only: dryRun avoids racing
  // in-flight spawns when polled (e.g. by `watch -n 5 mu`).
  const view = await listLiveAgents(db, { workstream, dryRun: true });
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
  // mu state is the read-only canonical-state-card verb. dryRun so
  // polling it doesn't race in-flight spawns. To force a real prune,
  // run `mu agent list -w <ws>` (the documented escape hatch).
  const view = await listLiveAgents(db, { workstream, dryRun: true });
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
  const workspaceOrphans = listWorkspaceOrphans(db, workstream);
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
    workspace_orphans: workspaceOrphans,
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
  if (workspaceOrphans.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `Workspace orphans (${workspaceOrphans.length}, on disk but no DB row — will block --workspace spawns):`,
      ),
    );
    for (const o of workspaceOrphans) {
      console.log(`  ${pc.bold(o.agent)}  ${pc.dim(o.path)}`);
    }
    console.log(pc.dim(`  Run \`mu workspace orphans -w ${workstream}\` for cleanup hints.`));
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

// ─── mu hud (dynamic table layout + --json) ──────────────────────────
//
// Print-once renderer of the workstream HUD card. No loop, no tmux side
// effects. The user composes redraw / placement: `watch -n 5 mu hud -w X`,
// `tmux display-popup -E 'mu hud -w X'`, status-bar interpolation via
// `#(mu hud -w X --json) | jq ...`, etc. mu's contract is 'print, exit,
// compose'.
//
// Default mode: greedy top-down table layout that fills the available
// terminal (or tmux pane) height + width with as much useful data as
// fits. No flags to pick a size — the substrate is already telling us
// the size.
//
// --json keeps the same structured shape it always had (machine reader).
// -n N still caps recent-events length (mostly meaningful for --json,
// but also bounds what the human view can pull from).

interface HudOpts {
  workstream?: string;
  json?: boolean;
  lines?: number; // recent-events tail cap; default 10
}

/** Format an elapsed duration (in ms) as a compact relative string:
 *  '12s', '3m', '1h', '2d'. Used by HUD to surface 'how stale'. */
function relTime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * Resolve the HUD's render budget (width × height) from the substrate.
 *
 * Order:
 * 1. `MU_HUD_FORCE_SIZE=WxH` env override — deterministic for tests +
 *    the only way an operator can force a non-default size on demand.
 * 2. `process.stdout` if it's a TTY (the easy path — same as every
 *    other terminal app).
 * 3. `currentPaneSize()` (tmux's `display-message -p '#{pane_width}
 *    #{pane_height}'`) — catches `watch -n 5 mu hud -w X`,
 *    `tmux display-popup -E 'mu hud -w X'`, and any other case where
 *    stdout is a pipe but the surrounding tmux pane has a real size.
 * 4. `120 × 30` fallback — a wide-ish dev-laptop shape so a non-tmux
 *    pipe still gets a usable layout.
 */
async function hudPaneSize(): Promise<{ width: number; height: number }> {
  const forced = process.env.MU_HUD_FORCE_SIZE;
  if (forced !== undefined) {
    const m = forced.match(/^(\d+)x(\d+)$/);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const width = Number.parseInt(m[1], 10);
      const height = Number.parseInt(m[2], 10);
      if (width > 0 && height > 0) return { width, height };
    }
    throw new UsageError(
      `MU_HUD_FORCE_SIZE must be 'WIDTHxHEIGHT' (e.g. '80x24'); got ${JSON.stringify(forced)}`,
    );
  }
  if (process.stdout.isTTY && process.stdout.columns && process.stdout.rows) {
    return { width: process.stdout.columns, height: process.stdout.rows };
  }
  const tmuxSize = await currentPaneSize().catch(() => undefined);
  if (tmuxSize !== undefined) return tmuxSize;
  return { width: 120, height: 30 };
}

/**
 * Build a header-less HUD table.
 *
 * Every HUD table now self-identifies through hint words baked into
 * its data cells (e.g. `agent worker-1`, `ready  build_x`, `track 1`,
 * `2 ready`, `ROI 200`). No column-header row is rendered — saves 2
 * vertical lines per table and lets every section render with the
 * exact same shape.
 *
 * `wordWrap: false` is the load-bearing setting: when a cell exceeds
 * its column width cli-table3 truncates with `…` instead of wrapping
 * to a second visual row. The HUD's row budget assumes one screen row
 * per data row — wrap would silently blow that out and push lower-
 * priority sections off the bottom. We pre-truncate every wide cell
 * via the truncate() helper; wordWrap:false is the safety belt for
 * anything we miss.
 */
function newHudTable(): InstanceType<typeof Table> {
  return new Table({ style: { border: [] }, wordWrap: false });
}

// Each formatHud*Table returns { rendered, rowsShown, rowsTotal }.
// rowsTotal == 0 cases are handled by renderSection's early-return
// (`if (full === 0) return`), so these helpers can assume non-empty
// input. The hint words baked into each cell identify the section.
function formatHudAgentsTable(
  db: Db,
  agents: readonly AgentRow[],
  width: number,
  rowCap: number,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = agents.length;
  const shown = agents.slice(0, rowCap);
  const now = Date.now();
  // No header row — hint words baked into each cell. The leftmost
  // status emoji + the dim 'agent' prefix on the name identify the
  // section. Saves 2 vertical lines.
  let nameW = "agent ".length;
  let agoW = "+ago".length;
  const taskBits: string[] = [];
  for (const a of shown) {
    nameW = Math.max(nameW, `agent ${a.name}`.length);
    const owned = listTasksByOwner(db, a.name);
    const taskBit =
      owned.length === 0
        ? "—"
        : owned.length === 1
          ? (owned[0]?.localId ?? "—")
          : `⊕${owned.length}`;
    taskBits.push(taskBit);
    const ago = `+${relTime(now - new Date(a.updatedAt).getTime())}`;
    agoW = Math.max(agoW, ago.length);
  }
  const statusW = 2; // emoji + 1
  const numCols = 4;
  const padding = numCols * 3 + 1;
  const taskBudget = Math.max(8, width - statusW - nameW - agoW - padding);
  const table = newHudTable();
  shown.forEach((a, i) => {
    const ago = `+${relTime(now - new Date(a.updatedAt).getTime())}`;
    const taskBit = taskBits[i] ?? "—";
    const truncated = truncate(taskBit, taskBudget);
    // Colour: status emoji per STATUS_COLORS; agent name bold; the
    // task id (when present) cyan to match the in-progress task
    // table; '—' / '⊕N' (no-task / multi) stays dim.
    const taskCell =
      taskBit === "—" || taskBit.startsWith("⊕") ? pc.dim(truncated) : pc.cyan(truncated);
    table.push([
      statusIcon(a.status),
      `${pc.dim("agent")} ${pc.bold(a.name)}`,
      taskCell,
      pc.dim(ago),
    ]);
  });
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/**
 * Render a task table for HUD. Columns: id, status, title, ROI, owner.
 * `title` cell absorbs slack via terminalWidth - sum(other cols).
 */
function formatHudTasksTable(
  tasks: readonly TaskRow[],
  width: number,
  rowCap: number,
  opts: { withOwner: boolean },
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = tasks.length;
  const shown = tasks.slice(0, rowCap);
  // No header row — we bake the section name INTO the first cell of
  // each row (`ready  cross_workstream_*` / `in-progress  build_x`)
  // and a `ROI 200` prefix on the ROI cell. Saves 2 vertical lines.
  // Status column already dropped (every row in ready is OPEN; every
  // row in in-progress is IN_PROGRESS by construction).
  const sectionPrefix = opts.withOwner ? "in-progress" : "ready";
  // Compute fixed-width columns. Seed from the prefix-decorated cell.
  let idW = `${sectionPrefix}  `.length; // section + double-space gutter
  let roiW = "ROI 100".length; // typical ROI width with prefix
  let ownerW = opts.withOwner ? "owner".length : 0;
  for (const t of shown) {
    idW = Math.max(idW, `${sectionPrefix}  ${t.localId}`.length);
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(0) : "∞";
    roiW = Math.max(roiW, `ROI ${roi}`.length);
    ownerW = Math.max(ownerW, (t.owner ?? "—").length);
  }
  const numCols = opts.withOwner ? 4 : 3;
  const padding = numCols * 3 + 1;
  const fixed = idW + roiW + (opts.withOwner ? ownerW : 0);
  const titleBudget = Math.max(10, width - fixed - padding);
  const table = newHudTable();
  for (const t of shown) {
    const roiNum = t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
    const roiStr = Number.isFinite(roiNum) ? roiNum.toFixed(0) : "∞";
    // Colour: id cyan (matches the agent table's task column);
    // ROI green for high-value (>=100), yellow for mid (>=50),
    // dim for low. Owner bold-cyan (the active worker is the most
    // useful pointer in an in-progress row).
    const roiColor = roiNum >= 100 ? pc.green : roiNum >= 50 ? pc.yellow : pc.dim;
    const idCell = `${pc.dim(sectionPrefix)}  ${pc.cyan(t.localId)}`;
    const row: string[] = [
      idCell,
      truncate(t.title, titleBudget),
      `${pc.dim("ROI")} ${roiColor(roiStr)}`,
    ];
    if (opts.withOwner) row.push(t.owner ? pc.bold(pc.cyan(t.owner)) : pc.dim("—"));
    table.push(row);
  }
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/**
 * Render the recent-events table for HUD. Columns: +ago, payload.
 * Payload absorbs slack.
 */
function formatHudRecentTable(
  events: readonly LogRow[],
  width: number,
  rowCap: number,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = events.length;
  const shown = events.slice(0, rowCap);
  const now = Date.now();
  // No header row — the +ago format and `task note ...` / `agent
  // spawn ...` style payload self-identify this as the events table.
  // Saves 2 vertical lines.
  let agoW = "+ago".length;
  for (const e of shown) {
    const ago = `+${relTime(now - new Date(e.createdAt).getTime())}`;
    agoW = Math.max(agoW, ago.length);
  }
  const numCols = 2;
  const padding = numCols * 3 + 1;
  const payloadBudget = Math.max(20, width - agoW - padding);
  const table = newHudTable();
  for (const e of shown) {
    const ago = `+${relTime(now - new Date(e.createdAt).getTime())}`;
    // Colour the leading verb token of the payload ('task close',
    // 'agent spawn', 'workspace create', etc.) so the eye can group
    // events at a glance. The verb is the first 1-2 tokens up to
    // (but not including) the entity id (which itself is bolded
    // when easy to identify). Falls back to the full dim payload
    // for events that don't fit the verb-shape.
    table.push([pc.dim(ago), colorEventPayload(truncate(e.payload, payloadBudget))]);
  }
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/** Recolour an event-log payload so the verb token (e.g. 'task close',
 *  'agent spawn', 'workspace create') stands out. Conservative: matches
 *  the verbs emitted by mu/src/agents.ts + tasks.ts + workstream.ts +
 *  workspace.ts; falls back to the original string when nothing matches
 *  so we never lose information just because we couldn't classify. */
function colorEventPayload(payload: string): string {
  const m = payload.match(
    /^(task (?:add|note|status|claim|release|close|update|delete|reject|defer|reap|edge add|edge remove)|agent (?:spawn|close|free|adopt)|workspace (?:create|free)|workstream (?:init|destroy)|approve (?:add|grant|deny)|snapshot (?:capture|restore|prune))\b/,
  );
  if (!m) return payload;
  const verb = m[1] ?? "";
  const rest = payload.slice(verb.length);
  return `${pc.cyan(verb)}${rest}`;
}

/**
 * Render the tracks table for HUD. Columns: #, roots, tasks, ready, kind.
 * `roots` cell absorbs slack (it lists every goal in the track and is
 * the longest cell on a busy diamond).
 */
function formatHudTracksTable(
  tracks: readonly Track[],
  width: number,
  rowCap: number,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = tracks.length;
  const shown = tracks.slice(0, rowCap);
  // No header row — hints baked into each cell ('track 1', '6 tasks',
  // '2 ready', 'merged'/'track'). Saves 2 vertical lines.
  let idxW = "track N".length;
  let tasksW = "N tasks".length;
  let readyW = "N ready".length;
  const kindW = "merged".length;
  shown.forEach((t, i) => {
    idxW = Math.max(idxW, `track ${i + 1}`.length);
    tasksW = Math.max(tasksW, `${t.taskIds.size} tasks`.length);
    readyW = Math.max(readyW, `${t.readyCount} ready`.length);
  });
  const numCols = 5;
  const padding = numCols * 3 + 1;
  const rootsBudget = Math.max(10, width - idxW - tasksW - readyW - kindW - padding);
  const table = newHudTable();
  shown.forEach((t, i) => {
    const roots = t.roots.map((r) => r.localId).join(", ");
    const kind = t.roots.length > 1 ? "merged" : "track";
    // Colour: 'merged' diamond is structurally interesting (multiple
    // independent goals share a prerequisite) — yellow to flag it.
    // Plain 'track' is unremarkable — dim.
    // Ready count: green if any ready, dim if none.
    const kindCell = t.roots.length > 1 ? pc.yellow(kind) : pc.dim(kind);
    const readyCell = `${t.readyCount > 0 ? pc.green(String(t.readyCount)) : pc.dim("0")} ${pc.dim("ready")}`;
    table.push([
      `${pc.dim("track")} ${pc.bold(String(i + 1))}`,
      pc.cyan(truncate(roots, rootsBudget)),
      `${t.taskIds.size} ${pc.dim("tasks")}`,
      readyCell,
      kindCell,
    ]);
  });
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/** Compact agent-status histogram for the HUD header. Each emoji is
 *  STATUS_COLORS-coloured so the same green/cyan/yellow signal that
 *  appears in the agents table shows up in the summary cell too. */
function agentStatusHistogram(agents: readonly AgentRow[]): string {
  const counts = new Map<AgentStatus, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  if (counts.size === 0) return pc.dim("none");
  const parts: string[] = [];
  for (const [status, n] of counts) parts.push(`${statusIcon(status)}${n}`);
  return parts.join(" ");
}

async function cmdHud(db: Db, opts: HudOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // mu hud is print-once-and-compose by design (`watch -n 5 mu hud`,
  // `tmux display-popup -E 'mu hud ...'`). dryRun so the periodic
  // poll doesn't race a long-running `git worktree add` mid-spawn,
  // which would otherwise prune the spawn's placeholder agent row
  // and surface as a confusing FOREIGN KEY constraint failure on the
  // subsequent `INSERT INTO vcs_workspaces`. (Surfaced live by
  // bug_agent_spawn_workspace_fk_failure.)
  const view = await listLiveAgents(db, { workstream, dryRun: true });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream).sort(byRoiDesc);
  const inProgress = (
    db
      .prepare(
        "SELECT * FROM tasks WHERE workstream = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC",
      )
      .all(workstream) as RawTaskRowForState[]
  ).map(rawTaskRowToTask);
  const eventLimit = opts.lines ?? 10;
  const recentEvents = listLogs(db, { workstream, kind: "event", limit: eventLimit });

  if (opts.json) {
    emitJson({
      workstream,
      summary: {
        ready: ready.length,
        inProgress: inProgress.length,
        tracks: tracks.length,
        agents: view.agents.length,
        orphans: view.orphans.length,
      },
      agents: view.agents,
      orphans: view.orphans,
      tracks,
      ready: withRoiAll(ready),
      inProgress: withRoiAll(inProgress),
      recent: recentEvents,
    });
    return;
  }

  // ── Human render: greedy top-down layout ──────────────────────────
  //
  // Sections (in priority order — the higher one wins the budget when
  // squeezed):
  //   1. Header line                                     (1 line)
  //   2. Agents table          (always; usually small)
  //   3. Ready tasks table     (operator's 'what to dispatch next')
  //   4. In-progress table     ('what's already running')
  //   5. Tracks table          (parallelism overview)
  //   6. Recent events table   ('what just happened')
  //
  // Every section is a cli-table3 with bold column headers and N
  // data rows. No section-name preamble — the column headers IDENTIFY
  // the section (a `roots` column ⇒ tracks; `+ago` + `event` ⇒
  // recent; etc.). Cost: 2N + 3 lines per section.
  // We deduct each section's cost from the remaining budget before
  // moving to the next. When we can't fit any rows of a section, we
  // skip the entire section (don't render anything).
  //
  // Width: every table runs to the full pane width; the most
  // compressible cell (title / payload / task) absorbs slack via the
  // existing truncate() helper, mirroring formatTaskListTable.
  const { width, height } = await hudPaneSize();
  let remaining = height;

  // Now that every table is header-less, both the top and bottom
  // borders of every table are visually similar (`┌─┬─┐` and
  // `└─┴─┘`). We keep both: the bottom of one table abutting the
  // top of the next forms a doubled seam that reads as a clear
  // boundary between sections (which is more honest now that no
  // section has its own header to separate it). printTable just
  // emits the rendered string and returns its line count.
  //
  // Cost math per section:
  //   table cost = 2N + 1   (top border + N·(data row + sep), bottom = the last sep)
  //   footer     = 1        (when truncated)
  const printTable = (rendered: string): number => {
    console.log(rendered);
    return rendered.split("\n").length;
  };

  // 1. Workstream-summary table. Single data row, no header — each
  // cell carries its own dim section word (`2 ready`, `0 in-progress`,
  // ...). Cost with bottom dropped + no header = 2 lines.
  // Colour: workstream bold-cyan (it's the load-bearing identifier);
  // counts coloured by significance — ready green if any (work to
  // dispatch), in-progress yellow if any (work in flight), tracks
  // bold (always meaningful), agents bold.
  const colorCount = (n: number, color: (s: string) => string): string =>
    n > 0 ? color(String(n)) : pc.dim("0");
  const headerTable = newHudTable();
  headerTable.push([
    pc.bold(pc.cyan(`mu-${workstream}`)),
    `${colorCount(ready.length, pc.green)} ${pc.dim("ready")}`,
    `${colorCount(inProgress.length, pc.yellow)} ${pc.dim("in-progress")}`,
    `${pc.bold(String(tracks.length))} ${pc.dim("tracks")}`,
    `${pc.bold(String(view.agents.length))} ${pc.dim("agents")}`,
    agentStatusHistogram(view.agents),
  ]);
  remaining -= printTable(headerTable.toString());

  // Helper: render a section if there's room, deducting its cost.
  // No section preamble — the table's column headers identify the
  // section. moreFooter shows '… +N more (<verb>)' when truncated.
  //
  // Sizing math (per section, all tables now header-less, bottom kept):
  //   actualCost(N) = 2N + 1   (top + N·(data + sep))
  //   footer line   = 1        (when truncated)
  //
  // Two cases:
  //   FULL fit: 2N + 1 <= remaining → render all rows, no footer
  //   TRUNCATED: pick largest N s.t. 2N + 1 + 1 <= remaining
  //              ⇒ N <= (remaining - 2) / 2
  //   If N is 0 we can't render anything useful; skip the section.
  const renderSection = (
    ren: (rowCap: number) => { rendered: string; rowsShown: number; rowsTotal: number },
    full: number,
    moreVerb: string,
  ): void => {
    if (full === 0) return; // section legitimately empty — don't render anything
    let rowCap: number;
    let willTruncate: boolean;
    if (2 * full + 1 <= remaining) {
      rowCap = full;
      willTruncate = false;
    } else {
      const slot = remaining - 2;
      rowCap = slot < 2 ? 0 : Math.floor(slot / 2);
      if (rowCap === 0) return;
      willTruncate = true;
    }
    const out = ren(rowCap);
    let cost = printTable(out.rendered);
    if (willTruncate && out.rowsShown < out.rowsTotal) {
      const extra = out.rowsTotal - out.rowsShown;
      console.log(pc.dim(`  … +${extra} more (${moreVerb})`));
      cost += 1;
    }
    remaining -= cost;
  };

  // 2. Agents.
  renderSection(
    (cap) => formatHudAgentsTable(db, view.agents, width, cap),
    view.agents.length,
    `mu agent list -w ${workstream}`,
  );

  // 3. Ready.
  renderSection(
    (cap) =>
      formatHudTasksTable(ready, width, cap, {
        withOwner: false,
      }),
    ready.length,
    `mu task ready -w ${workstream}`,
  );

  // 4. In progress.
  renderSection(
    (cap) =>
      formatHudTasksTable(inProgress, width, cap, {
        withOwner: true,
      }),
    inProgress.length,
    `mu task list --status IN_PROGRESS -w ${workstream}`,
  );

  // 5. Tracks.
  renderSection(
    (cap) => formatHudTracksTable(tracks, width, cap),
    tracks.length,
    `mu state -w ${workstream}`,
  );

  // 6. Recent events.
  renderSection(
    (cap) => formatHudRecentTable(recentEvents, width, cap),
    recentEvents.length,
    `mu log -w ${workstream} --kind event`,
  );
}

async function cmdAttach(db: Db, name: string, opts: { workstream?: string }): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const sessionName = `mu-${workstream}`;
  if (!(await sessionExists(sessionName))) {
    throw new UsageError(`workstream "${workstream}" has no tmux session yet`);
  }
  // mu agent attach prints scrollback + an attach hint; it has no
  // business pruning the registry. dryRun.
  const view = await listLiveAgents(db, { workstream, dryRun: true });
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

/** Stable JSON output: one line, no trailing newline beyond console.log's.
 *  Exported so cli/*.ts modules can use the same single-source-of-truth
 *  formatter. */
export function emitJson(value: unknown): void {
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
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as SpawnOpts;
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
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        backend?: VcsBackendName;
        from?: string;
        projectRoot?: string;
        workstream?: string;
        json?: boolean;
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
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        commit?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceFree(db, agent, opts))();
    });

  workspace
    .command("path <agent>")
    .description(
      "Print the on-disk path of an agent's workspace. Usable as `cd $(mu workspace path foo)`.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdWorkspacePath(db, agent, opts))();
    });

  workspace
    .command("orphans")
    .description(
      "List on-disk workspace dirs in <state-dir>/workspaces/<workstream>/ that have no DB row. These block subsequent `--workspace` spawns; surfaced by bug_workspace_orphan_not_in_state. Cleanup recipe shown in Next: hints.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdWorkspaceOrphans(db, opts))();
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
    .option(
      "-b, --blocked-by <ids>",
      "comma-separated task ids that block this one (this task is blocked by them)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string | undefined) {
      const opts = (this as Command).opts() as {
        title: string;
        impact: number;
        effortDays: number;
        blockedBy?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAdd(db, id, opts))();
    });

  task
    .command("list")
    .description("List every task in the current workstream (id, status, ROI, owner)")
    .option(...WORKSTREAM_OPT)
    .option(
      "--status <status>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive)`,
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string;
      };
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
    .description(
      "Append a note to a task. Author defaults to $MU_AGENT_NAME (env injected at spawn) > pane title > $USER > 'orchestrator'; pass --author to override. Single-quote the text (or use a quoted heredoc) to defer shell expansion of $VAR / $(...) / `cmd`; double quotes expand them in your shell before mu sees the note.",
    )
    .option("--author <name>", "override the auto-detected author label")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string, text: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        author?: string;
      };
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
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskClose(db, id, opts))();
    });

  task
    .command("open <id>")
    .description("Mark a task OPEN — e.g. to reopen something closed by mistake (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskOpen(db, id, opts))();
    });

  task
    .command("reject <id>")
    .description(
      "Mark a task REJECTED — terminal 'won't do' (out of scope, duplicate, wontfix). Refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReject(db, id, opts))();
    });

  task
    .command("defer <id>")
    .description(
      "Mark a task DEFERRED — parked, may revisit. Like reject, doesn't satisfy a blocked-by edge; refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskDefer(db, id, opts))();
    });

  task
    .command("release <id>")
    .description(
      "Clear a task's owner; pass --reopen to also flip status back to OPEN (idempotent)",
    )
    .option("--reopen", "also flip status back to OPEN")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        reopen?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskRelease(db, id, opts))();
    });

  task
    .command("claim <id>")
    .description(
      "Claim a task. Default: derive agent from $TMUX_PANE's title (must be a registered worker). " +
        "Use --for <worker> to dispatch. Use --self for orchestrator-direct work (anonymous claim, owner=NULL, actor recorded in agent_logs).",
    )
    .option("-f, --for <agent>", "claim on behalf of a registered worker (dispatch)")
    .option(
      "--self",
      "anonymous claim (orchestrator pattern): owner stays NULL; actor recorded in agent_logs.source. Mutually exclusive with --for.",
    )
    .option(
      "--actor <name>",
      "override the actor name used for the log (only valid with --self; defaults to pane title or $USER)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (taskId: string) {
      const opts = (this as Command).opts() as {
        for?: string;
        self?: boolean;
        actor?: string;
        evidence?: string;
        workstream?: string;
        json?: boolean;
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
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlock(db, blocked, opts))();
    });

  task
    .command("unblock <blocked>")
    .description("Remove a single blocking edge (idempotent)")
    .requiredOption("-b, --by <blocker>", "the task whose blocker edge to remove")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskUnblock(db, blocked, opts))();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task. Cascades to task_edges and task_notes via FK. Idempotent on missing.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
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
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        title?: string;
        impact?: number;
        effortDays?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUpdate(db, id, opts))();
    });

  task
    .command("reparent <id>")
    .description(
      "Atomically replace every incoming edge of <id> with the new --blocked-by list. Pass --blocked-by '' to clear all blockers.",
    )
    .requiredOption(
      "-b, --blocked-by <ids>",
      "comma-separated tasks that block <id> (empty string clears all)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReparent(db, id, opts))();
    });

  task
    .command("wait <ids...>")
    .description(
      "Block until the listed tasks reach --status (default CLOSED). Default: every task must reach the target (--all). Pass --any to exit on the first one that does. Exit 0 = condition met; 5 = timeout.",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option("--any", "succeed as soon as ONE listed task reaches the target (default: all must)")
    .option("--timeout <seconds>", "max seconds to wait (0 = forever, default 600)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        timeout?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskWait(db, ids, opts))();
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
    .option(...JSON_OPT)
    .action(function (slug: string) {
      const opts = (this as Command).opts() as {
        by?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdApprovalGrant(db, slug, opts))();
    });

  approve
    .command("deny <slug>")
    .description("Deny a pending approval (sets status='denied')")
    .option("--by <name>", "override decider name (default: agent via $TMUX_PANE, else 'user')")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (slug: string) {
      const opts = (this as Command).opts() as {
        by?: string;
        workstream?: string;
        json?: boolean;
      };
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
    .command("hud")
    .description(
      "Print-once HUD card for a workstream. Default: dynamic table layout that fills the terminal (or tmux pane) height + width with as much useful data as fits — header + agents + ready + in-progress + tracks + recent-events, each rendered as a cli-table3 with width-aware truncation. Use --json for the structured machine view. No loop, no tmux side effects — user composes redraw via `watch -n 5 mu hud -w X` or `tmux display-popup -E 'mu hud -w X'`.",
    )
    .option(
      "-n, --lines <n>",
      "recent-events tail cap (default 10; bounds the human view too)",
      parseLines,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as HudOpts;
      return handle((db) => cmdHud(db, opts))();
    });

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
      const opts = (this as Command).optsWithGlobals() as AdoptCliOpts;
      return handle((db) => cmdAdopt(db, paneOrTitle, opts))();
    });

  program
    .command("sql <query>")
    .description("Run a SQL query against the live mu DB (SELECT / UPDATE / DELETE all allowed)")
    .option(...JSON_OPT)
    .option(
      "--confirm-rows <n>",
      "abort if affected-row count differs from N (rollback)",
      parseLines,
    )
    .action(function (query: string) {
      const opts = (this as Command).opts() as { json?: boolean; confirmRows?: number };
      return handle((db) => cmdSql(db, query, opts))();
    });

  // ─── mu undo + mu snapshot {list, show} ────────────────────────
  //
  // `mu undo` lives at the top level (not under `mu snapshot`) because
  // it's the user-facing recovery verb — same prominence as `mu state`,
  // `mu doctor`. The list/show inspector verbs nest under `mu snapshot`
  // since they're scoped operations on the snapshots collection.

  program
    .command("undo")
    .description(
      "Restore the most recent snapshot (or one selected via --to). Pass --yes to actually restore; otherwise prints a dry-run summary. tmux state is NOT rolled back — the post-restore reconcile prunes ghost agents and surfaces orphan panes; re-spawn or `mu adopt` as needed.",
    )
    .option("--to <id>", "snapshot id to restore (default: most recent)", parseLines)
    .option("-y, --yes", "actually restore (without this flag, prints a dry-run summary)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        to?: number;
        yes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdUndo(db, opts))();
    });

  const snapshot = program
    .command("snapshot")
    .description("Snapshot inspection (use `mu undo` to restore one)");

  snapshot
    .command("list")
    .description("List snapshots, newest first.")
    .option("-n, --lines <n>", "cap rows; default 20", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { lines?: number; json?: boolean };
      return handle((db) => cmdSnapshotList(db, opts))();
    });

  snapshot
    .command("show <id>")
    .description("Show one snapshot's full metadata.")
    .option(...JSON_OPT)
    .action(function (idArg: string) {
      const id = parseLines(idArg);
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdSnapshotShow(db, id, opts))();
    });

  program
    .command("doctor")
    .description("Environment + state health check")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean };
      return handle((db) => cmdDoctor(db, opts))();
    });

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
