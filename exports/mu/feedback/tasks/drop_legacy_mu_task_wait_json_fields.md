---
id: "drop_legacy_mu_task_wait_json_fields"
workstream: "feedback"
status: CLOSED
impact: 8
effort_days: 0.2
roi: 40.00
owner: null
created_at: "2026-05-11T09:09:02.408Z"
updated_at: "2026-05-11T09:15:27.772Z"
blocked_by: []
blocks: []
---

# drop legacy mu task wait --json fields (tasks/allReached/anyReached/elapsedMs/boolean timedOut); keep firing/all/timedOut(array)

## Notes (2)

### #1 by "worker-cleanjson-1", 2026-05-11T09:15:20.470Z

```
FILES:
  - src/tasks/wait.ts (TaskWaitResult slimmed to {refs, timedOut}; isDone() inlined; removed startedAt)
  - src/cli/tasks/claim.ts (envelope built explicitly: {firing, all, timedOut, nextSteps}; elapsedMs computed locally; dropped TaskWaitResult import)
  - test/tasks-wait.test.ts (rewrote SDK-shape assertions to use refs[] + filter(reachedTarget))
  - test/v5-name-clash.test.ts (tasks → refs)
  - test/cli-task-wait-cross-ws.test.ts (out.allReached → out.timedOut === [])
  - CHANGELOG.md ([Unreleased] Breaking entry)
COMMANDS:
  - npm run typecheck (exit 0)
  - npm run lint (exit 0)
  - npm run test (1257/1257 passing)
  - npm run build (clean)
FINDINGS:
  - The legacy boolean `timedOut` from spreading WaitResult was being silently overwritten by the array `timedOut`. Genuine accident-waiting-to-bite; explicit envelope removes the foot-gun.
  - SDK consumers in src/: only src/cli/tasks/claim.ts and src/tasks.ts (re-exports) and src/index.ts (re-exports). Internal-only.
  - SDK consumers in test/: tasks-wait.test.ts (heavily), v5-name-clash.test.ts (2 lines). All updated.
  - The TaskWaitResult re-export is preserved in src/tasks.ts and src/index.ts (even though the type name kept the same, its shape narrowed).
DECISION:
  - Picked Option B (aggressive cleanup at the SDK level) per the brief. Result type is now `{ refs: TaskWaitTaskState[], timedOut: boolean }` — minimal and honest.
  - Inlined any/all derivation in isDone() instead of keeping helper booleans on the result.
  - CLI computes elapsedMs locally with its own `Date.now()` bracket; SDK no longer needs startedAt.
  - JSON envelope is built explicitly (no SDK spread). The dual-shape `timedOut` (boolean→array) is gone.
NEXT:
  - None. Operator-facing JSON shape (.firing.qualifiedId / .all / .timedOut[] / .nextSteps) preserved exactly.
VERIFIED:
  - typecheck/lint/test/build all green (1257 tests).
  - cli-task-wait-cross-ws.test.ts exercises every JSON-shape branch (--first cross-ws, --any, mixed bare+qualified, --all success, partial timeout, bad refs).
ODDITIES:
  - skills/mu/SKILL.md and docs/USAGE_GUIDE.md already document only the canonical {firing, all, timedOut, nextSteps} shape — nothing to update there.
```

### #2 by "worker-cleanjson-1", 2026-05-11T09:15:27.772Z

```
CLOSE: all 4 green; envelope is now {firing, all, timedOut[], nextSteps}; commit 7f3d4a0
```
