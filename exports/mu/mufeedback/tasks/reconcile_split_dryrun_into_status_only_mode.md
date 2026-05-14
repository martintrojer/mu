---
id: "reconcile_split_dryrun_into_status_only_mode"
workstream: "mufeedback"
status: CLOSED
impact: 55
effort_days: 0.3
roi: 183.33
owner: null
created_at: "2026-05-09T08:20:48.123Z"
updated_at: "2026-05-09T10:29:06.596Z"
blocked_by: ["review_code_should_overwrite_status_dup", "review_code_state_hud_in_progress_query_dup"]
blocks: ["bug_pane_title_glyph_stuck_at_needs_input", "docs_staleness_review_capstone"]
---

# feat: split reconcile dryRun into 'status-only' mode so mu state/hud refresh agent status without pruning or reaping

## Notes (1)

### #1 by "π - mu", 2026-05-09T08:21:28.440Z

```
SURFACED LIVE while orchestrating today's waves. mu state and mu hud SHOULD update agent status (operator's primary signal: "is worker-X busy or idle right now?") but should NOT do the dangerous bits (ghost prune, mid-spawn placeholder cleanup, the reaper that flips IN_PROGRESS tasks back to OPEN with reaper notes).

CURRENT STATE (src/reconcile.ts)

  ReconcileOptions { workstream?, dryRun?: boolean }
  Today dryRun=true MEANS:
    - skip ghost prune (good — won't kill mid-spawn placeholders)
    - skip status detection (BAD for state/hud — emoji + "busy/needs_input" goes stale)
    - skip orphan surface? no — orphan surface always runs (it's pure read)

  src/cli/state.ts:64,160    listLiveAgents(db, { workstream, dryRun: true })
  src/cli/hud.ts:333         listLiveAgents(db, { workstream, dryRun: true })
  
  Both pass dryRun: true. That was correct as far as "don't prune mid-spawn" goes (snap_undo_reconcile_destroys_recovered_agents lineage; bug_agent_spawn_workspace_fk_failure too) but it ALSO suppressed status refresh, which is the very thing the operator looks at the card to see.

  Net: when worker-X transitions busy → needs_input, mu state shows the OLD status until the next mutating verb (mu agent list / mu agent send / etc.) triggers a real reconcile.

WHAT THE OPERATOR WANTS

  mu state      — agent status FRESH, no DB-mutating cleanup
  mu hud        — agent status FRESH, no DB-mutating cleanup
  mu agent list — full reconcile (the documented escape hatch; mutates)

The desired primitive: "refresh status, but don't prune, don't reap, don't mutate task ownership".

PROPOSED SHAPE

  Replace `dryRun: boolean` with `mode: ReconcileMode` (a union):
  
    type ReconcileMode = 
      | "full"          // current default; prune + status + orphan + reaper-on-prune
      | "status-only"   // status + orphan; no prune, no reaper
      | "report-only"   // current dryRun; nothing mutates, just count would-be-prune
  
  ReconcileReport gains a `mode` field replacing `dryRun: boolean`.
  
  Call-site wiring:
    src/cli/state.ts        — { mode: "status-only" }
    src/cli/hud.ts          — { mode: "status-only" }
    src/cli/agents.ts (list) — { mode: "full" }       (existing)
    src/cli.ts cmdUndo      — { mode: "report-only" } (preserve current behavior)
    src/cli.ts cmdMission   — { mode: "status-only" } (bare `mu`)
    src/cli.ts cmdAttach    — { mode: "status-only" }
    src/cli.ts cmdDoctor    — { mode: "report-only" }  (read-only diagnostic)

LOAD-BEARING SUBTLETY: status-detection writes to DB

  Today, status detection in reconcile.ts:127 calls updateAgentStatus + refreshAgentTitle — both DB writes (and the title write also calls tmux). For "status-only" mode, those WRITES ARE DESIRED (the whole point). What status-only must NOT do:
    - deleteAgent (the prune)
    - the reaper-on-prune that runs inside deleteAgent and flips IN_PROGRESS → OPEN with [reaper] notes
  
  So the split is between "mutations the user expects from a refresh" (status + title) and "mutations the user does NOT expect from a refresh" (prune + reap). status-only allows the former, suppresses the latter.

ALSO: "status-only" still does the orphan-surface (pure read). Same as today. mu state's "Orphan panes" section keeps working.

EDGE: mid-spawn races
  
  Status-only avoids the prune so the %pending-<name> placeholder is safe. But status detection on a placeholder pane that doesn't yet have a usable scrollback/title might emit something weird. Recommend: skip status detection for any agent whose pane id starts with %pending- (already a known sentinel).

API CHANGE / BACKWARD COMPAT

  This is a breaking change to ReconcileOptions / ReconcileReport. Limited blast: only internal callers + src/index.ts re-exports + 1-2 docs cross-references. No public DB schema or CLI surface change.
  
  Migration: `dryRun: true` → `mode: "report-only"` everywhere. `dryRun: false` (default) → `mode: "full"` (default). New `mode: "status-only"` is the only new shape.
  
  CHANGELOG entry under [Unreleased] / Changed — explicit "breaking for SDK consumers using ReconcileOptions" note. The CLI verb behaviour is strictly better: mu state / mu hud now show fresh status without becoming dangerous.

WHERE TO IMPLEMENT

  src/reconcile.ts                — types + function
  src/agents.ts                   — listLiveAgents accepts/forwards mode
  src/cli/state.ts                — switch to status-only
  src/cli/hud.ts                  — switch to status-only
  src/cli.ts (cmdMission, cmdAttach, cmdDoctor) — switch to status-only / report-only
  src/index.ts                    — re-export ReconcileMode
  test/reconcile.test.ts          — three new tests, one per mode
  test/cli-snapshot.test.ts       — verify cmdUndo still uses report-only

LIVE TEST (manual)

  1. Spawn agent, send a slow command, mu state -w X repeatedly: status should flip busy → needs_input WITHOUT a separate `mu agent list`.
  2. Spawn agent, kill its pane externally, mu state -w X: should NOT prune the row (ghost stays visible). mu agent list: should prune.
  3. Workstream destroy + mu undo: cmdUndo should still preserve recovered rows (report-only behaviour unchanged).

SCOPE GUARD: ~0.3 days. ~50 LOC of API change + ~30 LOC of tests + ~20 LOC of call-site updates + CHANGELOG.

NEXT
  No follow-ups required. After ship, watch mu state's freshness in dogfood; if "the orphan surface still mutates because…" surfaces, that's a separate task.
```
