---
id: "fb_wait_nextsteps_robust_no_commits"
workstream: "feedback"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-12T11:13:27.730Z"
updated_at: "2026-05-12T15:09:29.094Z"
blocked_by: []
blocks: []
---

# BUG: mu task wait --first nextSteps cherry-pick recipe silently picks wrong sha when worker closed without committing — surface 'no commits between fork and HEAD' explicitly

## Notes (3)

### #1 by "π - mu", 2026-05-12T11:13:59.948Z

```
TRIAGED FROM agents_close_tasks_without_committing (proposal 3).

SHIP. Real bug. mu task wait --first --json's nextSteps[0].command is:

  git cherry-pick $(cd $(mu workspace path X) && git log -1 --format=%H)

When worker closed without committing, `git log -1 --format=%H` returns the parent BASE sha (= origin/main or wherever the workspace forked). git cherry-pick of base = noop or fails ('empty commit set'). Either way, the orchestrator's automation appears to succeed but pulls in nothing.

Fix:
  - cli/tasks/wait.ts: change the cherry-pick nextStep to FIRST check mu workspace commits --json. If items.length === 0, the nextStep becomes:
      Worker closed without committing — apply by hand:
        cd $(mu workspace path X -w ws) && git status
        # or: rescue diff via 'git diff' + 'git apply'
  - If items.length >= 1, keep the existing recipe but pin the SPECIFIC sha:
      git cherry-pick $(mu workspace commits X -w ws --json | jq -r '.items[0].sha')
    instead of the brittle git-log-1 form.

Test:
  - Integration test with two workers: one commits, one doesn't. After both close, assert wait's nextSteps emit different recipes per worker.

Promotion criterion: this is a real silent-data-loss bug for the orchestrator-automation flow. Should land before any next major release.

Effort: ~50 LOC + 1 integration test.
```

### #2 by "worker-3", 2026-05-12T14:56:17.122Z

```
DONE: d3806a4 mu task wait nextSteps now pin since-fork worker shas and surface no-commit rescue hints
```

### #3 by "π - mu", 2026-05-12T15:09:29.094Z

```
CLOSE: c3e5c34 (worker-3 d3806a4): mu task wait inlines the actual cherry-pick sha range (or 'closed without committing' rescue hint when no commits); 3 integration tests cover single/no/multi commit cases. Verified live: nextSteps now emit 'git cherry-pick <first>^..<last>' with real shas (was the brittle 'git log -1' substitution that returned base sha when worker didn't commit, causing silent data loss)
```
