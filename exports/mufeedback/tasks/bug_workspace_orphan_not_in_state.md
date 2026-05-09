---
id: "bug_workspace_orphan_not_in_state"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-08T12:56:33.316Z"
updated_at: "2026-05-08T13:52:39.307Z"
blocked_by: []
blocks: []
---

# BUG: orphan workspace dirs are invisible in mu state but block spawn

## Notes (4)

### #1 by π - infer-rs, 2026-05-08T12:56:33.438Z

```
FILES: mu CLI/workspace state; infer-rs workstream.
COMMANDS: mu state -w infer-rs; mu agent spawn worker-4 -w infer-rs --workspace --workspace-project-root /Users/mtrojer/infer-rs/infer-rs.
FINDINGS: mu state reported Workspaces (0), but spawning worker-4 with --workspace failed because /Users/mtrojer/.local/state/mu/workspaces/infer-rs/worker-4 already exists on disk. In a multi-command shell chain this initially surfaced only as Command aborted, making it look like a silent spawn failure.
DECISION: Treat as UX bug/nit: mu state/workspace list should surface orphan workspace dirs that can block future spawns, or spawn should include enough context even when run in a chain.
NEXT: Consider reconciling workspace dirs from disk like agent orphan reconciliation, or add a mu workspace orphans command.
VERIFIED: Isolated spawn reproduced explicit conflict.
ODDITIES: Similar to earlier bug_workspace_orphaned_after_agent_close note; this adds the state invisibility/spawn-blocking angle.
```

### #2 by π - infer-rs, 2026-05-08T13:01:05.757Z

```
FILES: mu workspace reconciliation/state display; infer-rs workstream workspace root /Users/mtrojer/.local/state/mu/workspaces/infer-rs.
COMMANDS: mu state -w infer-rs; mu workspace list -w infer-rs --all; find /Users/mtrojer/.local/state/mu/workspaces/infer-rs -maxdepth 1 -mindepth 1 -type d -exec basename {} \;; mu agent spawn worker-4 -w infer-rs --cli pi-meta --command 'pi-meta --no-solo' --workspace --workspace-project-root /Users/mtrojer/infer-rs/infer-rs; mu agent spawn worker-7 ... with stdout/stderr capture.
FINDINGS: During infer-rs parallel-track setup, mu state displayed Workspaces (0), and mu workspace list -w infer-rs --all showed only roadmap-v0-2 workspace rows, but disk had orphan directories under infer-rs: worker-2, worker-4, worker-7, and later sil-1 after a partial failed spawn. These orphan dirs block future agent spawn --workspace calls with conflict errors even though the normal state dashboard says there are no workspaces. Example isolated error: conflict: workspace dir already on disk for agent worker-7 (/Users/mtrojer/.local/state/mu/workspaces/infer-rs/worker-7); refusing to overwrite. This repeatedly looked like an orchestrator hang/stuck state because the first dashboard did not reveal the real blocker.
DECISION: This is not just stale user state; it is a mu UX/reconciliation bug. Any workspace dir that can block spawn should be surfaced in mu state or mu workspace list --all, ideally as an orphan workspace analogous to orphan agent panes. The task should remain actionable even if older workspace-cleanup bugs exist because the visible symptom here is state-dashboard false confidence.
NEXT: Implement one of: (1) state/workspace list scans workspace root for dirs without DB rows and shows them as orphan; (2) add mu workspace orphans; (3) make agent spawn, on conflict, suggest exact workspace free/rm command and optionally provide --adopt/--overwrite-safe. Also consider adding a preflight warning when workspace root contains unknown dirs for this workstream.
VERIFIED: Reproduced with worker-4 and worker-7. After failure, find showed orphan dirs while mu state still showed Workspaces (0).
ODDITIES: The older task bug_workspace_orphaned_after_agent_close is related, but this report captures the separate dashboard invisibility and spawn-blocking behavior encountered while trying to run infer-rs parallel tracks.
```

### #3 by π - infer-rs, 2026-05-08T13:53:48.818Z

```
FILES: /Users/mtrojer/.local/state/mu/workspaces/infer-rs; git worktree registry /Users/mtrojer/infer-rs.
COMMANDS: mu state -w infer-rs before cleanup; du/stat inventory of sil-1, silgit-1, worker-2, worker-4, worker-7; git -C /Users/mtrojer/infer-rs worktree remove --force /Users/mtrojer/.local/state/mu/workspaces/infer-rs/silgit-1; git -C /Users/mtrojer/infer-rs worktree prune; rm -rf none-backend copy dirs; mu state -w infer-rs after cleanup.
FINDINGS: Current mu state did show a Workspace orphans section with all 5 dirs before cleanup, including cleanup hint. This differs from the earlier state output that showed only Workspaces (0). The orphan dirs were cleaned: silgit-1 via git worktree remove/prune; sil-1, worker-2, worker-4, worker-7 via rm -rf because they were none-backend partial copies with no DB rows and no git metadata. After cleanup, find shows no dirs and git worktree list only shows the main worktree.
DECISION: Orphans caused by this investigation are cleaned. Keep this bug report as historical unless we can explain why earlier mu state did not show the orphan section but later did; possible version/path/timing issue.
NEXT: If implementing/fixing, add regression coverage that mu state shows orphan dirs consistently and that cleanup hints distinguish git worktrees from none-backend copies.
VERIFIED: Final mu state shows Workspaces (0) and no Workspace orphans section; git worktree list no longer includes silgit-1.
ODDITIES: The user correctly noticed that I had created workspace orphans; cleanup has now removed them.
```

### #4 by π - infer-rs, 2026-05-08T13:56:11.645Z

```
FILES: mu workspace orphans command.
COMMANDS: mu workspace orphans --help; mu workspace orphans -w infer-rs; mu state -w infer-rs.
FINDINGS: New mu workspace orphans command is available. Help says it lists on-disk workspace dirs under <state-dir>/workspaces/<workstream>/ with no DB row and provides cleanup hints. Current infer-rs check returns (no orphan workspace dirs in infer-rs), matching the manual cleanup. mu state currently also has no orphan section.
DECISION: This addresses the main discoverability gap from this report. Leave any remaining nuance to separate bugs for spawn rollback/FK and missing _mu repair.
NEXT: If satisfied, this task can be closed as fixed; keep bug_agent_spawn_workspace_fk_failure and bug_agent_spawn_workspace_aborts_without_status open for rollback/root-guardrail issues.
VERIFIED: Command exists and reports clean infer-rs state.
ODDITIES: Nice: state now points users at mu workspace orphans -w infer-rs when orphans are present.
```
