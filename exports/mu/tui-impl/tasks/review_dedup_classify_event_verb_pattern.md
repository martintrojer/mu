---
id: "review_dedup_classify_event_verb_pattern"
workstream: "tui-impl"
status: DEFERRED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-12T08:32:23.574Z"
updated_at: "2026-05-12T08:50:38.280Z"
blocked_by: []
blocks: []
---

# REVIEW low: Centralise classifyEventVerb row-cell builder (3 callsites in cards/log + popups/log)

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:32:23.878Z

```
FILES + LINES:
  - src/cli/tui/cards/log.tsx:66-71 + :83 — classifyEventVerb call + ts/source/verb/rest cell pack
  - src/cli/tui/popups/log.tsx:82-87 (filter blob), :168-172 (yank classifier), :236-241 (cell pack), :252 (colour switch)
CATEGORY: duplication
SEVERITY: low
FINDING: classifyEventVerb is called 5× across 2 files and produces the same `(verb, rest)` pair every time. Two callsites build the identical 4-cell row `[ts, source, verb, rest]`; another two run the colour switch `cls ? {color:"cyan"} : {dimColor:true}`.
SUGGESTED FIX: add `eventCells(row): {cells, verbColored}` to src/cli/tui/columns.ts (or inline in log.tsx if columns.ts feels off-topic). cards/log.tsx and popups/log.tsx call it once each and share a single source of truth for the row layout.
NOTE: small finding; flagging as a v0.5 polish — promotion criterion is the next regression of the kind bug_tui_log_card_columns_misaligned (which was about the row JSX, but the SAME duplication shape).
CROSS-REF: review_tui_code_and_tests
```
