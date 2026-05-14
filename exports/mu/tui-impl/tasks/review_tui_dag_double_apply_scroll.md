---
id: "review_tui_dag_double_apply_scroll"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: "worker-3"
created_at: "2026-05-13T12:56:04.220Z"
updated_at: "2026-05-13T14:30:33.859Z"
blocked_by: []
blocks: []
---

# REVIEW low: DAG popup re-runs applyScroll after drill.dispatch already did; useDrillKeymap needs onScrollChange

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:56:04.592Z

```
FILE(S):
  src/cli/tui/popups/dag.tsx:69-89

FINDING (duplication / non-idiomatic):
  The DAG popup's useInput callback dispatches the action to
  the drill keymap (which internally calls setScrollTop via
  applyScroll), and then re-computes applyScroll a SECOND time
  to figure out which root header is at the new top:

      useInput((input, key) => {
        if (statusFilter.onKey(input, key)) return;
        const action = dispatchPopupKeyFromInk(input, key);
        const before = drill.scrollTop;
        drill.dispatch(action);             // setScrollTop happens inside
        switch (action.kind) {
          case "close":
            onClose();
            return;
          default: break;
        }
        if (isNavAction(action)) {
          const nextTop = applyScroll(before, action, totalLines, viewport);  // recomputed!
          setFocusedRoot(lineToRoot[nextTop] ?? roots[0] ?? null);
        }
      });

  Plus: useDrillKeymap was instantiated with `onClose: () => {}`
  (empty) so the close branch was inten-tionally bounced back
  here for a different effect. That coupling is non-obvious.

WHY IT'S A PROBLEM:
  - applyScroll runs twice for every j/k keystroke (once inside
    drill.dispatch, once in this callback). They're guaranteed
    to compute the same value because they consume the same
    inputs — but a future change to drill.dispatch's clamp or
    page-step formula would silently desync.
  - The popup is reaching INTO the drill keymap's state to
    derive its own thing (focused root from nextTop). The drill
    keymap doesn't expose a onScrollChange callback; the popup
    re-implements applyScroll to compensate. A cleaner seam:
    `useDrillKeymap({ ..., onScrollChange: (newTop) => ... })`.
  - The empty `onClose: () => {}` paired with a separate
    `case "close": onClose()` in the popup's useInput is a
    workaround for the drill keymap not knowing the popup wants
    a different close behaviour for nav vs Esc. Splitting the
    intent (back vs popup-close) at the dispatcher level would
    clear this up.

PROPOSED FIX:
  Add an `onScrollChange?: (newTop: number) => void` to
  useDrillKeymap and have it fire after every applyScroll
  internally. The DAG popup wires:

      const drill = useDrillKeymap({
        body, viewport,
        onClose,                              // direct, no re-route
        onScrollChange: (newTop) => setFocusedRoot(lineToRoot[newTop] ?? roots[0] ?? null),
      });

      useInput((input, key) => {
        if (statusFilter.onKey(input, key)) return;
        drill.dispatch(dispatchPopupKeyFromInk(input, key));
      });

  Removes the duplicated applyScroll, removes the empty-onClose
  workaround, removes the `before` snapshot. The popup becomes
  ~5 LOC shorter and the dispatcher invariant ("scrollTop and
  focusedRoot are always consistent") is enforced by the hook,
  not by hopefully-identical math at the call site.

EFFORT NOTE:
  ~0.15d. Touches drill.tsx (add the optional callback) +
  dag.tsx (consume it). Other useDrillKeymap consumers are
  unchanged (the new option is optional and undefined-by-default).
  Behavioural change: none at the user surface.
```

### #2 by "worker-3", 2026-05-13T14:30:33.859Z

```
CLOSE: 3ebc527: useDrillKeymap onScrollChange callback; DAG popup ~5 LOC shorter, no duplicated applyScroll
```
