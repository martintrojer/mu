---
id: "workspace_free_cleanup_leaves_git"
workstream: "mufeedback"
status: CLOSED
impact: 40
effort_days: 1
roi: 40.00
owner: null
created_at: "2026-05-08T08:22:44.613Z"
updated_at: "2026-05-08T09:16:38.800Z"
blocked_by: []
blocks: []
---

# workspace free / cleanup leaves git worktree registration behind

## Notes (1)

### #1 by null, 2026-05-08T08:22:44.741Z

```
REPRO:
1. mu agent spawn worker-1 -w foo --workspace
   -> creates a git worktree at <state>/workspaces/foo/worker-1
2. mu agent close worker-1 -w foo
3. mu workspace free worker-1 -w foo  -> "no workspace for worker-1"
4. (no other CLI option, so manually) rm -rf <state>/workspaces/foo/worker-1
5. mu agent spawn worker-1 -w foo --workspace
   -> fatal: ".../foo/worker-1" is a missing but already registered worktree;
      use 'add -f' to override, or 'prune' or 'remove' to clear
6. Workaround: cd <main-repo> && git worktree prune

WHY THIS HURTS:
- Three sequential mu bugs combine into "blow away the git worktree
  registration manually". A user would never reach for `git worktree
  prune` from a "mu agent spawn failed" error.

EXPECTED:
- mu workspace free should ALWAYS run the backend's clean-removal
  command (`git worktree remove --force`, `jj workspace forget`,
  `sl rm -f`) even when the directory has been deleted out from under
  it, so the parent repo's worktree registry stays consistent.
- mu agent spawn --workspace should detect a stale worktree
  registration for the same path and offer to prune (or auto-prune
  with a log line) instead of just bubbling up the git error.

PROPOSED:
- In the workspace backend create() path, on git: detect "missing but
  already registered worktree" stderr and run `git worktree prune` once
  before retrying the add.

CONTEXT: hit during modelbridge-parity recovery. Combined with the
two prior task notes in this workstream, the recovery path was
4 commands of trial-and-error.
```
