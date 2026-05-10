---
id: "testreview_polling_helper_duplicated"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: null
created_at: "2026-05-10T11:34:53.688Z"
updated_at: "2026-05-10T12:29:47.063Z"
blocked_by: []
blocks: []
---

# test-review: tmux-state polling loops are duplicated across 3+ integration test files; lift into shared test/_env helper

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:35:13.510Z

```
FILES:
  test/cli-task-wait.integration.test.ts:88-93 (waitForPaneGone — 50ms × 20)
  test/acceptance.test.ts:204,213,247 (raw setTimeouts — should be polling instead)
  test/verbs.integration.test.ts (uses mixed pattern; some inline polls, some setTimeouts)
  test/claim.integration.test.ts (similar inline poll pattern)
  test/_env.ts (shared test infra; currently 47 LOC — perfect home)

FINDING: AGENTS.md prescribes "Polling loops (50ms × 10 attempts) when waiting for state to propagate, not fixed sleeps." The pattern is now hand-rolled in at least 3 integration test files (cli-task-wait.integration, claim.integration, verbs.integration) plus needed-but-missing in acceptance.test.ts. Each has slightly different attempt counts (10 vs 20) and different return shapes (some return boolean, some throw). One canonical helper would:
  (a) cure the acceptance-test sleep flakes (filed separately)
  (b) end the per-test "what's my polling shape" decision
  (c) make cleanup-related polling (waitForPaneGone, waitForOrphanCount, etc.) discoverable

WHY: This isn't urgent, but it's a small unforced cost — the 5 minutes a new contributor spends finding the right poll cadence multiplied across every new integration test. Test infrastructure is explicitly in scope per AGENTS.md ("test infrastructure beyond what's broken" is OUT of scope here, but the duplication that breeds inconsistency IS a finding).

FIX-SKETCH: In test/_env.ts (already exists; serves as the common test-environment seam):

  /** Poll a predicate every `intervalMs` for up to `attempts` tries.
   *  Returns true if the predicate ever returns truthy; false on
   *  exhaustion. Use for tmux state propagation (pane death, status
   *  flip, etc.). Replaces fixed setTimeout sleeps. */
  export async function pollUntil(
    pred: () => boolean | Promise<boolean>,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const attempts = opts.attempts ?? 20;
    const interval = opts.intervalMs ?? 50;
    for (let i = 0; i < attempts; i++) {
      if (await pred()) return true;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return false;
  }

Then replace each duplicated waitForPaneGone (and the acceptance setTimeouts) with:
  expect(await pollUntil(async () => !(await paneExists(paneId)))).toBe(true);

Net: -50 LOC across the test suite, +20 LOC in _env.ts, the cure for the acceptance flake (cf. testreview_acceptance_settimeout_race) and the wait-cross-ws flake (cf. testreview_wait_5s_default_timeout_flake) are both downstream of having this helper.
```
