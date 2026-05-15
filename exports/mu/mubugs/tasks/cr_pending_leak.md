---
id: "cr_pending_leak"
workstream: "mubugs"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-15T11:37:20.995Z"
updated_at: "2026-05-15T11:47:52.649Z"
blocked_by: []
blocks: ["umbrella"]
---

# Code review: placeholder skip leaks past prune loop

## Notes (3)

### #1 by "worker-1", 2026-05-15T11:37:24.447Z

```
FILE/LINE: src/reconcile.ts:145, src/reconcile.ts:167, src/reconcile.ts:191
WHAT'S WRONG: Placeholder pane ids are pushed into the generic survivors array, which forces step 2 to keep an isPendingPaneId() status-detection skip and lets step 3 build dbPaneIds from placeholder survivors. The review checklist/design says the placeholder sentinel must be isolated to step 1's prune loop; downstream status detection and orphan surfacing should reason about real tmux panes, not fake pane ids.
WHY IT MATTERS: Functionally this is mostly masked because real tmux pane ids are numeric, but it weakens the intended invariant and leaves sentinel-aware special cases in later phases. Future orphan/status changes can accidentally treat protected placeholders as live panes instead of simply non-pruned rows.
SUGGESTED FIX: Split the concepts: in step 1, skip deletion/counting for isPendingPaneId() rows but do not add them to the normal live-pane survivors/status-candidates set. Iterate status detection over agents whose paneId was present in tmuxByPaneId, and build step-3 dbPaneIds from real tmux-matched registered panes. That removes the step-2 isPendingPaneId() branch and keeps the placeholder protection local to prune.
SEVERITY: medium
```

### #2 by "π - mu", 2026-05-15T11:41:48.750Z

```
You are worker-1 in workstream `mubugs`. You have TWO claims:
  1. cr_pending_leak                (MEDIUM — tighten placeholder isolation to step 1 of reconcile())
  2. tr_placeholder_report_only     (MEDIUM — add report-only placeholder skip test)

Bundled because they both touch src/reconcile.ts + test/reconcile.integration.test.ts. Land them as ONE commit.

STEP 1 — read context:
  mu task notes umbrella -w mubugs
  mu task notes cr_pending_leak -w mubugs
  mu task notes tr_placeholder_report_only -w mubugs

STEP 2 — read the existing pieces:
  src/reconcile.ts (steps 1, 2, 3 — note the current placeholder leak: pending agents land in `survivors`, then step 2's status loop has its own `isPendingPaneId` skip, and step 3 uses `dbPaneIds` derived from survivors which includes placeholder ids — exactly the leakage cr_pending_leak flags).
  test/reconcile.integration.test.ts — note the existing full-mode placeholder-skip test; you'll add a parallel one for report-only.

STEP 3 — implement BOTH fixes in one commit:

  FIX A — cr_pending_leak (tighten isolation):
    - In reconcile() step 1, split placeholder rows OUT of `survivors`. Maintain them as `pendingSurvivors: AgentRow[]` (or similar). They should not be pruned/counted (existing behavior preserved), but they should NOT be in the set step 2 iterates for status detection or the set step 3 uses to build `dbPaneIds`.
    - In step 2: drop the `if (isPendingPaneId(...)) continue;` line — it's no longer needed because pending agents aren't in `survivors`.
    - In step 3: keep `dbPaneIds` derived from `survivors` (real-pane survivors only), so placeholder pane ids never end up in the orphan-exclusion set. Real pane ids are numeric so this would never have hit a real bug, but the invariant is now clean.

  FIX B — tr_placeholder_report_only (test the invariant in report-only mode too):
    - Add a test in test/reconcile.integration.test.ts mirroring the existing full-mode placeholder-skip test, but with `mode: "report-only"`. Assert:
      - report.mode === "report-only"
      - prunedGhosts === 0
      - the pending agent row survives (still in DB)
      - no capturePane / status-detection happens for the pending row (verify by mocking and asserting the mock wasn't called for that pane id)

STEP 4 — verify nothing else broke:
  rg -n "isPendingPaneId" src/reconcile.ts   # should appear once now (in step 1's prune branch), not twice
  npm run typecheck && npm run lint && npm run test:fast && npm run build
  node dist/cli.js --help

STEP 5 — commit (single commit covering both fixes):
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1
  git add -A
  git commit -m 'reconcile: isolate placeholder skip to step 1 + cover report-only mode (review wave A)

cr_pending_leak: placeholder pane ids previously leaked from step 1
into step 2 (status detection had a redundant isPendingPaneId skip)
and step 3 (dbPaneIds for orphan exclusion was built from a
survivors set that included placeholders). Functionally masked
because real tmux pane ids are numeric, but the design invariant
says "isolated to step 1". Split out a pendingSurvivors set in step
1; survivors is now real-pane-only; step 2 drops its redundant
skip; step 3 derives dbPaneIds from real survivors.

tr_placeholder_report_only: the existing placeholder-skip test only
covered full mode. Add a parallel report-only test asserting
prunedGhosts=0, the pending row survives, and no capturePane fires
for it. Defensive against a future refactor that might recreate
mid-spawn false positives in doctor/undo/TUI doctor summaries.

Closes cr_pending_leak / tr_placeholder_report_only.'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, close BOTH tasks with the same sha:

  mu task close cr_pending_leak -w mubugs --evidence '<sha> placeholder skip isolated to step 1; status detection + orphan exclusion no longer see placeholder pane ids'
  mu task close tr_placeholder_report_only -w mubugs --evidence '<sha> report-only placeholder skip test added; prunedGhosts=0, row survives, no capturePane fires'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1 (recreated; HEAD = e0ace82).
- ONE commit covering both fixes.
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 60 net (a small refactor + one test).
- No CHANGELOG.
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT touch src/cli/agents.ts, src/cli/doctor.ts, src/doctor-summary.ts (worker-2 territory).

COORDINATION WARNING
- worker-2 in parallel on wave B (tr_state_crash_entrypoint + cr_attach_precheck + cr_doctor_ghost_wording). Their changes touch src/cli/agents.ts + src/cli/doctor.ts + add a new test entrypoint. No file overlap with you. CHANGELOG: neither commit touches it.
```

### #3 by "worker-1", 2026-05-15T11:47:52.649Z

```
CLOSE: 385ead2 placeholder skip isolated to step 1; status detection + orphan exclusion no longer see placeholder pane ids
```
