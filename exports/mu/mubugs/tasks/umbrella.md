---
id: "umbrella"
workstream: "mubugs"
status: CLOSED
impact: 75
effort_days: 0.1
roi: 750.00
owner: null
created_at: "2026-05-15T10:51:17.656Z"
updated_at: "2026-05-15T11:54:31.547Z"
blocked_by: ["bug_no_recovery_after_tmux_server_crash", "cr_attach_precheck", "cr_doctor_ghost_wording", "cr_pending_leak", "tr_placeholder_report_only", "tr_state_crash_entrypoint"]
blocks: []
---

# Reconciler: collapse status-only into full mode (closes bug_no_recovery_after_tmux_server_crash)

## Notes (3)

### #1 by "π - mu", 2026-05-15T10:52:19.456Z

```
GOAL
====
Fix bug_no_recovery_after_tmux_server_crash by simplifying the reconciler — not by adding new code paths. The pane-event-driven reaper has a structural blind spot: when the WHOLE tmux server crashes, no per-pane exit events fire, so the reaper never runs, and `mu state` continues reporting agents as alive against ghost panes.

ROOT CAUSE (after analysis with the user)
=========================================
The reconciler's step-1 prune loop already handles "pane is gone" correctly: it calls deleteAgent() which is the canonical reaper hub (snapshots stuck IN_PROGRESS tasks, reverts to OPEN with [reaper] notes, emits task reap events). All in one tx.

BUT: deleteAgent only fires when the reconciler runs in `mode: "full"`. And `mu state` (the verb the user actually polls — both directly and via the TUI's slow tick) runs in `mode: "status-only"`, which intentionally skips the prune+reap step.

WHY status-only EXISTS
======================
Historical: it was introduced to fix bug_agent_spawn_workspace_fk_failure. createWorkspace inserts a vcs_workspaces row with a FK to agents. A concurrent `mu state` poll could reap a mid-spawn placeholder agent (paneId starts with `%pending-`) before the spawn finished, blowing up the FK insert.

The fix landed as: read paths (mu state, mu agent attach) use status-only and skip pruning entirely; only mu agent list (the explicit "reconcile now" verb) uses full.

WHY status-only IS NOW UNNECESSARY
==================================
The reconciler ALREADY imports isPendingPaneId. The fix-it-properly solution to the placeholder race is: skip placeholder pane ids in step 1's prune loop, regardless of mode. Once that defensive skip is in, status-only's protective effect against mid-spawn races becomes redundant — the placeholder is protected by its own sentinel, not by mode.

For non-placeholder agents, the prune loop's logic is correct in either mode: if the pane id isn't in tmux's current pane list, the agent is gone. Reaping is the right response.

PLAN — TWO COMMITS, ORDERED BY RISK
====================================

Commit 1 — reconcile_pending_skip:
  Add `isPendingPaneId(agent.paneId)` check to reconcile() step 1's prune loop. Skip placeholder agents in ALL modes. Defensive — no observable behavior change for users today (status-only already skipped them implicitly because it skipped the whole prune step). The point is to make the placeholder protection independent of mode.

Commit 2 — collapse_status_only_mode:
  Remove the `status-only` mode from ReconcileMode. Both `mu state` and `mu agent list` use `mode: "full"`. The wholesale-tmux-crash bug fixes itself: when the session is gone, listPanesInSession returns [], all agents are ghosts, the prune loop deletes them and reaps their IN_PROGRESS tasks via deleteAgent. mu state shows the truth.

  KEEP the `report-only` mode — that exists for a different reason (mu doctor, mu undo: mutate nothing under any circumstance) and we don't want to lose it.

BEHAVIORAL CHANGE TO CALL OUT IN CHANGELOG
==========================================
The TUI's slow-tick (default ~5s) will now reap agents whose pane has gone missing, where before it would have shown them as still-alive until the next mu agent list. This is CORRECT behavior — the user wants to see "agent reaped" in real time when a pane dies. But it's a visible behavior change worth a CHANGELOG line.

DAG ORDER
=========
reconcile_pending_skip → collapse_status_only_mode → {code_review, test_review} → umbrella
                                                  → bug_no_recovery_after_tmux_server_crash → umbrella

OPEN DECISIONS (resolved)
=========================
- New "lost" agent state: REJECTED. The existing reaper deletes agent rows; the audit trail lives in agent_logs. We don't need to preserve a row to remember the agent was there. This matches the existing per-pane-death reaper's behavior — no new vocabulary.
- mu workstream reap --respawn / --rescue-diffs: REJECTED for v1. Spawn args aren't persisted (would need schema change) and workspace dirs already survive a tmux crash so manual `cd $(mu workspace path X) && git diff` is fine. File later if real friction shows up.
- Periodic background probe on every mu invocation: REJECTED as too expensive (mu state is called every TUI tick). The reconciler IS the periodic probe; making it actually reap on `mu state` (via the mode collapse) is the right home.

NON-GOALS
=========
- No new agent statuses.
- No new verbs.
- No spawn-args persistence.
- No automatic respawn.
- No schema changes.
- No new substrate.

PILLAR CHECK
============
- Anti-feature pledge "no anticipatory abstractions": holds. We're REMOVING a mode, not adding one.
- Anti-feature pledge "no daemon": holds. No background process; the reconciler runs inline as before.
- "Be small": holds. Net LOC should be NEGATIVE (collapse removes mode plumbing).
```

### #2 by "π - mu", 2026-05-15T11:54:30.624Z

```
SESSION SUMMARY — reconciler mode collapse SHIPPED
==================================================

5 commits shipped to origin/main:

  fd181a4  reconcile: skip placeholder pane ids in prune loop (defensive, all modes)
  eb3c6fc  reconcile: collapse status-only into full; mu state now reaps lost sessions
  e0ace82  tests: workspace-staleness uses placeholder pane id post-collapse  [orchestrator fixup]
  a5afcf0  reconcile: isolate placeholder skip to step 1 + cover report-only mode (review wave A)
  0183608  reconcile/cli: extend reaper coverage to mu agent attach + crash-regression entrypoint + doctor wording (review wave B)

DELIVERED
=========
1. ReconcileMode collapsed: status-only → full. Two modes remain (full, report-only). Net LOC negative.
2. Defensive placeholder-skip in reconcile() step 1 makes the collapse safe across modes; placeholders no longer leak into step 2 (status detection) or step 3 (orphan exclusion).
3. mu state, mu agent attach, and the TUI dashboard slow-tick all now invoke full reconciliation. Wholesale tmux-server-crash agents are reaped within one reconcile interval — bug_no_recovery_after_tmux_server_crash CLOSED.
4. Crash-regression test exercises the actual signal: list-panes -s exits non-zero with "no server running" stderr (which listPanesInSession swallows). Asserts the full reap chain through mu state entrypoint.
5. Doctor wording corrected for post-collapse reality (report-only doctor surfaces no longer claim to reap).
6. Workspace-staleness integration test fixture migrated to placeholder pane id (caught by orchestrator's full-tier gate; the only test broken by the behavior change).

REVIEWERS
=========
code_review filed 3 findings; test_review filed 2. Triage:
  All 5 ACCEPTED; 0 rejected.
  Wave A (worker-1, 1 commit): cr_pending_leak + tr_placeholder_report_only — invariant tightening + report-only test coverage.
  Wave B (worker-2, 1 commit): tr_state_crash_entrypoint + cr_attach_precheck + cr_doctor_ghost_wording — entrypoint regression test + attach precheck reorder + doctor wording.

TEST COUNTS (final)
===================
- Fast tier: 1426 passing
- Full tier: 2499 passing
- New test files: test/state-crash-recovery.integration.test.ts (entrypoint-level reap regression).

DESIGN PRINCIPLES UPHELD
========================
- Anti-feature pledge "no anticipatory abstractions": REMOVED a mode rather than adding one.
- "Be small": net LOC negative on the impl commits. Review-fix waves added small targeted coverage + a tiny CLI reorder.
- Reaper substrate unchanged: deleteAgent() is still the canonical reaper hub; the fix was making more callsites reach it, not adding parallel reap paths.
- No new agent statuses, no new verbs, no schema changes.

ORCHESTRATOR COMMENTARY
=======================
The original bug report asked for ~5 features (lost state, mu workstream reap --respawn, --rescue-diffs, periodic background probe, etc). After triage, the actual fix turned out to be REMOVING a mode rather than adding code paths. Smallest possible substrate change; user-facing behavior change ships in CHANGELOG. The bug report's repro recipe now exits cleanly: agents reaped, IN_PROGRESS reverted, [reaper] notes emitted.

The orchestrator's e0ace82 fixup (collateral test breakage) is the canonical signal for why workers run fast tier and orchestrator runs full at push gate. Caught at push, fixed in 30 seconds, shipped in the next commit.

HEAD: 0183608
```

### #3 by "π - mu", 2026-05-15T11:54:31.547Z

```
CLOSE: 0183608 mubugs reconciler-collapse feature shipped: 5 commits, 1426 fast / 2499 full, all 8 findings resolved (0 rejected), bug_no_recovery_after_tmux_server_crash closed
```
