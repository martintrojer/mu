---
id: "bug_pane_title_glyph_stuck_at_needs_input"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: null
created_at: "2026-05-09T08:50:24.046Z"
updated_at: "2026-05-09T10:29:10.441Z"
blocked_by: ["reconcile_split_dryrun_into_status_only_mode"]
blocks: ["docs_staleness_review_capstone"]
---

# BUG: tmux pane border glyph stuck at moon (needs_input) even while agent is busy/working

## Notes (1)

### #1 by "π - mu", 2026-05-09T08:50:57.087Z

```
SAME ROOT CAUSE as reconcile_split_dryrun_into_status_only_mode (added as blocker).

OPERATOR-VISIBLE SYMPTOM: looking at mu-mufeedback in tmux, every pane border still shows the moon glyph (needs_input) even when the agent is actively in a busy state (cog glyph) doing tool calls. The border only refreshes when the operator runs a MUTATING reconcile path (mu agent list, mu agent send, etc.) — read-only verbs (mu state, mu hud, bare mu) never refresh it because they pass `dryRun: true` to listLiveAgents to avoid the prune+reap side effects.

WHY THIS WAS THE RIGHT TRADE PRE-FIX:
  - dryRun: true was added to fix bug_agent_spawn_workspace_fk_failure (462e3a7) and snap_undo_reconcile_destroys_recovered_agents (08a1045).
  - dryRun lumped together "don't prune ghosts" (good) AND "don't refresh status/title" (bad-but-tolerated).

WHY IT'S WRONG NOW:
  - The operator's primary signal IS the pane border glyph + the mu state card. Both are stale until something triggers a mutating reconcile.
  - The reconcile_split_dryrun_into_status_only_mode task proposes the exact fix: a 3-mode union (full / status-only / report-only) where status-only DOES refresh status + title but does NOT prune or reap.

DISPOSITION:
  - This task ships AS PART OF reconcile_split_dryrun_into_status_only_mode. The pane-title symptom is the load-bearing motivator for that task; this bug ticket exists so the operator-facing report (this very note) doesn't get lost in the larger feature task.
  - When reconcile_split_dryrun lands and mu state / mu hud switch to mode: "status-only", they will call refreshAgentTitle() which writes the pane-border title via `tmux select-pane -T`. The moon → cog transition will become visible without operator intervention.

NO SEPARATE CODE CHANGE. Closer of reconcile_split_dryrun should also close this task with evidence pointing at the same commit.

VERIFY post-fix:
  1. Spawn agent, send a slow command, watch the tmux pane border via just `mu state -w X` (not mu agent list).
  2. Border glyph should transition needs_input → busy → needs_input as the agent works + idles.
  3. Today: stays at needs_input until you `mu agent list` or send something.
```
