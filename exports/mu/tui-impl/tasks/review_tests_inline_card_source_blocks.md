---
id: "review_tests_inline_card_source_blocks"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-12T08:37:34.201Z"
updated_at: "2026-05-12T09:55:55.638Z"
blocked_by: []
blocks: []
---

# REVIEW low: per-card test files repeat 'no in-body +M more' static block

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:37:34.528Z

```
FILES + LINES (verbatim duplication of the "feat_card_footer_inset" regex block at the bottom):
  - test/tui-card-blocked.test.ts:135-155
  - test/tui-card-inprogress.test.ts:148-166
  - test/tui-card-recent.test.ts:135-153
  - test/tui-card-doctor.test.ts:130-150
  - test/tui-card-workspaces.test.ts:131-150
  - test/tui-card-tracks.test.ts:32-49
  - test/tui-card-ready.test.ts:25-42
CATEGORY: duplication / weak-coverage
SEVERITY: low
FINDING: 7 test files have the same trailing block:
   describe("...source: no in-body '+M more' line", () => {
     it("does not render '+{...} more' as a body Text node", () => {
       expect(SRC).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
       expect(SRC).not.toMatch(/<Text[^>]*>[^<]*\+\${[^}]+\}\s*more/);
     });
     it("wires bottomLabel into TitledBox", () => {
       expect(SRC).toMatch(/bottomLabel=\{bottomLabel\}/);
     });
   });
The intent (regression guard for feat_card_footer_inset) is sound, but the implementation has two issues:
   1. 7 byte-for-byte copies of the imports + describe block. A test-helper or a single sweep test (looped across all card files like test/tui-card-render-width.test.ts does) would collapse them.
   2. The regex `wires bottomLabel into TitledBox` matches the literal string `bottomLabel={bottomLabel}` — passes for any `<TitledBox bottomLabel={bottomLabel}>` with no further qualifier. Trivially evadable by accident: `let bottomLabel = undefined; <TitledBox bottomLabel={bottomLabel} ... />` passes the test but disables the inset.
SUGGESTED FIX: replace with a single sweep test in a sibling test file (like tui-card-render-width.test.ts already does for ListRow) that:
   - imports every card source under cards/*.tsx.
   - asserts the absent-pattern + the present-pattern with stricter forms (e.g. assert that bottomLabel is computed from `more > 0 ? \`+${more} more · Shift+...\` : undefined` shape).
Saves ~140 LOC of test duplication; one place to update on the next refactor.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:55:55.638Z

```
CLOSE: 9b6fac7: 7 byte-for-byte trailing blocks (~141 LOC) collapsed into single test/tui-card-footer-inset.test.ts sweep (~112 LOC) walking cards/*.tsx like tui-card-render-width.test.ts does for ListRow. Tightened bottomLabel assertion: now pins 'const bottomLabel = <count> > 0 ? `+${…} more · Shift+<digit>` : undefined' shape so 'let bottomLabel = undefined' can't pass. 22 sweep assertions + 75 unchanged per-card behaviour tests all green. 4 greens.
```
