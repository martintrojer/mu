---
id: "review_test_runcli_silently_swallows_throws"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-08T11:24:58.402Z"
updated_at: "2026-05-08T11:49:35.134Z"
blocked_by: []
blocks: []
---

# REVIEW: runCli helper swallows commander parse errors silently (false negatives)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:25:17.417Z

```
FILES: test/_runCli.ts:79-99 (try/catch swallow) ; every test file using runCli (test/hud.test.ts, test/cli-json-universal.test.ts -- not directly, test/cli-task-add-blocked-by.test.ts, test/sql-multi-statement.test.ts, test/json-output.test.ts).
WHAT THE HELPER CLAIMS (file header doc): captures stdout/stderr/exitCode for any verb invocation, normal-or-error paths.
WHAT IT ACTUALLY DOES: try { parseAsync(...) } catch { /* swallow */ } finally { restore }. The catch block has no body comment-only, so any thrown error from buildProgram() — TypeError on a misconfigured commander option, a real bug in cmdHud throwing a non-typed Error, an exception from openDb when the path is malformed — is silently swallowed AND `exitCode` stays at `null` because process.exit was never called. The test then sees stdout/stderr empty and exitCode null, which several tests treat as "completed normally".
GAP: A test that does `const { stdout } = await runCli([...]); expect(stdout).toContain("foo")` will fail loudly if the verb never produces output (good). But a test that does `const { exitCode } = await runCli([...]); expect(exitCode).toBeNull()` (used in test/hud.test.ts:48,63,80,98,114,130,134,146,159) will incorrectly pass when the verb THROWS a non-typed error during execution. The runCli helper provides no signal distinguishing 'completed normally' from 'threw a non-process.exit error'. Per skill: 'a test must fail when behavior is wrong'.
WHY IT MATTERS: Every hud test asserts `exitCode === null` to mean success. If a future refactor of cmdHud throws a TypeError during table rendering (e.g. accessing an undefined orphan), 8 hud tests would silently turn into 'no-op completed normally' green tests — they'd assert on `stdout` patterns and fail there, but the framing 'mu hud succeeded' would already be a lie. More dangerous: the assertion `exitCode === null || exitCode !== 0` in test/cli-task-add-blocked-by.test.ts:128 IS satisfied by exitCode === null (i.e. silent throw).
SUGGESTED FIX: In _runCli.ts, capture the thrown error (not from process.exit) into a `caughtError` field on the Capture interface. Make runCli's contract: { stdout, stderr, exitCode, error } where error !== undefined indicates an unhandled non-typed throw. Update tests that check `exitCode === null` to also assert `error === undefined`. Or: re-throw if the error is not a CommanderError and not the `__exit__:N` sentinel.
```
