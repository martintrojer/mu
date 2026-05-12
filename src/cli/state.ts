// mu — `mu state` (canonical state card) and TUI back-compat dispatch.
//
// One verb, two render modes:
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
//   mu state --tui              interactive ink dashboard: glance cards,
//                               fullscreen popups, live tick, read-only
//                               act-intents that yank commands for the
//                               user to run in a shell.
//
// Static mode and TUI share the same data set (loaded once via
// loadWorkstreamSnapshot); only the rendering strategy differs. --tui
// is mutually exclusive with --json.
//
// All modes support variadic `-w X[,Y]...` / `-w X -w Y` and `--all`.
// In static modes N=1 renders single-mode (legacy shape) and N≥2
// stacks per-workstream full cards. In TUI mode N≥2
// switches workstreams via tabs.
//
// All modes pass mode: "status-only" to listLiveAgents — refresh
// status + pane title (the operator's primary signal) but skip prune
// + reap, so the periodic poll never deletes mid-spawn placeholders
// (bug_agent_spawn_workspace_fk_failure) and the pane border indicator
// stays fresh between mutating verbs
// (bug_pane_title_glyph_stuck_at_needs_input).

import {
  JSON_OPT,
  UsageError,
  emitJson,
  formatAgentsTable,
  formatTaskListTable,
  formatTracks,
  formatWorkspacesTable,
  handle,
  parseCsvFlag,
  parseLines,
  printLogRow,
  resolveOptionalWorkstream,
  withRoiAll,
} from "../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../db.js";
import { pc } from "../output.js";
import { WORKSPACE_STALE_THRESHOLD, isWorkspaceStale } from "../staleness.js";
import { type WorkstreamSnapshot, loadWorkstreamSnapshot } from "../state.js";
import { listWorkstreams } from "../workstream.js";

// ─── Per-workstream loaded data ─────────────────────────────────────

// PerWsData was the previous private shape of loadWorkstreamData.
// Both the type and the loader now live at src/state.ts as the SDK
// seam (WorkstreamSnapshot + loadWorkstreamSnapshot) so the new ink
// TUI can consume them too. We keep `PerWsData` as a local alias to
// avoid touching every renderer downstream.
type PerWsData = WorkstreamSnapshot;

// ─── Workstream-set resolution ─────────────────────────────────────
//
// Both render modes accept TWO mutually-exclusive shapes (plus
// auto-resolve):
//   -w X         | -w X,Y     | -w X -w Y      explicit set (variadic + parseCsvFlag)
//   --all                                       every workstream on this machine
//   (none)                                      auto-resolve from $MU_SESSION/tmux (single ws)
//
// N=1 (single -w value, --all on a single-workstream machine, or
// auto-resolve) renders single-mode (legacy column shape + flat JSON).
// N≥2 stacks per-workstream cards in static modes or opens tabbed
// per-workstream snapshots in TUI mode.

export interface StateOpts {
  // Variadic on every render mode.
  workstream?: string[];
  all?: boolean;
  json?: boolean;
  tui?: boolean;
  events?: number; // recent-events cap (default 20)
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
// Unified single flat shape for `mu state --json`.

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
    recentCommits: d.recentCommits,
  };
}

// ─── cmdState — dispatch ────────────────────────────────────────────

export async function cmdState(db: Db, opts: StateOpts): Promise<void> {
  // --tui mutual-exclusion checks: enforce BEFORE the JSON / render
  // branches so combining --tui with JSON errors loudly instead of
  // silently winning whichever branch ran first.
  if (opts.tui === true && opts.json === true) {
    throw new UsageError("--tui and --json are mutually exclusive (TUI is render-only)");
  }

  const workstreams = await resolveWorkstreamSet(db, opts);

  // workstreams.length === 0 splits into THREE distinct user errors,
  // each with its own helpful message:
  //   (a) --all on a machine with zero workstreams (truly empty universe)
  //   (b) bare `mu state` outside a tmux session, with workstreams
  //       on the machine but no way to auto-pick one (the most
  //       common confusing case; bug_bare_mu_state_no_ws)
  //   (c) bare `mu state --json`: same as (b) but JSON consumer; emit
  //       {workstreams:[]} for back-compat
  if (workstreams.length === 0) {
    if (opts.json === true) {
      emitJson({ workstreams: [] });
      return;
    }
    const explicitAll = opts.all === true;
    if (explicitAll) {
      // (a) --all + truly empty machine
      console.log(pc.dim("(no workstreams) try `mu workstream init <name>`"));
      return;
    }
    // (b) bare `mu state` with no auto-resolution path. Surface the
    // available workstreams so the user can pick one without a
    // separate `mu workstream list` round-trip.
    const all = await listWorkstreams(db);
    if (all.length === 0) {
      console.log(pc.dim("(no workstreams) try `mu workstream init <name>`"));
      return;
    }
    const lines = [
      "`mu state` could not auto-resolve a workstream.",
      "",
      "You're not inside a tmux session whose name matches a workstream,",
      "and `$MU_SESSION` is unset.",
      "",
      `Workstreams on this machine: ${all.map((w) => w.name).join(", ")}`,
      "",
      "Try:",
      `  mu state -w ${all[0]?.name ?? "<name>"}     # pick one`,
      "  mu state --all              # render every workstream",
      "  mu --help                   # full verb list",
    ];
    throw new UsageError(lines.join("\n"));
  }

  const eventLimit = opts.events ?? 20;
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push(await loadWorkstreamSnapshot(db, ws, { eventLimit }));
  }
  const multi = workstreams.length > 1;

  // ── JSON: full static state shape ──
  if (opts.json === true) {
    if (multi) emitJson({ workstreams: perWs.map(fullJsonShape) });
    else {
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      emitJson(fullJsonShape(single));
    }
    return;
  }

  // ── Interactive TUI branch (explicit via --tui) ──
  // The legacy static card remains the default for `mu state` so it
  // stays visible to LLMs, screenshots, docs, and muscle-memory users.
  // Bare `mu` owns the TTY auto-route for humans. Mutual-exclusion with
  // --json is enforced earlier (above the JSON branch).
  // Multi-workstream TUI is supported via tabs as of
  // feat_tui_multi_workstream (workstream `tui-impl`): the resolved
  // ws set is forwarded to <App>; Tab / Shift-Tab cycles tabs.
  if (opts.tui === true) {
    const { runTui } = await import("./tui/index.js");
    await runTui(db, { workstreams: perWs.map((d) => d.workstreamName) });
    return;
  }

  // ── Static human render ──
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
  const staleWorkspaces = d.workspaces.filter((w) => isWorkspaceStale(w.commitsBehindMain));

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
  // Workspaces: warn line + tip when ANY row is ≥ WORKSPACE_STALE_THRESHOLD
  // commits behind main. Per bug_workspace_stale_parent_silent_drift.
  const workspacesHeader =
    staleWorkspaces.length > 0
      ? `${pc.bold(`Workspaces (${d.workspaces.length})`)} ${pc.yellow(`⚠ (${staleWorkspaces.length} stale ≥${WORKSPACE_STALE_THRESHOLD} commits behind):`)}`
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

export function printBareNoWorkstreamsHint(): void {
  console.log("");
  console.log("Next:");
  console.log("  Get started: mu workstream init <name>");
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
      "Canonical state card: agents + orphans + tracks + ready/in-progress/blocked/recent-closed tasks + workspaces + recent events. The agent/API-facing static state surface. Default prints the static card; pass --tui to enter the interactive ink-based dashboard. -w accepts repeat or comma-separate (or both); --all is sugar for every workstream on this machine. N≥2 stacks per-workstream cards.",
    )
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)",
    )
    .option("--all", "include every workstream on this machine")
    .option(
      "--tui",
      "interactive TUI (rounded-border dashboard with cards + popups; multi-ws via Tab/Shift-Tab tabs)",
    )
    .option(
      "--events <n>",
      "how many recent kind=event log entries to include (default 20)",
      parseLines,
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as StateOpts;
      return handle((db) => cmdState(db, opts), this as Command)();
    });
}
