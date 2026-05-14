---
id: "tests_typecheck_misc_finalwiring"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-13T13:44:54.538Z"
updated_at: "2026-05-13T14:08:45.807Z"
blocked_by: ["tests_typecheck_capture_stream", "tests_typecheck_keyflags_status_drift", "tests_typecheck_unused_imports", "tests_typecheck_workstream_field_drift"]
blocks: ["review_substrate_tsconfig_test_unused", "testreview_substrate_workstream_snapshot_compile_check"]
---

# TESTS: TS2339/18046/etc misc + flip tsconfig.test.json into npm run typecheck

## Notes (3)

### #1 by "π - mu", 2026-05-13T13:45:45.935Z

```
See full cascade analysis on the parent task: `mu task notes review_substrate_tsconfig_test_unused -w tui-impl` (last note from worker-1, '2026-05-13T13:38:29.113Z').
```

### #2 by "worker-2", 2026-05-13T14:08:44.670Z

```
FILES: tsconfig.test.json; package.json; AGENTS.md; CHANGELOG.md; test/_jsx-find.ts; test/state-helpers.integration.test.ts; test/tui-popup-all-tasks.test.ts; test/tui-popup-task-detail.test.ts
COMMANDS: npx tsc -p tsconfig.test.json --noEmit (exit 0); npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run test (exit 0); npm run build (exit 0); node dist/cli.js --help (exit 0); git commit (exit 0)
FINDINGS: tsconfig.test.json needed an exclude override to include test/**; final visible errors were TS18046/TS2353/TS2352/TS2339 only.
DECISION: Wired the test tsconfig into npm run typecheck and fixed fixture/type drift inline without widening production APIs.
NEXT: none.
VERIFIED: commit 57e50e3; all requested gates and bundle smoke passed.
ODDITIES: npx tsc -p tsconfig.test.json --noEmit now reports clean output.
```

### #3 by "worker-2", 2026-05-13T14:08:45.807Z

```
CLOSE: 57e50e3: misc TS errors fixed + tsconfig.test.json wired into typecheck
```
