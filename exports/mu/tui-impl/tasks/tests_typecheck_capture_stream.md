---
id: "tests_typecheck_capture_stream"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.2
roi: 200.00
owner: "worker-2"
created_at: "2026-05-13T13:44:52.677Z"
updated_at: "2026-05-13T13:52:33.825Z"
blocked_by: []
blocks: ["review_substrate_tsconfig_test_unused", "tests_typecheck_misc_finalwiring"]
---

# TESTS: TS2740 cascade — CaptureStream missing WriteStream members in test/_ink-render.ts

## Notes (3)

### #1 by "π - mu", 2026-05-13T13:45:44.961Z

```
See full cascade analysis on the parent task: `mu task notes review_substrate_tsconfig_test_unused -w tui-impl` (last note from worker-1, '2026-05-13T13:38:29.113Z').
```

### #2 by "worker-2", 2026-05-13T13:52:33.537Z

```
FILES: test/_ink-render.ts; test/tui-popup-tasks.test.ts; test/tui-use-notes-drill.test.ts; test/tui-row-budget-overflow.integration.test.ts; test/tui-drill-refresh.integration.test.ts; test/tui-titled-box-render.test.ts
COMMANDS: npm install (exit 0; installed missing deps/build); npx tsc -p tsconfig.test.json --noEmit 2>&1 | rg 'TS2740|TS4114' | head -20 with temporary tsconfig.test.json exclude override before fix (found TS2740/TS4114) and after fix (exit 0/no output); npx biome check changed files (exit 0); npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run build (exit 0); git commit (7c6077f)
FINDINGS: CaptureStream only needs Writable output capture plus columns/rows for these Ink render tests; Ink's render() typing wants NodeJS.WriteStream, causing TS2740 at call sites and TS4114 on _write overrides.
DECISION: Added createInkCaptureStream() in the shared harness and cast once through unknown to CaptureStream & NodeJS.WriteStream at the Ink boundary, instead of implementing 60+ tty WriteStream members. Added override on shared _write and removed the duplicate titled-box local CaptureStream by moving it onto the shared harness. Reverted tsconfig.test.json after probe.
VERIFIED: TS2740/TS4114 probe clean; typecheck/lint/test:fast/build green.
NEXT: Remaining test tsconfig cascade categories are for sibling tasks.
```

### #3 by "worker-2", 2026-05-13T13:52:33.825Z

```
CLOSE: 7c6077f: CaptureStream→WriteStream boundary clean; TS2740/TS4114 errors gone
```
