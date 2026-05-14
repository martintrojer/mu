---
id: "nit_invalid_id_typeerror"
workstream: "mufeedback"
status: CLOSED
impact: 10
effort_days: 0.2
roi: 50.00
owner: null
created_at: "2026-05-08T10:21:54.367Z"
updated_at: "2026-05-09T07:00:02.714Z"
blocked_by: []
blocks: []
---

# NIT: invalid task id throws TypeError instead of typed TaskIdInvalidError

## Notes (2)

### #1 by "π - mu", 2026-05-08T10:21:55.565Z

```
SURFACED while doing roadmap-v0-2 design pass.

REPRO:
  $ mu task add tmpA -w roadmap-v0-2 --title "..." --impact 1 --effort-days 0.1 --json
  {"error":"TypeError","message":"invalid task id: \"tmpA\" (expected /^[a-z][a-z0-9_-]{0,63}$/)","nextSteps":[],"exitCode":1}

EXPECTED:
  Typed TaskIdInvalidError with errorNextSteps() suggesting a sanitised id (lowercase + s/[^a-z0-9_-]/_/g) and pointing at the slugify helper.

ROOT CAUSE: src/tasks.ts addTask uses `throw new TypeError(...)` instead of a typed error class. The CLI's handle() wrapper catches Error but doesn't have a specific case → falls through to generic exit 1.

FIX:
1. Add TaskIdInvalidError extends Error implements HasNextSteps in src/tasks.ts (next to TaskExistsError / TaskNotFoundError).
2. errorNextSteps() returns:
   - "Use the auto-derived id (drop --id and pass --title)" → mu task add --title "..."
   - "Sanitise to a valid id" → mu task add <sanitised> --title "..." --impact ... --effort-days ...
3. Replace TypeError throw in addTask + isValidTaskId callers with the typed throw.
4. Add to handle() exit-code map (exit 4: validation error).
5. Test in test/tasks.test.ts.

~30 LOC; substrate is in place (the TaskExistsError / errorNextSteps pattern).
```

### #2 by "worker-mf-2", 2026-05-09T06:59:58.974Z

```
DONE on worker-mf-2 (commit ba70014).

WHAT CHANGED:
- src/tasks/errors.ts: new TaskIdInvalidError(attempted, reason: 'reserved-prefix'|'syntax') extends Error implements HasNextSteps. errorNextSteps() returns:
    1. 'Use the auto-derived id (drop --id and pass --title)' → mu task add --title "..." --impact <n> --effort-days <n>
    2. 'Sanitise to a valid id' → mu task add <sanitised> --title "..." ...
  Plus a tiny sanitiseTaskId() helper colocated with the error class (lowercase + s/[^a-z0-9_-]/_/g + trim leading non-letter + rewrite leading 'mu_' to 't_mu_' so the suggested command always passes isValidTaskId).
- src/tasks.ts: replaced both 'throw new TypeError' sites in addTask with TaskIdInvalidError (reasons distinguished).
- src/cli.ts: added TaskIdInvalidError to classifyError()'s conflict/exit-4 bucket alongside TaskNotInWorkstreamError / TaskExistsError / etc.
- test/tasks.test.ts: two new tests under addTask — one for syntax (asserts not-a-TypeError + sanitised candidate appears in step #2) and one for reserved 'mu_' prefix (asserts step #2's command starts with 't_mu_' not 'mu_').
- test/error-nextsteps.test.ts: two new rows in the table-driven coverage (syntax + reserved variants) with token assertions.
- test/cli-task-add-invalid-id.test.ts: new CLI smoke test that runs 'mu --json task add "Bad ID" ...' through the in-process buildProgram() runner (with process.argv shimmed since isJsonMode() reads process.argv directly), asserts exit=4, parses the JSON envelope from stderr, and pins error='TaskIdInvalidError', exitCode=4, nextSteps[0].command matches /--title/, and the sanitised step's command matches /mu task add bad_id /. Also asserts no row reaches the DB.
- CHANGELOG.md: entry under [Unreleased] / Fixed.

GATE: typecheck + lint + test (746/746) + build all green.

LOC: ~75 changed (slightly above the 30 estimate; mostly tests + the colocated sanitiser helper + CHANGELOG).
```
