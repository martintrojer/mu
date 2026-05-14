---
id: "bug_popup_q_esc_quits_app"
workstream: "tui-impl"
status: CLOSED
impact: 90
effort_days: 0.1
roi: 900.00
owner: null
created_at: "2026-05-11T13:12:08.892Z"
updated_at: "2026-05-11T13:30:37.708Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: q / Esc inside a popup quits the whole app instead of returning to the dashboard

## Notes (1)

### #1 by "π - mu", 2026-05-11T13:30:37.708Z

```
CLOSE: fixed in src/cli/tui/app.tsx; popup handler returns early before falling through to dispatchGlobalKey
```
