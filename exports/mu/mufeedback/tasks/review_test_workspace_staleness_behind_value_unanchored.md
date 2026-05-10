---
id: "review_test_workspace_staleness_behind_value_unanchored"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-09T08:32:06.389Z"
updated_at: "2026-05-09T09:58:46.674Z"
blocked_by: ["review_code_decorate_with_staleness_n_plus_one"]
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: workspace-staleness '\b5\b' assertion isn't anchored to the behind column (matches anywhere)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:32:35.779Z

```
FILES: test/workspace-staleness.test.ts:117-127 ("workspace list table renders a 'behind' column with a number"); src/cli.ts:377-407 (formatWorkspacesTable + formatBehind).

WHAT THE TESTS CLAIM: The test claims to verify that `mu workspace list` renders a 'behind' column AND that the value (5) appears in the rendered table after origin advances by 5 commits.

WHAT THEY ACTUALLY VERIFY:
  1. `expect(r.stdout).toMatch(/behind/)` — passes whenever the literal word "behind" appears anywhere. The cli-table3 header always renders "behind" as a column title (formatWorkspacesTable always emits the header), regardless of whether the row's behind value is 5, 0, null, or missing.
  2. `expect(plain).toMatch(/\b5\b/)` — passes whenever any cell contains a "5" with word boundaries. But the row also includes:
     - a parent_ref short hash (12 hex chars: `[0-9a-f]{12}` — frequently contains a digit "5" at random)
     - a created_at timestamp (`2026-05-09T...` — guaranteed to contain "5" because of "2026-05-")
     - the path (which contains the workspace dir name; might or might not contain 5)
     - the agent name "worker-1" (no "5", okay)
  The created_at field GUARANTEES the regex matches — even if commitsBehind is broken and returns null/0/100, the assertion passes because "5" appears in the year (2026) or in the timezone offset/seconds field of the ISO timestamp.

GAP: A regression that always returns 0 from gitBackend.commitsBehind (or a regression in formatBehind that renders "—" instead of the number) would NOT be caught by this test. The behind column is the entire bug_workspace_stale_parent_silent_drift fix; the test claims to verify it surfaces but only verifies that the cli-table3 framework still renders the header and that the timestamp contains a digit.

WHY IT MATTERS: 60. Not phantom-regression-guard (false-confidence-90+) — the JSON test at line 109 ("workspace list --json includes commitsBehindMain when behind=0") and the warn-line test at line 137 ("ANY workspace is >=10 behind") DO pin the underlying behaviour, so the SQL-level + warn-line behaviour is covered. But the table-rendering test is the only one for the human surface, and as written it tests "cli-table3 still works" not "behind column shows the right number". A change like swapping `formatBehind(r.commitsBehindMain)` for `pc.dim("—")` (e.g. someone refactors and forgets to wire it up) silently passes.

SUGGESTED FIX:
  - Replace `expect(plain).toMatch(/\b5\b/)` with a column-anchored assertion. Two options:
    (a) Run `mu workspace list --json`, assert `rows[0].commitsBehindMain === 5`, AND a separate text assertion that the behind cell of the table shows "5" — easiest is to grep for the row line and assert it ENDS with " 5 " or " 5 │" (column-position-anchored).
    (b) Switch the test to use --json for the value assertion (already done elsewhere in the file — line 109 pattern) and only assert text-presence of the header word "behind".
  Estimated: +3 LOC, +1 text-grep regex tightened.

EVIDENCE: test/workspace-staleness.test.ts:124-126 — `const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");  expect(plain).toMatch(/\b5\b/);`. The row that formatWorkspacesTable emits always contains the created_at column, which is the ISO date `2026-05-...` (year contains 6, seconds field rotates through every digit). Counterexample: hardwire `formatBehind` to always return `pc.dim("—")` — the test still passes because the date in created_at always contains a "5" (today's date 2026-05-09 alone has it). Or replace the integer 5 with a different commitsAhead value: the test as-written for any value of commitsAhead in [0..9] passes coincidentally most of the time.
```
