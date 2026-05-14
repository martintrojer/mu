---
id: "agent_close_orphans_workspace_dir_from"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 1
roi: 50.00
owner: null
created_at: "2026-05-08T08:22:17.622Z"
updated_at: "2026-05-08T09:04:27.324Z"
blocked_by: []
blocks: []
---

# agent close orphans workspace dir from registry; workspace free cant find it

## Notes (2)

### #1 by null, 2026-05-08T08:22:17.743Z

```
REPRO:
1. mu agent spawn worker-1 -w foo --workspace
   -> dir: ~/.local/state/mu/workspaces/foo/worker-1, vcs_workspaces row exists
2. mu workspace list -w foo  -> shows worker-1
3. mu agent close worker-1 -w foo
4. mu workspace list -w foo  -> EMPTY (registry row dropped)
5. ls ~/.local/state/mu/workspaces/foo/   -> worker-1/ STILL THERE
6. mu workspace free worker-1 -w foo  -> "no workspace for worker-1 (already gone?)"
7. The dir is now an orphan; the only way to clean it is rm -rf manually.

WHY THIS HURTS:
- Combined with the spawn-fails-on-existing-dir bug, the only way to
  recover and respawn is plain rm -rf, which defeats the safety
  promise of "we kept your workspace so you don't lose artifacts".
- mu workspace free should either:
  (a) NOT drop the vcs_workspaces row when the agent row is dropped, or
  (b) accept a path/agent-name fallback and walk the disk too.

EXPECTED:
- "mu workspace free <agent>" works after "mu agent close <agent>" by
  finding the orphan dir on disk under
  <state>/workspaces/<workstream>/<agent>/.
- OR: agent close keeps the vcs_workspaces row and only flips an
  "agent_alive" flag.

CONTEXT: hit immediately after the spawn-fails bug above, while
recovering from the pi -> pi-meta switch.
```

### #2 by null, 2026-05-08T09:04:27.221Z

```
DUPLICATE of bug_workspace_orphaned_after_agent_close (filed in same workstream by this orchestrator earlier today and shipped as commit cccba88).

The fix shipped: option (d) from the bug-design note. mu agent close now REFUSES if the agent has a workspace, throwing WorkspacePreservedError (exit 4) with three actionable resolutions:
  - mu workspace free <agent>  (preserve work)
  - mu agent close <agent> --discard-workspace  (lossy one-shot)
  - cd <workspace path>  (inspect first)

CAVEATS THE FIX DOESN'T COVER (filed separately as still-open follow-ups):
  - agent_spawn_workspace_fails_when_prior (claimed; addressing now)
    The 'just respawn the worker on the same name' recovery path
    still trips over the existing-dir check in createWorkspace.
  - workspace_free_cleanup_leaves_git (claimed; addressing now)
    git worktree registration survives a manual rm -rf; respawn
    fails with 'missing but already registered worktree'.

If you were already in the orphan state when cccba88 landed, you'll
need to manually rm -rf the orphaned dir AND run 'cd <main-repo> && git worktree prune' (for git workspaces). The fixes for those two
follow-ups are landing in the same session.
```
