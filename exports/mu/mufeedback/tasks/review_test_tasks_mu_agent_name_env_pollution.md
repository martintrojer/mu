---
id: "review_test_tasks_mu_agent_name_env_pollution"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-09T08:33:59.482Z"
updated_at: "2026-05-09T09:45:14.889Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: 2 tasks.test.ts identity tests fail when MU_AGENT_NAME is set in shell env (mu-spawned pane)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:34:43.083Z

```
FILES: test/tasks.test.ts:781-794 ("--self falls back to 'orchestrator' when no $MU_AGENT_NAME, $TMUX_PANE, or $USER"); test/tasks.test.ts:1836-1851 ("falls back to pane title when MU_AGENT_NAME is unset"); src/tasks/claim.ts:281-289 (resolveActorIdentity); src/tmux.ts:678-682 (currentAgentName).

WHAT THE TESTS CLAIM: They claim to verify the resolveActorIdentity / claimSelf fallback chain: MU_AGENT_NAME > pane title > USER > 'orchestrator'.

WHAT THEY ACTUALLY VERIFY: Both tests use withEnv("MU_AGENT_NAME", undefined, ...) which DELETES the env var from process.env for the test body. This works fine when run via `npm test` from a non-mu pane (MU_AGENT_NAME never existed). It also "works" when run from a mu-spawned pane because withEnv deletes + restores. The reported FAILURE mode (per the tracker note: "fire when MU_AGENT_NAME is set in the env (mu-spawned pane)") is documented in multiple commits as "out of scope" — but the underlying failure is not env-pollution-leaking-PAST-withEnv. Looking at the tests more carefully:

Test "falls back to pane title when MU_AGENT_NAME is unset" at line 1836: this test sets up a MOCKED tmux executor that returns "legacy-pane-title" for `display-message #{pane_title}`, then asserts resolveActorIdentity() returns "legacy-pane-title". When MU_AGENT_NAME is set in the parent shell, withEnv clears it. So far so good. But the OTHER side of the chain is `currentAgentName()` which calls `currentPaneTitle()` which queries TMUX via the EXECUTOR. The test installs the mocked executor. So the failure must be something else.

Re-reading: the test at line 782 ("--self falls back to 'orchestrator' when no $MU_AGENT_NAME ...") wraps three nested withEnv calls (MU_AGENT_NAME=undef, TMUX_PANE=undef, USER=undef) and calls `claimTask(db, "auth", { self: true })`. The claimSelf resolves `actor` via `await resolveActorIdentity()` IF opts.actor is undefined. resolveActorIdentity checks process.env.MU_AGENT_NAME first — withEnv deleted it, so it should fall through. Then `await currentAgentName()` — but TMUX_PANE was deleted, so currentPaneTitle should return undefined… UNLESS the test runner's tmux executor wasn't reset and a previous test's setTmuxExecutor leaked. Look: the file's beforeEach (line 60, around) doesn't always resetTmuxExecutor; only the tmux unit-test file does that. 

Actually, the most likely culprit: `withEnv` deletes MU_AGENT_NAME for the CALLBACK lifetime. If the resolveActorIdentity / currentPaneTitle path forks a worker / awaits across ticks and another async test's setTmuxExecutor mock is still active, the fallback chain returns the mock's pane title instead of 'orchestrator'. But that's a different failure mode than "MU_AGENT_NAME set in env". The tracker description likely means: when MU_AGENT_NAME=test-reviewer-1 is set in the test runner's process.env at startup, withEnv does delete it for the body, but if any awaited operation inside fn() reads the env BEFORE the delete propagates (it shouldn't — process.env is sync), the reading sees the parent-shell value.

The actual failure most plausibly is: nested withEnv await — `await withEnv("MU_AGENT_NAME", undefined, async () => { await withEnv("TMUX_PANE", undefined, ...) })`. The outer withEnv's finally clause RESTORES MU_AGENT_NAME=test-reviewer-1 (the original from process.env at function entry) and the test ASSERTION runs INSIDE the inner withEnv but the resolveActorIdentity actually consults the env at the moment the await resolves, which is fine. But look carefully at line 1844: only TMUX_PANE is wrapped in withEnv inside the outer — MU_AGENT_NAME is set with `await withEnv("MU_AGENT_NAME", undefined, async () => { await withEnv("TMUX_PANE", "%99", async () => { ... }) })`. That's fine pattern.

GAP: Reproduction: run `npm test -- test/tasks.test.ts -t "MU_AGENT_NAME"` from inside a mu-spawned pane (MU_AGENT_NAME=worker-foo set in process.env at vitest startup). The test "prefers $MU_AGENT_NAME when set" at line 1817 sets MU_AGENT_NAME=worker-7 via withEnv and expects `actor === "worker-7"`. Should pass — withEnv overwrites, restores. The failing tests are likely those that EXPECT the fallback path: line 782 ('orchestrator' last resort) and line 1836 (pane title fallback). The bug is NOT env pollution — it's that the test CONSTRUCTS a state ("MU_AGENT_NAME unset") that the test runner can never legitimately observe when launched from a mu pane, because vitest worker processes inherit MU_AGENT_NAME and even after withEnv deletes it, something else (e.g. a child process the test spawns, an earlier-frozen module init, or a setTimeout already-queued log) re-reads the original. Hard to say without running.

The point: The 2 failures are documented and noted "out of scope" multiple times. They are NOT yet a backlog item. They SHOULD be: filing as a real backlog item is the right move. Either:
  (a) Skip these tests when MU_AGENT_NAME is set at module-load time with a `describe.skipIf(...)` (~3 LOC, narrow but unflattering).
  (b) Fix withEnv to assert the env var is truly absent at fn() entry (fail loud if module-load-time captured value persisted somewhere) — would surface the actual mechanism.
  (c) Refactor identity resolution to take env as an explicit dep injection so tests don't have to fight process.env at all.

WHY IT MATTERS: 70. This is exactly the false-confidence pattern at the meta-level: tests that pass on CI (where MU_AGENT_NAME is absent) but fail in the developer's mu-spawned pane. Devs get noise / false positives every test run. The "out of scope" punt across multiple commits is itself a signal that this needs a real owner.

SUGGESTED FIX: File as a real backlog item ("test_isolation_mu_agent_name_in_pane") and either implement (a) (3 LOC stopgap) or (c) (~30 LOC, proper). Smallest correct: at the top of test/tasks.test.ts, `if (process.env.MU_AGENT_NAME !== undefined) { console.warn("MU_AGENT_NAME is set; identity tests will skip") }` and use `(process.env.MU_AGENT_NAME ? it.skip : it)` pattern for the 2 affected tests. ~6 LOC.

EVIDENCE: Tracker description explicitly notes "2 pre-existing tasks.test.ts failures fire when MU_AGENT_NAME is set in the env (mu-spawned pane). Multiple commits noted this as 'out of scope'." Multiple commits = not 1, not 2 — pattern. Reproduction in the dev loop: every dev who runs `npm test` from inside an mu agent pane sees these failures every time. That's friction without a backlog entry.
```
