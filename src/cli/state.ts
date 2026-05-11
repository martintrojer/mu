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

import {
  JSON_OPT,
  UsageError,
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
  resolveOptionalWorkstream,
  withRoiAll,
} from "../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../db.js";
import { pc } from "../output.js";
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

export interface StateOpts {
  // Variadic on every render mode.
  workstream?: string[];
  all?: boolean;
  json?: boolean;
  mission?: boolean;
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
  // Mission is the only mode that survives a no-workstream context:
  // bare `mu` outside a tmux session is a discovery moment, not an
  // error. Default keeps today's "workstream required" failure
  // (resolveWorkstreamSet throws via the resolveWorkstream chain
  // inside the explicit branches).
  if (opts.mission === true && (opts.workstream === undefined || opts.workstream.length === 0)) {
    if (opts.all !== true) {
      const auto = await resolveOptionalWorkstream();
      if (auto === null) {
        await renderMissionNoWorkstream(db, opts);
        return;
      }
    }
  }

  // --tui mutual-exclusion checks: enforce BEFORE the JSON / render
  // branches so combining --tui with another render flag errors
  // loudly instead of silently winning whichever branch ran first.
  if (opts.tui === true) {
    if (opts.json === true) {
      throw new UsageError("--tui and --json are mutually exclusive (TUI is render-only)");
    }
    if (opts.mission === true) {
      throw new UsageError(
        "--tui and --mission are mutually exclusive (mission is a static glance card)",
      );
    }
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
    process.stderr.write(`${lines.join("\n")}\n`);
    process.exit(2);
  }

  const eventLimit = opts.events ?? 20;
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push(await loadWorkstreamSnapshot(db, ws, { eventLimit }));
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
    if (multi) emitJson({ workstreams: perWs.map(fullJsonShape) });
    else {
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      emitJson(fullJsonShape(single));
    }
    return;
  }

  // ── Interactive TUI branch (opt-in via --tui) ──
  // The TUI replaces the old --hud render mode. It is OPT-IN: the
  // legacy static card is the default for `mu state` so it stays
  // visible to LLMs, screenshots, docs, and muscle-memory users.
  // See feat_resurrect_state_card (workstream `tui-impl`) for the
  // rationale on demoting the prior TTY auto-route. Multi-ws TUI is
  // its own follow-up (feat_tui_multi_workstream). Mutual-exclusion
  // with --json / --mission is enforced earlier (above the JSON
  // branch); only the multi-ws guard is left here because it depends
  // on resolveWorkstreamSet() output.
  if (opts.tui === true) {
    if (multi) {
      throw new UsageError("--tui currently supports a single workstream; pass exactly one -w");
    }
    const { runTui } = await import("./tui/index.js");
    const single = perWs[0];
    if (single === undefined) throw new Error("invariant: workstreams non-empty");
    await runTui(db, { workstream: single.workstreamName });
    return;
  }

  // ── Static human render ──
  if (opts.mission === true) {
    renderMissionMode(perWs);
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

// ─── commander wiring ────────────────────────────────────────────────
//
// wireStateCommands is called by buildProgram() in src/cli.ts. Wired
// here so every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";

export function wireStateCommands(program: Command): void {
  program
    .command("state")
    .description(
      "Canonical state card: agents + orphans + tracks + ready/in-progress/blocked/recent-closed tasks + workspaces + recent events. The 'what does an LLM look at first?' verb. JSON-first. Default prints the static card; pass --tui to enter the interactive ink-based dashboard (replaces the old --hud). --mission emits the stripped 5-col glance card (agents + orphans + tracks + ready) — bare `mu` is an alias. -w accepts repeat or comma-separate (or both); --all is sugar for every workstream on this machine. N≥2 stacks per-workstream cards (full / mission).",
    )
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)",
    )
    .option("--all", "include every workstream on this machine")
    .option("--mission", "stripped 5-column glance card (agents + orphans + tracks + ready)")
    .option(
      "--tui",
      "interactive TUI (rounded-border dashboard with cards + popups; single-ws only)",
    )
    .option(
      "--events <n>",
      "how many recent kind=event log entries to include (default 20)",
      parseLines,
    )
    .option("-n, --lines <n>", "alias for --events (kept for --hud muscle memory)", parseLines)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as StateOpts;
      return handle((db) => cmdState(db, opts), this as Command)();
    });
}
