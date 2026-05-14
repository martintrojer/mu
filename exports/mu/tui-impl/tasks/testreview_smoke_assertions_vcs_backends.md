---
id: "testreview_smoke_assertions_vcs_backends"
workstream: "tui-impl"
status: DEFERRED
impact: 40
effort_days: 0.4
roi: 100.00
owner: null
created_at: "2026-05-12T11:17:30.943Z"
updated_at: "2026-05-12T12:30:46.967Z"
blocked_by: []
blocks: []
---

# TEST REVIEW: VCS backend smoke tests assert only broad shapes

## Notes (1)

### #1 by "worker-3", 2026-05-12T11:17:38.784Z

```
FILES: test/workspace-backends.test.ts:420-446; test/workspace-commits.test.ts:296-313; test/workspace-refresh.test.ts:303-326.
FINDING: The jj/sl backend tests intentionally accept almost any non-throwing shape: commitsBehind may be null or any non-negative number; commitsSinceBase only checks array/field types; jj rebaseTo either succeeds with arrays or throws any non-typed error. These tests provide weak safety for important workspace operations: a backend could always return null/[], skip parsing commits, ignore conflicts, or fail trunk resolution and still pass. That is false confidence whenever jj/sl are available in CI.
RECOMMENDED FIX: Build deterministic local jj/sl fixtures with known base and one or two draft commits, plus a controlled trunk/remote where possible. Assert exact commit count/order/subject for commitsSinceBase, exact behind count for commitsBehind, and concrete replay/conflict behavior for rebaseTo. If a backend/tool version cannot support a deterministic assertion, split it into an explicit smoke test named as such and add a separate unit test around the parser/command adapter with captured realistic command output so core behavior is constrained.
VERIFIED: audit only; no code changed.
```
