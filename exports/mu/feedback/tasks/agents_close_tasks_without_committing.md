---
id: "agents_close_tasks_without_committing"
workstream: "feedback"
status: CLOSED
impact: 30
effort_days: 1
roi: 30.00
owner: null
created_at: "2026-05-12T06:09:22.967Z"
updated_at: "2026-05-12T11:14:23.679Z"
blocked_by: []
blocks: []
---

# agents close tasks without committing when prompt lacks explicit FINAL ACTION block

## Notes (2)

### #1 by "π - modelbridge", 2026-05-12T06:09:23.551Z

```
OBSERVATION:
The mu skill explicitly tells orchestrators to end every dispatch
prompt with a loud "⚠️ FINAL ACTION: git commit -am '...' THEN
mu task close <id> --evidence '...'" block, because without it
agents commit + report success in chat without running the typed
close, and mu task wait hangs.

Today I observed the inverse failure mode: workers happily ran
mu task close (the close did happen) but did NOT run git commit
first. The workspace was left dirty; the orchestrator had to apply
the diff by hand.

This is more subtle than "wait hangs" because:
- mu task wait fires fine (the close happened)
- the worker's workspace shows IN_PROGRESS_GENUINELY_DONE state but
  HEAD has no new commits
- mu workspace commits returns {items:[], count:0}
- the recipe in the wait nextSteps ("git cherry-pick $(cd
  $(mu workspace path X) && git log -1 --format=%H)") silently
  cherry-picks the WRONG commit (the parent base sha, since worker
  never committed)

PROPOSED:
1. mu task close should optionally check the workspace for dirty
   state and either:
   (a) refuse to close with "uncommitted changes; commit first or
       pass --discard-workspace-dirty", OR
   (b) auto-commit pending changes with subject derived from task
       title + id (this is what jj operators expect anyway)
2. Stronger nudge in the agent's perceived skill content: when the
   agent runs mu task close, post-emit a Next: hint of the form
   "Commit your workspace edits before the next wave: cd
   $(mu workspace path) && git status".
3. Make mu task wait nextSteps cherry-pick recipe robust to
   "items: []" by surfacing a clear error when no commits exist
   between fork and HEAD, instead of letting "$(... | jq ... null)"
   silently produce a bad sha.

CONTEXT: hit during modelbridge-parity-2 wave 1, worker-1 closed
anthropic_mid_stream_classifier_retry without committing. Diff was
intact in the workspace and the orchestrator could rescue via git
diff > /tmp/foo.patch && git apply /tmp/foo.patch && git commit,
but the wait recipe's natural cherry-pick path failed first.

WORKAROUND I USED:
1. mu workspace commits worker-1 -w ws --json -> empty
2. cd <workspace> && git diff > /tmp/w.patch
3. cd <main> && git apply /tmp/w.patch && git commit -am '...'
```

### #2 by "π - mu", 2026-05-12T11:14:23.679Z

```
CLOSE: triaged into 3 follow-ups: fb_close_require_clean (DEFERRED, opt-in flag), fb_close_post_emit_commit_hint (OPEN, ship next), fb_wait_nextsteps_robust_no_commits (OPEN, real silent-data-loss bug — ship next). Each has line-precise spec notes.
```
