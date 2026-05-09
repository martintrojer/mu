---
id: "review_code_cli_tasks_re_export_indirection"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.1
roi: 350.00
owner: "worker-mf-2"
created_at: "2026-05-09T08:30:59.219Z"
updated_at: "2026-05-09T09:34:57.724Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "review_code_cli_tasks_oversize"]
---

# REVIEW: src/cli/tasks.ts re-exports cluster modules with no caller

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:31:20.505Z

```
FILES: src/cli/tasks.ts:14-41 (the dual import + re-export of cmdTask{Blocked,Goals,List,Next,OwnedBy,Ready,Search,Close,Defer,Open,Reject})

FINDINGS: After the refactor extracted lifecycle.ts and queries.ts, src/cli/tasks.ts both imports the cmd functions (so wireTaskCommands can use them) AND re-exports them, with this docstring:

  // re-export so external callers continue to
  // `import { cmdTaskList } from "./cli/tasks.js"`.

The "external callers" don't exist. Grep:
  grep -rn "cmdTask\b\|cmdMy" src/ test/ — outside of cli/tasks.ts and the lifecycle/queries modules themselves, the ONLY callers are:
    - src/cli/agents.ts:500 imports cmdMyNext + cmdMyTasks from "./tasks.js" (reasonable — those two functions actually live in cli/tasks.ts proper).
    - No imports of cmdTaskList, cmdTaskClose, cmdTaskBlocked, cmdTaskGoals, cmdTaskNext, cmdTaskOwnedBy, cmdTaskReady, cmdTaskSearch, cmdTaskOpen, cmdTaskReject, or cmdTaskDefer from anywhere outside src/cli/tasks.ts.

The re-export is dead. It also isn't surfaced via src/index.ts (the SDK boundary) — the CLI cmd functions are explicitly NOT part of the SDK contract (only the SDK functions like claimTask are). So the "external callers" the comment promises are imaginary; the wrapper isn't carrying its weight.

WHY IT MATTERS: 35. Pure smell. Adds 24 lines of import-then-re-export ceremony plus a misleading comment that promises a contract no caller relies on. Future readers will protect the re-exports out of fear of breaking "external callers"; deleting the re-exports is a 24-line cleanup.

SUGGESTED FIX (~24 LOC delete):
1. Delete the `export { cmdTaskBlocked, ... } from "./tasks/queries.js"` block (cli/tasks.ts:27-35) and the `export { cmdTaskClose, ... } from "./tasks/lifecycle.js"` block (cli/tasks.ts:36-41).
2. Update the docstring at cli/tasks.ts:14-17 to drop the "re-export so external callers continue to..." promise. The IMPORT half stays (wireTaskCommands needs them).

ALTERNATIVES CONSIDERED:
- Keep them "for symmetry" — but symmetry isn't a value if the contract isn't real. The skill says "Abstractions must justify their cost" and "Deletion is often the highest-value refactor".
- Move wireTaskCommands into queries.ts/lifecycle.ts so cli/tasks.ts disappears entirely. Bigger; would also need cmdMyTasks/cmdMyNext to find a new home (probably cli/agents.ts where wireSelfCommands lives). Worth a follow-up but not in scope here.

EVIDENCE:
- grep -rn "cmdTask\b\|cmdMy" --include="*.ts" src/ test/ | grep -v "cli/tasks/\|src/cli/tasks.ts" → 4 hits, all of which are cmdMyNext/cmdMyTasks (which actually live in cli/tasks.ts and would be unaffected by the deletion).
- src/index.ts has no cmd* exports at all (CLI cmd functions are not part of the SDK).
```
