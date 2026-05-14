---
id: "review_tui_app_render_card_inline_function"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: null
created_at: "2026-05-13T12:53:44.299Z"
updated_at: "2026-05-13T14:26:57.859Z"
blocked_by: []
blocks: []
---

# REVIEW low: renderPopup is hoisted inner function inside App; new closure each render

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:55.718Z

```
FILE(S):
  src/cli/tui/app.tsx:480-525 (renderPopup nested in App)

FINDING (non-idiomatic / complexity):
  `renderPopup` is declared as an INNER function INSIDE the
  `App` component:

      export function App({ db, workstreams, initialActive }) {
        ...
        return (
          ...
          if (popup !== null) { return ...renderPopup(popup)... }
          ...
        );

        function renderPopup(id: NonNullable<PopupId>): JSX.Element {
          const props = { yank: yankFn, onFooter: footerFn, ... };
          switch (id) { case 0: return <CommitsPopup {...props} />; ... }
        }
      }

  The function captures every render-scoped binding (`yankFn`,
  `footerFn`, `setPopup`, `snap`, `popupMode`, `setPopupMode`,
  `setPopupFilterEditing`, `db`, `workstream`). It's redeclared
  on every render of <App>, and runs only when `popup !== null`.

  The hoisting `function renderPopup() {}` after a return
  statement is unusual — it's only legal because of JS function
  hoisting, but linting/biome rules sometimes flag this. The
  current code structure makes the popup-render dispatch
  invisible if you scroll past the render JSX.

WHY IT'S A PROBLEM:
  - Cognitive cost: the function's definition is below the
    return statements that use it, courtesy of hoisting. Readers
    used to top-down code have to scroll past the render to find
    it.
  - On every render, a new closure is allocated even when the
    popup is closed. Trivial in absolute cost but unnecessary.
  - The captured `props` object literal is re-created on every
    render of the parent → the popup component's props identity
    changes each tick, even when their content is the same.
    Memoised popups (none today, but a future perf finding)
    would never see stable props.

PROPOSED FIX:
  Extract `<PopupRouter>` as a top-level component:

      function PopupRouter({ id, props }: { id: NonNullable<PopupId>; props: PopupProps }) {
        switch (id) { ... return <CommitsPopup {...props} /> ... }
      }

  Then `<App>` does:

      if (popup !== null) {
        return <PopupRouter id={popup} props={popupProps} />;
      }

  Combined with the registry-table proposal in
  review_tui_app_card_render_two_switches, this becomes a
  one-liner table lookup.

EFFORT NOTE:
  Trivial (≈30 LOC moved); 0.1d. Worth tying to the registry
  refactor for compounding benefit.
```

### #2 by "π - mu", 2026-05-13T14:26:57.859Z

```
CLOSE: 456cb71 superseded the original concern: renderPopup body is now a POPUP_REGISTRY[id] lookup + spread, not inline JSX, so the closure-per-render objection no longer applies. The registry collapse is the structural fix; pulling renderPopup out as a named PopupRouter wouldn't change React's identity-stability story.
```
