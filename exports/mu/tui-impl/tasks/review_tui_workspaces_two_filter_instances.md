---
id: "review_tui_workspaces_two_filter_instances"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: "worker-1"
created_at: "2026-05-13T12:53:57.799Z"
updated_at: "2026-05-13T15:55:15.935Z"
blocked_by: []
blocks: []
---

# REVIEW low: workspaces popup hand-rolls filter-edit bubble (use-popup-filter needs enabled prop)

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:58.931Z

```
FILE(S):
  src/cli/tui/popups/workspaces.tsx:185-200 (two flt instances + manual bubble)
  src/cli/tui/use-popup-filter.tsx:200-225 (usePopupFilter onEditingChange)

FINDING (non-idiomatic):
  workspaces.tsx instantiates `usePopupFilter()` TWICE (one for
  the workspace list, one for the commits drill) but
  `usePopupFilter`'s built-in `onEditingChange` callback can only
  bubble up one of them. The popup works around this by:

      const flt = usePopupFilter();        // no onEditingChange
      const drillFlt = usePopupFilter();   // no onEditingChange
      const inShow = mode === "drill" && showSha !== null;
      const activeFilterEditing = inShow ? false : mode === "drill" ? drillFlt.editing : flt.editing;
      useEffect(() => {
        onFilterEditingChange?.(activeFilterEditing);
      }, [activeFilterEditing, onFilterEditingChange]);

  Manual ternary + manual useEffect — bypassing the hook's
  documented bubble seam.

  Other popups (agents/blocked/inprogress/recent/all-tasks/log/
  doctor) all use `usePopupFilter({onEditingChange:
  onFilterEditingChange})` — single line.

WHY IT'S A PROBLEM:
  - Two of the same primitive instantiated side-by-side with
    different idioms means a future popup author has no clear
    pattern to copy. The next "two-filter popup" will probably
    mis-implement this.
  - The custom useEffect duplicates work that
    use-popup-filter.tsx exists to centralise. That's a minor
    contradiction with the explicit `review_dedup_filter_editing_effect`
    motivation noted in the hook's header.
  - The conditional `inShow ? false : mode === "drill" ?
    drillFlt.editing : flt.editing` encodes UI state machine
    knowledge inside the bubbling logic. If the show-mode UX
    changes (e.g. a future show-mode filter for grep within
    diffs) the bubbling logic has to be updated too.

PROPOSED FIX:
  Extend usePopupFilter to accept an `enabled: boolean`:

      const flt = usePopupFilter({
        enabled: !inShow && mode !== "drill",
        onEditingChange: onFilterEditingChange,
      });
      const drillFlt = usePopupFilter({
        enabled: !inShow && mode === "drill",
        onEditingChange: onFilterEditingChange,
      });

  Each instance bubbles `false` when disabled (so the StatusBar
  hint flips correctly) and the active one bubbles `true` when
  editing. No conditional bubbling logic at the call site.

  Or simpler: pass `enabled` through from the call site only;
  the hook's onEditingChange becomes
  `enabled ? state.editing : false`. The hook decides; the call
  site is one prop simpler.

EFFORT NOTE:
  ~0.15d. Touches use-popup-filter.tsx (add the `enabled` prop)
  + workspaces.tsx (collapse the two-bubble plumbing). Tests
  for use-popup-filter need one new case (`enabled=false →
  always bubbles false`).

  Bonus: the same pattern applies to any future popup with
  multiple filter scopes.
```

### #2 by "worker-1", 2026-05-13T15:55:15.935Z

```
CLOSE: a1b1683: usePopupFilter.enabled prop; workspaces popup uses two instances cleanly
```
