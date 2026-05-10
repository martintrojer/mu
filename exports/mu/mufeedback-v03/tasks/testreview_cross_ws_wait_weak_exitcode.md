---
id: "testreview_cross_ws_wait_weak_exitcode"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: null
created_at: "2026-05-10T11:34:09.637Z"
updated_at: "2026-05-10T11:47:01.421Z"
blocked_by: []
blocks: []
---

# test-review: cli-task-wait-cross-ws bad-ref tests use weak `exitCode !== null` assertion; would pass for ANY non-null exit

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:34:22.852Z

```
FILES: test/cli-task-wait-cross-ws.test.ts:184-208 (two `bad ref` tests)

FINDING: Both bad-ref tests assert only `expect(exitCode).not.toBeNull()` despite the comment immediately above saying "TaskNotFoundError → exit 3 via the cli handler." The assertion would pass for exit 1, 2, 3, 4, 5, 6, or any non-null code — including the generic exit-1 catch-all that mu uses when a typed error class slips through classifyError(). Sister files (cli-task-claim.test.ts:97 `expect(exitCode).toBe(4)`, cli-task-add-invalid-id.test.ts:60 `expect(exitCode).toBe(4)`) all pin exit codes precisely; this file is the lone weak link.

WHY: Exit codes are mu's contract with shell pipelines (per VOCABULARY.md / CHANGELOG.md exit-code map: 2=usage, 3=not-found, 4=conflict, 5=timeout, 6=reaper). A regression where `mu task wait wsa/foo ghostws/bar` started returning exit 1 (untyped) instead of exit 3 (TaskNotFoundError) would break shell scripts that branch on exit code AND would NOT fail this test. Classic "weak assertion" smell from the test-reviewer skill.

FIX-SKETCH: Two-line tightening; comments already document the intent.
  - expect(exitCode).not.toBeNull();     →    expect(exitCode).toBe(3);
Same for the second test. If a future change deliberately maps the error to a different code, the test BREAKS LOUDLY (which is the right outcome — exit codes are part of the public surface).
```
