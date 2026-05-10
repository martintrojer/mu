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
// MULTI-WORKSTREAM (v0.3+, hud_multi_workstream + hud_unify_workstream_flag):
// hud is the one verb where `-w/--workstream` is variadic (`<names...>`,
// canonicalised through parseCsvFlag — repeat or comma-separate or both)
// instead of single-valued. `--all` is orthogonal sugar for "every
// workstream on this machine" and is mutually exclusive with `-w`.
// Single (N=1, the common case) renders EXACTLY the legacy shape (same
// columns, same JSON keys). N≥2 grows the workstream-summary table to N
// rows, gains a leading `workstream` column on subsequent tables, and
// switches the JSON envelope to `{ workstreams: [...] }`.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import Table from "cli-table3";
import { type AgentRow, type AgentStatus, listLiveAgents } from "../agents.js";
import {
  UsageError,
  byRoiDesc,
  emitJson,
  parseCsvFlag,
  relTime,
  resolveWorkstream,
  statusIcon,
  truncate,
  withRoiAll,
} from "../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../db.js";
import { EVENT_VERB_PREFIXES, type LogRow, displayEventPayload, listLogs } from "../logs.js";
import { pc } from "../output.js";
import { type TaskRow, listInProgress, listReady, listTasksByOwner } from "../tasks.js";
import { currentPaneSize } from "../tmux.js";
import { type Track, getParallelTracks } from "../tracks.js";
import { listWorkstreams } from "../workstream.js";

interface HudOpts {
  // Variadic on hud (the one carve-out). Single-valued on every other
  // verb. parseCsvFlag canonicalises repeat / comma / mixed forms.
  workstream?: string[];
  all?: boolean;
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

// ─── Multi-mode plumbing ─────────────────────────────────────────────
//
// In multi-mode (N≥2), every per-workstream table-row needs to know
// which workstream it came from so we can prepend a `workstream` cell
// AND so we can sort by (workstream, intra-key) before rendering.
// The SDK row types don't all carry workstream identity (Track has no
// workstreamName field), so we tag each row at the data-loading seam
// and carry the tag through to render.
type Tagged<T> = { ws: string; row: T };
const tag =
  <T>(ws: string) =>
  (row: T): Tagged<T> => ({ ws, row });

// Bold-cyan workstream prefix cell for multi-mode tables. Mirrors the
// header treatment in the workstream-summary table so the eye groups
// rows by colour.
const wsCell = (ws: string): string => pc.bold(pc.cyan(ws));

// Each formatHud*Table returns { rendered, rowsShown, rowsTotal }.
// rowsTotal == 0 cases are handled by renderSection's early-return
// (`if (full === 0) return`), so these helpers can assume non-empty
// input. The hint words baked into each cell identify the section.
function formatHudAgentsTable(
  db: Db,
  agents: readonly Tagged<AgentRow>[],
  width: number,
  rowCap: number,
  multi: boolean,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = agents.length;
  const shown = agents.slice(0, rowCap);
  const now = Date.now();
  // No header row — hint words baked into each cell. The leftmost
  // status emoji + the dim 'agent' prefix on the name identify the
  // section. Saves 2 vertical lines.
  let nameW = "agent ".length;
  let agoW = "+ago".length;
  let wsW = "workstream".length;
  const taskBits: string[] = [];
  for (const { ws, row: a } of shown) {
    nameW = Math.max(nameW, `agent ${a.name}`.length);
    wsW = Math.max(wsW, ws.length);
    // Scope by the agent's own workstream so a same-named worker
    // elsewhere can't pollute this row's task count.
    const owned = listTasksByOwner(db, a.workstreamName, a.name);
    const taskBit =
      owned.length === 0 ? "—" : owned.length === 1 ? (owned[0]?.name ?? "—") : `⊕${owned.length}`;
    taskBits.push(taskBit);
    const ago = `+${relTime(now - new Date(a.updatedAt).getTime())}`;
    agoW = Math.max(agoW, ago.length);
  }
  const statusW = 2; // emoji + 1
  const numCols = multi ? 5 : 4;
  const padding = numCols * 3 + 1;
  const leadW = multi ? wsW : 0;
  const taskBudget = Math.max(8, width - leadW - statusW - nameW - agoW - padding);
  const table = newHudTable();
  shown.forEach(({ ws, row: a }, i) => {
    const ago = `+${relTime(now - new Date(a.updatedAt).getTime())}`;
    const taskBit = taskBits[i] ?? "—";
    const truncated = truncate(taskBit, taskBudget);
    // Colour: status emoji per STATUS_COLORS; agent name bold; the
    // task id (when present) cyan to match the in-progress task
    // table; '—' / '⊕N' (no-task / multi) stays dim.
    const taskCell =
      taskBit === "—" || taskBit.startsWith("⊕") ? pc.dim(truncated) : pc.cyan(truncated);
    const cells: string[] = [];
    if (multi) cells.push(wsCell(ws));
    cells.push(
      statusIcon(a.status),
      `${pc.dim("agent")} ${pc.bold(a.name)}`,
      taskCell,
      pc.dim(ago),
    );
    table.push(cells);
  });
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/**
 * Render a task table for HUD. Columns: id, status, title, ROI, owner.
 * `title` cell absorbs slack via terminalWidth - sum(other cols).
 */
function formatHudTasksTable(
  tasks: readonly Tagged<TaskRow>[],
  width: number,
  rowCap: number,
  opts: { withOwner: boolean; multi: boolean },
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
  let wsW = "workstream".length;
  for (const { ws, row: t } of shown) {
    idW = Math.max(idW, `${sectionPrefix}  ${t.name}`.length);
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(0) : "∞";
    roiW = Math.max(roiW, `ROI ${roi}`.length);
    ownerW = Math.max(ownerW, (t.ownerName ?? "—").length);
    wsW = Math.max(wsW, ws.length);
  }
  const numCols = (opts.withOwner ? 4 : 3) + (opts.multi ? 1 : 0);
  const padding = numCols * 3 + 1;
  const leadW = opts.multi ? wsW : 0;
  const fixed = leadW + idW + roiW + (opts.withOwner ? ownerW : 0);
  const titleBudget = Math.max(10, width - fixed - padding);
  const table = newHudTable();
  for (const { ws, row: t } of shown) {
    const roiNum = t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
    const roiStr = Number.isFinite(roiNum) ? roiNum.toFixed(0) : "∞";
    // Colour: id cyan (matches the agent table's task column);
    // ROI green for high-value (>=100), yellow for mid (>=50),
    // dim for low. Owner bold-cyan (the active worker is the most
    // useful pointer in an in-progress row).
    const roiColor = roiNum >= 100 ? pc.green : roiNum >= 50 ? pc.yellow : pc.dim;
    const idCell = `${pc.dim(sectionPrefix)}  ${pc.cyan(t.name)}`;
    const row: string[] = [];
    if (opts.multi) row.push(wsCell(ws));
    row.push(idCell, truncate(t.title, titleBudget), `${pc.dim("ROI")} ${roiColor(roiStr)}`);
    if (opts.withOwner) row.push(t.ownerName ? pc.bold(pc.cyan(t.ownerName)) : pc.dim("—"));
    table.push(row);
  }
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

/**
 * Render the recent-events table for HUD. Columns: +ago, payload.
 * Payload absorbs slack.
 */
function formatHudRecentTable(
  events: readonly Tagged<LogRow>[],
  width: number,
  rowCap: number,
  multi: boolean,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = events.length;
  const shown = events.slice(0, rowCap);
  const now = Date.now();
  // No header row — the +ago format and `task note ...` / `agent
  // spawn ...` style payload self-identify this as the events table.
  // Saves 2 vertical lines.
  let agoW = "+ago".length;
  let wsW = "workstream".length;
  for (const { ws, row: e } of shown) {
    const ago = `+${relTime(now - new Date(e.createdAt).getTime())}`;
    agoW = Math.max(agoW, ago.length);
    wsW = Math.max(wsW, ws.length);
  }
  const numCols = multi ? 3 : 2;
  const padding = numCols * 3 + 1;
  const leadW = multi ? wsW : 0;
  const payloadBudget = Math.max(20, width - leadW - agoW - padding);
  const table = newHudTable();
  for (const { ws, row: e } of shown) {
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
    const cells: string[] = [];
    if (multi) cells.push(wsCell(ws));
    cells.push(pc.dim(ago), colorEventPayload(truncate(display, payloadBudget)));
    table.push(cells);
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
  tracks: readonly Tagged<Track>[],
  width: number,
  rowCap: number,
  multi: boolean,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = tracks.length;
  const shown = tracks.slice(0, rowCap);
  // No header row — hints baked into each cell ('track 1', '6 tasks',
  // '2 ready', 'merged'/'track'). Saves 2 vertical lines.
  let idxW = "track N".length;
  let tasksW = "N tasks".length;
  let readyW = "N ready".length;
  let wsW = "workstream".length;
  const kindW = "merged".length;
  shown.forEach(({ ws, row: t }, i) => {
    idxW = Math.max(idxW, `track ${i + 1}`.length);
    tasksW = Math.max(tasksW, `${t.taskIds.size} tasks`.length);
    readyW = Math.max(readyW, `${t.readyCount} ready`.length);
    wsW = Math.max(wsW, ws.length);
  });
  const numCols = multi ? 6 : 5;
  const padding = numCols * 3 + 1;
  const leadW = multi ? wsW : 0;
  const rootsBudget = Math.max(10, width - leadW - idxW - tasksW - readyW - kindW - padding);
  const table = newHudTable();
  shown.forEach(({ ws, row: t }, i) => {
    const roots = t.roots.map((r) => r.name).join(", ");
    const kind = t.roots.length > 1 ? "merged" : "track";
    // Colour: 'merged' diamond is structurally interesting (multiple
    // independent goals share a prerequisite) — yellow to flag it.
    // Plain 'track' is unremarkable — dim.
    // Ready count: green if any ready, dim if none.
    const kindCell = t.roots.length > 1 ? pc.yellow(kind) : pc.dim(kind);
    const readyCell = `${t.readyCount > 0 ? pc.green(String(t.readyCount)) : pc.dim("0")} ${pc.dim("ready")}`;
    const cells: string[] = [];
    if (multi) cells.push(wsCell(ws));
    cells.push(
      `${pc.dim("track")} ${pc.bold(String(i + 1))}`,
      pc.cyan(truncate(roots, rootsBudget)),
      `${t.taskIds.size} ${pc.dim("tasks")}`,
      readyCell,
      kindCell,
    );
    table.push(cells);
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

// ─── Workstream-set resolution ────────────────────────────────────────
//
// The hud verb accepts TWO mutually-exclusive shapes (plus auto-resolve):
//   -w X         | -w X,Y     | -w X -w Y      explicit set (variadic + parseCsvFlag)
//   --all                                       every workstream on this machine
//   (none)                                      auto-resolve from $MU_SESSION/tmux (single ws)
//
// hud is the one verb where `-w/--workstream` is variadic — every other
// mu verb keeps it single-valued. Codified by hud_unify_workstream_flag
// (v0.3); the metavar `<names...>` is the syntactic signal.
//
// When N=1 (single -w value, or --all on a single-workstream machine,
// or auto-resolve), we AUTO-COLLAPSE to single-mode rendering. So
// callers who today use `mu hud -w X` see byte-for-byte identical
// output (including the JSON shape — the back-compat contract for any
// tmux status-bar pipes consuming `mu hud --json | jq`).
async function resolveWorkstreamSet(db: Db, opts: HudOpts): Promise<string[]> {
  const explicitW = opts.workstream !== undefined && opts.workstream.length > 0;
  const explicitAll = opts.all === true;
  if (explicitAll && explicitW) {
    throw new UsageError("--all and -w/--workstream are mutually exclusive");
  }
  if (explicitAll) {
    const all = await listWorkstreams(db);
    return all.map((w) => w.name);
  }
  if (explicitW) {
    // parseCsvFlag canonicalises repeat / comma / mixed forms into a
    // flat string[] (stripping whitespace + empty fragments). If the
    // resolved list is empty (e.g. `-w ,,`), fall through to the
    // auto-resolution chain — same as `mu hud` with no -w at all.
    const names = parseCsvFlag(opts.workstream);
    const deduped = Array.from(new Set(names));
    if (deduped.length > 0) {
      // Strict validation: every entry must exist. A typo'd name
      // would silently render half a HUD.
      for (const n of deduped) {
        if (tryResolveWorkstreamId(db, n) === null) throw new WorkstreamNotFoundError(n);
      }
      return deduped;
    }
  }
  // No explicit -w (or it canonicalised away to nothing): auto-resolve
  // a single workstream from $MU_SESSION / tmux session.
  const single = await resolveWorkstream(undefined);
  return [single];
}

interface PerWsData {
  workstreamName: string;
  view: Awaited<ReturnType<typeof listLiveAgents>>;
  tracks: Track[];
  ready: TaskRow[];
  inProgress: TaskRow[];
  recent: LogRow[];
}

async function loadWorkstreamData(
  db: Db,
  workstream: string,
  eventLimit: number,
): Promise<PerWsData> {
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
  const recent = listLogs(db, { workstream, kind: "event", limit: eventLimit });
  return { workstreamName: workstream, view, tracks, ready, inProgress, recent };
}

/** Per-workstream JSON shape — the legacy single-mode shape, computed
 *  for one workstream. Used flat for N=1 (back-compat) and as the
 *  array element for N≥2. */
function jsonShape(d: PerWsData): Record<string, unknown> {
  return {
    workstreamName: d.workstreamName,
    summary: {
      ready: d.ready.length,
      inProgress: d.inProgress.length,
      tracks: d.tracks.length,
      agents: d.view.agents.length,
      orphans: d.view.orphans.length,
    },
    agents: d.view.agents,
    orphans: d.view.orphans,
    tracks: d.tracks,
    ready: withRoiAll(d.ready),
    inProgress: withRoiAll(d.inProgress),
    recent: d.recent,
  };
}

export async function cmdHud(db: Db, opts: HudOpts): Promise<void> {
  const workstreams = await resolveWorkstreamSet(db, opts);

  // Empty-DB-with-no-workstreams path under --all: render the legacy
  // empty-hint single-mode by deferring to resolveWorkstream's normal
  // failure semantics. For --all with 0, we have nothing to render at
  // all — print a one-line hint and exit cleanly (mirrors `mu state`).
  if (workstreams.length === 0) {
    if (opts.json) {
      emitJson({ workstreams: [] });
      return;
    }
    console.log(pc.dim("(no workstreams)"));
    return;
  }

  const eventLimit = opts.lines ?? 10;
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push(await loadWorkstreamData(db, ws, eventLimit));
  }

  // AUTO-COLLAPSE: N=1 always renders single-mode (no extra column,
  // legacy JSON shape). This keeps `mu hud -w X` byte-for-byte
  // identical AND collapses `--workstreams X,X` (dedup'd to ['X'])
  // and `--all` on a single-workstream machine.
  const multi = workstreams.length > 1;

  if (opts.json) {
    if (multi) {
      emitJson({ workstreams: perWs.map(jsonShape) });
    } else {
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      emitJson(jsonShape(single));
    }
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

  // 1. Workstream-summary table. ONE data row per workstream, no
  // header — each cell carries its own dim section word (`2 ready`,
  // `0 in-progress`, ...). Cost with bottom dropped + no header =
  // 2N+1 lines total.
  // Colour: workstream bold-cyan (it's the load-bearing identifier);
  // counts coloured by significance — ready green if any (work to
  // dispatch), in-progress yellow if any (work in flight), tracks
  // bold (always meaningful), agents bold.
  const colorCount = (n: number, color: (s: string) => string): string =>
    n > 0 ? color(String(n)) : pc.dim("0");
  const headerTable = newHudTable();
  for (const d of perWs) {
    headerTable.push([
      pc.bold(pc.cyan(d.workstreamName)),
      `${colorCount(d.ready.length, pc.green)} ${pc.dim("ready")}`,
      `${colorCount(d.inProgress.length, pc.yellow)} ${pc.dim("in-progress")}`,
      `${pc.bold(String(d.tracks.length))} ${pc.dim("tracks")}`,
      `${pc.bold(String(d.view.agents.length))} ${pc.dim("agents")}`,
      agentStatusHistogram(d.view.agents),
    ]);
  }
  remaining -= printTable(headerTable.toString());

  // ── Union the per-workstream collections ──────────────────────────
  // Sort by (workstream, intra-key). The intra-key order is preserved
  // by Array.prototype.sort being stable in modern V8: per-workstream
  // we already have the canonical order from listReady (ROI desc) /
  // listInProgress (insertion) / etc.; an outer stable sort by
  // workstreamName keeps that intact within each group.
  const allAgents: Tagged<AgentRow>[] = perWs.flatMap((d) =>
    d.view.agents.map(tag(d.workstreamName)),
  );
  const allReady: Tagged<TaskRow>[] = perWs.flatMap((d) => d.ready.map(tag(d.workstreamName)));
  const allInProgress: Tagged<TaskRow>[] = perWs.flatMap((d) =>
    d.inProgress.map(tag(d.workstreamName)),
  );
  const allTracks: Tagged<Track>[] = perWs.flatMap((d) => d.tracks.map(tag(d.workstreamName)));
  // Stable-sort each by workstream so within-ws order is preserved.
  // (In single-mode multi=false, this is a no-op since every row has
  // the same ws.)
  if (multi) {
    const byWs = (a: { ws: string }, b: { ws: string }): number => a.ws.localeCompare(b.ws);
    allAgents.sort(byWs);
    allReady.sort(byWs);
    allInProgress.sort(byWs);
    allTracks.sort(byWs);
  }
  // Recent events: union with DESC sort by created_at (cross-workstream
  // timeline view — the operator sees what happened most recently
  // across the whole machine), then take the first eventLimit.
  // listLogs returns oldest-first per workstream; we resort the union.
  const allRecent: Tagged<LogRow>[] = perWs.flatMap((d) => d.recent.map(tag(d.workstreamName)));
  allRecent.sort(
    (a, b) => new Date(b.row.createdAt).getTime() - new Date(a.row.createdAt).getTime(),
  );
  const recentBounded = allRecent.slice(0, eventLimit);

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

  // The "more" footer hints reference a single workstream by name in
  // single-mode; in multi-mode we drop the `-w` suffix and let the
  // operator pick which workstream they want to drill into.
  const moreScope = multi ? "" : ` -w ${workstreams[0]}`;

  // 2. Agents.
  renderSection(
    (cap) => formatHudAgentsTable(db, allAgents, width, cap, multi),
    allAgents.length,
    `mu agent list${moreScope}`,
  );

  // 3. Ready.
  renderSection(
    (cap) => formatHudTasksTable(allReady, width, cap, { withOwner: false, multi }),
    allReady.length,
    `mu task next -n 0${moreScope}`,
  );

  // 4. In progress.
  renderSection(
    (cap) => formatHudTasksTable(allInProgress, width, cap, { withOwner: true, multi }),
    allInProgress.length,
    `mu task list --status IN_PROGRESS${moreScope}`,
  );

  // 5. Tracks.
  renderSection(
    (cap) => formatHudTracksTable(allTracks, width, cap, multi),
    allTracks.length,
    `mu state${moreScope}`,
  );

  // 6. Recent events.
  renderSection(
    (cap) => formatHudRecentTable(recentBounded, width, cap, multi),
    recentBounded.length,
    `mu log${moreScope} --kind event`,
  );
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireHudCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, handle, parseLines } from "../cli.js";

export function wireHudCommand(program: Command): void {
  program
    .command("hud")
    .description(
      "Print-once HUD card for one or more workstreams. Default: dynamic table layout that fills the terminal (or tmux pane) height + width with as much useful data as fits — header + agents + ready + in-progress + tracks + recent-events, each rendered as a cli-table3 with width-aware truncation. Pass `-w` multiple times (or comma-separate) to render multiple workstreams in one card (gains a leading `workstream` column on every section); `--all` is sugar for every workstream on this machine. Use --json for the structured machine view (single-workstream shape unchanged; multi wraps in `{workstreams:[...]}`). No loop, no tmux side effects — user composes redraw via `watch -n 5 mu hud -w X` or `tmux display-popup -E 'mu hud -w X'`.",
    )
    .option(
      "-n, --lines <n>",
      "recent-events tail cap (default 10; bounds the human view too)",
      parseLines,
    )
    // -w on hud is variadic (the one carve-out from WORKSTREAM_OPT —
    // hud_unify_workstream_flag). Every other verb keeps single-valued -w.
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)",
    )
    .option("--all", "include every workstream on this machine")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string[];
        all?: boolean;
        json?: boolean;
        lines?: number;
      };
      return handle((db) => cmdHud(db, opts))();
    });
}
