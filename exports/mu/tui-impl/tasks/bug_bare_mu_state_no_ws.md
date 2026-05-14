---
id: "bug_bare_mu_state_no_ws"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.1
roi: 700.00
owner: null
created_at: "2026-05-11T13:12:09.176Z"
updated_at: "2026-05-11T14:05:32.597Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: bare `mu state` outside a workstream prints '(no workstreams)' instead of a useful error + --help; should error nicely and show usage

## Notes (1)

### #1 by "π - mu", 2026-05-11T14:05:32.597Z

```
CLOSE: src/cli/state.ts splits the empty path into 3 distinct user-facing messages with workstream list + suggestions; +3 tests; 4 greens
```
