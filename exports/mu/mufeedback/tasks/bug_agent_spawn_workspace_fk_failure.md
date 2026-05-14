---
id: "bug_agent_spawn_workspace_fk_failure"
workstream: "mufeedback"
status: CLOSED
impact: 45
effort_days: 0.4
roi: 112.50
owner: null
created_at: "2026-05-08T13:06:12.449Z"
updated_at: "2026-05-08T16:56:06.838Z"
blocked_by: []
blocks: []
---

# BUG: agent spawn --workspace fails FK staging with correct git root

## Notes (5)

### #1 by "π - infer-rs", 2026-05-08T13:06:12.563Z

```
FILES: /Users/mtrojer/hacking/mu/src/agents.ts spawnAgent workspace staging; /Users/mtrojer/hacking/mu/src/workspace.ts createWorkspace; /Users/mtrojer/hacking/mu/src/db.ts schema for agents/vcs_workspaces.
COMMANDS: mu agent spawn silgit-1 -w infer-rs --cli pi-meta --command 'pi-meta --no-solo' --workspace --workspace-project-root /Users/mtrojer/infer-rs with stdout/stderr capture; schema query for agents/vcs_workspaces; row query for silgit-1; git worktree list.
FINDINGS: After correcting --workspace-project-root to the actual git root (/Users/mtrojer/infer-rs), --workspace spawn no longer fell back to the huge none/cp backend, but failed with stderr: error: FOREIGN KEY constraint failed. No silgit-1 agent row or workspace row remained. Need inspect whether spawnAgent inserts a placeholder agent row whose pane_id/status violates some constraint, whether createWorkspace inserts vcs_workspaces before the agent row is visible/committed, or whether deleteAgent rollback cascades unexpectedly.
DECISION: This is a separate mu bug from (a) missing _mu window and (b) wrong-root none-backend huge copy. It prevents correct-root git workspace spawning in this workstream.
NEXT: Add a focused unit/integration test for spawnAgent({workspace:true, workspaceProjectRoot:<git-root>}) and assert placeholder agent row satisfies FK, workspace row insert succeeds, pane creation either completes or rollback frees workspace. Consider wrapping spawn workspace staging in an explicit transaction with rollback ordering tested.
VERIFIED: Correct-root spawn returned exit=1 and stderr foreign key constraint failed. State still shows no silgit-1 agent/workspace.
ODDITIES: This might be data/schema-specific to current DB migrations or agents/vcs_workspaces FK shape; compare against roadmap-v0-2 where existing git workspace rows exist.
```

### #2 by "π - infer-rs", 2026-05-08T13:06:44.354Z

```
FILES: git worktree registry under /Users/mtrojer/infer-rs; workspace dir /Users/mtrojer/.local/state/mu/workspaces/infer-rs/silgit-1.
COMMANDS: cd /Users/mtrojer/infer-rs && git worktree list --porcelain | sed -n '/silgit-1/,+4p'; du -sh /Users/mtrojer/.local/state/mu/workspaces/infer-rs/*.
FINDINGS: Correct-root FK failure is also partially stateful: it left a real git worktree at /Users/mtrojer/.local/state/mu/workspaces/infer-rs/silgit-1 (226M, detached at 64a41b5d3a...). No vcs_workspaces DB row and no agent row exist, so mu state still reports Workspaces (0), but git worktree list sees silgit-1. This is another orphan-producing path, not just a clean FK failure.
DECISION: Workspace spawn rollback must remove the git worktree if DB insertion or later staging fails. Also state/workspace orphan detection should detect git-worktree-backed dirs/registrations, not only copy dirs.
NEXT: When cleaning this manually, use git worktree remove --force /Users/mtrojer/.local/state/mu/workspaces/infer-rs/silgit-1 from /Users/mtrojer/infer-rs, then prune. Do not just rm -rf unless also pruning git worktree metadata.
VERIFIED: git worktree list shows silgit-1; du shows 226M dir.
ODDITIES: The nested-root none backend orphans are ~1.8G copies; the correct-root git orphan is smaller but registered in git.
```

### #3 by "π - infer-rs", 2026-05-08T13:53:48.928Z

```
FILES: /Users/mtrojer/.local/state/mu/workspaces/infer-rs/silgit-1; git worktree registry under /Users/mtrojer/infer-rs.
FINDINGS: Cleaned the silgit-1 orphan created by the correct-root FK failure using git worktree remove --force followed by git worktree prune. The directory and git worktree registry entry are gone.
DECISION: The cleanup does not change the bug: correct-root spawn produced FK failure after creating a git worktree and before recording DB rows. It just removes the local artifact from infer-rs.
NEXT: Reproducer should create a temporary git repo/workstream and assert rollback removes worktree on FK/pane-stage failure.
VERIFIED: git worktree list now shows only /Users/mtrojer/infer-rs main worktree.
```

### #4 by "π - infer-rs", 2026-05-08T14:34:32.556Z

```
FILES: installed mu /opt/homebrew/bin/mu v0.1.0; infer-rs workstream.
COMMANDS: mu agent spawn silfix-1 -w infer-rs --cli pi-meta --command 'pi-meta --no-solo' --workspace --workspace-project-root /Users/mtrojer/infer-rs with stdout/stderr capture; mu workspace orphans -w infer-rs; mu state -w infer-rs; which mu; mu --version.
FINDINGS: Regression/repro after task was marked CLOSED by π - mu: correct-root workspace spawn still fails. stdout now prints preflight: [mu] workspace preflight: backend=git projectRoot=/Users/mtrojer/infer-rs. stderr: error: FOREIGN KEY constraint failed. Unlike the earlier silgit-1 attempt, cleanup now appears to work: mu workspace orphans -w infer-rs reports no orphan workspace dirs after failure. So the rollback/orphan part is improved, but the FK staging failure remains.
DECISION: Reopen or keep tracking: auto --workspace spawn is still unusable for infer-rs edit workers, even with correct git root and clean orphan state.
NEXT: Investigate exact FK statement around placeholder agent + createWorkspace. Workaround for infer-rs may be manual git worktree + mu agent spawn --cwd (no --workspace) until fixed.
VERIFIED: /opt/homebrew/bin/mu version 0.1.0 reproduced exit=1; no orphans left afterwards.
ODDITIES: bug_agent_spawn_workspace_fk_failure showed CLOSED already, but the user-visible issue persists.
```

### #5 by "π - mu", 2026-05-08T16:56:06.734Z

```
ROOT CAUSE FOUND + FIXED on main (commit 462e3a7).

═══ THE BUG ═══

A race between two cooperating verbs:

  Spawn path (--workspace):
    1. INSERT INTO agents (..., pane_id = '%pending-<name>', ...)
    2. backend.createWorkspace()  -- runs `git worktree add`,
                                     takes 2-3s on infer-rs's
                                     13k-file checkout
    3. INSERT INTO vcs_workspaces (..., agent = <name>, ...)

  Read path (called by mu hud / mu state / bare mu / mu agent attach
  / mu doctor):
    reconcile() prunes any agent row whose pane_id doesn't match a
    live tmux pane.

'%pending-<name>' is not a live tmux pane. So a `watch -n 5 mu hud`
poll firing during step 2 of a spawn deletes the placeholder row;
step 3 then fails its agent FK because the row is gone. Surfaces as
the FOREIGN KEY error on the WRONG LINE — looks like the
vcs_workspaces insert is broken when really the agent row was
deleted out from under us.

═══ HYPHENS ARE *NOT* THE CAUSE ═══

The 'no-hyphen workspace spawn succeeded' evidence in note #1297 is
a coincidence. After the fix, hyphenated names spawn cleanly:
  $ mu agent spawn fk-hyphen-test -w infer-rs --cli pi-meta \
      --command 'sh -c "read x"' --workspace \
      --workspace-project-root /Users/mtrojer/infer-rs
  Spawned fk-hyphen-test (pi-meta ...) with auto-workspace
  workspace: /Users/mtrojer/.local/state/mu/workspaces/infer-rs/fk-hyphen-test (git)

Naming convention is back to no-restriction (any [a-z][a-z0-9_-]{0,31}).
silgit-1, silbuild-1, etc. would all work fine now.

═══ THE FIX ═══

ListLiveAgentsOptions gains a dryRun?: boolean. Every read-only
call site sets it true:
  cmdHud, cmdState, cmdMission, cmdAttach, cmdDoctor, cmdDoctorJson
cmdList (mu agent list) keeps mutating: it's the documented escape
hatch for forcing a real prune.

When dryRun:true, reconcile() COUNTS would-be-pruned ghosts but
doesn't DELETE them. orphan-detection still runs (pure read).

Same shape as the snap_undo_reconcile fix (commit 08a1045):
read verbs are read-only by default; the one explicit
'refresh and prune' verb keeps mutating semantics.

═══ VERIFIED ═══

- Live smoke: `while true; do mu hud > /dev/null; sleep 0.1; done`
  loop + concurrent --workspace spawn now succeeds.
- 713/713 tests (was 710 + 3 new dryRun-propagation regression tests
  in test/verbs.test.ts).
- infer-rs's three subsequent spawns at ~16:51 (sila/silb/texta) all
  succeeded against the post-fix mu binary.

═══ FOR INFER-RS ═══

You can drop the no-hyphen workaround. `mu agent spawn <any-name>
--workspace` works against your 13k-file checkout under any
poll-rate hud loop now.

CHANGELOG.md ### Fixed entry under [Unreleased] documents the fix.
```
