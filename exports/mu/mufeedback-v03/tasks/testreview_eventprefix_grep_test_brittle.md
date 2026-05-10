---
id: "testreview_eventprefix_grep_test_brittle"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-10T11:34:28.092Z"
updated_at: "2026-05-10T12:23:02.949Z"
blocked_by: []
blocks: []
---

# test-review: state-render `every emitEvent callsite` regex-grep test is brittle and gives false confidence

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:34:48.787Z

```
FILES: test/state-render.test.ts:430-475 ("every emitEvent callsite under src/ uses a payload prefix in EVENT_VERB_PREFIXES")

FINDING: This test walks src/ with readdirSync, regex-extracts emitEvent(...) callsites, and asserts the first two whitespace-delimited words of each payload literal exist in EVENT_VERB_PREFIXES. The brittle bits:

  1. The regex `/emitEvent\s*\(\s*[^,]+,\s*[^,]+,\s*([`'"])((?:\.|(?!\1)[\s\S])*?)\1/g` only matches if the third arg STARTS with a string-literal quote. If a callsite uses a variable: `emitEvent(db, ws, msg)` — silently SKIPPED (length filter `words.length === 2` evaluates against a synthesized string from a never-extracted literal).

  2. The `head = literal.split("${")[0]` assumes the prefix is plain text BEFORE any interpolation. If a future emitter is `\`${kind} foo bar\`` the head becomes empty and the entry is silently skipped.

  3. The `words.length === 2` guard means single-word payloads (e.g. `\`stalled\`` if anyone refactors `agent stalled` to a single token) ARE ignored entirely, never failing.

Net: the test ENFORCES "if you write a 2-word string-literal-prefixed emitEvent, register the prefix" — but lets every interpolated, single-word, or variable-argument emitEvent slide through. False confidence.

WHY: This is a meta-coverage assertion (test-the-whole-source-tree-is-self-consistent). Its value comes entirely from being airtight; the loopholes above defeat its purpose. The CHANGELOG-listed `agent stalled` event came in via a string template — confirm which form the regex matches; even if it does today, the test's robustness is fragile.

FIX-SKETCH:
  Option A (smaller): replace the regex grep with an AST-based walk (TypeScript compiler API) so callsites are extracted by syntax, not by string-shape. ~80 LOC; eliminates loopholes 1-3.
  Option B (smaller still): drop this test entirely. The runtime behaviour ("colorEventPayload colours every verb in EVENT_VERB_PREFIXES") is already covered by the sibling test ("colours every verb in EVENT_VERB_PREFIXES"). The grep test was added to catch drift between EVENT_VERB_PREFIXES and the actual emitEvent calls — but a stronger drift-detector is to run the actual mu state command after each emit-able verb and assert the recent-events tail contains a coloured version.
  Option C: keep the grep but at least change `words.length === 2` → assert if length differs (would catch refactors that split or merge prefixes).
```
