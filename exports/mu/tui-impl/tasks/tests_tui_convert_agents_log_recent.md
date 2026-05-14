---
id: "tests_tui_convert_agents_log_recent"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.3
roi: 183.33
owner: "worker-1"
created_at: "2026-05-13T14:41:26.885Z"
updated_at: "2026-05-13T15:04:05.470Z"
blocked_by: ["tests_tui_capture_stream_seam_helper"]
blocks: ["testreview_tui_static_source_grep_pervasive"]
---

# TESTS: convert popups/{agents,log,recent} tests from source-grep to behaviour

## Notes (2)

### #1 by "π - mu", 2026-05-13T14:41:31.479Z

```
Sub-task of testreview_tui_static_source_grep_pervasive. See `mu task notes testreview_tui_static_source_grep_pervasive -w tui-impl` for the full split rationale.
```

### #2 by "worker-1", 2026-05-13T15:04:05.470Z

```
CLOSE: 1d26435: 3 popup tests converted to behaviour; verified each catches a deliberate regression (agent yank rename, log Enter→drill removal, recent open→reopen rename)
```
