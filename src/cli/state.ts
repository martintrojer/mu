// mu — `mu state` (canonical state card) + bare `mu` (mission control).
//
// One verb, three render modes (merge_state_into_hud_render_mode, v0.3):
//
//   mu state                    full card: agents + orphans + tracks +
//                               ready/in-progress/blocked/recent-closed +
//                               workspaces + recent events. Top-to-bottom,
//                               every section gets its full table. JSON-
//                               first by design (per Ilya's council
//                               critique: state cards as the default
//                               attention surface; SQL/raw verbs as the
//                               escape hatch underneath).
//
//   mu state --hud              dynamic-fit render: greedy top-down table
//                               layout that fills the terminal (or tmux
//                               pane) height + width with as much useful
//                               data as fits. Section ordering is fixed:
//                               header / agents / ready / in-progress /
//                               tracks / recent. Truncated tables get a
//                               "… +N more (<verb>)" footer. Designed for
//                               `watch -n 5 mu state --hud` /
//                               `tmux display-popup -E 'mu state --hud'`.
//
//   mu state --mission          stripped 5-column glance card: agents +
//                               orphans + tracks + ready. The bare-`mu`
//                               muscle-memory orient call ("what's going
//                               on?"). Bare `mu` (no verb) is an alias.
//
// All three modes share the same data set (loaded once via
// loadWorkstreamData); only the rendering strategy differs. --hud and
// --mission are mutually exclusive.
//
// All three modes support variadic `-w X[,Y]...` / `-w X -w Y` and
// `--all`. N=1 renders single-mode (legacy shape); N≥2 stacks per-
// workstream cards (full / mission) or unions with a leading workstream
// column (hud).
//
// All three modes pass mode: "status-only" to listLiveAgents — refresh
// status + pane title (the operator's primary signal) but skip prune
// + reap, so the periodic poll never deletes mid-spawn placeholders
// (bug_agent_spawn_workspace_fk_failure) and the pane border indicator
// stays fresh between mutating verbs
// (bug_pane_title_glyph_stuck_at_needs_input).

import Table from "cli-table3";
import { type AgentRow, type AgentStatus, listLiveAgents } from "../agents.js";
import {
  IDLE_GLYPH,
  JSON_OPT,
  UsageError,
  byRoiDesc,
  emitJson,
  formatAgentsTable,
  formatReadyTable,
  formatTaskListTable,
  formatTracks,
  formatWorkspacesTable,
  formatWorkstreamsTable,
  handle,
  parseCsvFlag,
  parseLines,
  printLogRow,
  relTime,
  resolveOptionalWorkstream,
  statusIcon,
  truncate,
  withRoiAll,
} from "../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../db.js";
import { EVENT_VERB_PREFIXES, type LogRow, displayEventPayload, listLogs } from "../logs.js";
import { pc } from "../output.js";
import {
  type TaskRow,
  listBlocked,
  listInProgress,
  listReady,
  listRecentClosed,
  listTasksByOwner,
} from "../tasks.js";
import { currentPaneSize } from "../tmux.js";
import { type Track, getParallelTracks } from "../tracks.js";
import {
  type WorkspaceOrphan,
  type WorkspaceRow,
  decorateWithStaleness,
  listWorkspaceOrphans,
  listWorkspaces,
} from "../workspace.js";
import { listWorkstreams } from "../workstream.js";

// ─── Per-workstream loaded data ─────────────────────────────────────

interface PerWsData {
  workstreamName: string;
  view: Awaited<ReturnType<typeof listLiveAgents>>;
  tracks: Track[];
  ready: TaskRow[];
  inProgress: TaskRow[];
  blocked: TaskRow[];
  recentClosed: TaskRow[];
  workspaces: WorkspaceRow[];
  workspaceOrphans: WorkspaceOrphan[];
  recent: LogRow[];
}

async function loadWorkstreamData(
  db: Db,
  workstream: string,
  eventLimit: number,
): Promise<PerWsData> {
  // status-only refresh: don't prune mid-spawn placeholders or reap
  // unreachable agents — every render-mode is a polling read surface
  // (`watch -n 5 mu state`, tmux popup, etc.). See module-level
  // comment for the bug history.
  const view = await listLiveAgents(db, { workstream, mode: "status-only" });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream).sort(byRoiDesc);
  const inProgress = listInProgress(db, workstream);
  const blocked = listBlocked(db, workstream);
  const recentClosed = listRecentClosed(db, workstream);
  // Decorate workspaces with staleness (commits-behind-main) per
  // bug_workspace_stale_parent_silent_drift. Pure observation: backends
  // never fetch; they read whatever the local refs cache says.
  const workspaces = await decorateWithStaleness(listWorkspaces(db, workstream));
  const workspaceOrphans = listWorkspaceOrphans(db, workstream);
  const recent = listLogs(db, { workstream, kind: "event", limit: eventLimit });
  return {
    workstreamName: workstream,
    view,
    tracks,
    ready,
    inProgress,
    blocked,
    recentClosed,
    workspaces,
    workspaceOrphans,
    recent,
  };
}

// ─── Workstream-set resolution ─────────────────────────────────────
//
// All three render modes accept TWO mutually-exclusive shapes (plus
// auto-resolve):
//   -w X         | -w X,Y     | -w X -w Y      explicit set (variadic + parseCsvFlag)
//   --all                                       every workstream on this machine
//   (none)                                      auto-resolve from $MU_SESSION/tmux (single ws)
//
// N=1 (single -w value, --all on a single-workstream machine, or
// auto-resolve) renders single-mode (legacy column shape + flat JSON).
// N≥2 grows the workstream-summary table to N rows (hud) or stacks
// per-ws cards (full / mission).

interface StateOpts {
  // Variadic on every render mode.
  workstream?: string[];
  all?: boolean;
  json?: boolean;
  hud?: boolean;
  mission?: boolean;
  events?: number; // recent-events cap (default 20 full / 10 hud)
  lines?: number; // alias short-flag -n (hud muscle memory)
}

async function resolveWorkstreamSet(db: Db, opts: StateOpts): Promise<string[]> {
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
    // flat string[] (stripping whitespace + empty fragments).
    const names = parseCsvFlag(opts.workstream);
    const deduped = Array.from(new Set(names));
    if (deduped.length > 0) {
      // Strict validation: every entry must exist. A typo'd name
      // would silently render a half card.
      for (const n of deduped) {
        if (tryResolveWorkstreamId(db, n) === null) throw new WorkstreamNotFoundError(n);
      }
      return deduped;
    }
  }
  // No explicit -w (or it canonicalised away to nothing): auto-resolve
  // a single workstream from $MU_SESSION / tmux session.
  const single = await resolveOptionalWorkstream();
  if (single === null) return [];
  return [single];
}

// ─── JSON shape ─────────────────────────────────────────────────────
//
// Per merge_state_into_hud_render_mode (v0.3): unified single flat
// shape across `mu state` and `mu state --hud`. `--mission` emits a
// stripped subset for the muscle-memory glance use case.

function fullJsonShape(d: PerWsData): Record<string, unknown> {
  return {
    workstreamName: d.workstreamName,
    agents: d.view.agents,
    orphans: d.view.orphans,
    tracks: d.tracks,
    ready: withRoiAll(d.ready),
    inProgress: withRoiAll(d.inProgress),
    blocked: withRoiAll(d.blocked),
    recentClosed: withRoiAll(d.recentClosed),
    workspaces: d.workspaces,
    workspaceOrphans: d.workspaceOrphans,
    recent: d.recent,
  };
}

function missionJsonShape(d: PerWsData): Record<string, unknown> {
  return {
    workstreamName: d.workstreamName,
    agents: d.view.agents,
    orphans: d.view.orphans,
    tracks: d.tracks,
    ready: withRoiAll(d.ready),
  };
}

// ─── cmdState — dispatch ────────────────────────────────────────────

export async function cmdState(db: Db, opts: StateOpts): Promise<void> {
  if (opts.hud === true && opts.mission === true) {
    throw new UsageError("--hud and --mission are mutually exclusive");
  }

  // Mission is the only mode that survives a no-workstream context:
  // bare `mu` outside a tmux session is a discovery moment, not an
  // error. Default and --hud keep today's "workstream required"
  // failure (resolveWorkstreamSet throws via the resolveWorkstream
  // chain inside the explicit branches).
  if (opts.mission === true && (opts.workstream === undefined || opts.workstream.length === 0)) {
    if (opts.all !== true) {
      const auto = await resolveOptionalWorkstream();
      if (auto === null) {
        await renderMissionNoWorkstream(db, opts);
        return;
      }
    }
  }

  const workstreams = await resolveWorkstreamSet(db, opts);

  // --all on an empty machine: render empty hint cleanly.
  if (workstreams.length === 0) {
    if (opts.json === true) {
      emitJson({ workstreams: [] });
      return;
    }
    console.log(pc.dim("(no workstreams)"));
    return;
  }

  const eventLimit = opts.events ?? opts.lines ?? (opts.hud === true ? 10 : 20);
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push(await loadWorkstreamData(db, ws, eventLimit));
  }
  const multi = workstreams.length > 1;

  // ── JSON: render-mode-specific shape ──
  if (opts.json === true) {
    if (opts.mission === true) {
      if (multi) emitJson({ workstreams: perWs.map(missionJsonShape) });
      else {
        const single = perWs[0];
        if (single === undefined) throw new Error("invariant: workstreams non-empty");
        emitJson(missionJsonShape(single));
      }
      return;
    }
    // Default + --hud share the same flat machine view.
    if (multi) emitJson({ workstreams: perWs.map(fullJsonShape) });
    else {
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      emitJson(fullJsonShape(single));
    }
    return;
  }

  // ── Human render: dispatch ──
  if (opts.mission === true) {
    renderMissionMode(perWs);
    return;
  }
  if (opts.hud === true) {
    await renderHudMode(db, perWs, eventLimit, multi, workstreams);
    return;
  }
  renderFullMode(perWs);
}

// ─── Render: full mode (default `mu state`) ────────────────────────

function renderFullMode(perWs: PerWsData[]): void {
  perWs.forEach((d, i) => {
    if (i > 0) console.log("");
    renderFullCard(d);
  });
}

function renderFullCard(d: PerWsData): void {
  const { workstreamName, view, tracks, ready, inProgress, blocked, recentClosed, recent } = d;
  const STALE_THRESHOLD = 10;
  const staleWorkspaces = d.workspaces.filter(
    (w) =>
      w.commitsBehindMain !== undefined &&
      w.commitsBehindMain !== null &&
      w.commitsBehindMain >= STALE_THRESHOLD,
  );

  console.log(pc.bold(`State of mu-${workstreamName}`));
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
  // Workspaces: warn line + tip when ANY row is ≥ STALE_THRESHOLD
  // commits behind main. Per bug_workspace_stale_parent_silent_drift.
  const workspacesHeader =
    staleWorkspaces.length > 0
      ? `${pc.bold(`Workspaces (${d.workspaces.length})`)} ${pc.yellow(`⚠ (${staleWorkspaces.length} stale ≥${STALE_THRESHOLD} commits behind):`)}`
      : pc.bold(`Workspaces (${d.workspaces.length})`);
  console.log(workspacesHeader);
  if (d.workspaces.length === 0) {
    console.log(pc.dim("  (none)"));
  } else {
    console.log(formatWorkspacesTable(d.workspaces));
  }
  if (staleWorkspaces.length > 0) {
    const example = staleWorkspaces[0]?.agentName ?? "<agent>";
    console.log(
      pc.yellow(
        `⚠ Tip: Free + recreate stale workspaces to land patches against current main: mu workspace free ${example} + mu workspace create ${example}`,
      ),
    );
  }
  if (d.workspaceOrphans.length > 0) {
    console.log("");
    console.log(
      pc.yellow(
        `Workspace orphans (${d.workspaceOrphans.length}, on disk but no DB row — will block --workspace spawns):`,
      ),
    );
    for (const o of d.workspaceOrphans) {
      console.log(`  ${pc.bold(o.agentName)}  ${pc.dim(o.path)}`);
    }
    console.log(pc.dim(`  Run \`mu workspace orphans -w ${workstreamName}\` for cleanup hints.`));
  }
  console.log("");
  console.log(pc.bold(`Recent events (last ${recent.length} of kind=event)`));
  if (recent.length === 0) {
    console.log(pc.dim("  (none)"));
  } else {
    for (const row of recent) printLogRow(row);
  }
}

// ─── Render: mission mode (bare `mu` / `mu state --mission`) ───────

function renderMissionMode(perWs: PerWsData[]): void {
  perWs.forEach((d, i) => {
    if (i > 0) console.log("");
    renderMissionCard(d);
  });
}

function renderMissionCard(d: PerWsData): void {
  console.log(pc.bold(`mu-${d.workstreamName}`));
  console.log("");
  console.log(pc.bold(`Agents (${d.view.agents.length})`));
  console.log(formatAgentsTable(d.view.agents));
  if (d.view.orphans.length > 0) {
    console.log("");
    console.log(pc.yellow(`Orphan panes (${d.view.orphans.length})`));
    for (const orphan of d.view.orphans) {
      console.log(
        `  ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
  console.log("");
  console.log(pc.bold(`Tracks (${d.tracks.length})`));
  console.log(formatTracks(d.tracks));
  console.log("");
  console.log(pc.bold(`Ready (${d.ready.length})`));
  console.log(formatReadyTable(d.ready));
}

/**
 * Mission fallback when bare `mu` runs but no workstream resolves —
 * not in a tmux session, no `$MU_SESSION`, no `-w` flag. Show what
 * workstreams exist on this machine and a hint at next steps. Exit 0
 * (orientation, not failure). For `--json`, emit a structured shape so
 * scripts can detect the case without parsing prose.
 */
async function renderMissionNoWorkstream(db: Db, opts: StateOpts): Promise<void> {
  const summaries = await listWorkstreams(db);
  if (opts.json === true) {
    emitJson({ workstreamName: null, workstreams: summaries });
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

// ─── Render: hud mode (--hud, dynamic-fit) ─────────────────────────
//
// Greedy top-down table layout that fills the available terminal (or
// tmux pane) height + width with as much useful data as fits. No flags
// to pick a size — the substrate is already telling us the size.
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
// Every section is a header-less cli-table3 with hint words baked into
// each cell ("agent worker-1", "ready  build_x", "track 1", etc.) so
// no column headers are needed. Saves 2 vertical lines per table.

/**
 * Resolve the HUD's render budget (width × height) from the substrate.
 *
 * Order:
 * 1. `MU_HUD_FORCE_SIZE=WxH` env override — deterministic for tests +
 *    the only way an operator can force a non-default size on demand.
 * 2. `process.stdout` if it's a TTY (the easy path — same as every
 *    other terminal app).
 * 3. `currentPaneSize()` (tmux's `display-message -p '#{pane_width}
 *    #{pane_height}'`) — catches `watch -n 5 mu state --hud`,
 *    `tmux display-popup -E 'mu state --hud'`, and any other case
 *    where stdout is a pipe but the surrounding tmux pane has a real
 *    size.
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
 * `wordWrap: false` is the load-bearing setting: when a cell exceeds
 * its column width cli-table3 truncates with `…` instead of wrapping
 * to a second visual row. The HUD's row budget assumes one screen row
 * per data row — wrap would silently blow that out and push lower-
 * priority sections off the bottom.
 */
function newHudTable(): InstanceType<typeof Table> {
  return new Table({ style: { border: [] }, wordWrap: false });
}

// In multi-mode, every per-workstream row needs its workstream tag so
// we can prepend a leading `workstream` cell AND sort by (workstream,
// intra-key). The SDK row types don't all carry workstream identity
// (Track has no workstreamName field), so we tag at the load seam.
type Tagged<T> = { ws: string; row: T };
const tag =
  <T>(ws: string) =>
  (row: T): Tagged<T> => ({ ws, row });

const wsCell = (ws: string): string => pc.bold(pc.cyan(ws));

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
  const statusW = 2;
  const numCols = multi ? 5 : 4;
  const padding = numCols * 3 + 1;
  const leadW = multi ? wsW : 0;
  const taskBudget = Math.max(8, width - leadW - statusW - nameW - agoW - padding);
  const table = newHudTable();
  shown.forEach(({ ws, row: a }, i) => {
    const ago = `+${relTime(now - new Date(a.updatedAt).getTime())}`;
    const taskBit = taskBits[i] ?? "—";
    const truncated = truncate(taskBit, taskBudget);
    const taskCell =
      taskBit === "—" || taskBit.startsWith("⊕") ? pc.dim(truncated) : pc.cyan(truncated);
    // Idle (alive + assigned + no recent progress): prepend the ⚠
    // glyph to the status cell and yellow the agent name. Status text
    // stays truthful ('needs_input') — idle is a supplement, not a
    // 5th status. See idle_assigned_agent_detection.
    const idle = a.idle === true;
    const statusCell = idle
      ? `${pc.yellow(IDLE_GLYPH)} ${statusIcon(a.status)}`
      : statusIcon(a.status);
    const nameCell = idle
      ? `${pc.dim("agent")} ${pc.yellow(a.name)}`
      : `${pc.dim("agent")} ${pc.bold(a.name)}`;
    const cells: string[] = [];
    if (multi) cells.push(wsCell(ws));
    cells.push(statusCell, nameCell, taskCell, pc.dim(ago));
    table.push(cells);
  });
  return { rendered: table.toString(), rowsShown: shown.length, rowsTotal: total };
}

function formatHudTasksTable(
  tasks: readonly Tagged<TaskRow>[],
  width: number,
  rowCap: number,
  opts: { withOwner: boolean; multi: boolean },
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = tasks.length;
  const shown = tasks.slice(0, rowCap);
  const sectionPrefix = opts.withOwner ? "in-progress" : "ready";
  let idW = `${sectionPrefix}  `.length;
  let roiW = "ROI 100".length;
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

function formatHudRecentTable(
  events: readonly Tagged<LogRow>[],
  width: number,
  rowCap: number,
  multi: boolean,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = events.length;
  const shown = events.slice(0, rowCap);
  const now = Date.now();
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
    if (!payload.startsWith(verb)) continue;
    const next = payload.charCodeAt(verb.length);
    if (!Number.isNaN(next) && next !== 0x20 && next !== 0x09) continue;
    const rest = payload.slice(verb.length);
    return `${pc.cyan(verb)}${rest}`;
  }
  return payload;
}

function formatHudTracksTable(
  tracks: readonly Tagged<Track>[],
  width: number,
  rowCap: number,
  multi: boolean,
): { rendered: string; rowsShown: number; rowsTotal: number } {
  const total = tracks.length;
  const shown = tracks.slice(0, rowCap);
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

async function renderHudMode(
  db: Db,
  perWs: PerWsData[],
  eventLimit: number,
  multi: boolean,
  workstreams: string[],
): Promise<void> {
  const { width, height } = await hudPaneSize();
  let remaining = height;

  const printTable = (rendered: string): number => {
    console.log(rendered);
    return rendered.split("\n").length;
  };

  // 1. Workstream-summary table. ONE data row per workstream, no
  // header — each cell carries its own dim section word (`2 ready`,
  // `0 in-progress`, ...). Cost with bottom dropped + no header =
  // 2N+1 lines total.
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

  // ── Union the per-workstream collections. Stable sort by
  // workstream so within-ws order is preserved (Array.prototype.sort
  // is stable in modern V8). In single-mode (multi=false) this is a
  // no-op since every row has the same ws.
  const allAgents: Tagged<AgentRow>[] = perWs.flatMap((d) =>
    d.view.agents.map(tag(d.workstreamName)),
  );
  const allReady: Tagged<TaskRow>[] = perWs.flatMap((d) => d.ready.map(tag(d.workstreamName)));
  const allInProgress: Tagged<TaskRow>[] = perWs.flatMap((d) =>
    d.inProgress.map(tag(d.workstreamName)),
  );
  const allTracks: Tagged<Track>[] = perWs.flatMap((d) => d.tracks.map(tag(d.workstreamName)));
  if (multi) {
    const byWs = (a: { ws: string }, b: { ws: string }): number => a.ws.localeCompare(b.ws);
    allAgents.sort(byWs);
    allReady.sort(byWs);
    allInProgress.sort(byWs);
    allTracks.sort(byWs);
  }
  // Recent events: union with DESC sort by created_at (cross-workstream
  // timeline view), then take the first eventLimit.
  const allRecent: Tagged<LogRow>[] = perWs.flatMap((d) => d.recent.map(tag(d.workstreamName)));
  allRecent.sort(
    (a, b) => new Date(b.row.createdAt).getTime() - new Date(a.row.createdAt).getTime(),
  );
  const recentBounded = allRecent.slice(0, eventLimit);

  // Helper: render a section if there's room, deducting its cost.
  // Sizing math (per section, all tables header-less, bottom kept):
  //   actualCost(N) = 2N + 1   (top + N·(data + sep))
  //   footer line   = 1        (when truncated)
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
// wireStateCommands is called by buildProgram() in src/cli.ts. Wired
// here so every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";

export function wireStateCommands(program: Command): void {
  program
    .command("state")
    .description(
      "Canonical state card: agents + orphans + tracks + ready/in-progress/blocked/recent-closed tasks + workspaces + recent events. The 'what does an LLM look at first?' verb. JSON-first. --hud switches to a dynamic-fit renderer that fills the terminal/pane (header + agents + ready + in-progress + tracks + recent — designed for `watch -n 5 mu state --hud` / `tmux display-popup -E 'mu state --hud'`); --mission emits the stripped 5-col glance card (agents + orphans + tracks + ready) — bare `mu` is an alias. -w accepts repeat or comma-separate (or both); --all is sugar for every workstream on this machine. N≥2 stacks per-workstream cards (full / mission) or unions with a leading workstream column (--hud).",
    )
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)",
    )
    .option("--all", "include every workstream on this machine")
    .option("--hud", "dynamic-fit render: greedy top-down layout that fills the terminal/pane")
    .option("--mission", "stripped 5-column glance card (agents + orphans + tracks + ready)")
    .option(
      "--events <n>",
      "how many recent kind=event log entries to include (default 20 for full / 10 for --hud)",
      parseLines,
    )
    .option("-n, --lines <n>", "alias for --events (kept for --hud muscle memory)", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as StateOpts;
      return handle((db) => cmdState(db, opts), this as Command)();
    });
}
