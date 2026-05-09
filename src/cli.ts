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
import { Command, InvalidArgumentError } from "commander";

import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  type AgentRow,
  type AgentStatus,
  STATUS_EMOJI,
  WorkspacePreservedError,
  getAgentByPane,
} from "./agents.js";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
} from "./approvals.js";
import { wireAgentCommands, wireSelfCommands } from "./cli/agents.js";
import { wireApproveCommands } from "./cli/approve.js";
import { wireDoctorCommand } from "./cli/doctor.js";
import { wireHudCommand } from "./cli/hud.js";
import { wireLogCommand } from "./cli/log.js";
import { wireSnapshotCommands } from "./cli/snapshot.js";
import { wireSqlCommand } from "./cli/sql.js";
import { cmdMission, wireStateCommands } from "./cli/state.js";
import { wireTaskCommands } from "./cli/tasks.js";
import { wireWorkspaceCommands } from "./cli/workspace.js";
import { wireWorkstreamCommands } from "./cli/workstream.js";
import { type Db, openDb } from "./db.js";
import { type LogRow, displayEventPayload } from "./logs.js";
import {
  type NextStep,
  hasNextSteps,
  isJsonMode,
  muTable,
  pc,
  printNextStepsTo,
} from "./output.js";
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
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  type TaskRow,
  type TaskStatus,
  isTaskStatus,
} from "./tasks.js";
import { PaneNotFoundError, TmuxError, tmux } from "./tmux.js";
import type { Track } from "./tracks.js";
import {
  HomeDirAsProjectRootError,
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
    err instanceof HomeDirAsProjectRootError ||
    err instanceof ApprovalAlreadyDecidedError ||
    err instanceof ClaimerNotRegisteredError ||
    err instanceof SnapshotVersionMismatchError ||
    err instanceof TaskIdInvalidError
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
export function handle(fn: (db: Db) => Promise<void>): () => Promise<void> {
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
  // Cap the variable-width columns so a long tmux window name (or a
  // future free-text role) can't push the table past the terminal.
  // Other columns are bounded by their schemas (name 32-char cap,
  // cli is one of pi/codex/claude, status is one of OPEN/...).
  const table = muTable({
    head: [
      pc.bold(""),
      pc.bold("name"),
      pc.bold("cli"),
      pc.bold("status"),
      pc.bold("window"),
      pc.bold("role"),
    ],
    colWidths: [null, null, null, null, 32, 14],
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

  // Title is pre-truncated above; use muTable so wordWrap:false acts
  // as a safety belt for any other cell we don't pre-trim.
  const table = muTable({
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
 *  can reuse it. The `behind` column shows how many commits the row's
 *  parent_ref is behind the project's default branch HEAD; color-coded
 *  green ≤2, yellow 3–9, red ≥10. Renders "—" when the count couldn't
 *  be computed (no main resolvable, none-backend, missing parent_ref)
 *  or wasn't asked for (no decorateWithStaleness call). Surfaced by
 *  bug_workspace_stale_parent_silent_drift. */
export function formatWorkspacesTable(rows: readonly WorkspaceRow[]): string {
  // The path column is the one that bit operators today: an absolute
  // ~/.local/state/mu/workspaces/<ws>/worker-foo path runs ~70 chars
  // and pushed the table to ~200 cols. Front-truncate so the useful
  // trailing `<ws>/<agent>` suffix survives, then cap the column with
  // colWidths as a safety belt (tables_truncate_long_cols_audit).
  const PATH_BUDGET = 40;
  const table = muTable({
    head: ["agent", "workstream", "backend", "path", "parent_ref", "behind", "created"].map((h) =>
      pc.bold(h),
    ),
    colWidths: [null, null, null, PATH_BUDGET, null, null, null],
  });
  for (const r of rows) {
    table.push([
      r.agent,
      r.workstream,
      r.backend,
      truncateFront(r.path, PATH_BUDGET - 2),
      r.parentRef ? pc.dim(r.parentRef.slice(0, 12)) : pc.dim("—"),
      formatBehind(r.commitsBehindMain),
      pc.dim(r.createdAt),
    ]);
  }
  return table.toString();
}

/** Color-code the commits-behind-main count. Green ≤2 (fresh), yellow
 *  3–9 (drifting), red ≥10 (stale). Undefined / null renders as a dim
 *  em-dash so the column stays well-typed even when staleness wasn't
 *  computed. */
function formatBehind(n: number | null | undefined): string {
  if (n === undefined || n === null) return pc.dim("—");
  if (n <= 2) return pc.green(String(n));
  if (n <= 9) return pc.yellow(String(n));
  return pc.red(String(n));
}

/** One agent_logs row, human-formatted. Used by `mu log` (read + tail)
 *  and by the `recent events` section of `mu state`. Exported so the
 *  cli/log.ts module can reuse it. */
export function printLogRow(row: LogRow): void {
  const ws = row.workstream ?? pc.dim("—");
  const time = row.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const kindColor =
    row.kind === "event" ? pc.cyan : row.kind === "broadcast" ? pc.yellow : (s: string) => s;
  // For `kind='event'`, strip the `task.claim<TAB>...` structured
  // prefix used by claim events; the human-readable prose tail is
  // what the user wants to see. Other event kinds pass through
  // unchanged. See review_code_last_claim_actor_brittle.
  const payload = row.kind === "event" ? displayEventPayload(row.payload) : row.payload;
  console.log(
    `${pc.dim(`#${row.seq}`)} ${pc.dim(time)}  ${pc.bold(row.source)}  ${kindColor(row.kind)}  [${ws}]  ${payload}`,
  );
}

/**
 * Workstreams summary table renderer. Used by `mu workstream list`
 * and `bare mu` (no-workstream discovery fallback). Both verbs render
 * the same shape; the helper lives in cli.ts so cli/workstream.ts and
 * cli/state.ts can both import it without a lateral cli/* dependency.
 */
export function formatWorkstreamsTable(rows: WorkstreamSummary[]): string {
  // Workstream names are user-chosen free-form text; everything else
  // is a small int / fixed-shape token. Cap the name column so a long
  // workstream name doesn't push the row counts off-screen.
  const table = muTable({
    head: ["name", "tmux", "agents", "tasks", "edges", "notes"].map((h) => pc.bold(h)),
    colWidths: [40, null, null, null, null, null],
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
 * looking up the matching agent row. Returns null when `$TMUX_PANE` is
 * unset or the pane isn't a managed agent — the lenient variant used
 * by verbs that have a sensible fallback (e.g. `mu approve add` falls
 * back to 'user'). `resolveSelf` wraps this with the strict throwing
 * variant for verbs that genuinely require a managed-pane caller.
 */
export function resolveSelfOptional(db: Db): AgentRow | null {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return null;
  return getAgentByPane(db, paneId) ?? null;
}

/**
 * Strict variant of `resolveSelfOptional`: throws UsageError with a
 * helpful message if `$TMUX_PANE` is unset or the pane isn't a
 * managed agent. Used by `mu whoami` / `my-tasks` / `my-next` to give
 * an LLM-in-a-pane zero-config self-identification. Lives in cli.ts
 * so cli/agents.ts and cli/tasks.ts can both import it without a
 * lateral cli/* dependency.
 */
export function resolveSelf(db: Db): AgentRow {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) {
    throw new UsageError(
      "$TMUX_PANE is not set; this verb only works inside an mu-spawned tmux pane (or any tmux pane, but the pane has to be a managed agent)",
    );
  }
  const agent = resolveSelfOptional(db);
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

/** Format an elapsed duration (in ms) as a compact relative string:
 *  '12s', '3m', '1h', '2d', '3w'. Used by the task list table when
 *  `--sort recency`/`--sort age` is active so the timeframe the user
 *  is sorting by is visible. Mirrors the helper in src/cli/hud.ts;
 *  kept in sync (the hud version omits weeks because it shows tighter
 *  windows, but for task list a 5w-old item is real and worth a tag).
 */
export function relTime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

// ─── Task list --sort ──────────────────────────────────────────────
//
// Four keys; default is `roi` (preserves prior behaviour). The two
// time-based keys (`recency` = updated_at DESC, `age` = created_at ASC)
// are the surface for "what did I touch most recently" and "what's
// gone stale" — neither was queryable before. `id` is the boring
// tiebreaker default for `mu task list` (local_id ASC).
export const TASK_SORT_KEYS = ["roi", "recency", "age", "id"] as const;
export type TaskSortKey = (typeof TASK_SORT_KEYS)[number];

export function isTaskSortKey(s: string): s is TaskSortKey {
  return (TASK_SORT_KEYS as readonly string[]).includes(s);
}

export function parseSortOption(raw: string, flag = "--sort"): TaskSortKey {
  if (!isTaskSortKey(raw)) {
    throw new UsageError(
      `${flag} must be one of ${TASK_SORT_KEYS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/** Sort a copy of `tasks` by `key`. Pure (does not mutate input). */
export function sortTasks(tasks: readonly TaskRow[], key: TaskSortKey): TaskRow[] {
  const out = tasks.slice();
  switch (key) {
    case "roi":
      return out.sort(byRoiDesc);
    case "recency":
      // updated_at DESC: most-recently-touched first.
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "age":
      // created_at ASC: oldest first ("what's gone stale").
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "id":
      return out.sort((a, b) => a.localId.localeCompare(b.localId));
  }
}

/** Which timestamp basis the table's relative-time column should use
 *  for the active sort, or `null` if no time column should be shown. */
export function relTimeBasisForSort(key: TaskSortKey): "updatedAt" | "createdAt" | null {
  if (key === "recency") return "updatedAt";
  if (key === "age") return "createdAt";
  return null;
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

/** Front-truncate `s` to fit `max` columns, prepending an ellipsis when
 *  truncated. Used for paths where the trailing `<workstream>/<agent>`
 *  suffix is the only useful bit (the leading `~/.local/state/mu/...`
 *  prefix is identical for every row). Surfaced live by `mu workspace
 *  list` blowing the terminal width on the `path` column
 *  (tables_truncate_long_cols_audit). */
export function truncateFront(s: string, max: number): string {
  if (max <= 1) return s.slice(-max);
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
}

export function formatTaskListTable(
  tasks: readonly TaskRow[],
  opts: { withWorkstream?: boolean; relTimeBasis?: "updatedAt" | "createdAt" } = {},
): string {
  if (tasks.length === 0) return pc.dim("  (no tasks)");
  // The optional relative-time column is appended at the end; header
  // mirrors the timestamp basis ("updated" / "created") so a glance
  // says which sort key is live.
  const timeHeader =
    opts.relTimeBasis === "updatedAt"
      ? "updated"
      : opts.relTimeBasis === "createdAt"
        ? "created"
        : null;
  const baseHead = opts.withWorkstream
    ? ["id", "workstream", "status", "title", "impact", "effort", "ROI", "owner"]
    : ["id", "status", "title", "impact", "effort", "ROI", "owner"];
  const head = timeHeader === null ? baseHead : [...baseHead, timeHeader];

  // Pre-compute the relative-time strings (relative to NOW) so column
  // width and row text agree.
  const now = Date.now();
  const timeCells: string[] = [];
  if (opts.relTimeBasis !== undefined) {
    const basis = opts.relTimeBasis;
    for (const t of tasks) {
      const ts = basis === "updatedAt" ? t.updatedAt : t.createdAt;
      const ms = now - new Date(ts).getTime();
      timeCells.push(relTime(ms));
    }
  }

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
  let timeWidth = 0;
  if (timeHeader !== null) {
    timeWidth = timeHeader.length;
    for (const cell of timeCells) timeWidth = Math.max(timeWidth, cell.length);
  }
  // cli-table3 adds 2 chars of padding per cell + 1 char border per
  // column. Account for that to find the title budget.
  const numCols = head.length;
  const otherTotal = otherCols.reduce((acc, c) => acc + (widths.get(c) ?? 0), 0) + timeWidth;
  const padding = numCols * 3 + 1;
  const titleBudget = Math.max(20, terminalWidth() - otherTotal - padding);

  // Title is pre-truncated to titleBudget above; muTable adds the
  // wordWrap:false safety belt for any cell we don't trim.
  const table = muTable({
    head: head.map((h) => pc.bold(h)),
  });
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t) continue; // noUncheckedIndexedAccess
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    const title = truncate(t.title, titleBudget);
    const baseRow = opts.withWorkstream
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
    const row = timeHeader === null ? baseRow : [...baseRow, pc.dim(timeCells[i] ?? "")];
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
 * Generic workstream-scope assertion. The three typed wrappers
 * (`assertAgentInWorkstream`, `assertTaskInWorkstream`,
 * `assertApprovalInWorkstream`) all share this shape: SELECT the
 * `workstream` column from `<table>` WHERE `<keyCol>` = key, and if
 * the row exists with a non-matching workstream throw a typed
 * `*NotInWorkstreamError`. No-op when `expectedWs` is undefined or
 * the row doesn't exist (downstream handlers raise the matching
 * `*NotFoundError`).
 *
 * Doing the lookup directly via raw SQL (rather than through the
 * typed `getAgent` / `getTask` / `getApproval`) keeps the helper
 * decoupled from each row's full schema — it only ever needs the
 * one column. The typed errors are constructed by `errFactory` so
 * each caller keeps its specific error class and exit-code mapping.
 */
export function assertEntityInWorkstream<E extends Error>(
  db: Db,
  table: string,
  keyCol: string,
  keyVal: string,
  expectedWs: string | undefined,
  errFactory: (keyVal: string, expectedWs: string, actualWs: string | null) => E,
): void {
  if (!expectedWs) return;
  const row = db.prepare(`SELECT workstream FROM ${table} WHERE ${keyCol} = ?`).get(keyVal) as
    | { workstream: string | null }
    | undefined;
  if (row && row.workstream !== expectedWs) {
    throw errFactory(keyVal, expectedWs, row.workstream);
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
  // agents.workstream is NOT NULL in the schema, so `actual` is
  // never null in practice; the `?? "—"` is defence-in-depth for the
  // typed-error contract (which expects a non-null actual).
  assertEntityInWorkstream(
    db,
    "agents",
    "name",
    agentName,
    workstream,
    (n, exp, actual) => new AgentNotInWorkstreamError(n, exp, actual ?? "—"),
  );
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
  // tasks.workstream is NOT NULL in the schema; see assertAgentInWorkstream.
  assertEntityInWorkstream(
    db,
    "tasks",
    "local_id",
    taskId,
    workstream,
    (id, exp, actual) => new TaskNotInWorkstreamError(id, exp, actual ?? "—"),
  );
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

export function parsePositiveNumber(value: string): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive number, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseImpact(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || n > 100) {
    throw new InvalidArgumentError(`expected 1..100, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseLines(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Parses a non-negative integer (0 is valid). Used for --since which
// uses 0 as the "replay everything" cursor.
export function parseNonNegativeInt(value: string): number {
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
export const WORKSTREAM_OPT = [
  "-w, --workstream <name>",
  "workstream (defaults to $MU_SESSION or the current tmux session minus mu- prefix)",
] as const;

// Reusable --json flag for every read verb. Output shape is documented
// per-verb but follows a consistent pattern: collections → JSON arrays;
// single entities → JSON objects. Empty results print `[]` (collections)
// or `null` (single-entity reads with no match — currently none, since
// every "single" verb errors on miss). Pretty-printing is OFF; one
// document per line so output is grep/jq friendly.
export const JSON_OPT = ["--json", "emit machine-readable JSON instead of a table"] as const;

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

  wireWorkstreamCommands(program);
  wireAgentCommands(program);
  wireSelfCommands(program);
  wireWorkspaceCommands(program);
  wireTaskCommands(program);
  wireLogCommand(program);
  wireApproveCommands(program);
  wireStateCommands(program);
  wireHudCommand(program);
  wireSqlCommand(program);
  wireSnapshotCommands(program);
  wireDoctorCommand(program);
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
