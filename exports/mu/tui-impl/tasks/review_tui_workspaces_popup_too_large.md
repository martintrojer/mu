---
id: "review_tui_workspaces_popup_too_large"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.6
roi: 91.67
owner: "worker-2"
created_at: "2026-05-13T12:53:14.221Z"
updated_at: "2026-05-13T17:07:55.377Z"
blocked_by: []
blocks: []
---

# REVIEW med: workspaces popup is 586 LOC with 3 fused sub-views + sentinel state machine

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:53:14.505Z

```
FILE(S):
  src/cli/tui/popups/workspaces.tsx (586 LOC)

FINDING (complexity):
  workspaces.tsx is 586 LOC — the second-largest file in the TUI
  cluster after app.tsx (714). It carries THREE conceptually
  distinct sub-views:

    1. Top-level workspace list (with own filter `flt`,
       cursor + applyCursor + centredVisibleSlice).
    2. Drill view: commits-since-fork list (with own filter
       `drillFlt`, drill cursor, drill viewport, async load
       via listCommitsForWorkspace, NEWEST-FIRST reorder).
    3. Show view: git/jj/sl `<backend>.showCommit` diff body
       (own loader, own scroll state via showDrill /
       useDrillKeymap, OSC-52-style yank).

  Plus tuicr launch, the "show mode" sentinel `showSha`, three
  separate useEffect cleanups for show-state reset, and a manual
  filter-bubble `useEffect(onFilterEditingChange?)` because
  usePopupFilter's built-in onEditingChange can't multiplex
  between flt and drillFlt.

  The header comment explicitly notes this:
  > "show mode is a popup-local sub-mode (showSha state below)
  >  so we don't have to widen <App>'s PopupMode union for one
  >  popup."

  And later:
  > "Two independent filter instances: one for the workspace
  >  list, one for the commits drill view."

WHY IT'S A PROBLEM:
  - Per AGENTS.md: "Hard cap: 1500 LOC per file. Refactor signal
    at 800." 586 is below the signal but the signal is for files
    of generally homogeneous content; this file is three
    sub-components fused into one.
  - The "show mode" lives via a `null|string` sentinel inside the
    "drill" prop union — i.e. the popup invents a third state by
    overloading `showSha !== null`, then carefully resets it on
    workspace change AND on mode change AND on Esc. Three
    useEffects with non-trivial deps just to keep that ad-hoc
    state machine consistent. A `mode: "list"|"commits"|"show"`
    union (local to the popup, not <App>) would be clearer.
  - The filter-editing bubble is hand-rolled rather than using
    onEditingChange — because the hook only supports one source.
    Either a) use onEditingChange on the active flt only via
    conditional construction, or b) extend usePopupFilter to take
    an `enabled: boolean` so two instances can be wired (the
    inactive one bubbles `false`).
  - Mixed concerns make targeted unit testing harder; the
    workspaces-popup test (249 LOC) is largely static-source
    greps for these sub-states (matching e.g. the literal
    `setShowSha(c.sha)` and the regex
    `/if \(inShow && focused !== undefined && showSha !== null\)/`
    — implementation-coupled tests, see separate finding).

PROPOSED FIX:
  Promote "show" to a first-class sub-mode and split the file:

    - workspaces.tsx (~200 LOC): top-level list + dispatch table
      between sub-views.
    - workspaces-commits-drill.tsx (~180 LOC): commits-list
      drill (own state, own filter, own keymap).
    - workspaces-show-drill.tsx (~180 LOC): the git-show body
      (own loader, own keymap, tuicr launch).

  Per the task spec the show-mode is intentionally popup-local;
  splitting into sibling files keeps that scope while removing
  the mixed-concern complexity. Each sub-view file gets its own
  small focused test.

  Smaller subset (separately shippable): replace the `showSha`
  sentinel + 3 reset useEffects with an explicit
  `localMode: "commits" | "show"` enum. This collapses 3
  useEffects into 1 reducer-style state and clears the "third
  state via overloaded sentinel" smell without touching files.
  Estimated effect: -40 LOC of useEffects, +10 LOC for the
  reducer.

EFFORT NOTE:
  Full split: 0.6-0.8d, touches the test file heavily.
  Local-mode replacement: 0.25d, minimal test churn.
  Risk: real behaviour to preserve (loadShow tied to slowTickNonce,
  reset on focused-workspace change, OSC-52 yank, tuicr launch).
  Add behaviour tests before refactoring.
```

### #2 by "worker-2", 2026-05-13T17:07:51.486Z

```
FILES: src/cli/tui/popups/workspaces.tsx; test/tui-popup-workspaces.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast -- test/tui-popup-workspaces.test.ts test/tui-use-popup-filter.test.ts (exit 0); npm run test (exit 0); npm run test:fast (exit 0); npm run build (exit 0); MU_DB_PATH=mktemp node dist/cli.js state --json (exit 0)
FINDINGS: Workspaces popup previously derived show mode from mode=drill plus showSha; reset logic lived across separate effects.
DECISION: Implemented smaller subset only: explicit localMode list|commits|show with reducer actions for enter/leave drill/show and workspace/mode resets. Kept App PopupMode binary and deferred file split.
VERIFIED: Full green gates plus bundle smoke passed.
ODDITIES: Initial bundle-smoke command used zsh read-only variable name status after build succeeded; reran smoke with rc variable and it passed.
```

### #3 by "worker-2", 2026-05-13T17:07:55.377Z

```
CLOSE: a859dce: localMode enum; 3 reset useEffects → 1 reducer; behaviour preserved (smaller subset per the finding's split — full file split deferred)
```
