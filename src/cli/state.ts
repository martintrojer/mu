// mu — bare `mu` (mission-control) + `mu state` (canonical state card).
//
// Two read-only verbs sharing the same data shape:
//
//   bare `mu`                   quick mission control: agents + orphans +
//                               tracks + ready (5 columns wide, glanceable)
//   bare `mu` (no workstream)   discovery mode: list workstreams that exist
//                               + how to pick one (orientation, not failure)
//   mu state                    canonical state card: agents + orphans +
//                               tracks + ready/in-progress/blocked/recent-
//                               closed + workspaces + recent events.
//                               JSON-first by design (per Ilya's council
//                               critique: state cards as the default
//                               attention surface; SQL/raw verbs as the
//                               escape hatch underneath).
//
// Both pass dryRun: true to listLiveAgents — they're read-only, so the
// periodic poll doesn't race in-flight spawns (see
// bug_agent_spawn_workspace_fk_failure).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import pc from "picocolors";
import { listLiveAgents } from "../agents.js";
import {
  type RawTaskRowForState,
  byRoiDesc,
  emitJson,
  formatAgentsTable,
  formatReadyTable,
  formatTaskListTable,
  formatTracks,
  formatWorkspacesTable,
  formatWorkstreamsTable,
  printLogRow,
  rawTaskRowToTask,
  resolveOptionalWorkstream,
  resolveWorkstream,
  withRoiAll,
} from "../cli.js";
import type { Db } from "../db.js";
import { listLogs } from "../logs.js";
import { listBlocked, listReady } from "../tasks.js";
import { getParallelTracks } from "../tracks.js";
import { listWorkspaceOrphans, listWorkspaces } from "../workspace.js";
import { listWorkstreams } from "../workstream.js";

export async function cmdMission(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
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

export async function cmdState(
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

// (RawTaskRowForState + rawTaskRowToTask live in src/cli.ts so cmdHud
// can reuse them.)

// ─── commander wiring ────────────────────────────────────────────────
//
// wireStateCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle, parseLines } from "../cli.js";

export function wireStateCommands(program: Command): void {
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
}
