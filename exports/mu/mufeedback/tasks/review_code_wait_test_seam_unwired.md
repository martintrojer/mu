---
id: "review_code_wait_test_seam_unwired"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-09T08:32:53.491Z"
updated_at: "2026-05-09T09:19:10.405Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: src/tasks/wait.ts test seam (setWaitSleepForTests / poll counter) has no callers

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:33:20.597Z

```
FILES: src/tasks/wait.ts:35-65 (setWaitSleepForTests, getWaitPollCount, resetWaitPollCount, currentWaitSleep)

FINDINGS: The wait.ts module was just enhanced (commit a4febdd, on the in-flight branch — your workspace is at 97eb014, but the next commit on main introduces these test seams). The new exports are:

  setWaitSleepForTests(impl)       // swap sleep impl for tests
  getWaitPollCount() / resetWaitPollCount()  // observe poll cadence

The module-level mutable state `pollCount` is shared across every concurrent waitForTasks() in the process, with the docstring "Total number of polls performed across all `waitForTasks` calls in this process." Since waitForTasks IS the verb that races multiple polls in parallel (the orchestrator waits on N tasks; each spawns its own poll loop in tests), a single global counter conflates polls from independent waits. This makes the counter useful only for tests that run a single waitForTasks at a time.

Looking at src/index.ts and the existing test files at HEAD: NEITHER setWaitSleepForTests NOR getWaitPollCount is exported through src/index.ts (the SDK boundary). They're only reachable via deep import "src/tasks/wait.js" — which violates the "src/index.ts is the SDK contract" pillar. If the seam is for tests, exporting it from index.ts (alongside setSleepForTests for tmux) is the symmetric thing to do.

Also (potential): currentWaitSleep is mutable module state; setWaitSleepForTests doesn't restore the previous impl on test failure (no try/finally pattern enforced). The setSleepForTests in src/tmux.ts also lacks this, but at least its test surface is narrow. With wait.ts's poll-cadence test goal, every test that swaps the sleep MUST also reset the counter or the next test's assertion is contaminated.

Note on sequencing: the task said worker-mf-2 is finishing this fix in flight. Filing this as a follow-up review; not blocking the fix itself. The clamp-to-deadline change (the load-bearing fix) is correct.

WHY IT MATTERS: 30. Test ergonomics + SDK-boundary smell. Module-level mutable counter shared across concurrent waits will produce false-positive test failures if any test ever asserts an exact count from a multi-wait scenario. The counter's docstring acknowledges the limitation ("across all calls in this process") but doesn't loud-fail a misuse.

SUGGESTED FIX (~10 LOC):
1. Export setWaitSleepForTests + getWaitPollCount + resetWaitPollCount from src/index.ts (under a clearly-marked "Test seams" comment block). Match the export style for setSleepForTests.
2. In test fixtures / beforeEach, document that callers should resetWaitPollCount() before each test — or add a context-scoped variant: `withWaitSleep(impl, async () => { ... })` that auto-restores.
3. Audit setSleepForTests in tmux.ts for the same auto-restore pattern; if the team likes it there, propagate.

Effort 0.05 if just step 1; 0.1 if step 2 too.

ALTERNATIVES CONSIDERED:
- Per-call sleep override (`waitForTasks(db, ids, { sleepImpl: ... })`). More pure functional, no module state. But then `pollCount` has no home. Probably right for the long term; deferred.
- Drop the seam entirely and use Vitest's fake timers (`vi.useFakeTimers()` + `vi.advanceTimersByTime`). Cleaner; the existing src/tmux.ts setSleepForTests pattern already chose against this for unknown reasons (probably to keep tests provider-agnostic).

EVIDENCE:
- git diff 97eb014 a4febdd -- src/tasks/wait.ts → adds the seams + clamp.
- grep -rn "setWaitSleepForTests\|getWaitPollCount" src/ test/ → empty (no callers; not exported via index.ts; the seam is dead until test suite catches up).
- src/index.ts §"tmux" exports setSleepForTests; analogous wait export missing.
```
