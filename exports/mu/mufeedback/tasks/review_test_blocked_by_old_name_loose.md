---
id: "review_test_blocked_by_old_name_loose"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-08T11:23:27.480Z"
updated_at: "2026-05-08T12:57:12.456Z"
blocked_by: []
blocks: []
---

# REVIEW: --blocks rejection test passes whether old name is removed or not

## Notes (1)

### #1 by "test-reviewer-1", 2026-05-08T11:23:45.420Z

```
FILES: test/cli-task-add-blocked-by.test.ts:106-138 ; src/cli.ts (mu task add option list)
WHAT THE TEST CLAIMS: it("--blocks (the old name) is rejected by commander as unknown option")
WHAT IT ACTUALLY VERIFIES: After running `task add build ... --blocks design`, asserts (1) `exitCode === null || exitCode !== 0` and (2) `stderr` matches `/unknown option|--blocks/` and (3) the row "build" was not inserted.
GAP: The exit-code assertion `exitCode === null || exitCode !== 0` is satisfied when `exitCode` is null (which is the runCli "completed normally" sentinel — i.e. SUCCESS). And the regex `/unknown option|--blocks/` matches any stderr containing `--blocks` — which includes the literal `--blocks` we just passed if commander echoes it back, OR a perfectly fine help line that happens to mention --blocks. The "build NOT inserted" check is the only real signal here, and even THAT can be satisfied if commander interprets `--blocks design` as a stray positional (e.g. consumed as another title) and the add fails for an unrelated reason. None of the three predicates establishes "commander parsed --blocks and rejected it specifically".
WHY IT MATTERS: This is the regression test for the v0.2 rename of `--blocks` -> `--blocked-by`. If a future maintainer accidentally re-introduces a deprecated `--blocks` alias that swaps semantics back to "this task BLOCKS those" (the original footgun), every part of this test could pass green: (a) commander returns exitCode 0 -> runCli reports null -> assertion 1 passes; (b) stderr is empty so --blocks substring not matched, but `unknown option` also not matched -- wait, this would actually fail. So a true accidental alias would be caught. BUT a refactor that turns --blocks into a no-op (silently ignored) would: produce exit 0, empty stderr, AND insert build (so check 3 catches it). The real gap is that the "rejected by commander" claim of the test name is uncorroborated — we don't assert it was rejected for being unknown, just that the side-effect didn't happen.
SUGGESTED FIX: Tighten to `expect(exitCode).not.toBeNull(); expect(exitCode).toBe(1);` (commander uses exit 1 for unknown options via exitOverride), and `expect(stderr).toMatch(/unknown option.*--blocks/)`. That nails the semantic instead of the symptom. Add a sibling test that --blocks is not in the help output of `mu task add --help`.
```
