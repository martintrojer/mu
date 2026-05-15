---
id: "collapse_status_only_mode"
workstream: "mubugs"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: null
created_at: "2026-05-15T10:51:18.307Z"
updated_at: "2026-05-15T11:10:29.896Z"
blocked_by: ["reconcile_pending_skip"]
blocks: ["bug_no_recovery_after_tmux_server_crash", "code_review", "test_review"]
---

# Collapse status-only → full; mu state and mu agent list use one mode

## Notes (4)

### #1 by "π - mu", 2026-05-15T10:53:16.460Z

```
TASK
====
Collapse the `status-only` reconcile mode into `full`. After this lands, the `ReconcileMode` type has two variants: `"full"` (the only mutating mode) and `"report-only"` (mutate nothing). Both `mu state` and `mu agent list` use `"full"`.

PRECONDITION
============
reconcile_pending_skip is closed and on main. The placeholder skip is the safety net that makes this collapse safe.

WHY
===
status-only existed to protect mid-spawn placeholders from being reaped during a `mu state` poll. With the placeholder skip in place from the previous commit, that protection is now mode-independent. The status-only mode's only remaining job becomes "skip the prune step", which is exactly what's preventing the bug_no_recovery_after_tmux_server_crash from auto-fixing itself.

When the WHOLE tmux session is gone, listPanesInSession returns [], every agent is a ghost, and the prune loop's deleteAgent reaps their IN_PROGRESS tasks correctly. We just need to actually run the prune loop on read paths.

SCOPE
=====

1. src/reconcile.ts:
   - Change `export type ReconcileMode = "full" | "status-only" | "report-only";` → `export type ReconcileMode = "full" | "report-only";`
   - Remove the status-only branch from any switch/conditional in reconcile().
   - Update doc comments to remove status-only references; document the simplification.
   - Keep the prune-loop's existing structure (placeholder skip from prior commit + deleteAgent on prune).

2. src/agents.ts (listLiveAgents):
   - Update the JSDoc on ListLiveAgentsOptions.mode: remove status-only.
   - The default mode parameter stays `"full"`.

3. CALLERS — find every `mode: "status-only"` callsite via `rg -n 'status-only|"status-only"' src/` and convert each:
   - Most should just drop the `mode` option entirely (defaults to `"full"`).
   - Keep `report-only` callers (mu doctor, mu undo) untouched.

4. TESTS — find every test that explicitly tests status-only mode via `rg -n 'status-only' test/`:
   - Tests that asserted "status-only does NOT prune" need rewriting to test the new contract: full prunes; report-only does not.
   - Tests that asserted "status-only updates status without pruning" should be merged into full-mode tests (full updates status AND prunes; the status-update behavior is unchanged).
   - Delete redundant tests that exercise the removed mode.

5. CHANGELOG.md (under [0.4.2] — unreleased; create the section if missing):
   ### Changed
   - **TUI dashboard / `mu state`**: agents whose tmux pane has disappeared are now reaped on the next reconcile pass (slow-tick on the TUI; immediate on CLI invocations). Previously these reads ran in `status-only` mode which skipped reaping; ghost agents lingered in `mu state` output until the operator ran `mu agent list`. The visible effect: when a tmux session disappears (server crash, manual `tmux kill-server`, etc.), `mu state` and the TUI now report the truth — agents removed from the registry, their IN_PROGRESS tasks reverted to OPEN with `[reaper]` notes — within one reconcile interval. Closes the gap reported in `bug_no_recovery_after_tmux_server_crash` (mubugs workstream).
   ### Removed
   - Internal `ReconcileMode = "status-only"` variant. The placeholder-pane protection that motivated it is now defensive in the reconcile() prune loop itself, independent of mode.

TEST COVERAGE
=============
1. Wholesale tmux-session-disappearance: simulate via mocked tmux executor returning empty pane list AND sessionExists=false. Assert: every registered agent is deleted, their IN_PROGRESS tasks revert to OPEN with [reaper] notes, task reap events fire.
2. Existing per-pane-death reaper tests stay green (same mechanism, just now reachable from more callsites).
3. Placeholder protection still works in full mode (covered by reconcile_pending_skip tests; verify they still pass after the collapse).
4. report-only mode still mutates nothing (regression guard for mu undo's snap_undo_reconcile_destroys_recovered_agents fix).

VERIFY
======
- rg -n 'status-only' src/ → only doc/comment references in CHANGELOG/historical context should remain (or zero)
- rg -n 'status-only' test/ → zero
- npm run typecheck && npm run lint
- npm run test:fast
- npm run build
- node dist/cli.js --help

CONSTRAINTS
===========
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1 (refreshed before this task lands).
- ESM, strict types, no `any`, no non-null assertions.
- LOC: net NEGATIVE expected (removing a mode + its tests).
- Single commit covering src + tests + CHANGELOG.
- Biome auto-fix is fine; never `--write --unsafe`.

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean:

  mu task close collapse_status_only_mode -w mubugs --evidence '<sha> ReconcileMode collapsed; status-only callers migrated to full; tests rewritten; bug_no_recovery_after_tmux_server_crash closes as side effect'

  Then close the bug task itself with the same sha:
  mu task close bug_no_recovery_after_tmux_server_crash -w mubugs --evidence '<sha> reaper now fires on read paths via collapse_status_only_mode; original symptom (mu state lying after tmux server crash) no longer reproducible — repro recipe verified manually.'
```

### #2 by "π - mu", 2026-05-15T11:02:58.113Z

```
You are worker-1 in workstream `mubugs`. Claim is set on you for `collapse_status_only_mode`.

YOUR TASK: collapse_status_only_mode — remove the `status-only` reconcile mode. After this lands, ReconcileMode = `"full" | "report-only"`. Both `mu state` and `mu agent list` use `"full"`.

PRECONDITION
============
reconcile_pending_skip is on main (fd181a4). The placeholder skip is the safety net that makes this collapse safe.

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w mubugs
  mu task notes collapse_status_only_mode -w mubugs
  mu task notes reconcile_pending_skip -w mubugs    # the prep commit that makes this safe

The collapse_status_only_mode task note has the precise scope (5 work items: src/reconcile.ts, src/agents.ts, callsite migration, test rewrite, CHANGELOG entry).

STEP 2 — read the existing pieces:
  src/reconcile.ts — note ReconcileMode type, the mode-aware deleteAgent call in step 1, mode-aware status-detection skip in step 2.
  src/agents.ts ListLiveAgentsOptions.mode — JSDoc references status-only.
  rg -n 'status-only|"status-only"' src/   # find every callsite to migrate
  rg -n 'status-only' test/                # find every test that needs rewriting or deletion

STEP 3 — implement per the task note. Summary of the 5 work items:

  WORK ITEM A — src/reconcile.ts:
    - ReconcileMode type drops "status-only".
    - reconcile() removes any conditional that was specific to status-only. The two existing conditions (mode === "full" for prune, mode !== "report-only" for status detection) need updating: the status-detection condition must become `mode === "full"` since "report-only" is the only remaining non-full mode and it must skip status detection.
    - Update doc comments to remove status-only references; document the simplification (the prep-commit's defensive placeholder skip is what made this collapse safe).

  WORK ITEM B — src/agents.ts:
    - ListLiveAgentsOptions.mode JSDoc: drop the status-only paragraph; keep the report-only paragraph (mu doctor, mu undo). Default mode stays "full".

  WORK ITEM C — Callsites:
    - For each callsite that previously passed `mode: "status-only"`, drop the option entirely (default is "full").
    - Most likely candidates: src/cli/state.ts (mu state); maybe src/cli/agents.ts (mu agent attach if it uses status-only).

  WORK ITEM D — Tests:
    - Find every test that referenced `status-only`. Rewrite or delete:
      - "status-only does NOT prune" tests → delete (the contract no longer exists; full prunes).
      - "status-only updates status without pruning" tests → merge into full-mode tests if the status-update behavior isn't already covered.
      - "report-only does NOT mutate" tests → keep (regression guard for snap_undo_reconcile_destroys_recovered_agents).
    - Add a NEW test for the wholesale-tmux-crash regression: mocked tmux executor returns empty pane list (and sessionExists=false if the reconciler checks that — which it doesn't currently, that's the whole point: empty pane list IS the signal). Assert all agents deleted, IN_PROGRESS tasks reverted to OPEN with [reaper] notes, task reap events emitted. This test goes in test/reconcile.integration.test.ts (since the existing reconcile tests live there).

  WORK ITEM E — CHANGELOG.md:
    Add or extend the [0.4.2] — unreleased section per the umbrella note's spec. Both ### Changed (TUI/mu state behavior change) and ### Removed (internal ReconcileMode = status-only variant) entries. Mention closure of bug_no_recovery_after_tmux_server_crash explicitly.

STEP 4 — verification queries:
  rg -n 'status-only' src/ test/
  Expected: zero, OR only doc/comment historical references in CHANGELOG history (not the new entry).

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify FAST GREENS + bundle smoke (workers run fast tier; orchestrator runs full at push gate):
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run build
  node dist/cli.js --help

STEP 7 — commit (single commit covering src + tests + CHANGELOG):
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1
  git add -A
  git commit -m 'reconcile: collapse status-only into full; mu state now reaps lost sessions

The reconciler had three modes (full / status-only / report-only).
status-only was a workaround for a mid-spawn race that was fixed
properly in the previous commit by adding a defensive placeholder
skip to the prune loop in all modes. With that safety net in place,
status-only collapses into full without observable change for any
callsite that uses the placeholder protection.

The user-visible benefit: mu state and the TUI dashboard (which
previously ran in status-only and skipped reaping) now reap agents
whose pane has disappeared. Closes the gap reported in
bug_no_recovery_after_tmux_server_crash where a wholesale tmux
server crash left mu state showing dead agents as alive forever.

Net LOC negative.'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, do TWO closes:

  mu task close collapse_status_only_mode -w mubugs --evidence '<sha> ReconcileMode collapsed; status-only callers migrated; tests rewritten; CHANGELOG updated; net LOC negative'

  mu task close bug_no_recovery_after_tmux_server_crash -w mubugs --evidence '<sha> mu state now reaps lost sessions via the collapse; original bug repro recipe verified — agents are now deleted + tasks reverted + [reaper] notes emitted within one reconcile interval after a wholesale tmux server crash.'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1 (just recreated; HEAD = fd181a4 placeholder skip).
- ESM, strict types, no `any`, no non-null assertions.
- LOC: NET NEGATIVE expected (removing a mode + plumbing).
- Single commit covering src + tests + CHANGELOG.
- Biome auto-fix is fine; never `--write --unsafe`.
```

### #3 by "worker-1", 2026-05-15T11:10:26.379Z

```
FILES: src/reconcile.ts, src/agents.ts, src/state.ts, src/cli/{state,agents,snapshot}.ts, src/doctor-summary.ts, src/agents/spawn.ts, src/cli/tasks/claim.ts, test/reconcile.integration.test.ts, test/verbs-listlive.integration.test.ts, TUI fixture tests, CHANGELOG.md
COMMANDS: mu task notes umbrella/collapse_status_only_mode/reconcile_pending_skip; rg status-only src/test; npx biome check --write src test; npm run typecheck; npm run lint; npm run test:fast; npm run build; node dist/cli.js --help; npx vitest run test/reconcile.integration.test.ts test/verbs-listlive.integration.test.ts; git commit
FINDINGS: ReconcileMode now has only full/report-only. The pending-pane skip from fd181a4 protects workspace pre-stage placeholders directly, so mu state and attach can use default full reconciliation safely.
DECISION: Removed status-only mode and migrated read-path callers to default full. Kept report-only for doctor/undo. Updated TUI test fixtures to use report-only where the mode is irrelevant fixture data.
VERIFIED: typecheck, lint, fast tier, build, CLI help, and focused reconcile/listLive tests all pass. rg -n status-only src/ test/ returns zero.
ODDITIES: npm install was needed because node_modules was absent; package-lock was restored so no dependency/version diff remains.
```

### #4 by "worker-1", 2026-05-15T11:10:29.896Z

```
CLOSE: 65ec5d9 ReconcileMode collapsed; status-only callers migrated; tests rewritten; CHANGELOG updated; net LOC negative
```
