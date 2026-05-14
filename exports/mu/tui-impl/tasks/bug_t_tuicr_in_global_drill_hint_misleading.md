---
id: "bug_t_tuicr_in_global_drill_hint_misleading"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: null
created_at: "2026-05-13T07:37:49.056Z"
updated_at: "2026-05-13T08:00:34.855Z"
blocked_by: []
blocks: []
---

# BUG: 't tuicr' shows in popup-drill global status-bar hint cluster on EVERY drill including ones where 't' does nothing (TaskDetailDrill notes); should ONLY appear in git-show drills (where it's already correctly inset into the bottom border via bottomLabel)

## Notes (1)

### #1 by "π - mu", 2026-05-13T08:00:34.855Z

```
CLOSE: bdb9f2a: dropped t tuicr from global POPUP_DRILL_HINTS; per-popup hint= prop already does context-conditional placement via TitledBox bottomLabel
```
