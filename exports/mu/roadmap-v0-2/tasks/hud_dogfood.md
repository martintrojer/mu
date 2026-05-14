---
id: "hud_dogfood"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-07T17:51:33.284Z"
updated_at: "2026-05-09T08:03:39.238Z"
blocked_by: ["hud_widget_impl"]
blocks: []
---

# Dogfood: run a real wave using mu hud + pane border, file friction

## Notes (1)

### #1 by "π - mu", 2026-05-09T08:03:39.122Z

```
DOGFOODED MANUALLY by the operator across this session's multi-agent dispatches (mu state -w X, mu hud -w X, pane border watching, mu workspace list, mu task wait — all exercised live while the crew worked through cross_workstream_claim_for, hud_colors_stripped_under_watch_and, workspace_create_partial_dir_on_failure, bug_workspace_stale_parent_silent_drift, tmux_pane_border_top_and_bottom_plus_glyph_audit, nit_invalid_id_typeerror, nit_task_list_sort_by_recency).

FINDINGS surfaced + already-shipped during this dogfood pass (each its own task, all closed):
  - hud_colors_stripped_under_watch_and  → closed by 67014c7 (TMUX-aware color detect)
  - tmux_pane_border_top_and_bottom_plus_glyph_audit → closed by d1d43e0 (heavy 4-side border + glyph drift cleanup)
  - bug_workspace_stale_parent_silent_drift → closed by 670afce (staleness column + warn line)
  - nit_task_list_sort_by_recency → closed by 959aa6c (--sort key)
  - bug_workspace_spawn_hyphen_agent_fk_failure → REJECTED (no longer reproduces; previously fixed by 462e3a7)
  - agent_orphan_typed_verb_debate → REJECTED (auto-prune + reaper note IS the surface)

NEXT-WAVE FOLLOW-UPS already filed (none required for this task to close):
  - The "Workspaces (N) ⚠ (K stale ≥10 commits behind):" header + Tip line worked end-to-end (live demo: code-reviewer-1 / test-reviewer-1 lit up red 38 against fresh worker-1 = green 0).
  - The /new-before-unrelated-work discipline (now in SKILL.md) was applied between every cross-task dispatch in this session; the workers landed clean prompts each time.

NO FRICTION FILED that wasn't already closed in this session. Closing as done.
```
