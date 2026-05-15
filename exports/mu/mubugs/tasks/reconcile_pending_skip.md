---
id: "reconcile_pending_skip"
workstream: "mubugs"
status: CLOSED
impact: 60
effort_days: 0.25
roi: 240.00
owner: null
created_at: "2026-05-15T10:51:17.982Z"
updated_at: "2026-05-15T10:58:37.991Z"
blocked_by: []
blocks: ["collapse_status_only_mode"]
---

# Defensive: reconcile() skips placeholder pane ids during prune in ALL modes

## Notes (3)

### #1 by "π - mu", 2026-05-15T10:53:16.125Z

```
TASK
====
Add `isPendingPaneId(agent.paneId)` skip to `reconcile()` step 1's prune loop. Skip placeholder agents in ALL modes (not just status-only).

WHY
===
Today, status-only mode protects placeholder agents from being pruned by skipping the entire prune step. Once we collapse status-only into full (next task), placeholders need their own protection. The protection lives where the placeholder sentinel is checked elsewhere in the file.

This is a defensive prep-commit. No observable behavior change for users today — status-only already skipped the prune step entirely; full mode never raced against placeholders in the wild because callers were disciplined about which mode to use.

SCOPE
=====
ONE source change in src/reconcile.ts step 1 (the prune loop):

  for (const agent of dbAgents) {
    if (tmuxByPaneId.has(agent.paneId)) {
      survivors.push(agent);
+   } else if (isPendingPaneId(agent.paneId)) {
+     // Mid-spawn placeholder; the real pane id will replace this
+     // shortly. Treat as a survivor so spawn's vcs_workspaces FK
+     // insert can complete (was previously protected only by
+     // status-only mode skipping prune entirely; this defensive
+     // skip makes the protection independent of mode).
+     survivors.push(agent);
    } else {
      if (mode === "full") deleteAgent(db, agent.name, agent.workstreamName);
      prunedGhosts++;
    }
  }

isPendingPaneId is already imported at the top of reconcile.ts. No new imports needed.

TEST COVERAGE
=============
Add to test/reconcile.test.ts (or wherever the existing prune tests live; verify with `rg -l reconcile test/`):

1. reconcile in `full` mode: agent with paneId starting with `%pending-` is NOT pruned even when not in tmux's pane list.
2. reconcile in `full` mode: agent with normal paneId not in tmux IS pruned (existing behavior; regression guard).
3. reconcile in `status-only` mode: same placeholder skip (still works; the new branch fires before the existing mode check).
4. The skip does NOT count toward prunedGhosts (the placeholder is not a ghost).

CONSTRAINTS
===========
- ESM, strict types, no `any`, no non-null assertions.
- LOC: +5-10 net in src/reconcile.ts; +20-40 net in tests.
- Single commit. No CHANGELOG (this is a prep commit; the user-facing change lands in collapse_status_only_mode).

VERIFY
======
- npm run typecheck && npm run lint
- npm run test:fast (workers run fast tier; orchestrator runs full at push gate per the established policy from the multimachine wave)
- npm run build
- node dist/cli.js --help (bundle smoke; silent stderr = top-level await deadlock, see HANDOVER Gotcha 1)

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean:

  mu task close reconcile_pending_skip -w mubugs --evidence '<sha> placeholder skip in reconcile prune loop, all modes; tests cover both full + status-only paths'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1 (will be created when claim happens)
- ESM, strict types, no `any`, no non-null assertions.
- Biome auto-fix is fine (`npx biome check --write`); never `--write --unsafe`.
```

### #2 by "π - mu", 2026-05-15T10:54:34.743Z

```
You are worker-1 in workstream `mubugs`. Claim is set on you for `reconcile_pending_skip`.

YOUR TASK: reconcile_pending_skip (defensive prep-commit; trivial).

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w mubugs
  mu task notes reconcile_pending_skip -w mubugs

The umbrella note has the full design + rationale (why we're collapsing the modes, why this prep-commit is needed). The task note has the precise scope.

STEP 2 — read the existing pieces:
  src/reconcile.ts — the file you're modifying. Note the existing `isPendingPaneId` import, the prune loop in step 1, the existing mode-aware deleteAgent call.

STEP 3 — implement per the task note. The change is ~5 LOC: in step 1's prune loop, add an `else if (isPendingPaneId(agent.paneId))` branch that pushes to survivors and continues, BEFORE the existing `else` that prunes. Same paneId check that already protects placeholders in status detection.

STEP 4 — tests in test/reconcile.test.ts (or wherever the existing prune tests live; check with `rg -l 'reconcile' test/`):
  - Add: full mode skips placeholder pane id during prune.
  - Add: status-only mode skips placeholder pane id during prune (still works post-skip; the new branch fires before the mode check).
  - Add: full mode prunes a NORMAL pane id missing from tmux (regression guard).
  - Add: placeholder skip does NOT count toward prunedGhosts.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify FAST GREENS + bundle smoke (workers run fast tier; orchestrator runs full at push gate):
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run build
  node dist/cli.js --help

STEP 7 — commit:
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1
  git add -A
  git commit -m 'reconcile: skip placeholder pane ids in prune loop (defensive, all modes)'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, run EXACTLY:

  mu task close reconcile_pending_skip -w mubugs --evidence '<sha> placeholder skip in prune loop, all modes; tests cover full + status-only paths'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 50 net added.
- Single commit. No CHANGELOG (deferred to collapse_status_only_mode).
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT remove status-only mode in this commit. That's the next task. This is just the defensive skip.
```

### #3 by "worker-1", 2026-05-15T10:58:37.991Z

```
CLOSE: e1e960a placeholder skip in prune loop, all modes; tests cover full + status-only paths
```
