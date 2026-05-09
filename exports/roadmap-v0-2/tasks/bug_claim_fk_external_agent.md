---
id: "bug_claim_fk_external_agent"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-08T05:29:33.083Z"
updated_at: "2026-05-08 05:48:50"
blocked_by: ["adopt_impl"]
blocks: []
---

# BUG: mu task claim fails with FK error when claimer agent isn't in the DB (cross-pi-session use)

## Notes (2)

### #1 by system, 2026-05-08T05:30:22.837Z

```
Surfaced immediately after the v2 ON UPDATE CASCADE migration cleaned 46 orphan owners on the live DB. The FK on tasks.owner is now strictly enforced, so 'mu task claim' from a pi session that wasn't itself spawned by mu (the same pattern that historically created the 46 orphans) errors with bare 'FOREIGN KEY constraint failed' instead of silently writing the orphan.

Reproduction (every 'main orchestrator' invocation):
  1. Run pi outside any 'mu agent spawn' (e.g., 'pi -s mu' from the host shell).
  2. mu task claim <id> -w <ws>
  3. -> 'error: FOREIGN KEY constraint failed' (no actionable message, no exit-code class for it).

Workaround used right now: 'mu sql UPDATE tasks SET status=IN_PROGRESS, updated_at=datetime(now) WHERE local_id=...' — leaves owner=NULL. Awkward; defeats the point of typed claim verb.

Why this matters more than other nits:
  - It's the orchestrator's own loop (the one running this work) that hits it.
  - Every time. Promotion-by-occurrence already cleared on first invocation.
  - Bare 'FOREIGN KEY constraint failed' is a poor error message; user has no obvious next step.

Fix options considered:
  (a) Auto-INSERT a synthetic 'external' agents row on first claim from outside mu.
      ✗ Pollutes 'mu agent list' with phantom rows.
  (b) Drop the FK on tasks.owner; revert to soft-FK as before v2.
      ✗ Regression; we just hardened it. The FK catches real bugs (typo'd owner names, deleted-agent re-claims).
  (c) At claim time, detect TMUX_PANE not in agents table and write status=IN_PROGRESS WITHOUT owner (anonymous claim). Surface a warning.
      ✓ Preserves FK invariant.
      ✓ Lets external pi sessions still drive the task graph.
      ✗ Loses provenance.
  (d) Synthesize an agent name from the pane title (the claim protocol identity step) and require it pre-exist as an agents row. If it doesn't, error with a useful message: 'this pane (%6441 "π - mu") isnt a registered mu agent — run mu adopt first.'
      ✓ Forces the user toward mu adopt (which is exactly what were building right now in adopt_impl).
      ✓ The error message tells the user what to do.
      ✓ Preserves FK invariant AND provenance.
      ✗ Requires mu adopt to ship first (so this bug is BLOCKED by adopt_impl).

Recommendation: option (d). Wait until mu adopt ships, then update the claim path to give a self-curing error message (suggest 'mu adopt <pane-id>'). Estimated 10 LOC + 2 tests in src/tasks.ts.

Side note: this same FK-failure mode exists for any verb that writes tasks.owner from outside mus spawn loop. mu task release is OK (sets owner=NULL). mu agent close is OK (cascade SET NULL). The only entry points that create orphans are claim and direct SQL.
```

### #2 by system, 2026-05-08T05:48:50.835Z

```
SHIPPED. The bare 'FOREIGN KEY constraint failed' has been replaced with a typed ClaimerNotRegisteredError. The error includes:
  - the resolved claimer name (so the user knows what mu thinks they're called)
  - the pane id when resolved from $TMUX_PANE (with the exact 'mu adopt %<pane>' command to fix it)
  - a fallback hint suggesting --for when the name came from --for itself

Live dogfood proof:
  $ mu task claim bug_claim_fk_external_agent -w roadmap-v0-2
  conflict: claimer 'π - mu' (pane %6441) is not a registered mu agent (no row in agents table).
    Register this pane with: mu adopt %6441
  exit: 4

  $ mu task claim bug_claim_fk_external_agent --for ghost-agent
  conflict: claimer 'ghost-agent' is not a registered mu agent (no row in agents table).
    Pass --for <agent> to claim as a registered agent.
  exit: 4

The check is a tiny SELECT 1 FROM agents WHERE name=? before the UPDATE — adds essentially no overhead. The atomic CAS on owner is preserved (the rejection happens BEFORE the transaction begins).

Implementation: ClaimerNotRegisteredError class in src/tasks.ts (~25 LOC including doc), pre-check in claimTask (~12 LOC), error mapping in src/cli.ts (1 line), SDK re-export in src/index.ts (1 line), 3 tests. Net ~50 LOC; well under the 'subtractive over additive' bar.

The orchestrator's own pane (%6441 in tmux session 'mu') still can't claim into 'roadmap-v0-2' because the pane lives in a different tmux session — but that's a scope-correctness invariant of mu (workstream isolation), not a bug. The error message correctly tells the user how to register their pane (mu adopt) and the cross-session rejection from adopt itself tells them the pane is in the wrong session.
```
