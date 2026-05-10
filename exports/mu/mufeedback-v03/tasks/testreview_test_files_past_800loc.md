---
id: "testreview_test_files_past_800loc"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 1
roi: 35.00
owner: null
created_at: "2026-05-10T11:33:45.238Z"
updated_at: "2026-05-10T12:59:10.109Z"
blocked_by: []
blocks: []
---

# test-review: 5 test files past the 800 LOC refactor signal (tasks 2565, verbs 1305, workspace 1135, workstream 934, tmux 910)

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:34:05.310Z

```
FILES:
  test/tasks.test.ts      — 2565 LOC (29 describe blocks)
  test/verbs.test.ts      — 1305 LOC (13 describe blocks)
  test/workspace.test.ts  — 1135 LOC (16 describe blocks)
  test/workstream.test.ts —  934 LOC
  test/tmux.test.ts       —  910 LOC

FINDING: AGENTS.md § Code style says "Hard cap: 1500 LOC per file. Refactor signal at 800." The rule is written for src/ but the substrate cluster — flat test/ dir, one file per SDK module — applies the same way: when test/tasks.test.ts has 172 tests across 29 describe blocks, scrolling for the right one is real friction and merge conflicts on this file have happened (its own contributors comment that it's "the catch-all for src/tasks.ts").

WHY: Refactor signal exists for a reason — past 800 the file stops reading as a unit and starts reading as an archive. test/tasks.test.ts is past the HARD cap counting comments. None of the v0.3 wave offenders (test/archive-cli.test.ts, archives.test.ts, snapshots.test.ts, json-output.test.ts) crossed 800 — the v0.3 contributors honored the rule; the legacy files predate it.

FIX-SKETCH: Surgical splits that map 1:1 to existing src/ subdir clusters (no behaviour change, just file rename + import sort):
  test/tasks.test.ts (2565) →
    test/tasks-crud.test.ts          (CRUD + cycle + edges + reparent + delete)
    test/tasks-lifecycle.test.ts     (status + claim + release + reject + defer + cascade)
    test/tasks-wait.test.ts          (waitForTasks + stuck warn + sortTasks + parseSortOption)
    test/tasks-meta.test.ts          (slugifyTitle, idFromTitle, isValidTaskId, isTaskStatus, relTime, TASK_STATUS_LIST)
  test/verbs.test.ts (1305) →
    test/verbs-spawn-close.test.ts   (spawn liveness + closeAgent + freeAgent)
    test/verbs-listlive.test.ts      (listLiveAgents + mode propagation)
    test/verbs-misc.test.ts          (isValidAgentName, composeAgentTitle, sendToAgent, readAgent, cmdAgentShow, adoptAgent)
  test/workspace.test.ts (1135) →
    test/workspace-backends.test.ts  (none/git/jj/sl backend impls + detectBackend)
    test/workspace-sdk.test.ts       (createWorkspace + freeWorkspace + listWorkspaces + orphans + closeAgent integration)
    test/workspace-staleness-mem.test.ts  (decorateWithStaleness + memoization)
Each split should keep beforeEach/afterEach copies (intentional duplication is fine; shared fixture extraction is a separate task).
```
