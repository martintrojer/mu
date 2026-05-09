---
id: "review_test_error_nextsteps_too_loose"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: null
created_at: "2026-05-08T11:23:48.966Z"
updated_at: "2026-05-08T12:57:12.865Z"
blocked_by: []
blocks: []
---

# REVIEW: error-nextsteps loop only checks shape, not content

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:24:08.925Z

```
FILES: test/error-nextsteps.test.ts:43-66 ; src/agents.ts / src/tasks.ts / src/approvals.ts / src/workspace.ts / src/workstream.ts (errorNextSteps methods)
WHAT THE TEST CLAIMS: Each typed error 'implements HasNextSteps with non-empty, well-formed steps' (one parameterised test per error class, ~22 cases).
WHAT IT ACTUALLY VERIFIES: For each error, asserts: (a) hasNextSteps(err) === true, (b) `errorNextSteps()` returns an Array, (c) length > 0, (d) every step has string `intent` and string `command` of length > 0. NOT verified: that the command is actually a valid `mu ...` command, that it references the right entity (e.g. that `WorkspaceNotFoundError("alice")` mentions "alice" in any step), or that the suggestions are actionable.
GAP: An errorNextSteps() method that returned [{ intent: " ", command: " " }] would pass (after trimming, no — they check `length > 0` not `trim().length > 0`, so even " " with one space passes). More realistically: an errorNextSteps() method that returned a generic [{intent:"Read help",command:"mu --help"}] regardless of the error's parameters would pass for every case. The five "specific" tests below (ClaimerNotRegisteredError, TaskNotInWorkstreamError, AgentNotInWorkstreamError, WorkstreamNameInvalidError, PaneNotFoundError) cover only 5 of the 22 error classes. The other 17 (TaskNotFoundError, TaskExistsError, TaskAlreadyOwnedError, CycleError, CrossWorkstreamEdgeError, AgentExistsError, AgentNotFoundError, AgentDiedOnSpawnError, TmuxError, WorkspaceExistsError, WorkspacePathNotEmptyError, WorkspacePreservedError, WorkspaceNotFoundError, ApprovalNotFoundError, ApprovalAlreadyDecidedError, ApprovalNotInWorkstreamError x2) have NO content assertions.
WHY IT MATTERS: The whole point of errorNextSteps() is actionability — directing the user to the right verb with the right id. A regression that swaps `mu task show foo` for a generic `mu help` would slip through silently for 17/22 error classes. The skill explicitly flags "missing assertions" and "tests that pass on broken code"; this loop is the textbook case.
SUGGESTED FIX: For every error case in the parametric loop, add at minimum: `expect(steps.some(s => s.command.includes(<entityId>))).toBe(true)` where entityId is whatever identifying string the error was constructed with (taskId / agentName / paneId / slug). This shifts the assertion from "is well-formed" to "is contextual". Cost: pass an `expectedTokens: string[]` field into the cases tuple; ~10 LOC.
```
