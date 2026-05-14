---
id: "review_tests_app_test_grep"
workstream: "tui-impl"
status: DEFERRED
impact: 55
effort_days: 0.3
roi: 183.33
owner: null
created_at: "2026-05-12T08:35:58.034Z"
updated_at: "2026-05-12T08:50:38.885Z"
blocked_by: []
blocks: []
---

# REVIEW high: tui-app.test.ts only structurally inspects source — zero rendered behaviour

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:35:58.342Z

```
FILE + LINES:
  - test/tui-app.test.ts (entire file)
CATEGORY: false-confidence / fake-testing
SEVERITY: high
FINDING: The file's own header acknowledges this:
   "We can't easily render <App> directly in unit tests (it needs a Db + workstream that loadWorkstreamSnapshot can hit). The keymap logic is already covered. The popup-lifecycle state-restore is implicit in <App> via React's component-state lifecycle (state outlives the popup mount because it lives in <App>, not the popup). We assert this STRUCTURALLY by inspecting the source"
The "structural" tests then grep app.tsx for `setVisibility / setTickMs / setFooter` not appearing in the popup props bag, and for `if (popup !== null) return` near `case "openPopup":`. A regression that:
  - Wires a popup prop wrong (e.g. yank() never reaches clipboardRef).
  - Suppresses tab navigation incorrectly.
  - Drops a card from the visibility map.
…would all pass.
SUGGESTED FIX: same as review_tests_static_source_overuse — ink-testing-library mount + send keystrokes + assert rendered frame + assert callback arg. The "popups don't get setVisibility" invariant becomes a real test: open popup, mutate visibility from outside the popup → confirm cards show post-popup-close.
NOTE: file's "Touch unused imports so biome is satisfied" trailer (`void Box; void Text; void Writable;`) is itself a code smell — the imports are scaffolding for a never-arrived test. Either delete the imports or wire them up.
CROSS-REF: review_tui_code_and_tests
```
