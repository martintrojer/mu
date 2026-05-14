---
id: "tests_tui_capture_stream_seam_helper"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-1"
created_at: "2026-05-13T14:41:26.577Z"
updated_at: "2026-05-13T14:51:23.877Z"
blocked_by: []
blocks: ["testreview_tui_static_source_grep_pervasive", "tests_tui_convert_agents_log_recent", "tests_tui_convert_ready_inprogress_blocked", "tests_tui_convert_workspaces_commits_doctor"]
---

# TESTS: document CaptureStream-based behaviour-test seam + add simulateInput helper

## Notes (2)

### #1 by "π - mu", 2026-05-13T14:41:31.174Z

```
Sub-task of testreview_tui_static_source_grep_pervasive. See `mu task notes testreview_tui_static_source_grep_pervasive -w tui-impl` for the full split rationale.
```

### #2 by "worker-1", 2026-05-13T14:51:23.877Z

```
CLOSE: 098d72c: simulateInput helper + behaviour-test header docs added (test/_ink-render.ts + new test/_ink-render.test.ts with 7 unit tests; CHANGELOG Tests entry). Four greens: typecheck/lint/test:fast (1371)/test (2431)/build all clean.
```
