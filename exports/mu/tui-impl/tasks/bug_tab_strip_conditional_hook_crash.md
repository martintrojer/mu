---
id: "bug_tab_strip_conditional_hook_crash"
workstream: "tui-impl"
status: CLOSED
impact: 90
effort_days: 0.1
roi: 900.00
owner: null
created_at: "2026-05-12T17:03:52.125Z"
updated_at: "2026-05-12T17:18:56.139Z"
blocked_by: []
blocks: []
---

# BUG (CRITICAL): TabStrip calls useStdout() conditionally — 'Rendered fewer hooks than expected' crash on small panes / when terminalColumns prop changes

## Notes (1)

### #1 by "π - mu", 2026-05-12T17:18:56.139Z

```
CLOSE: 68a4f3b: TabStrip pure component; useStdout pulled into <App>; rules-of-hooks regression test added; manual smoke = mu in small pane no longer crashes
```
