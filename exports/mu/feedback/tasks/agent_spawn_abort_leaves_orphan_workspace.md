---
id: "agent_spawn_abort_leaves_orphan_workspace"
workstream: "feedback"
status: CLOSED
impact: 18
effort_days: 0.3
roi: 60.00
owner: null
created_at: "2026-05-11T07:26:55.520Z"
updated_at: "2026-05-11T08:11:06.175Z"
blocked_by: []
blocks: []
---

# agent spawn abort can leave orphan workspace without surfaced cleanup command

## Notes (4)

### #1 by "π - infer-rs", 2026-05-11T07:26:55.641Z

```
FILES: mu agent spawn / workspace create flow (not inspected yet).
COMMANDS: from infer-rs checkout: mu agent spawn worker-bench-1 -w infer-rs --cli pi-meta --workspace --workspace-project-root /Users/mtrojer/infer-rs/infer-rs --json -> output only 'Command aborted'; then mu state -w infer-rs --json showed no agent and workspaceOrphans=[worker-bench-1]; mu workspace list showed count 0; mu workspace orphans showed cleanup recipe.
FINDINGS: spawn can create the workspace before aborting, but the failed command did not surface the orphan or cleanup command in its stderr/stdout. This is especially easy to hit when using pi-meta / solo/liveness behavior.
DECISION: file as feedback task per operator instruction.
NEXT: make agent spawn rollback the workspace on launch failure, or print the orphan cleanup command in the error/nextSteps.
VERIFIED: orphan path existed at /Users/mtrojer/.local/state/mu/workspaces/infer-rs/worker-bench-1.
```

### #2 by "π - infer-rs", 2026-05-11T07:29:01.403Z

```
UPDATE: second repro with --command 'pi-meta --no-solo' left an even stranger partial state: mu state showed agent worker-bench-1 with paneId=%pending-worker-bench-1/status=spawning, but no tmux mu-infer-rs session/pane existed; workspaceOrphans had worker-bench-1; workspace dir was a plain cp-like directory with no .git (not a git worktree). Cleanup required mu agent close worker-bench-1 plus rm -rf workspace dir. This supports rollback/cleanup-on-spawn-failure and clearer error output.
```

### #3 by "π - infer-rs", 2026-05-11T07:29:24.385Z

```
UPDATE: likely trigger is absent tmux workstream session. Manually creating it with 'tmux new-session -d -s mu-infer-rs -n orchestrator' before running the same spawn command made spawn succeed and create a real git workspace. Suggest spawn either auto-creates the workstream tmux session or fails before workspace creation with an explicit 'tmux session missing; run ...' nextStep.
```

### #4 by "worker-spawn-1", 2026-05-11T08:10:58.851Z

```
FIX: src/agents/spawn.ts spawnAgent now wraps createOrReusePane + setPaneTitle + enableMuPaneBordersForPane + finalizeAgentRow + awaitSpawnLiveness in a single outer try. paneId tracked as string|undefined (rollbackSpawn skips killPane when undefined). Inner try/catches removed (clarity over belt-and-suspenders; rollbackSpawn is idempotent + best-effort). When workspace was prestaged, the thrown error gets augmented with orphan-cleanup nextSteps via attachOrphanCleanupHint() (works for typed errors like AgentDiedOnSpawnError that already expose nextSteps, AND for bare TmuxError from createOrReusePane). DEFERRED follow-ups: (1) auto-create missing tmux workstream session before spawn (operator's update note 3) — would change tmux side-effects; file separately. (2) SIGINT handlers between prestage and first try (needs process-global state); defer. TESTS: 4 new in test/verbs-spawn.test.ts (createOrReusePane fail rolls back ws+row; nextSteps include mu workspace orphans/free; finalize fail still rolls back; liveness fail with --workspace appends orphan hints to AgentDiedOnSpawnError). All 1156 tests pass. CHANGELOG updated under [Unreleased].
```
