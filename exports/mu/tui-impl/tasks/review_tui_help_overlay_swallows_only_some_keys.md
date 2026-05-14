---
id: "review_tui_help_overlay_swallows_only_some_keys"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: "worker-4"
created_at: "2026-05-13T12:53:59.801Z"
updated_at: "2026-05-13T14:53:13.873Z"
blocked_by: []
blocks: []
---

# REVIEW low: useInput swallow-rules duplicated for help+popup branches in app.tsx

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:54:00.639Z

```
FILE(S):
  src/cli/tui/app.tsx:259-273 (helpOpen branch in useInput)
  src/cli/tui/help.tsx:74-84 (Help component's local useInput)

FINDING (complexity / overlap):
  Help overlay key handling lives in TWO places:

    app.tsx (line 263-273): "Help overlay owns its local scroll
      keys. App only handles close/toggle here, then swallows
      every other key so j/k/Ctrl-D/Ctrl-U cannot leak into the
      global dashboard keymap while the overlay is open."

    help.tsx (line 79-84):
      useInput((input, key) => {
        const action = dispatchPopupKeyFromInk(input, key);
        setScrollTop((s) => applyHelpScroll(s, action, rows, totalRows));
      });

  ink fires `useInput` on EVERY mounted component. So pressing
  `j` while help is open:
    1. Help.tsx's useInput dispatches popupKey → moveDown →
       updates Help's scrollTop.
    2. App.tsx's useInput sees `j`, falls through the helpOpen
       guard's `if (escape || q || Q || ?)` check, returns
       early (`return;` at line 271) — i.e. swallows it.

  This works, but the fact that App.tsx's guard exists ONLY
  to suppress the global keymap path while letting Help's local
  useInput handle the keys is non-obvious. The comment notes
  this:
  > "App only handles close/toggle here, then swallows every
  >  other key so `j` / `k` / Ctrl-D / Ctrl-U cannot leak into
  >  the global dashboard keymap while the overlay is open."

WHY IT'S A PROBLEM:
  - Subtle invariant: ink's useInput in BOTH App and Help fire
    for the same key event. Help.tsx scrolls; App.tsx returns
    early. The order of fires is non-deterministic per ink's
    useInput contract (or at least undocumented).
  - The popup-mode block (line 277-318) does the SAME pattern:
    when popup !== null, ALL global keys except a handful are
    consumed by App.tsx's `return;` and the popup's local
    useInput handles them. Two copies of the same "consume the
    global path while the local path handles" pattern.
  - The contract is implicit: a future `<App>` simplification
    that "cleans up" this guard (replacing `return;` with
    fall-through) would silently break help-overlay scrolling
    AND popup navigation by routing the key to the global
    dispatcher. The tests that catch this are static-source
    greps (test/tui-app.test.ts) which can be fooled by any
    refactor that preserves the literal text but loses the
    behaviour.

PROPOSED FIX:
  Lift the "active mode" decision into a single state and have
  App's useInput dispatch ONCE based on it:

      const inputMode = helpOpen ? "help" : popup !== null ? "popup" : "dashboard";
      useInput((input, key) => {
        switch (inputMode) {
          case "help":     // App handles only close/?, swallow rest
          case "popup":    // App handles only quit/help-toggle, swallow rest
          case "dashboard": // global dispatch
        }
      });

  Help and popup local useInputs continue to handle their own
  scroll/nav. The dispatch boundaries become explicit and
  centralised. Each branch's return-early is documented in one
  place.

  Smaller subset: add a single test that mounts <App> with
  helpOpen=true, sends `j`, asserts only Help's scroll moves
  (not card visibility). Without behaviour testing the
  refactor-risk stays high.

EFFORT NOTE:
  Refactor: 0.3d, low risk. Behaviour-test enabling: depends on
  resolution of testreview_tui_app_no_behaviour_coverage.

  Pure documentation alternative: add a header comment to
  app.tsx's useInput callback that calls out the "two useInputs
  fire per event" invariant. Would not improve correctness, just
  surface the invariant.
```

### #2 by "worker-4", 2026-05-13T14:53:13.873Z

```
CLOSE: d971dd9: shouldSwallowGlobalKey helper; help + popup branches consolidated
```
