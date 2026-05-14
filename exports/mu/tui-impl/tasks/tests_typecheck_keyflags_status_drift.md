---
id: "tests_typecheck_keyflags_status_drift"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: "worker-2"
created_at: "2026-05-13T13:44:53.886Z"
updated_at: "2026-05-13T13:59:29.214Z"
blocked_by: []
blocks: ["review_substrate_tsconfig_test_unused", "tests_typecheck_misc_finalwiring"]
---

# TESTS: TS2559/2322 cascade — AgentStatus/KeyFlags/fixture drift

## Notes (3)

### #1 by "π - mu", 2026-05-13T13:45:45.602Z

```
See full cascade analysis on the parent task: `mu task notes review_substrate_tsconfig_test_unused -w tui-impl` (last note from worker-1, '2026-05-13T13:38:29.113Z').
```

### #2 by "worker-2", 2026-05-13T13:59:25.227Z

```
FILES: test/state-helpers.integration.test.ts; test/tui-state-hook-rerender.test.ts; test/tui-keys.test.ts; test/tui-use-popup-filter.test.ts; test/tui-card-doctor.test.ts; test/tui-card-commits.test.ts; test/workspace-sdk.integration.test.ts
COMMANDS: temporary tsconfig.test.json exclude probe + npx tsc -p tsconfig.test.json --noEmit | rg 'TS2559|TS2322|TS2741' (exit 0 from rg/no matches after fixes); npm run typecheck (0); npm run lint (0); npm run test:fast (0); npm run build (0)
FINDINGS: AgentStatus fixtures still used stale alive/running values; KeyFlags tests used narrow f1/backspace object casts; WorkstreamSnapshot fixtures missed recentCommits/commitsBackend; one fake VcsBackend fixture lacked newer required methods.
DECISION: align tests with current public shapes without src changes or any casts to any; reverted tsconfig.test.json probe change before commit.
NEXT: remaining tsconfig.test cascade categories stay for sibling tasks.
VERIFIED: b2a465d clears TS2559/TS2322/TS2741 filter output and passes typecheck/lint/test:fast/build.
```

### #3 by "worker-2", 2026-05-13T13:59:29.214Z

```
CLOSE: b2a465d: TS2559/TS2322/TS2741 cleared (AgentStatus + KeyFlags fixtures aligned)
```
