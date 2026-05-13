// mu — pure rendering helpers used by every cli/*.ts verb wrapper.
//
// Extracted from src/cli.ts (review_cli_ts_past_refactor_signal): the
// table renderers, status colourers, truncators, and relative-time
// formatter were the bulk of cli.ts's bloat (~600 LOC over the 800-LOC
// refactor signal). Co-locating them here keeps cli.ts focused on
// argument parsing, workstream resolution, and program wiring.
//
// All helpers are pure (no I/O beyond returning a string) except
// `printLogRow` which writes a single line to stdout — kept here so
// `mu log` and the `recent events` section of `mu state` share one
// renderer. cli.ts re-exports every symbol for back-compat with the
// existing import surface (tests + cli/* importers).

import { type AgentRow, type AgentStatus, STATUS_EMOJI } from "../agents.js";
import { type LogRow, displayEventPayload } from "../logs.js";
import { muTable, pc } from "../output.js";
import type { TaskRow } from "../tasks.js";
import type { TaskStatus } from "../tasks/status.js";
import type { Track } from "../tracks.js";
import type { WorkspaceRow } from "../workspace.js";
import type { WorkstreamSummary } from "../workstream.js";

// ─── Status colours / icons ────────────────────────────────────────────

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

/**
 * Glyph used to flag the derived 'idle but assigned' state
 * (`AgentRow.idle === true`; idle_assigned_agent_detection). Plain
 * Unicode warning sign so it renders the same in cli-table3 cells
 * AND in single-line prose without needing a Nerd Font (the agent's
 * primary status glyph still uses Nerd Font via STATUS_EMOJI).
 */
export const IDLE_GLYPH = "⚠";

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

/** Ink colour equivalent of colorStatus(). The TUI must not embed
 * picocolors ANSI strings inside <Text>; rows pass this value to Ink's
 * color prop instead. DEFERRED maps to gray to mirror colorStatus()'s
 * dim treatment in the static CLI tables. */
export type InkColor = "cyan" | "yellow" | "green" | "red" | "gray";

export function inkColorForStatus(status: TaskStatus): InkColor {
  switch (status) {
    case "OPEN":
      return "cyan";
    case "IN_PROGRESS":
      return "yellow";
    case "CLOSED":
      return "green";
    case "REJECTED":
      return "red";
    case "DEFERRED":
      return "gray";
  }
}

// ─── Width / truncation helpers ───────────────────────────────────────

/**
 * Default fallback when stdout isn't a TTY (e.g. output is piped to
 * less/jq) and `process.stdout.columns` is undefined. 100 fits an 80-col
 * terminal with some breathing room; 100 is wide enough to keep most
 * rows on one line.
 */
const DEFAULT_TERMINAL_WIDTH = 100;

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
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

/** Format an elapsed duration (in ms) as a compact relative string:
 *  '12s', '3m', '1h', '2d', '3w'. Used by the task list table when
 *  `--sort recency`/`--sort age` is active so the timeframe the user
 *  is sorting by is visible. Mirrors the helper in src/cli/state.ts
 *  (TUI renderers); kept in sync (the TUI version omits weeks because it shows tighter
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

/** Like {@link relTime} but with a trailing " ago" suffix. The TUI's
 *  Recent card / popup wants past-tense formatting ("3m ago") while
 *  the In-progress card / popup wants the bare token ("3m"); both
 *  buckets share the rest of the arithmetic. Hoisted out of the TUI
 *  cluster (review_unify_format_when_since) so the two formatters
 *  can't drift the way they were starting to. */
export function relTimeAgo(ms: number): string {
  return `${relTime(ms)} ago`;
}

// ─── Table renderers ──────────────────────────────────────────────────

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
    // Idle (alive + assigned + no recent progress): supplement the
    // status glyph with a yellow ⚠ prefix, and yellow the agent
    // name itself so the row is visually obvious. The status column
    // stays the truth ('needs_input') — the ⚠ is the supplement.
    const idle = a.idle === true;
    const glyphCell = idle
      ? `${pc.yellow(IDLE_GLYPH)} ${statusIcon(a.status)}`
      : statusIcon(a.status);
    const nameCell = idle ? pc.yellow(a.name) : a.name;
    table.push([
      glyphCell,
      nameCell,
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
  // ready-task table doesn't blow out terminal width.
  let idW = "name".length;
  let impactW = "impact".length;
  let effortW = "effort".length;
  let roiW = "ROI".length;
  let ownerW = "owner".length;
  for (const t of sorted) {
    idW = Math.max(idW, t.name.length);
    impactW = Math.max(impactW, String(t.impact).length);
    effortW = Math.max(effortW, String(t.effortDays).length);
    const roi = (t.impact / t.effortDays).toFixed(1);
    roiW = Math.max(roiW, roi.length);
    ownerW = Math.max(ownerW, (t.ownerName ?? "").length);
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
      pc.bold("name"),
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
      t.name,
      truncate(t.title, titleBudget),
      String(t.impact),
      String(t.effortDays),
      roi,
      t.ownerName ?? "",
    ]);
  }
  return table.toString();
}

export function formatTracks(tracks: readonly Track[]): string {
  if (tracks.length === 0) return pc.dim("  (no open tracks)");
  const lines: string[] = [];
  tracks.forEach((track, i) => {
    const rootNames = track.roots.map((r) => r.name).join(", ");
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
      r.agentName,
      r.workstreamName,
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
  const ws = row.workstreamName ?? pc.dim("—");
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
 * and the bare-`mu` empty-machine discovery fallback. Both
 * render the same shape; the helper lives here so cli/workstream.ts
 * and cli.ts can both import it without a lateral cli/* dependency.
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
      r.name,
      r.tmuxAlive ? pc.green("alive") : pc.dim("—"),
      String(r.agentCount),
      String(r.taskCount),
      String(r.edgeCount),
      String(r.noteCount),
    ]);
  }
  return table.toString();
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
    ? ["name", "workstream", "status", "title", "impact", "effort", "ROI", "owner"]
    : ["name", "status", "title", "impact", "effort", "ROI", "owner"];
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
    widths.set("localId", Math.max(widths.get("localId") ?? 0, t.name.length));
    if (opts.withWorkstream) {
      widths.set("workstream", Math.max(widths.get("workstream") ?? 0, t.workstreamName.length));
    }
    widths.set("status", Math.max(widths.get("status") ?? 0, t.status.length));
    widths.set("impact", Math.max(widths.get("impact") ?? 0, String(t.impact).length));
    widths.set("effortDays", Math.max(widths.get("effortDays") ?? 0, String(t.effortDays).length));
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    widths.set("roi", Math.max(widths.get("roi") ?? 0, roi.length));
    widths.set("owner", Math.max(widths.get("owner") ?? 0, (t.ownerName ?? "—").length));
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
          t.name,
          t.workstreamName,
          colorStatus(t.status),
          title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.ownerName ?? pc.dim("—"),
        ]
      : [
          t.name,
          colorStatus(t.status),
          title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.ownerName ?? pc.dim("—"),
        ];
    const row = timeHeader === null ? baseRow : [...baseRow, pc.dim(timeCells[i] ?? "")];
    table.push(row);
  }
  return table.toString();
}
