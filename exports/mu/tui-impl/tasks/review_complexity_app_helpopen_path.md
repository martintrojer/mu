---
id: "review_complexity_app_helpopen_path"
workstream: "tui-impl"
status: DEFERRED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-12T08:34:31.306Z"
updated_at: "2026-05-12T08:50:37.702Z"
blocked_by: []
blocks: []
---

# REVIEW low: app.tsx help-overlay early-Esc handler is asymmetric with popup close

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:34:31.628Z

```
FILE + LINES:
  - src/cli/tui/app.tsx:139-143
    if (helpOpen && (key.escape || input === "q" || input === "Q")) {
      setHelpOpen(false);
      return;
    }
CATEGORY: complexity / non-idiomatic
SEVERITY: low
FINDING: Help overlay close is hand-wired BEFORE the global dispatcher runs. Popup close has been moved into dispatchPopupKey and the popup's own useInput handler. The asymmetry (one closes via dispatchGlobalKey + one closes inline) is a small but real complexity cost — every reader has to learn both shapes.
SUGGESTED FIX: extend dispatchGlobalKey to know about the help-overlay close (e.g. add `mode: "dashboard" | "help" | "popup"` arg, or just a `helpOpen: boolean` flag), and let the action dispatcher in app.tsx flip helpOpen via the standard switch. Removes ~5 LOC of pre-dispatch glue. Lower priority — there's only one such case so the cost is small — but flagged because the next mode-overlay (e.g. workstream picker, command palette) will repeat the asymmetry.
CROSS-REF: review_tui_code_and_tests
```
