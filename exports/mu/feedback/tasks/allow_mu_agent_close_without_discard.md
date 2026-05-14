---
id: "allow_mu_agent_close_without_discard"
workstream: "feedback"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: null
created_at: "2026-05-11T08:18:34.971Z"
updated_at: "2026-05-11T08:42:00.658Z"
blocked_by: []
blocks: []
---

# Allow mu agent close without --discard-workspace when workspace is empty

## Notes (3)

### #1 by "π - gchatui", 2026-05-11T08:19:14.339Z

```
SEEN: 2026-05-11 in workstream gchatui.

After a misconfigured spawn (wrong --cli), I had to clean up two
agents whose workspaces were freshly created and contained nothing
beyond `.git`. `mu agent close worker-1` refused because of pending
workspace state, suggesting:
  - mu workspace free worker-1
  - or mu agent close worker-1 --discard-workspace

Both of those workspaces had zero tracked or untracked files (just
the .git pointer file from the worktree). `mu agent close` could
detect "workspace is clean and has no commits since fork" and just
do the right thing without requiring --discard-workspace.

DESIRED:
  - `mu agent close <name>` with a clean workspace = silently free it
    and close the agent.
  - `--discard-workspace` remains the explicit-loss flag for
    workspaces with uncommitted changes or unmerged commits.

PRIORITY: low. Cosmetic friction; current behaviour is safe (it
errs toward not losing work).
```

### #2 by "worker-closeclean-1", 2026-05-11T08:41:48.968Z

```
Implemented. closeAgent now calls isWorkspaceClean(row); if true (no uncommitted changes per backend.isClean() AND zero commits since fork per backend.commitsSinceBase()), auto-frees and proceeds. New VcsBackend.isClean() implemented for git (git status --porcelain), jj (jj diff -r @ --summary), sl (sl status), none (true). --discard-workspace stays as the lossy override. CloseAgentResult gains workspaceAutoFreedClean: boolean for accurate CLI rendering / JSON. Tests: clean none auto-frees, clean git auto-frees, dirty git refuses, commits-since-fork refuses, --discard overrides both. typecheck + lint + 1194 tests + build all green.
```

### #3 by "worker-closeclean-1", 2026-05-11T08:42:00.658Z

```
CLOSE: all 4 green; clean-workspace close no longer requires --discard-workspace; commit 40d08af
```
