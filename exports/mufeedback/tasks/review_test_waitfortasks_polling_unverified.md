---
id: "review_test_waitfortasks_polling_unverified"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: "worker-mf-2"
created_at: "2026-05-08T11:24:35.252Z"
updated_at: "2026-05-09T08:12:46.690Z"
blocked_by: []
blocks: []
---

# BUG: waitForTasks sleeps a full pollMs before checking deadline (pollMs > timeoutMs sleeps through it); + missing poll-count test

## Notes (3)

### #1 by test-reviewer-1, 2026-05-08T11:24:53.923Z

```
FILES: test/tasks.test.ts:1571-1685 (waitForTasks describe) ; src/tasks.ts:1354-1411 (waitForTasks implementation).
WHAT THE TESTS CLAIM: 8 tests covering waitForTasks timeout, polling, deletion-mid-wait, partial progress, etc.
WHAT THEY ACTUALLY VERIFY: status of the returned object (allReached/anyReached/timedOut/elapsedMs<bound). They never assert the NUMBER OF POLLS. The "blocks until the condition is met" test only asserts `Date.now() - flipAt >= 30` (lower bound on wait); it does not assert that the function woke up promptly after the flip (no upper bound except via test timeout).
GAP: 1) A regression where pollMs is ignored and the loop hot-spins (e.g. accidentally `setTimeout(resolve, 0)`) would still pass every test — they'd just complete faster. The same is true for a regression in the opposite direction (fixed 1000ms poll regardless of pollMs override). 2) The "deleted mid-wait" test only asserts `reachedTarget=false` for the deleted task; it doesn't assert that wait still progressed correctly for sibling tasks (race condition coverage gap). 3) No test exercises `pollMs > timeoutMs` (deadline would expire mid-sleep — does the function return promptly or sleep through the deadline?). The current impl awaits `setTimeout(resolve, pollMs)` BEFORE re-checking, so a `pollMs=10000, timeoutMs=100` would sleep 10s before noticing the deadline. That's a real bug in the production code, masked by the absence of a test.
WHY IT MATTERS: waitForTasks is the first 'long-lived' verb in mu (R4 in the roadmap). The CLI maps timedOut to exit code 5 and scripts depend on this. A polling regression silently doubling latency or busy-spinning is hard to notice in dogfood — the absence of a poll-count assertion means the scaffolding cannot catch it.
SUGGESTED FIX: Inject a poll-count side channel: replace the `setTimeout` await with a test-overridable sleep (mirror src/tmux.ts's setSleepForTests pattern). One new test asserts `pollCount === expected`. Add a test for `pollMs > timeoutMs` asserting the function returns within `<= timeoutMs + small slack` not within `<= pollMs`.
```

### #2 by π - mu, 2026-05-09T08:06:36.034Z

```
TRIAGE during deferred-task review (operator hypothesis: refactor made these defunct).

Re-verified against current main (post-refactor): not defunct. Worse — contains a real production bug, not just a test gap.

CONFIRMED IN src/tasks/wait.ts:130-138 (current main):

  for (;;) {
    if (Date.now() >= deadline) {
      return { ...snap, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));    // ← sleeps FULL pollMs
    snap = snapshot();
    if (isDone(snap)) return snap;
  }

WITH `pollMs=10000, timeoutMs=100`: caller asked for 100ms timeout, function sleeps 10s before noticing deadline expired. Caller-visible: timeoutMs is silently ignored when pollMs > timeoutMs.

WHAT TO SHIP (~0.3 days, was originally tagged 0.4 as test-only — bumped impact 50→60 + retitled to BUG):
  1. Fix the loop: clamp the sleep to `min(pollMs, deadline - Date.now())` so the function returns within `timeoutMs + small slack`, never `pollMs` later.
  2. Add poll-count side-channel (mirror src/tmux.ts's setSleepForTests pattern):
       export function setWaitSleepForTests(s: ((ms: number) => Promise<void>) | undefined): void
     Default sleep uses real setTimeout; tests inject a counted/instant version.
  3. Tests:
     a. Regression for the bug: pollMs=1000, timeoutMs=50 → assert elapsedMs < 100 (NOT 1000+).
     b. Poll count: pollMs=10ms, timeoutMs=100ms → assert pollCount ∈ a tight range (e.g. 8-12).
     c. Deletion-mid-wait sibling-progress test (the original gap from the deferred review).

PROMOTION JUSTIFIED BECAUSE:
  - This is a production bug (caller-visible behaviour wrong), not just missing test coverage.
  - waitForTasks is the orchestrator's primary scope-finishing primitive (we used it heavily this session); the bug is reachable any time a script picks unbalanced poll/timeout.
  - The fix is small (~1 LOC for the clamp + ~30 LOC for the test infrastructure).
```

### #3 by worker-mf-2, 2026-05-09T08:12:57.606Z

```
FIXED. Shipped as commit 5430a28 on worker-mf-2.

ROOT CAUSE: src/tasks/wait.ts:130-138 awaited a full pollMs before re-checking the deadline. With pollMs=10000, timeoutMs=100 the function slept ~10s past the requested timeout. Caller-visible: timeoutMs silently ignored whenever pollMs > timeoutMs.

FIX: clamp poll sleep to min(pollMs, deadline - now). Handles deadline=Infinity (timeoutMs=0 = wait forever) and skips sleep when clamp goes <=0 (re-snapshots once at the boundary, then returns). Avoids passing 0/negatives to setTimeout.

TEST SEAM: setWaitSleepForTests + getWaitPollCount + resetWaitPollCount mirror src/tmux.ts's setSleepForTests pattern. Re-exported via src/tasks.ts and src/index.ts.

NEW TESTS in test/tasks.test.ts (waitForTasks describe):
  - 'returns within timeoutMs even when pollMs > timeoutMs (clamped sleep)' — pollMs=1000, timeoutMs=50, asserts elapsed < 200ms (pre-fix: ~1000ms).
  - 'polls roughly timeoutMs/pollMs times (asserts cadence via test seam)' — pollMs=10, timeoutMs=100, asserts pollCount in [5,15].
  - 'deletion of one task mid-wait does not block sibling progress detection' — covers the original gap from the deferred test review.

SMOKE-TESTED end-to-end via dist/index.js: pollMs=5000, timeoutMs=100 returns in 101ms (was ~5000ms pre-fix).

GATES: typecheck + lint + test (767 passing) + build all green. CHANGELOG entry added under [Unreleased] / Fixed.
```
