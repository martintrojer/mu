---
id: "add_mu_workspace_recreate_free_create"
workstream: "feedback"
status: CLOSED
impact: 25
effort_days: 0.2
roi: 125.00
owner: null
created_at: "2026-05-11T08:18:35.090Z"
updated_at: "2026-05-11T08:49:17.486Z"
blocked_by: []
blocks: []
---

# Add mu workspace recreate (free + create) shortcut

## Notes (3)

### #1 by "π - gchatui", 2026-05-11T08:19:20.085Z

```
SEEN: 2026-05-11 in workstream gchatui.

Between waves I had to run:
  mu workspace free worker-1
  mu workspace create worker-1 -w gchatui

...for each agent. This is a near-universal "I'm done with this wave,
prep the workspace for the next dispatch" pattern. The `nextSteps`
in `mu task wait --json` already suggests `free && create` as one
combined intent.

DESIRED: `mu workspace recreate <agent> [-w <ws>]` that does both,
atomic, with the same safety checks as `free` (refuse if dirty
unless --force or --commit).

PRIORITY: low. Two-command shortcut.
```

### #2 by "worker-wsrecreate-1", 2026-05-11T08:48:33.724Z

```
DONE. Added 'mu workspace recreate <agent>' as a free+create shortcut (the dogfood between-wave verb).

SDK: src/workspace.ts now exports recreateWorkspace(db, agent, opts) -> { workspace, previousParentRef }. Refuses on dirty WC via WorkspaceDirtyError (verb='recreate' so the error message + nextSteps point at --force, not git stash). --force is the lossy escape. Reuses the previous backend unless --backend overrides.

To emit ONE 'workspace recreate' event (not free+create), createWorkspace + freeWorkspace gained a private _suppressEvent flag (NOT in the SDK contract; called only by recreateWorkspace). One pre-mutation snapshot under the same label.

Backend interface: added listDirtyFiles() to VcsBackend (jj/none -> [], git/sl wrap the existing helpers). Two real callers (rebaseTo internals, the new recreate dirty check) so it clears the no-anticipatory-abstractions bar.

CLI: 'mu workspace recreate <agent>' wired in src/cli/workspace.ts with the same options as create (--backend, --from, --project-root, --workstream, --json) plus --force. Help text documents the atomic guarantees.

Tests: test/cli-workspace-recreate.test.ts (9 tests, all green): clean recreate bumps parent_ref; ONE event row emitted; git happy path; dirty refusal w/ message + survival of dirty file; --force discards; missing workspace -> WorkspaceNotFoundError; unknown agent -> WorkspaceNotFoundError (the row check fires first, AgentNotFoundError is reserved for a racy create-half failure); --json envelope shape { workspace, previousParentRef, nextSteps } with required intents (Send work, List workspaces, ...); CLI exits 4 on dirty.

Docs: USAGE_GUIDE.md pipeline recipe footnote (recreate as alt to refresh); VOCABULARY.md new 'recreate' row alongside 'refresh'; SKILL.md workspace verb list updated; CHANGELOG.md Unreleased Added entry.

Validation: npm run typecheck && lint && test (68 files / 1199 tests) && build all green.
```

### #3 by "worker-wsrecreate-1", 2026-05-11T08:49:17.486Z

```
CLOSE: all 4 green; new verb + tests; commit 0f37b8d
```
