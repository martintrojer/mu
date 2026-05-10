---
id: "workspace_create_partial_dir_on_failure"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-08T14:21:22.094Z"
updated_at: "2026-05-09T05:58:57.919Z"
blocked_by: ["snap_dogfood"]
blocks: []
---

# mu workspace create can leave partial on-disk dir if interrupted; none-backend cp -a from $HOME is a footgun

## Notes (1)

### #1 by worker-1, 2026-05-09T05:58:52.060Z

```
FIXED workspace_create_partial_dir_on_failure (snap_dogfood Finding 4).

═══ FILES ═══
  src/workspace.ts        — new HomeDirAsProjectRootError class +
                            $HOME guard + try/catch around
                            backend.createWorkspace that rms the
                            partial dir on throw before re-raising.
  src/cli.ts              — error map: HomeDirAsProjectRootError →
                            "conflict" / exit 4.
  src/index.ts            — re-export HomeDirAsProjectRootError.
  test/workspace.test.ts  — two new describe() blocks: HOME guard
                            (3 cases inc. positive non-HOME control)
                            + cleanup-on-backend-throw (flaky
                            backend that creates partial dir then
                            throws, asserts dir gone + recovery
                            createWorkspace succeeds).
  CHANGELOG.md            — Unreleased entry above the HUD-colors fix.

═══ COMMANDS ═══
  npm run typecheck && npm run lint && npm run test && npm run build
    → all green (the 2 pre-existing tasks.test.ts $USER/$TMUX_PANE
       failures from --self resolution are unrelated; verified by
       git-stashing the changes and running test before the patch —
       same 2 fail, same 155 pass).

  Manual smoke (real bin, /tmp DB, real tmux):
    cd $HOME
    mu workstream init smoke-ws
    MU_SPAWN_LIVENESS_MS=0 mu agent spawn smoke-1 -w smoke-ws \
      --command "sh -c \"read x\""    → exit 0
    mu workspace create smoke-1 -w smoke-ws
      → conflict: refusing to create workspace with projectRoot=$HOME
        (/Users/mtrojer); a recursive copy/clone of your home directory
        is almost never what you want
        Next:
          Re-run from inside a real project directory : cd <your-project> && mu workspace create smoke-1 -w smoke-ws
          Or pass --project-root explicitly           : mu workspace create smoke-1 -w smoke-ws --project-root <your-project>
        exit=4   ✓ HOME GUARD WORKS
      ls ~/.local/state/mu/workspaces/smoke-ws/    → ENOENT (no partial dir)

    mu workspace create smoke-1 -w smoke-ws --project-root /tmp
      → cp: /tmp/./x2pagent-diagnostic-sockets-mtrojer/*.sock is a socket
        (not copied)... cp threw nonzero; createWorkspace re-raised.
      ls ~/.local/state/mu/workspaces/smoke-ws/    → empty (cleanup ran)
      mu workspace list -w smoke-ws                → no rows
      ✓ CLEANUP-ON-THROW WORKS END-TO-END (real cp -a failure, real rm -rf)

═══ FINDINGS ═══
  Sub-bug (a) — HOME-as-projectRoot footgun:
    Fixed via path.resolve()-equality check at top of createWorkspace.
    resolve() normalises trailing slash, ./, symlinks-in-name, so
    cd && mu workspace create + --project-root ~/ + --project-root ~/./
    are all blocked uniformly. Direct children of $HOME (~/Documents,
    ~/projects/foo) are NOT blocked — the brief explicitly cautioned
    against that overreach. No --force escape hatch — use
    --project-root <real-path> instead, the guard exists to make the
    user pick deliberately.

  Sub-bug (b) — partial dir not cleaned up on throw:
    Wrapped backend.createWorkspace in try/catch; rmSync(path, {
    recursive: true, force: true }) on throw before re-raising the
    original error. Best-effort: if rm itself fails, the user can
    still recover via mu workspace orphans + the existing nextSteps
    on WorkspacePathNotEmptyError. Composes cleanly with the existing
    INSERT-failure rollback (bug_agent_spawn_workspace_fk_failure)
    that runs backend.freeWorkspace if the row insert fails — so the
    on-disk + registry-row pair is now atomic-ish at every failure
    boundary.

  Sub-bug (c) — orphan-detection:
    Per the brief (verify only). Code reading confirms
    listWorkspaceOrphans() in src/workspace.ts already returns ANY
    dir-on-disk-without-row, so a partial dir from a hypothetical
    rm-failed cleanup WOULD show up in mu workspace orphans. No new
    task filed — sub-bug (b) cleanup makes the orphan path the rare
    fallback rather than the common case.

═══ DECISION ═══
  Fixed both interlocking sub-bugs (a) and (b) in src/workspace.ts.
  No public API changes outside the new exported error class.
  Stayed strictly within scope: did not block direct children of
  $HOME (overreach), did not add a --force flag (anti-pattern), did
  not touch the orphan-detection path (already correct), did not
  reach into backend implementations (the cleanup lives at the
  SDK boundary, not duplicated per backend).

═══ NEXT ═══
  - hud_dogfood is the only remaining roadmap-v0-2 task; still
    blocked. After it: roadmap-v0-2 is complete.
  - No follow-up tasks filed.

═══ VERIFIED ═══
  ✓ npm run typecheck
  ✓ npm run lint
  ✓ npm run test (two pre-existing tasks.test failures unrelated;
    confirmed by stashing the patch and re-running)
  ✓ npm run build
  ✓ Manual: HOME guard rejects with typed error + nextSteps + exit 4
  ✓ Manual: cleanup-on-throw works against a REAL cp -a failure
    (sockets in /tmp), no partial dir, no orphan row, exit nonzero
  ✓ Manual: positive control — workspace create with a clean
    --project-root succeeds normally (covered by the existing
    workspace SDK suite, 30+ green tests)

═══ ODDITIES ═══
  - The classic node:os import for homedir() is brought in fresh
    in src/workspace.ts; it was not previously imported there. No
    cross-cluster footprint though — homedir() is a single-line
    pure call.
  - Two pre-existing $USER/--self failures in test/tasks.test.ts
    fire when the test is run with the host user $USER set to
    "worker-1" (the agent name), because the test asserts $USER
    overrides --self resolution. Out of scope for this task; not
    introduced by this patch.
```
