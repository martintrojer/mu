---
id: "testreview_acceptance_settimeout_race"
workstream: "mufeedback-v03"
status: CLOSED
impact: 45
effort_days: 0.3
roi: 150.00
owner: null
created_at: "2026-05-10T11:33:25.079Z"
updated_at: "2026-05-10T12:24:24.861Z"
blocked_by: []
blocks: []
---

# test-review: acceptance.test.ts uses raw setTimeout sleeps instead of polling for tmux state

## Notes (1)

### #1 by "reviewer-2", 2026-05-10T11:33:41.247Z

```
FILES: test/acceptance.test.ts (line 203 sleep 200ms; line 213 sleep 100ms; line 247 view4 race)
FINDING: The acceptance test uses two `await new Promise((resolve) => setTimeout(resolve, 100|200))` waits between (a) spawning agents and reconciling, (b) killing bob's pane and observing the prune. AGENTS.md § Tests explicitly says: "Polling loops (50ms × 10 attempts) when waiting for state to propagate, NOT fixed sleeps." This is the canonical "everything works" gate; it should not have race-prone sleeps at the head.

Today this passes consistently because the operations are fast enough; on a loaded CI runner it's the obvious flake candidate. Symptom would be: view2.report.prunedGhosts === 0 (not 1) because reconcile fired before tmux had finished tearing down the pane. The test would then fail at `expect(view2.report.prunedGhosts).toBe(1)`.

WHY: The acceptance test is the load-bearing gate per AGENTS.md ("if this passes, MVP is done"); a single retry-able failure here erodes operator trust in the gate. The 100ms is NOT a real signal of pane death — tmux briefly reports a killed pane as still alive (the same waitForPaneGone helper exists in test/cli-task-wait.integration.test.ts for exactly this).

FIX-SKETCH: Lift the 50ms × N polling helper into a shared test utility (e.g. test/_env.ts adds `pollUntil(predicate, attempts=20, intervalMs=50)`):
  await pollUntil(async () => !(await paneExists(bob.paneId)));
  const view2 = await listLiveAgents(db, { workstream });
  expect(view2.report.prunedGhosts).toBe(1);
Apply at all 3 sleep sites in acceptance.test.ts and copy the same helper into the integration tests (which currently each carry their own waitForPaneGone duplicate).
```
