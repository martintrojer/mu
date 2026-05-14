---
id: "review_tui_drill_wraps_body_twice"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.25
roi: 160.00
owner: "worker-3"
created_at: "2026-05-13T12:53:15.953Z"
updated_at: "2026-05-13T13:47:23.700Z"
blocked_by: []
blocks: ["bug_drill_text_no_truncate_wrap"]
---

# REVIEW med: useDrillKeymap + DrillScrollView each call wrapAnsiLines on the same body

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:16.730Z

```
FILE(S):
  src/cli/tui/popups/drill.tsx:71-83 (useDrillKeymap)
  src/cli/tui/popups/drill.tsx:140-160 (DrillScrollView)

FINDING (duplication / non-idiomatic):
  Both `useDrillKeymap` and `DrillScrollView` independently call
  `wrapAnsiLines(body, wrapWidth)`:

    useDrillKeymap:
      const wrapWidth = Math.max(0, contentWidthFromCols(termColsForLayout()) - 2);
      const wrappedBody = useMemo(() => wrapAnsiLines(body, wrapWidth), [body, wrapWidth]);
      const totalLines = useMemo(() => (wrappedBody === "" ? 0 : wrappedBody.split("
").length), [wrappedBody]);

    DrillScrollView:
      const wrapWidth = Math.max(0, contentWidthFromCols(termColsForLayout()) - 2);
      const wrappedBody = useMemo(() => wrapAnsiLines(body, wrapWidth), [body, wrapWidth]);
      const lines = useMemo(() => (wrappedBody === "" ? [] : wrappedBody.split("
")), [wrappedBody]);

  Each consumer renders a drill (e.g. popups/log.tsx, doctor.tsx,
  workspaces.tsx, commits.tsx, agents.tsx) instantiates BOTH the
  hook AND the view → each `wrapAnsiLines(...)` call runs twice
  per render of every popup drill, with identical inputs.
  `wrapAnsiLines` is non-trivial (regex-driven character-by-character
  wrap) and called on possibly-large bodies (git-show diffs, agent
  scrollback up to 80 lines).

  Memoised, so React skips the recomputation across re-renders with
  same body/width — but they still pay 2× the work whenever the
  body OR wrapWidth changes (every body refresh / terminal resize).

WHY IT'S A PROBLEM:
  - Duplicated computation: same wrap result computed twice every
    time it changes (body refresh from a slow tick, terminal
    resize, mode switch).
  - Drift risk: the `wrapWidth = Math.max(0, contentWidthFromCols(termColsForLayout()) - 2)` formula is repeated; if the chrome budget changes (it has — see POPUP_CHROME_ROWS comment in viewport.ts), one site might be updated and the other forgotten. Same risk: if wrapAnsiLines's contract changes (e.g. trailing-newline behaviour), both sites need attention.
  - Hook + view should agree on totalLines. Today they DO agree
    because both run the same code; the moment one diverges, scroll
    clamping desyncs from rendered content.

PROPOSED FIX:
  Have `useDrillKeymap` return BOTH the keymap AND the wrapped lines:

      export function useDrillKeymap(...): {
        scrollTop: number;
        dispatch: (a: PopupAction) => void;
        wrappedLines: readonly string[];   // new
        totalLines: number;                // new
      }

  Then `<DrillScrollView body=... viewport=... scrollTop=... wrappedLines=... totalLines=...>` accepts already-wrapped data; wrap math runs ONCE per popup.

  Or invert: introduce a `useWrappedBody(body, wrapWidth)` hook
  that returns the wrapped lines + totalLines. Both useDrillKeymap
  and DrillScrollView consume it; React's useMemo guarantees the
  same hook call site runs once per render tree.

EFFORT NOTE:
  Touches drill.tsx (the helper) + every popup that mounts a
  drill. ~7 popups consume DrillScrollView. Estimated 0.25d
  including small test deltas (the `wrapAnsi` test stays as-is;
  the per-popup tests are mostly static-source so unchanged).
```

### #2 by "worker-3", 2026-05-13T13:47:23.700Z

```
CLOSE: 36db477: useWrappedBody/keymap wrapped metadata dedups wrap math between scroll clamp and paint
```
