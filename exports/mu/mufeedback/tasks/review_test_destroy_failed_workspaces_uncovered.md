---
id: "review_test_destroy_failed_workspaces_uncovered"
workstream: "mufeedback"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: null
created_at: "2026-05-08T11:24:12.541Z"
updated_at: "2026-05-09T10:28:25.624Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: destroyWorkstream tests never exercise failedWorkspaces path

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:24:31.605Z

```
FILES: test/workstream.test.ts:288-433 (destroyWorkstream describe block); src/workstream.ts:240-330 (workspace cleanup + failedWorkspaces accumulation); src/cli.ts:572-585 (WARNING render of failedWorkspaces).
WHAT THE TESTS CLAIM: a comprehensive describe block on destroyWorkstream covering tmux + DB + workspaces.
WHAT THE TESTS ACTUALLY VERIFY: every test asserts `freedWorkspaces: 0, failedWorkspaces: []`. None of them seeds a vcs_workspaces row. The new-in-v0.2 cleanup loop (lines 257-282) — backendByName/freeWorkspace + the failure-accumulation try/catch + the parent-dir rmdir — has zero coverage.
GAP: 1) freedWorkspaces++ is dead code from the test's perspective (always 0 in assertions). 2) The failedWorkspaces population path is never exercised — a backend that throws ('git worktree remove' refuses, jj workspace forget fails, path is on a read-only mount, etc.) would still leave freedWorkspaces at 0 AND would push to failedWorkspaces, but no test verifies the shape of that failure record (agent/backend/path/error fields) or that destroy proceeds despite the throw. 3) The WARNING block in cli.ts that renders failedWorkspaces to the user has no test coverage anywhere. 4) The parent-dir rmdir best-effort cleanup is untested — the rmdir-when-non-empty branch silently swallows.
WHY IT MATTERS: This was the explicit motivating bug ("mufeedback note #195" per src/workstream.ts:251 comment). The fix landed without a regression test that actually fires through the freed/failed paths. A future refactor that drops the try/catch (turning a single bad worktree into an aborted destroy with half-cleaned state) would pass every existing test.
SUGGESTED FIX: Two new tests. (a) Happy path: insert a vcs_workspaces row pointing at a real tempdir; assert destroyWorkstream returns freedWorkspaces=1, the path no longer exists on disk, the parent dir is reaped. (b) Failure path: stub VcsBackend.freeWorkspace via the existing backendByName seam (or a `MU_VCS_BACKEND_OVERRIDE` env that returns a backend whose freeWorkspace throws); assert freedWorkspaces=0, failedWorkspaces=[{agent, backend, path, error}], and the workstreams DELETE STILL ran (FK cascade fired, so the row is gone). Both tests verify the v0.2 contract that workspace failures are surfaced rather than swallowed and don't block destroy.
```
