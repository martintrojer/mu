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
  STATUS_EMOJI,
  WorkspacePreservedError,
  getAgent,
  getAgentByPane,
} from "./agents.js";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
} from "./approvals.js";
import {
  cmdAdopt,
  cmdAgentShow,
  cmdAttach,
  cmdClose,
  cmdFree,
  cmdList,
  cmdRead,
  cmdSend,
  cmdSpawn,
  cmdWhoami,
} from "./cli/agents.js";
import {
  cmdApprovalAdd,
  cmdApprovalDeny,
  cmdApprovalGrant,
  cmdApprovalList,
  cmdApprovalWait,
} from "./cli/approve.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdHud } from "./cli/hud.js";
import { type LogReadOpts, type LogWriteOpts, cmdLog } from "./cli/log.js";
import { cmdSnapshotList, cmdSnapshotShow, cmdUndo } from "./cli/snapshot.js";
import { cmdSql } from "./cli/sql.js";
import { cmdMission, cmdState } from "./cli/state.js";
import {
  cmdClaim,
  cmdMyNext,
  cmdMyTasks,
  cmdTaskAdd,
  cmdTaskBlock,
  cmdTaskBlocked,
  cmdTaskClose,
  cmdTaskDefer,
  cmdTaskDelete,
  cmdTaskGoals,
  cmdTaskList,
  cmdTaskNext,
  cmdTaskNote,
  cmdTaskNotes,
  cmdTaskOpen,
  cmdTaskOwnedBy,
  cmdTaskReady,
  cmdTaskReject,
  cmdTaskRelease,
  cmdTaskReparent,
  cmdTaskSearch,
  cmdTaskShow,
  cmdTaskTree,
  cmdTaskUnblock,
  cmdTaskUpdate,
  cmdTaskWait,
} from "./cli/tasks.js";
import {
  cmdWorkspaceCreate,
  cmdWorkspaceFree,
  cmdWorkspaceList,
  cmdWorkspaceOrphans,
  cmdWorkspacePath,
} from "./cli/workspace.js";
import { cmdDestroy, cmdInit, cmdWorkstreamList } from "./cli/workstream.js";
import { type Db, openDb } from "./db.js";
import type { LogRow } from "./logs.js";
import { type NextStep, hasNextSteps, isJsonMode, printNextStepsTo } from "./output.js";
import {
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
} from "./snapshots.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  TASK_STATUS_LIST,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  type TaskRow,
  type TaskStatus,
  getTask,
  isTaskStatus,
} from "./tasks.js";
import { PaneNotFoundError, TmuxError, tmux } from "./tmux.js";
import type { Track } from "./tracks.js";
import type { VcsBackendName } from "./vcs.js";
import {
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
} from "./workspace.js";
import { WorkstreamNameInvalidError, type WorkstreamSummary } from "./workstream.js";

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
export function parseStatusOption(raw: string, flag = "--status"): TaskStatus {
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

export function statusIcon(status: AgentStatus): string {
  return STATUS_COLORS[status](STATUS_EMOJI[status]);
}

export function formatAgentsTable(agents: readonly AgentRow[]): string {
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

export function formatReadyTable(tasks: readonly TaskRow[]): string {
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

export function formatTracks(tracks: readonly Track[]): string {
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

/** Workspaces table renderer. Used by `mu workspace list` and by
 *  `mu state`'s Workspaces section — exported so cli/workspace.ts
 *  can reuse it. */
export function formatWorkspacesTable(rows: readonly WorkspaceRow[]): string {
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

/** Helper types/converters used by `mu state` and `mu hud` for their
 *  IN_PROGRESS / recent_closed slices. Both verbs re-query the tasks
 *  table directly (with status + ordering not exposed by listTasks)
 *  so the column-name conversion lives here as a shared helper. */
export interface RawTaskRowForState {
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

export function rawTaskRowToTask(r: RawTaskRowForState): TaskRow {
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

/**
 * Workstreams summary table renderer. Used by `mu workstream list`
 * and `bare mu` (no-workstream discovery fallback). Both verbs render
 * the same shape; the helper lives in cli.ts so cli/workstream.ts and
 * cli/state.ts can both import it without a lateral cli/* dependency.
 */
export function formatWorkstreamsTable(rows: WorkstreamSummary[]): string {
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

/**
 * Resolve "the agent running this process" by reading `$TMUX_PANE` and
 * looking up the matching agent row. Throws UsageError with a helpful
 * message if either step fails. Used by `mu whoami` / `my-tasks` /
 * `my-next` to give an LLM-in-a-pane zero-config self-identification.
 * Lives in cli.ts so cli/agents.ts and cli/tasks.ts can both import
 * it without a lateral cli/* dependency.
 */
export function resolveSelf(db: Db): AgentRow {
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

// ─── Shared SDK-CLI bridge helpers (used by cli/*.ts) ──────────────
//
// These were extracted from inline-with-task-verbs in cli.ts; the
// task verbs moved to src/cli/tasks.ts but the helpers stay here so
// every cli/*.ts module can import them from one canonical location.

function roiOf(t: TaskRow): number {
  return t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
}

export function byRoiDesc(a: TaskRow, b: TaskRow): number {
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

export function withRoiAll<T extends TaskRow>(tasks: T[]): (T & { roi?: number })[] {
  return tasks.map(withRoi);
}

/** Truncate `s` to fit `max` columns (counting display width as length;
 *  good enough for ASCII titles, undercount for emoji/CJK — acceptable
 *  trade-off given the terminal will visually clip anyway). Adds an
 *  ellipsis when truncated. */
export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, max);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
}

export function formatTaskListTable(
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

export function colorStatus(status: TaskRow["status"]): string {
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
 * Sister of `assertTaskInWorkstream` for verbs that target an agent
 * by name. Agent names are globally unique today (PK on agents.name),
 * so the `-w` flag is purely a scope check: operators think workstream-
 * first and `-w` turns silent wrong-target acts into clear
 * `AgentNotInWorkstreamError` (exit 4). No-op when `workstream` is
 * undefined or the agent doesn't exist (downstream handler raises
 * `AgentNotFoundError`).
 */
export function assertAgentInWorkstream(
  db: Db,
  agentName: string,
  workstream: string | undefined,
): void {
  if (!workstream) return;
  const agent = getAgent(db, agentName);
  if (agent && agent.workstream !== workstream) {
    throw new AgentNotInWorkstreamError(agentName, workstream, agent.workstream);
  }
}

/**
 * Sister of `assertAgentInWorkstream` for verbs that target a single
 * task by ID. Globally-unique task IDs mean these verbs could ignore
 * the flag, but accepting it gives the operator a sanity check ("yes,
 * I think this task is in that workstream") and raises a clear
 * `TaskNotInWorkstreamError` instead of silently acting on the task
 * they didn't mean. No-op when `workstream` is undefined or the task
 * doesn't exist (downstream handler raises `TaskNotFoundError`).
 */
export function assertTaskInWorkstream(
  db: Db,
  taskId: string,
  workstream: string | undefined,
): void {
  if (!workstream) return;
  const task = getTask(db, taskId);
  if (task && task.workstream !== workstream) {
    throw new TaskNotInWorkstreamError(taskId, workstream, task.workstream);
  }
}

/**
 * Default fallback when stdout isn't a TTY (e.g. output is piped to
 * less/jq) and `process.stdout.columns` is undefined. 100 fits an 80-col
 * terminal with some breathing room; 100 is wide enough to keep most
 * rows on one line.
 */
const DEFAULT_TERMINAL_WIDTH = 100;

// ─── Verb implementations ──────────────────────────────────────────────

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
      const opts = (this as Command).opts() as {
        down?: boolean;
        workstream?: string;
        json?: boolean;
      };
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
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        lines?: number;
      };
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
      const opts = (this as Command).optsWithGlobals() as {
        name?: string;
        cli?: string;
        role?: string;
        workstream?: string;
        json?: boolean;
      };
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
