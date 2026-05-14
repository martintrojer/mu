---
id: "testreview_runcli_global_shims_race"
workstream: "tui-impl"
status: DEFERRED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-12T11:17:53.300Z"
updated_at: "2026-05-12T12:30:47.583Z"
blocked_by: []
blocks: []
---

# TEST REVIEW: runCli mutates process globals and is unsafe under concurrent tests

## Notes (1)

### #1 by "worker-3", 2026-05-12T11:18:01.004Z

```
FILES: test/_runCli.ts:59-181; representative consumers across test/json-output.test.ts, test/archive-cli.test.ts, test/cli-*.test.ts, test/state-render.test.ts. Particularly relevant globals: process.env.MU_DB_PATH at 60/78/172-176, process.argv at 70/79/167, console/stdout/stderr shims at 61-103/163-166, process.exit shim at 104-123.
FINDING: runCli is a heavily used in-process CLI harness that mutates process-wide globals. The current suite avoids explicit test.concurrent usage, but future intra-file concurrency or a helper that calls runCli from two async branches would cross-wire stdout/stderr, argv, exitCode, and MU_DB_PATH between invocations. That creates false confidence because failures can be captured by the wrong call or DB operations can hit the wrong temp DB. The helper has its own contract tests, but they only cover sequential calls.
RECOMMENDED FIX: Either serialize runCli with a module-level async mutex and document it as non-reentrant, or switch CLI tests that need isolation to subprocess execution with env/stdout captured per process. Add a regression test that starts two runCli calls through an intentional synchronization point and proves they cannot overlap (mutex) or are isolated (subprocess). Also expose a narrower commander test seam for pure parse/usage checks that does not monkey-patch process globals.
VERIFIED: audit only; no code changed.
```
