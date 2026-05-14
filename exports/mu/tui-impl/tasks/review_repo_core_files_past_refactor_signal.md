---
id: "review_repo_core_files_past_refactor_signal"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.8
roi: 50.00
owner: "worker-3"
created_at: "2026-05-12T11:14:39.597Z"
updated_at: "2026-05-13T09:14:51.431Z"
blocked_by: ["bug_tui_card_body_collapses_into_bottom_border", "review_repo_agent_list_all_dead_surface", "review_repo_archive_events_not_incremental", "review_repo_export_bucket_index_not_additive", "review_repo_git_dirty_check_dup", "review_repo_hud_residue_dead_helpers", "review_repo_process_exit_inside_handlers", "review_repo_unused_zod_dependency", "review_repo_workspace_commits_json_loses_metadata", "testreview_acceptance_bypasses_lifecycle", "testreview_env_leak_no_color", "testreview_fixed_sleep_flakes", "testreview_json_shape_weak_assertions", "testreview_static_source_assertions"]
blocks: []
---

# REVIEW med: several core files exceed the 800 LOC refactor signal

## Notes (4)

### #1 by "worker-2", 2026-05-12T11:14:39.948Z

```
FILES: `wc -l`: src/tasks.ts:1433, src/vcs.ts:1282, src/workspace.ts:1015, src/archives.ts:938, src/snapshots.ts:832, src/cli.ts:820, src/cli/agents.ts:805, src/importing.ts:803, src/agents.ts:800.
FINDING: AGENTS.md says 800 LOC is the refactor signal and 1500 LOC is the hard cap. Multiple non-TUI files are at/over the signal; `src/tasks.ts` is close to the hard cap. The natural clusters already exist for agents/tasks, but the root hubs still carry substantial implementation; `vcs.ts` in particular has four backend implementations in one large file.
RECOMMENDED FIX: Split only along concrete current seams (no anticipatory layers): e.g. move task edit/edge/query internals out of `src/tasks.ts` into the existing `src/tasks/` cluster; split `src/vcs.ts` into backend files under one cohesive `src/vcs/` cluster; consider `workspace/` helpers for orphan/decorate/recreate; keep hubs as re-export/API facades. Update ARCHITECTURE.md if a new cluster is introduced.
```

### #2 by "π - mu", 2026-05-12T12:43:26.635Z

```
DECISION (orchestrator triage): SHIP, but BLOCKED by every other v0.4.0 task. File-split refactor touches every import; gating ensures no in-flight work conflicts at cherry-pick time.

Implementation per the original audit recommendation:

Split each file along concrete current seams (NO anticipatory layers). Files in priority order:

1. src/tasks.ts (1433 LOC, closest to 1500 hard cap):
   src/tasks/ already has cluster files. Move task edit/edges/queries internals from src/tasks.ts INTO src/tasks/{edit,edges,queries}.ts. Keep src/tasks.ts as the SDK hub re-exporting from src/tasks/*.

2. src/vcs.ts (1282 LOC):
   Split into src/vcs/{git,jj,sl,none,index}.ts under one cohesive cluster. Each backend impl in its own file. src/vcs.ts becomes the type/interface + re-export hub.

3. src/workspace.ts (1015 LOC):
   Split into src/workspace/{crud,refresh,decorate,orphans,recreate,index}.ts. Move the helpers cited in the audit (orphan/decorate/recreate) into the cluster.

4. src/archives.ts (938 LOC):
   Likely candidate cluster: src/archives/{create,addremove,query,export,delete,index}.ts.

5. src/snapshots.ts (832 LOC):
   Smaller — possibly defer if the natural split isn't obvious.

6. src/cli.ts + src/cli/agents.ts + src/importing.ts + src/agents.ts (all 800-820):
   Just over the signal — defer unless an obvious split presents itself.

For EACH split:
- ARCHITECTURE.md: add the new cluster's row in the module table (per AGENTS.md cluster requirement: clear theme, no upward imports, ARCHITECTURE.md row).
- Hub file becomes a re-export facade so external imports don't need to change.
- Run four greens after EACH file split (one commit per major file).

⚠️ ORDERING ⚠️
This task is BLOCKED by every other open v0.4.0 task. Do NOT start until 'mu task tree review_repo_core_files_past_refactor_signal' shows all blockers CLOSED.

Estimated total diff: -8000 LOC removed from hub files, +8000 LOC added across cluster files (net zero, organisational change). Real risk: any work in flight on the split files at the same time = guaranteed merge conflicts. The blocking edges keep this from happening.

⚠️ FINAL ACTION ⚠️
After ALL splits land green, close with sha-list:
mu task close review_repo_core_files_past_refactor_signal -w tui-impl --evidence '<sha-list>: split tasks.ts/vcs.ts/workspace.ts/archives.ts (and others if natural)'
```

### #3 by "worker-3", 2026-05-13T09:14:51.140Z

```
FILES: src/tasks.ts + src/tasks/{core,id,queries,edit,edges}.ts; src/vcs.ts + src/vcs/{types,helpers,index,git,jj,sl,none}.ts; src/workspace.ts + src/workspace/{core,crud,decorate,orphans,recreate}.ts; src/archives.ts + src/archives/{core,query,addremove,delete}.ts; src/snapshots.ts + src/snapshots/{core,capture,restore,prune}.ts; docs/ARCHITECTURE.md; CHANGELOG.md
COMMANDS: per split ran npm run typecheck && npm run lint && npm run test:fast && npm run build && node dist/cli.js --help (all exit 0); final npm run test exit 0
FINDINGS: Split all priority files 1-5 into cohesive clusters with root files as re-export hubs. Verified no cluster file imports through its own hub.
DECISION: Shipped tasks, vcs, workspace, archives, and snapshots splits; no need to defer snapshots because natural capture/restore/prune split was obvious.
VERIFIED: npm run test passed: 155 files / 2320 tests. Git diff HEAD~5..HEAD shortstat: 37 files changed, 5452 insertions, 5669 deletions, net -217 LOC.
```

### #4 by "worker-3", 2026-05-13T09:14:51.431Z

```
CLOSE: 78db7c4,a65eccf,33f0be6,f10bd2a,72b3ffe: split tasks.ts/vcs.ts/workspace.ts/archives.ts/snapshots.ts; net LOC change -217
```
