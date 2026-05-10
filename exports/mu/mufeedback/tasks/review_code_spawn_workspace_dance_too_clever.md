---
id: "review_code_spawn_workspace_dance_too_clever"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: null
created_at: "2026-05-09T08:32:09.937Z"
updated_at: "2026-05-09T10:14:36.201Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: spawnAgent's workspace placeholder dance is the most-commented code in agents/

## Notes (2)

### #1 by code-reviewer-1, 2026-05-09T08:32:45.344Z

```
FILES: src/agents/spawn.ts:140-180 (the placeholder-pane-id dance) + src/agents/spawn.ts:215-245 (the patch-then-rollback)

FINDINGS: spawnAgent's workspace integration uses a "stage agent row with %pending-<name> as the pane id, then patch in the real pane id post-create" trick to satisfy the FK on vcs_workspaces.agent. The 18-line block comment from line 140 is essentially an apology:

  // Workspace integration: when --workspace is set, allocate the
  // VCS workspace BEFORE the pane so we can use the workspace path
  // ... [4 paragraphs of design narration] ...
  // Solution: stage the workspace creation in two phases: ...
  // Actually simpler: just create the workspace dir first, then ...
  // Splitting dir vs row creation isn't worth the complexity though, so we
  // create the agent first WITHOUT a pane, then the workspace row,
  // ... Too many moving parts; instead simplify:
  // create the agent with a placeholder pane id ("%pending"), make
  // the workspace, create the real pane in the workspace dir, then
  // update the agent's pane_id.

The narration of the rejected designs is itself a code-smell signal. The current shape leaks the placeholder convention (`%pending-<name>`) into:
  - src/agents.ts:269 (refreshAgentTitle has to special-case it: `if (agent.paneId.startsWith("%pending-")) return;`)
  - The reconcile path (src/reconcile.ts:118 prunes any agent whose paneId isn't in tmuxByPaneId — `%pending-foo` is never in tmux, so reconcile would prune the placeholder mid-spawn → the bug surfaced as bug_agent_spawn_workspace_fk_failure, fixed by making every read-only verb pass `dryRun: true`).

So the placeholder design has spawned (sorry) at least two cross-module workarounds:
  1. composeAgentTitle / refreshAgentTitle has a `%pending-` early return.
  2. Every read-only verb (state, hud, doctor, mission, attach) MUST pass `dryRun: true` to reconcile() to avoid pruning placeholder rows mid-spawn.

The dryRun: true workaround in particular is now the documented load-bearing pattern (5 call sites + a long comment in src/agents.ts:472-486 explaining "why" — also recently extracted from refactor_split). It works, but every new read verb has to remember the rule. The next read-only verb that forgets `dryRun: true` will silently re-introduce the FK-failure regression.

WHY IT MATTERS: 50. Architectural smell + future-bug risk; not a current bug. The fix would untangle two cross-module workarounds. The current shape works because the team has internalised the pattern; it's brittle because the pattern is invisible to the type system (any new read verb defaults to mutating reconcile, which is the wrong default for a read-only context).

SUGGESTED FIX (~50 LOC, exploratory):
Option A: Make vcs_workspaces.agent FK deferred (DEFERRABLE INITIALLY DEFERRED in the schema), then drop the placeholder dance:
  1. Open transaction.
  2. Insert agent row WITHOUT pane_id (or with NULL pane_id; requires schema change to allow NULL).
  3. Allocate workspace.
  4. Spawn pane.
  5. UPDATE agents SET pane_id = ?.
  6. Commit.
The whole transaction looks like one atomic operation; FK CASCADE on rollback handles the unhappy path.

Option B: Keep the placeholder but make the type system enforce it. Add a "pending agent" tagged-union variant so refreshAgentTitle / reconcile match exhaustively rather than string-matching `%pending-`.

Option C (smallest, deferred): Document the dryRun-default in src/reconcile.ts itself by flipping the default to `dryRun: true` and forcing the mutating callers (just `mu agent list` today) to opt in via `dryRun: false`. This would catch new read verbs that forget. ~20 LOC + one schema-of-defaults audit.

Likely best: Option C, since it's smallest and addresses the more-likely future-bug. File Option A as a separate, deeper task if/when the schema gets a real migration.

ALTERNATIVES CONSIDERED:
- Do nothing. Defensible: the bug it would prevent has already been hit + fixed; subsequent panic-fixed in 670afce + earlier. Counter: one bug per pattern is the canonical "smell-becomes-bug" cycle the skill flags.

EVIDENCE:
- src/agents/spawn.ts:140-160 (the four-paragraph design narration in a comment).
- src/agents/spawn.ts:155-159 (`paneId: \`%pending-${opts.name}\`` insert).
- src/agents.ts:269 (`if (agent.paneId.startsWith("%pending-")) return;`).
- src/agents.ts:472-486 (load-bearing dryRun: true documentation block).
- 5 call sites grep -n "dryRun: true" src/cli/ → state.ts, hud.ts, doctor.ts, mission, agent attach.
- bug_agent_spawn_workspace_fk_failure in CHANGELOG / mufeedback history.
```

### #2 by worker-mf-4, 2026-05-09T10:10:18.840Z

```
ANALYSIS — investigated the four options below. SHIPPING Option 4 (named-helpers + drop the apologetic narration); DEFERRING Option 2 (eliminate the placeholder by reordering ws-dir-create → pane-create → atomic dual insert) as a separate, larger task.

────────────────────────────────────────────────────────────────────
SHAPE TODAY (src/agents/spawn.ts:140-260)
────────────────────────────────────────────────────────────────────
When `--workspace` is set:
  1. INSERT agents row with paneId = `%pending-<name>` (placeholder)
  2. createWorkspace(db, ...) — creates dir + INSERTs vcs_workspaces row keyed on agent FK
     - rollback on throw: deleteAgent(db, opts.name)
  3. createOrReusePane(...) — gets real paneId
  4. setPaneTitle + enableMuPaneBordersForPane
  5. UPDATE agents SET pane_id = <real>, updated_at = ?
     - rollback on throw: killPane + freeWorkspace + deleteAgent
  6. awaitSpawnLiveness
     - rollback on throw: freeWorkspace + deleteAgent + killPane

Cross-module workarounds the placeholder spawned:
  - src/agents.ts:294  refreshAgentTitle has a `.startsWith("%pending-")` early-return
  - src/agents.ts:504-521  the load-bearing `dryRun: true` rationale block in listLiveAgents,
    documenting that any read-only verb that forgets dryRun risks racing a long-running spawn
    and pruning the placeholder row mid-flight (→ FK failure on workspace insert).

────────────────────────────────────────────────────────────────────
OPTIONS SCORED
────────────────────────────────────────────────────────────────────

Option 1 — wrap everything in db.transaction(...)
  Simpler? No. Safer? No. Same observable behaviour? Yes for the SQL bits.
  VERDICT: REJECTED. tmux pane creation and workspace dir creation are non-SQL
  side effects; SQLite rollback can't undo them. The hard-to-rollback steps are
  exactly the ones outside SQL. This is a non-starter (and the task brief
  identified it as such).

Option 2 — reverse the order: ws dir → pane → atomic dual insert
  Sketch:
    a. Validate name + uniqueness.
    b. createWorkspaceDir(...)               # backend-level only, no DB row yet
    c. createOrReusePane(... cwd=ws-path)    # gets real paneId
    d. setPaneTitle + borders
    e. db.transaction(() => {
         insertAgent(... paneId)             # real paneId; no placeholder
         insertWorkspaceRow(...)             # FK to agent now satisfied
       })
    f. awaitSpawnLiveness
  Failure handling:
    - (b) throws: backend-level rmSync (already implemented in createWorkspace's cleanup-on-throw)
    - (c-d) throws: kill pane, then free dir
    - (e) throws: kill pane, free dir (no agent/ws rows ever existed → no SQL rollback needed,
      the transaction handles atomicity by construction)
    - (f) throws: kill pane, free dir, deleteAgent (CASCADE drops vcs_workspaces row)
  Simpler? YES — eliminates the placeholder + the patch-pane-id step + one rollback path.
  Safer? YES — no `%pending-` invariant for the rest of the codebase to learn.
    - refreshAgentTitle's special-case goes away.
    - Half the dryRun rationale evaporates (the placeholder-can't-be-pruned half;
      the snap_undo half remains, so `dryRun: true` is still load-bearing for read verbs).
  Same observable behaviour? Yes — the only externally-visible difference is that an
    agent row never appears with a `%pending-` paneId mid-spawn (only callers that race
    a spawn would notice; today they prune the placeholder which we patched around).
  Compatible with recent fixes?
    - dryRun fix: still needed for snap_undo, but the placeholder rationale goes away → less
      load-bearing.
    - cleanup-on-throw fix in createWorkspace: must be split. Today createWorkspace does
      backend.createWorkspace → INSERT vcs_workspaces in one call with rollback on each.
      Splitting it means workspace.ts grows a `createWorkspaceDir` (returns parentRef + path)
      and a separate `recordWorkspaceRow(db, dir, parentRef, ...)`. Existing callers
      (cmdWorkspaceCreate) keep using the combined createWorkspace (which calls both).
      Cleanup-on-throw stays in createWorkspaceDir; the row insert lives in the spawn
      transaction. Slight refactor but mechanical.
  Cost: ~120-180 LOC across spawn.ts + workspace.ts + minor test additions. Worth doing
    but exceeds the 0.4-day budget for a refactor of "the most-fragile code in agents/"
    where the failure mode is already patched. DEFER as its own task.

Option 3 — DEFERRABLE INITIALLY DEFERRED FK on vcs_workspaces.agent
  Simpler? In code, yes. In schema, no — there's no migrations layer in 0.1.0
  (db.ts is a single CREATE-IF-NOT-EXISTS block). The first non-additive schema
  change should land alongside a `schema_version` table per AGENTS.md.
  VERDICT: DEFER. The right design when migrations land. File alongside Option 2.

Option 4 — keep current shape; encapsulate phases as named functions
  Simpler? In comprehension yes — the apologetic 18-line "rejected designs"
  narration goes away because three small named functions speak for themselves.
  Safer? Marginally. No new invariants introduced; the placeholder convention
  becomes a single named constant (`PENDING_PANE_PREFIX`) so the two consumers
  (refreshAgentTitle, the rationale block) reference one source.
  Same observable behaviour? Yes (literally — pure code motion).
  Compatible with recent fixes? Yes; both stay in place verbatim.
  Cost: ~50-80 LOC of code motion; no test changes; no schema changes.

Option 5 — flip the `dryRun` default to true on listLiveAgents/reconcile
  Simpler? Smaller surface for new callers (read-only is the common case).
  Safer? Yes — type system catches new read verbs that forget the flag (today
  the wrong default is silent).
  Same observable behaviour? Only `mu agent list` keeps the mutating path;
  it would have to opt-in via `dryRun: false`. Test churn: ~10 callsites in
  test/ assume the current default and pass nothing; each would need an
  explicit `dryRun: false` to match.
  VERDICT: GOOD IDEA but bigger blast radius than the budget allows for a
    refactor whose stated failure mode is already patched. DEFER as its own
    task (also a small migration of the test suite).

────────────────────────────────────────────────────────────────────
DECISION
────────────────────────────────────────────────────────────────────
Ship Option 4 now (no observable change; under-budget):
  - Extract `prestageAgentForWorkspace(db, opts, cli)` — the placeholder-row + workspace
    create with rollback on the inner throw.
  - Extract `finalizeAgentRow(db, opts, paneId, prestaged, cli)` — either patch the
    placeholder row to the real paneId, or insert a fresh agent row when `--workspace`
    wasn't requested.
  - Extract `rollbackSpawn(db, opts, paneId, hasWorkspace)` — collapses the two
    near-identical 5-line cleanup blocks (post-finalize and post-liveness) into one.
  - Replace `\"%pending-\"` magic-string with `PENDING_PANE_PREFIX` constant + a
    small `pendingPaneIdFor(name)` helper, exported so refreshAgentTitle and the
    rationale block reference one source.
  - Drop the 18-line \"rejected designs\" narration from spawnAgent — the helper names
    speak for themselves; the actual cross-module rationale lives in the
    PENDING_PANE_PREFIX docstring + the existing dryRun rationale block.

Defer Option 2 (the real win — eliminate the placeholder) and Option 5 (flip dryRun
default) as separate, properly-scoped follow-ups. File them as new tasks with this
analysis as the seed.

────────────────────────────────────────────────────────────────────
FOLLOW-UP TASKS TO FILE (out of scope here)
────────────────────────────────────────────────────────────────────
  T1: refactor_spawn_eliminate_pending_pane_placeholder
      Implement Option 2. Splits createWorkspace into createWorkspaceDir +
      recordWorkspaceRow; restructures spawn flow to ws-dir → pane → atomic
      dual-insert; deletes PENDING_PANE_PREFIX + the refreshAgentTitle special
      case. ~150 LOC, ~2-3 new test cases (mid-spawn pane-kill rollback,
      tx-failure-with-pane-alive cleanup).
  T2: refactor_reconcile_dry_run_default_true
      Flip listLiveAgents/reconcile default to dryRun: true; mu agent list opts
      in to dryRun: false; ~10 test callsites updated; 1 doc block removed.
  T3 (after migrations land): consider DEFERRABLE FK on vcs_workspaces.agent.
```
