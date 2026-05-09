// mu — `mu hud` verb (dynamic table layout + --json).
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
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import Table from "cli-table3";
import { type AgentRow, type AgentStatus, listLiveAgents } from "../agents.js";
import {
  UsageError,
  byRoiDesc,
  emitJson,
  relTime,
  resolveWorkstream,
  statusIcon,
  truncate,
  withRoiAll,
} from "../cli.js";
import type { Db } from "../db.js";
import { EVENT_VERB_PREFIXES, type LogRow, displayEventPayload, listLogs } from "../logs.js";
import { pc } from "../output.js";
import { type TaskRow, listInProgress, listReady, listTasksByOwner } from "../tasks.js";
import { currentPaneSize } from "../tmux.js";
import { type Track, getParallelTracks } from "../tracks.js";

interface HudOpts {
  workstream?: string;
  json?: boolean;
  lines?: number; // recent-events tail cap; default 10
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
    // Scope by the agent's own workstream so a same-named worker
    // elsewhere can't pollute this row's task count
    // (bug_v5_name_clash_silent_misroute).
    const owned = listTasksByOwner(db, a.name, { workstream: a.workstream });
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
    // Strip the `task.claim<TAB>...` structured prefix from claim
    // events before colouring/truncating; the prose tail still
    // starts with `task claim` so the verb-prefix colourer matches
    // unchanged. See review_code_last_claim_actor_brittle.
    const display = displayEventPayload(e.payload);
    table.push([pc.dim(ago), colorEventPayload(truncate(display, payloadBudget))]);
  }
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/** Recolour an event-log payload so the verb token (e.g. 'task close',
 *  'agent spawn', 'workspace create') stands out. Drives off
 *  EVENT_VERB_PREFIXES in src/logs.ts — the same list the SDK uses to
 *  document its emitter contract — so the HUD can't silently drift
 *  away from the verbs callers actually emit (the original ad-hoc
 *  regex did, missing `task block` / `approval granted` / `task
 *  reparent`; see review_code_hud_event_color_regex_drift). Falls back
 *  to the original string when nothing matches so we never lose
 *  information just because we couldn't classify. Exported for tests.
 */
export function colorEventPayload(payload: string): string {
  for (const verb of EVENT_VERB_PREFIXES) {
    // Match the prefix only at a word boundary: the next char must be
    // end-of-string or whitespace. Prevents `approval addendum` (if
    // such a payload ever appears) from being mis-coloured as
    // `approval add`.
    if (!payload.startsWith(verb)) continue;
    const next = payload.charCodeAt(verb.length);
    if (!Number.isNaN(next) && next !== 0x20 && next !== 0x09) continue;
    const rest = payload.slice(verb.length);
    return `${pc.cyan(verb)}${rest}`;
  }
  return payload;
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

export async function cmdHud(db: Db, opts: HudOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // mu hud is print-once-and-compose by design (`watch -n 5 mu hud`,
  // `tmux display-popup -E 'mu hud ...'`). status-only so the periodic
  // poll doesn't race a long-running `git worktree add` mid-spawn
  // (would otherwise prune the placeholder row and FK-fail the
  // subsequent INSERT INTO vcs_workspaces — see
  // bug_agent_spawn_workspace_fk_failure) AND so the busy/needs_input
  // glyph in the table refreshes between mutating verbs (see
  // bug_pane_title_glyph_stuck_at_needs_input).
  const view = await listLiveAgents(db, { workstream, mode: "status-only" });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream).sort(byRoiDesc);
  const inProgress = listInProgress(db, workstream);
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

// ─── commander wiring ────────────────────────────────────────────────
//
// wireHudCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle, parseLines } from "../cli.js";

export function wireHudCommand(program: Command): void {
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
}
