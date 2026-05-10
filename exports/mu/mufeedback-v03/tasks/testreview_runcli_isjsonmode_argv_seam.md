---
id: "testreview_runcli_isjsonmode_argv_seam"
workstream: "mufeedback-v03"
status: CLOSED
impact: 40
effort_days: 0.3
roi: 133.33
owner: null
created_at: "2026-05-10T11:35:46.491Z"
updated_at: "2026-05-10T12:21:03.100Z"
blocked_by: []
blocks: []
---

# test-review: runCli cannot trigger --json error envelopes (isJsonMode reads real process.argv); workaround duplicated

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:36:05.077Z

```
FILES:
  src/output.ts:193 isJsonMode() — reads process.argv directly
  test/_runCli.ts:65-95 — never sets process.argv
  test/cli-snapshot.test.ts:97-104 — comment explicitly says "the runCli harness can't trigger --json error mode"
  test/cli-task-add-invalid-id.test.ts:35-58 — manual shim: `process.argv = ["node", "mu", ...argv]; try { ... } finally { process.argv = original }`

FINDING: runCli wires MU_DB_PATH and shims stdout/stderr/console/process.exit, but it does NOT shim process.argv. isJsonMode() reads process.argv directly (intentionally — commander has consumed its own argv by handler-time). Result: every test that wants to assert the JSON ERROR envelope shape (vs the table-form error message) must duplicate the manual argv shim from cli-task-add-invalid-id.test.ts:35-58. Today exactly one test does that; one other test (cli-snapshot.test.ts:97) explicitly comments that "we just can't test this here" and falls back to the table-form assertion, leaving the JSON-error envelope shape untested.

WHY: --json error envelopes are part of the public CLI contract per CHANGELOG and the OUTPUT_LABELS_AUDIT. A regression in emitError's JSON shape (missing nextSteps key, wrong exit code field, mis-rendered error name) would only break in production. The per-test argv-shim workaround is also a footgun — if the test throws between argv= and finally, the next test in the same worker sees the leaked argv (vitest runs files in workers but tests within a file share the worker's globals).

FIX-SKETCH: Have runCli shim process.argv inside the same try/finally block that already shims stdout/stderr/exit:

  // existing prelude...
  const originalArgv = process.argv;
  process.argv = ["node", "mu", ...argv];
  try {
    // existing parse...
  } finally {
    process.argv = originalArgv;
    // existing restoration...
  }

This is ~3 LOC and removes the workaround at test/cli-task-add-invalid-id.test.ts:35-58 (-20 LOC) AND lets test/cli-snapshot.test.ts add the missing JSON-error-envelope assertion without per-test ceremony. Net deletion across the suite + new behaviour coverage.

(Also: the call site in test/cli-task-add-invalid-id.test.ts shows process.argv = ["node", "mu", "--json", ...] — note "--json" must be in argv even though it's also in the argv passed to runCli; today the test author has to know that. Centralising the shim hides the foot-gun.)
```
