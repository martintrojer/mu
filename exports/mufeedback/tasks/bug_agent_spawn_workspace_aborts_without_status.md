---
id: "bug_agent_spawn_workspace_aborts_without_status"
workstream: "mufeedback"
status: CLOSED
impact: 45
effort_days: 0.3
roi: 150.00
owner: null
created_at: "2026-05-08T12:58:40.860Z"
updated_at: "2026-05-08T13:38:37.481Z"
blocked_by: []
blocks: []
---

# BUG: agent spawn --workspace can abort shell before status capture

## Notes (4)

### #1 by π - infer-rs, 2026-05-08T12:58:40.968Z

```
FILES: mu agent spawn/workspace path; infer-rs workstream.
COMMANDS: find workspace dirs showed only worker-2 worker-4 worker-7; then ran a shell loop spawning sil-1 with --workspace and stdout/stderr redirected to /tmp/mu-spawn-sil-1.{out,err}.
FINDINGS: mu agent spawn sil-1 --workspace produced only Command aborted in the harness and appears to abort before the shell could print exit/status or continue the loop. This is distinct from the earlier explicit workspace-dir conflict for worker-7, where isolated capture produced exit=4 plus stderr. Need inspect /tmp captures and tmux/db state to see if a partial workspace/pane was created.
DECISION: Stop spawning workspace edit agents in infer-rs until this is understood/cleaned; use existing reviewer only or direct orchestration.
NEXT: Make agent spawn failure modes always return a normal exit code and diagnostic without killing/aborting the parent command; add tests for stale dir and fresh role-name workspace spawn.
VERIFIED: Reproduced after avoiding known stale dirs and logged task. Existing related bug_workspace_orphan_not_in_state covers stale dirs invisible in state; this covers abort-before-status behavior.
ODDITIES: The aborted shell did not print the loop exit line even though the command was redirected and the script had no set -e.
```

### #2 by π - infer-rs, 2026-05-08T13:01:05.888Z

```
FILES: mu agent spawn --workspace path; infer-rs workstream; /tmp/mu-spawn-sil-1.out and /tmp/mu-spawn-sil-1.err; tmux/db state.
COMMANDS: find /Users/mtrojer/.local/state/mu/workspaces/infer-rs -maxdepth 1 -mindepth 1 -type d -exec basename {} \; showed only worker-2 worker-4 worker-7 before trying sil-1. Then ran a shell loop with mu agent spawn sil-1 -w infer-rs --cli pi-meta --command 'pi-meta --no-solo' --workspace --workspace-project-root /Users/mtrojer/infer-rs/infer-rs > /tmp/mu-spawn-sil-1.out 2> /tmp/mu-spawn-sil-1.err; intended to print exit code and continue. Follow-up checked tmp files, tmux list-panes, mu sql agents, find workspace dirs, and mu state.
FINDINGS: The sil-1 spawn produced only Command aborted in the coding harness. Both redirected files were empty. The shell loop did not print the planned exit=... line, despite no explicit set -e in that command. No tmux pane or agents DB row for sil-1 existed afterwards. However, a new workspace dir /Users/mtrojer/.local/state/mu/workspaces/infer-rs/sil-1 was created, making the failure partially stateful and creating another orphan. This differs from the worker-7 stale-dir case, where isolated capture cleanly returned exit=4 and stderr contained an actionable conflict message.
DECISION: Treat as a separate spawn failure-mode bug from stale workspace dirs. agent spawn --workspace can partially create workspace state and then abort in a way that loses stdout/stderr/actionable diagnostics to callers. This is especially bad for orchestrators because it appears as being stuck, and retrying accumulates more orphan dirs.
NEXT: Make workspace creation + agent registration transactional or add rollback on failure. Ensure every failure returns a normal exit code plus diagnostic on stderr. Add integration tests for fresh --workspace spawn failure after workspace-dir creation but before agent registration, and assert no orphan dir remains or that the orphan is reported/adoptable. If the abort comes from underlying git worktree/cp/tmux command, wrap it and preserve stderr.
VERIFIED: Follow-up inspection showed empty /tmp/mu-spawn-sil-1.{out,err}, no sil-1 pane in tmux list-panes, no sil-1 DB agent row from mu sql, but find listed sil-1 as a newly-created workspace directory.
ODDITIES: The command harness prints Command aborted when the tool call process aborts; even with redirection, mu produced no captured diagnostic for sil-1. This made parallel setup unsafe, so I stopped spawning --workspace agents in infer-rs.
```

### #3 by π - infer-rs, 2026-05-08T13:05:53.016Z

```
FILES: /Users/mtrojer/hacking/mu/src/workspace.ts; /Users/mtrojer/hacking/mu/src/vcs.ts; failed workspace /Users/mtrojer/.local/state/mu/workspaces/infer-rs/sil-1.
COMMANDS: test -e /Users/mtrojer/infer-rs/infer-rs/.git; test -e /Users/mtrojer/infer-rs/.git; du -sh /Users/mtrojer/infer-rs/infer-rs; du -sh /Users/mtrojer/.local/state/mu/workspaces/infer-rs/sil-1; read agents.ts spawnAgent and workspace/vcs backend detection code.
FINDINGS: Important correction/reframe: the sil-1 failure may not be a tmux/_mu issue. I passed --workspace-project-root /Users/mtrojer/infer-rs/infer-rs, which is not a git root, so detectBackend falls through to the none backend. noneBackend runs cp -a projectRoot/. workspacePath. The nested crate dir is 69G, so spawn began a huge copy and left a 1.8G partial sil-1 directory when aborted. The actual git root is /Users/mtrojer/infer-rs. This explains the empty stdout/stderr and partial workspace better than a missing _mu pane.
DECISION: Keep this bug open but refine it: agent spawn --workspace should preflight/announce selected backend and project root before doing huge none-backend copies, and should clean up partial copy dirs on interruption/failure. The missing _mu window is tracked separately in bug_workstream_init_does_not_repair_missing_mu_window.
NEXT: Add guardrails for none backend: warn/require confirmation above a size threshold, or print selected backend/project root before copying. Ensure interrupted cp removes partial workspace dir or records it as orphan. In orchestrator practice, pass --workspace-project-root /Users/mtrojer/infer-rs for this repo.
VERIFIED: /Users/mtrojer/infer-rs/infer-rs has no .git; /Users/mtrojer/infer-rs has .git; sil-1 contains a partial copied tree and no DB workspace row.
ODDITIES: The state invisibility bug still applies independently: sil-1 is now an orphan dir not visible in mu state/workspace list.
```

### #4 by π - infer-rs, 2026-05-08T13:53:49.044Z

```
FILES: /Users/mtrojer/.local/state/mu/workspaces/infer-rs/{sil-1,worker-2,worker-4,worker-7}.
FINDINGS: Removed the none-backend partial copy orphans created by wrong-root workspace spawns. These were large cp -a snapshots (~1.8-1.9G each) with no DB rows and no git metadata.
DECISION: Local disk/state is cleaned; bug remains as a guardrail request: none backend should preflight project root/backend/size and rollback partial dirs on interruption/failure.
NEXT: Add size threshold/warning or require explicit --workspace-backend none for huge non-VCS copies.
VERIFIED: workspace directory inventory is empty after cleanup.
```
