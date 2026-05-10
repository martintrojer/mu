---
id: "snap_undo_reconcile_destroys_recovered_agents"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 85
effort_days: 0.5
roi: 170.00
owner: null
created_at: "2026-05-08T14:21:21.891Z"
updated_at: "2026-05-08T14:39:07.113Z"
blocked_by: ["snap_dogfood"]
blocks: []
---

# mu undo + workstream-destroy: reconcile prunes the recovered agent row + cascades vcs_workspaces away

## Notes (2)

### #1 by worker-1, 2026-05-08T14:38:50.371Z

```
SHIPPED: Option C, narrowed to "post-restore reconcile is dry-run".

═══ FILES ═══

MODIFIED (source, 13 net non-comment LOC across 2 files):
  src/reconcile.ts                +5 net
    - ReconcileOptions: gains `dryRun?: boolean` (with docstring
      naming snap_dogfood Finding 2 + this task as the trigger).
    - ReconcileReport: gains `dryRun: boolean` (lets callers
      switch their output text without re-deriving from options).
    - reconcile(): step 1 (prune) skips deleteAgent when dryRun;
      step 2 (status detect) is wrapped in `if (!dryRun)`; step 3
      (orphan surface) runs unchanged. prunedGhosts is still
      counted in dryRun mode (becomes "would-be-pruned"
      semantically).
    - Default dryRun: false → mu agent list / mu doctor unchanged.

  src/cli.ts                      +8 net
    - cmdUndo's reconcile loop now passes `dryRun: true`.
    - JSON shape: `reconcile.ghostsPruned` → `wouldBePrunedGhosts`;
      `statusChanges` removed (always 0); `dryRun: true` added.
    - Human heading: "Reconcile (tmux NOT rolled back)" →
      "Reconcile (tmux NOT rolled back; rows NOT pruned)".
    - First metric line: "agents pruned (DB row → dead pane): N" →
      "would-be-pruned (DB row → dead pane): N (suppressed: rows
      preserved as restored)".
    - New nextStep advertising the escape hatch:
      "Confirm + actually prune dead-pane rows you don't want to
       re-spawn : mu agent list -w <ws>"

NEW TESTS (test-only):
  test/reconcile.test.ts          +5 unit tests (~57 LOC)
    1. counts ghosts but does NOT delete
    2. counter-test: non-dryRun pass right after still prunes
    3. status-detect skipped (statusChanges always 0)
    4. orphan-surface still runs in dryRun mode
    5. REGRESSION: snap_dogfood Finding 2 shape

  test/snapshots.test.ts          +2 end-to-end SDK tests (~49 LOC)
    1. restore + dryRun reconcile preserves recovered agent + workspace
    2. counter-test: same scenario WITHOUT dryRun loses the rows
       (proves the fix is load-bearing)

  test/cli-snapshot.test.ts       +1 line shift
    - Updated JSON shape assertion (renamed field).
    - Updated heading-text assertion ("...; rows NOT pruned").

CHANGELOG.md updated with new "### Fixed" subsection under
[Unreleased] (the live smoke-test transcript inline).

═══ COMMANDS ═══
  git pull origin main                       # fast-forward to 8afe300
  npm install                                # clean
  npm run typecheck                          # clean
  npm run lint                               # clean
  npm run test                               # 709/711 (2 pre-existing
                                              claimTask --self flakes;
                                              same as last 3 tasks)
  npm run build                              # clean: dist/cli.js 245KB
End-to-end smoke against a temp DB (verified bug is fixed):
  rm -rf /tmp/mu-undo-fix-smoke
  MU_STATE_DIR=/tmp/mu-undo-fix-smoke MU_DB_PATH=/tmp/mu-undo-fix-smoke/mu.db node dist/cli.js workstream init dogfix
  MU_STATE_DIR=...                  node dist/cli.js task add design -w dogfix --title D --impact 80 --effort-days 1
  # Insert agent + vcs_workspaces row via mu sql (skips tmux spawn complexity)
  MU_STATE_DIR=...                  node dist/cli.js sql "INSERT INTO agents ..."  → 1 row affected
  MU_STATE_DIR=...                  node dist/cli.js sql "INSERT INTO vcs_workspaces ..." → 1 row affected
  MU_STATE_DIR=...                  node dist/cli.js workstream destroy -w dogfix --yes
  MU_STATE_DIR=...                  node dist/cli.js undo --yes
    → "would-be-pruned (DB row → dead pane) : 1 (suppressed: rows preserved as restored)"
  MU_STATE_DIR=...                  node dist/cli.js sql "SELECT name FROM agents WHERE workstream='dogfix'"
    → dog-1 (✅ restored AND preserved)
  MU_STATE_DIR=...                  node dist/cli.js sql "SELECT agent FROM vcs_workspaces WHERE workstream='dogfix'"
    → dog-1 (✅ FK CASCADE didn't fire because the row wasn't pruned)
  MU_STATE_DIR=...                  node dist/cli.js agent list -w dogfix
    → (no agents)        # mu agent list IS the escape hatch — still prunes
  MU_STATE_DIR=...                  node dist/cli.js sql "SELECT name FROM agents WHERE workstream='dogfix'"
    → (no rows)          # legit prune happened on the user's explicit ask

═══ FINDINGS ═══

  - The contract this defends ("the restore brings back the
    snapshot's rows verbatim; reconcile reports drift but MUST
    NOT mutate rows the restore just brought back") is symmetric
    with `mu agent list`'s contract ("reality wins; ghost rows
    get pruned"). Both are right; they're answering different
    questions. The fix lets the user choose: `mu undo` preserves
    state; `mu agent list` reconciles state. Live smoke confirms
    both flows.

  - Choosing dryRun (Option C) over Option A (skip reconcile)
    matters because the orphan-surface pass IS still useful
    info post-restore — it tells the user which tmux panes
    exist that the restored DB doesn't know about. Option A
    would have lost that signal. Option C keeps it.

  - Status-detect was the trickiest call. In dryRun mode it'd
    technically be safe to RUN status detect (just don't write).
    But updateAgentStatus + refreshAgentTitle BOTH mutate the
    DB, and refreshAgentTitle even pushes to tmux. Skipping
    the whole step is the cleanest "no mutation" interpretation
    and shrinks the LOC. If status-detect-without-write is ever
    needed elsewhere, it's a future refactor.

═══ DECISION ═══

Picked **Option C** narrowed: "post-restore reconcile runs in
dryRun mode."

Why C over A (skip reconcile entirely):
  - Lose the orphan-surface signal entirely. The user's
    legitimate question "are there panes the DB doesn't know
    about?" stops getting answered.
Why C over B (read-only / report-only):
  - C IS B's strongest form. dryRun is exactly "read-only
    reconcile". The implementation reduces to a single boolean
    flag through one option struct, no plumbing through 4
    layers required.
Why narrow C to "all rows" rather than "track just-restored set":
  - The "just restored" set would require the reconcile pass to
    know which rows came from the snapshot vs which were
    already present. That's not knowable without comparing
    against the pre-restore state (which the restore destroyed).
    Treating "everything in the DB right after restore" as
    "just restored" is the right granularity AND matches the
    contract verbatim.
  - The escape hatch exists: `mu agent list` is the documented
    next step for "OK, NOW prune the dead-pane rows I don't
    want to re-spawn". Surfaced in the new nextStep block.

LOC: 13 net non-comment source + ~107 LOC tests. Well under the
<300 budget; no Option B fallback needed.

═══ NEXT ═══
  - The two ready follow-ups from snap_dogfood are still queued:
    cross_workstream_claim_for (ROI 200) and
    workspace_create_partial_dir_on_failure (ROI 120). Neither
    is on me; both are independent of this fix.
  - snap_dogfood-style pass against the new behaviour would be
    a nice follow-up: re-run Section D on the live DB and confirm
    the recovered agent + workspace stay put. The unit + smoke
    tests cover the same shape; a fresh dogfood would just add
    one more level of confidence.

═══ VERIFIED ═══
  - typecheck/lint/test/build gate: GREEN at 709/711 (the 2
    misses are the SAME pre-existing claimTask --self flakes
    from snap_schema's note #337 / snap_undo_verb's note #345).
  - 7 new tests across reconcile + snapshots; 81/81 in those
    files green.
  - Live smoke-test against a temp DB confirms the snap_dogfood
    Section D scenario is fixed end-to-end:
    * agents row survives mu undo
    * vcs_workspaces row survives (no FK CASCADE)
    * tasks + edges + notes still recovered (regression-free)
    * mu agent list still prunes (escape hatch intact)
  - The output text now honestly reflects what's happening:
    "would-be-pruned: N (suppressed: rows preserved as restored)"
    is more honest than the old "agents pruned: N" which was
    diagnostic but misleading because the prune was the bug.

═══ ODDITIES ═══
  - The dryRun flag is added to ReconcileOptions but only ONE
    call site (cmdUndo) uses it. That's intentional per the
    "no anticipatory abstractions" pledge: it solves the bug
    in the one place that has it. If a future caller needs
    "report drift without mutating", the API is already there;
    if not, the boolean costs nothing.
  - I chose to keep the prunedGhosts COUNT in dryRun mode (so
    the user can still see "you have N dead-pane rows the
    snapshot brought back"). The alternative — set
    prunedGhosts=0 in dryRun mode — would have been cleaner
    typing-wise but would have lost the "informational signal"
    the next-step block depends on.
  - The existing test `reconcile — empty cases` was using
    `toEqual` with a strict object literal; my new dryRun
    field broke it. Update was a 1-line addition. Same for
    one other test in the same file. No semantic change to
    those tests.
  - The cli-snapshot test's heading assertion was the gentlest
    possible regression catcher: it was `toContain("Reconcile
    (tmux NOT rolled back)")`. My new heading happens to still
    contain that substring. I tightened the assertion to the
    full new heading (";rows NOT pruned" included) so any
    future text drift is caught.
  - JSON shape change is a breaking change for any --json
    consumer of `mu undo`. Documented in the CHANGELOG entry
    under "### Fixed". Pre-fix consumers depending on
    `reconcile.ghostsPruned` get undefined. The semantics
    they're relying on were also wrong (the count claimed to
    be "agents pruned" but the prune was the bug); the new
    field name `wouldBePrunedGhosts` is honest.
  - The CHANGELOG entry I added went under "### Fixed" rather
    than "### Added" to make it clear this is bug fix correcting
    behaviour shipped in snap_undo_verb (commit 04ae96c). Same
    [Unreleased] block; no version stamp needed.
```

### #2 by π - mu, 2026-05-08T16:28:24.178Z

```
MERGED: worker-1 patch (CHANGELOG + src/cli.ts + src/reconcile.ts + 3 test files) merged to main as commit 08a1045 by orchestrator. Gate green: typecheck + lint + 710/710 tests + build. mu undo --yes round-trip live in /opt/homebrew/bin/mu (symlink into this checkout).
```
