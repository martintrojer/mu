---
id: "review_test_invalid_id_overspecs_sanitised_command"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-09T08:34:48.633Z"
updated_at: "2026-05-09T09:59:26.972Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: TaskIdInvalidError tests overspec the sanitised command's exact suffix (drift on cosmetic copy edits)

## Notes (1)

### #1 by "test-reviewer-1", 2026-05-09T08:35:15.359Z

````
FILES: test/tasks.test.ts:152-204 (TaskIdInvalidError typed-error + reserved-prefix tests); test/cli-task-add-invalid-id.test.ts:75-86 (sanitised assertion); src/tasks/errors.ts:78-87 (TaskIdInvalidError.errorNextSteps).

WHAT THE TESTS CLAIM: Verify that TaskIdInvalidError carries actionable errorNextSteps (auto-derive path + sanitised candidate path), and that the sanitised candidate is itself a runnable command.

WHAT THEY ACTUALLY VERIFY: They verify the EXACT prefix `"mu task add bad_id "` (with trailing space) and `"mu task add"` etc. The matchers used are:
  - tasks.test.ts:181 `expect(sanitisedStep?.command).toMatch(/mu task add bad_id /)` — pinned with trailing space.
  - tasks.test.ts:204 `expect(sanitisedStep?.command).toMatch(/ t_mu_/)` — pinned with leading space, no trailing.
  - cli-task-add-invalid-id.test.ts:84 `expect(sanitised?.command).toMatch(/mu task add bad_id /)` — same pinned form.

These are tighter than necessary in two ways:
  (1) They lock the spacing between the verb and the rest of the command. A cosmetic edit that, say, switches the suffix from `"mu task add ${sanitised} --title \"...\""` to `"mu task add ${sanitised} -t \"...\""` (using -t shorthand, common in this codebase) breaks the regex even though the behaviour — "the sanitised candidate IS a valid runnable command" — is unchanged.
  (2) None of them actually validate "this command is runnable". The "the suggested command would actually pass isValidTaskId" comment at tasks.test.ts:201 PROMISES a stronger assertion than the regex check delivers. To verify runnability, the test should `isValidTaskId(extractedId)` on the parsed-out id token, not just regex on the whole string.

GAP: A regression that produces an invalid sanitised id (e.g. sanitiseTaskId returns "MU_internal" instead of "t_mu_internal" because someone changes the casing logic) would still pass the regex `/ t_mu_/` if the rest of the suggested command happens to contain "t_mu_" elsewhere — but more importantly, the test that's CALLED OUT in the test as "the suggested command would actually pass isValidTaskId" doesn't actually run isValidTaskId on the suggested id. The promise is in the comment; the assertion is just regex.

WHY IT MATTERS: 30. Not false confidence — the existing assertions DO catch the most common regressions (the regex would fail on a totally broken sanitiser). It's overspec at the cosmetic level + an unfulfilled promise in the comment. Drift signal: the moment someone reformats the suggested command (e.g. changes `--title "..." --impact <n> --effort-days <n>` to `-t "..." -i <n> -e <n>` for consistency with the rest of the codebase's terse-flag style), 3 tests fail unrelated to behaviour.

SUGGESTED FIX: Tighten the assertion to actually check what the comment claims:
  ```ts
  const cmd = sanitisedStep?.command ?? "";
  // Extract the second token (the id) and validate it.
  const idToken = cmd.split(/\s+/)[3]; // ['mu', 'task', 'add', '<id>', ...]
  expect(idToken).toBeDefined();
  expect(isValidTaskId(idToken!)).toBe(true);
  expect(cmd.startsWith("mu task add ")).toBe(true);
  ```
  Then drop the `/mu task add bad_id /` regex and the `/ t_mu_/` regex; assert the id token directly. Renames a brittle string-shape check into a behaviour check ("the suggested id passes isValidTaskId"). ~5 LOC each, 3 sites = ~15 LOC.

EVIDENCE: src/tasks/errors.ts:84-87 — sanitised candidate template is `mu task add ${sanitised} --title "..." --impact <n> --effort-days <n>`. tasks.test.ts:181 + 204 + cli-task-add-invalid-id.test.ts:84 — three regex anchors that lock cosmetic shape. Counterexample: change errors.ts:86 to `mu task add ${sanitised} -t "..." -i <n> -e <n>` (cosmetic refactor; same behaviour). All three tests fail; behaviour is unchanged.
````
