---
id: "feat_popup_enter_drill"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.3
roi: 250.00
owner: null
created_at: "2026-05-11T13:12:09.472Z"
updated_at: "2026-05-11T15:00:43.430Z"
blocked_by: ["bug_tui_render_ghosting", "feat_column_aligned_lists", "feat_resurrect_state_card"]
blocks: ["feat_track_drill_chains_to_task_drill", "tui_impl_complete"]
---

# FEAT: Enter inside a popup should drill into the focused row (task → notes/tree, agent → scrollback, track → task list)

## Notes (1)

### #1 by "worker-3", 2026-05-11T15:00:43.430Z

```
CLOSE: defe150 — Enter drills read-only per popup (agents→scrollback, tracks→task list, ready→notes, log→no-op); typed PopupAction.drill in keys.ts; popupMode lifted into App; status bar drill hints; 1401 tests pass
```
