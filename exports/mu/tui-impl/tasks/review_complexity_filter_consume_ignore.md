---
id: "review_complexity_filter_consume_ignore"
workstream: "tui-impl"
status: DEFERRED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-12T08:34:03.916Z"
updated_at: "2026-05-12T08:50:37.993Z"
blocked_by: []
blocks: []
---

# REVIEW low: classifyFilterKey 'consume-noop' uses appendChar with empty string (clarity)

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:34:04.301Z

```
FILE + LINES:
  - src/cli/tui/use-popup-filter.tsx:163-188 (the nav-key + ctrl branch returning {kind:"appendChar", char:""})
CATEGORY: non-idiomatic / complexity
SEVERITY: low
FINDING: The classifier hijacks `appendChar` with `char: ""` as a "consume-and-ignore" sentinel because the reducer drops empty chars. The header comment is upfront about this — "We piggy-back on appendChar with '' (reducer rejects via isPrintable) → state unchanged → caller treats as consumed" — but it's a clever trick that obscures intent. A reader has to follow appendChar → isPrintable → state-unchanged to discover that nav keys are eaten.
SUGGESTED FIX: add a first-class `{kind:"consume"}` action variant. Reducer returns state as-is. Classifier returns `{kind:"consume"}` for nav / ctrl / unknown. Same observable behaviour; immediate-read clarity. ~5 LOC change; tests update one assertion in tui-use-popup-filter.test.ts.
NOTE: low priority; just a clarity refactor. The current behaviour is correct.
CROSS-REF: review_tui_code_and_tests
```
