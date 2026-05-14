---
id: "review_repo_process_exit_inside_handlers"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-2"
created_at: "2026-05-12T11:14:37.203Z"
updated_at: "2026-05-12T13:14:09.334Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW med: command handlers call process.exit inside handle wrapper

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:37.483Z

```
FILES: src/cli/state.ts:237; src/cli/tasks/claim.ts:476 and 504; src/cli/handle.ts:375-389.
FINDING: Leaf handlers call `process.exit(2/5)` from inside functions already wrapped by `handle()`. That bypasses the normal typed-error/return path and risks skipping `handle()`'s `finally` cleanup (`db.close()`), while making these functions harder to unit-test as plain command handlers.
RECOMMENDED FIX: Route non-zero handler outcomes through a typed error or a small `CliExitError`/return-code mechanism owned by `handle()`. For `cmdState` no-workstream error, throw `UsageError` with the prepared message (or teach `handle` to render it). For `cmdTaskWait` timeout, throw/return a timeout result that `handle` maps to exit 5 after closing the DB.
```

### #2 by "worker-2", 2026-05-12T13:14:09.334Z

```
CLOSE: 9ff9ba9: centralized leaf handler exits via UsageError/CliExitError; four greens passed
```
