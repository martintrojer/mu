---
id: "review_code_cli_tasks_oversize"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-09T08:36:20.645Z"
updated_at: "2026-05-09T10:43:47.898Z"
blocked_by: ["review_code_cli_tasks_re_export_indirection"]
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: src/cli/tasks.ts is 1234 LOC — refactor moved verbs OUT but wireTaskCommands still drowns the file

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:36:44.508Z

```
FILES: src/cli/tasks.ts (1234 LOC; second-largest file in src/ after src/cli.ts at 945)

FINDINGS: After the refactor moved cmdTaskClose/Open/Reject/Defer to cli/tasks/lifecycle.ts and cmdTaskList/Next/Ready/Blocked/Goals/OwnedBy/Search to cli/tasks/queries.ts, the parent file is still 1234 LOC. AGENTS.md flags 800 LOC as the "refactor signal" and 1500 LOC as a "hard cap". cli/tasks.ts is well past the signal.

What's still in cli/tasks.ts:
- cmdMyTasks / cmdMyNext (51 LOC)
- cmdTaskAdd / cmdTaskNote / unescapeNoteText / lastClaimActor / cmdTaskShow / cmdTaskNotes / printNote / cmdTaskRelease / cmdClaim / cmdTaskBlock / cmdTaskUnblock / cmdTaskDelete / cmdTaskUpdate / cmdTaskReparent / cmdTaskTree / cmdTaskWait / TreeJsonNode (the verb implementations the refactor didn't move)
- wireTaskCommands (~440 LOC of Commander wiring at the bottom — by far the biggest single function in the file)

The wireTaskCommands function is the natural extraction target — it's pure Commander glue, no domain logic, and the wireXxxCommands pattern across the rest of cli/ already proves the layout works.

Proposed second-pass split:
  src/cli/tasks/wire.ts            — wireTaskCommands (~440 LOC)
  src/cli/tasks/edges.ts           — block / unblock / reparent / delete (~150 LOC)
  src/cli/tasks/edit.ts            — add / note / show / notes / update (~250 LOC)
  src/cli/tasks/claim.ts           — claim / release / wait + lastClaimActor (~250 LOC)
  src/cli/tasks/tree.ts            — tree + buildJsonTree + renderTree + formatTreeNodeLabel (~80 LOC)
Then cli/tasks.ts becomes a slim re-export hub (~30 LOC), and cmdMyTasks/cmdMyNext find a new home (probably cli/tasks/queries.ts since they're query-shaped).

WHY IT MATTERS: 35. AGENTS.md compliance + readability. 1234 LOC is nothing TypeScript can't handle but is well past the "I have to scroll a lot to find the verb I want to read" line. The recently-completed refactor went 80% of the way; the wire-up split is the obvious finisher.

SUGGESTED FIX (~440 LOC moved, no behaviour change):
1. Extract wireTaskCommands into src/cli/tasks/wire.ts. Keep imports the same. Update cli.ts's import. Net: cli/tasks.ts drops to ~800 LOC (right at the refactor signal).
2. (Optional, follow-up) Continue with the per-verb splits above if 800 still feels heavy.

ALTERNATIVES CONSIDERED:
- Leave at 1234 LOC. Workable. Hard cap is 1500 so we have headroom; the refactor's primary goal was reached.
- Move JUST cmdTaskTree (tree rendering is its own visual mini-DSL). ~80 LOC. Smaller win.

EVIDENCE: wc -l src/cli/tasks.ts → 1234. AGENTS.md: "Hard cap: 1500 LOC per file. Refactor signal at 800."
```
