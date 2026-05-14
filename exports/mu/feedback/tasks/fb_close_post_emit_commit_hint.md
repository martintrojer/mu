---
id: "fb_close_post_emit_commit_hint"
workstream: "feedback"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: null
created_at: "2026-05-12T11:13:27.149Z"
updated_at: "2026-05-12T14:46:07.377Z"
blocked_by: []
blocks: []
---

# NIT: post-emit Next: hint after mu task close — 'commit your workspace edits before the next wave: cd $(mu workspace path) && git status'

## Notes (3)

### #1 by "π - mu", 2026-05-12T11:13:59.563Z

```
TRIAGED FROM agents_close_tasks_without_committing (proposal 2).

SHIP. One-line addition to the printNextSteps() output of mu task close. After:
  Reopen if needed         : mu task open <id> -w <ws>
  Pick the next ready task : mu task next -w <ws>
  See full state           : mu state -w <ws>

Add (when actor has a workspace AND it's dirty):
  Don't forget to commit   : cd $(mu workspace path <actor> -w <ws>) && git commit -am '<task-title>'

Implementation sketch:
  - cli/tasks/lifecycle.ts cmdClose: after the close, query workspaces.dirty(actor) and conditionally append a NextStep.
  - Test: extend test/cli-tasks-close.test.ts (or wherever) with a dirty-workspace case; assert the new step appears in stdout and stderr-json.

Tiny + high-leverage. The wait nextSteps pair (fb_wait_nextsteps_robust_no_commits) is the upstream safety net; this is the close-time reminder. Both should ship before v0.5.

Effort: ~30 LOC + 1 test.
```

### #2 by "worker-3", 2026-05-12T14:29:03.075Z

```
DONE: c0d95ee cli close adds dirty-workspace commit reminder after task close
```

### #3 by "π - mu", 2026-05-12T14:46:07.377Z

```
CLOSE: 3576d17 (worker-3 c0d95ee): mu task close appends 'Don't forget to commit' NextStep when actor's workspace is dirty; tests cover dirty/clean/no-workspace/json paths
```
