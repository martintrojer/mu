---
id: "workstream_destroy_yes_leaves_workspace"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 1
roi: 50.00
owner: null
created_at: "2026-05-08T09:06:41.902Z"
updated_at: "2026-05-08T09:49:03.339Z"
blocked_by: []
blocks: []
---

# workstream destroy --yes leaves workspace dirs and git worktree registrations on disk

## Notes (1)

### #1 by system, 2026-05-08T09:06:59.871Z

```
REPRO:
1. mu workstream init foo
2. mu agent spawn worker-1 -w foo --workspace --command "..."
   -> creates ~/.local/state/mu/workspaces/foo/worker-1 + git worktree
3. (work happens, agent closes naturally or via mu agent close)
4. mu workstream destroy -w foo --yes
   -> "Destroyed foo: killed tmux=true, agents=0, tasks=N, edges=M, notes=K"
   -> NO mention of workspaces in the dry-run preview OR the success summary
5. ls ~/.local/state/mu/workspaces/foo/   -> worker-1/ STILL THERE
6. cd <main repo> && git worktree list  -> stale entries pointing at the
   no-longer-tracked paths

WHY THIS IS WORSE THAN agent_close_orphans_workspace_dir_from:
- That bug is "close one agent". This is "destroy the entire workstream"
  with explicit --yes confirmation. The user is signalling MAXIMUM intent
  to clean up.
- The destroy summary lists every other entity it cleaned up
  (tmux/agents/tasks/edges/notes) — workspaces are conspicuously missing,
  so the user has no way to notice the gap from output alone.
- The "Re-spawn" hint cannot work if the workstream is destroyed; there is
  no follow-up command to clean the orphans, which makes the orphan state
  effectively permanent unless the user knows about `git worktree remove`.

EXPECTED:
1. dry-run preview should include a workspaces line:
     workspaces : 3 (will be removed from disk + VCS registry)
2. --yes should run the per-backend clean removal:
     - git: `git worktree remove --force <path>` (then rmdir parent if empty)
     - jj: `jj workspace forget`
     - sl: equivalent
     - none: rm -rf
3. summary should report: workspaces=3
4. on partial failure (e.g. uncommitted changes blocking git worktree
   remove), surface the path(s) and the recovery hint, do NOT silently
   leave them.

WORKAROUND THAT WORKED FOR ME:
  cd <main repo>
  git worktree remove --force <state>/workspaces/<ws>/<agent>   # x N
  rmdir <state>/workspaces/<ws>

CONTEXT: hit immediately after closing modelbridge-parity (14 tasks,
3 historical workspaces). All 3 had to be cleaned by hand.

RELATED:
- agent_close_orphans_workspace_dir_from (single-agent variant)
- workspace_free_cleanup_leaves_git (downstream symptom)
```
