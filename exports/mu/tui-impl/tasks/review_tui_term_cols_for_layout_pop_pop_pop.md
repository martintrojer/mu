---
id: "review_tui_term_cols_for_layout_pop_pop_pop"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: "worker-3"
created_at: "2026-05-13T12:55:26.059Z"
updated_at: "2026-05-13T16:41:41.483Z"
blocked_by: []
blocks: []
---

# REVIEW low: termColsForLayout() reads process.stdout.columns from popups; useStdout would be more idiomatic

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:55:26.388Z

```
FILE(S):
  src/cli/tui/columns.ts:115-130 (termColsForLayout + contentWidthFromCols)
  Every src/cli/tui/popups/*.tsx and src/cli/tui/cards/*.tsx (~16 callers)

FINDING (non-idiomatic / inconsistency):
  `termColsForLayout()` is a thin wrapper:
    export function termColsForLayout(): number {
      return process.stdout.columns ?? 80;
    }

  Every popup and card calls
  `const contentWidth = contentWidthFromCols(termColsForLayout())`
  at the top of its render function. The header comment in
  columns.ts justifies it:
  > "Why `process.stdout.columns` and not the `useStdout()` hook:
  >  card/popup FCs are also called as plain functions in unit
  >  tests (no ink renderer mounted, so React hook context is
  >  null), and ink already re-renders the entire tree on
  >  SIGWINCH so the bare property read is current at render time."

  Meanwhile `<App>` and a handful of other components READ
  useStdout()'s columns to compute their own dashboard width and
  pass `cols` DOWN as a prop:

    src/cli/tui/cards/agents.tsx receives `cols` and uses
        `cols ?? termColsForLayout()`

  So cards have a `cols` prop (ink-blessed) but ALSO call
  termColsForLayout() as a fallback. Popups don't take a `cols`
  prop at all — they always read process.stdout.columns directly.

WHY IT'S A PROBLEM:
  - Two paths for "what's the terminal width": the App-driven
    prop chain (used by cards) and the global process.stdout
    read (used by popups). On a SIGWINCH, ink re-renders the
    whole tree but a popup might read `process.stdout.columns`
    BEFORE ink has updated its internal stdout state, depending
    on the order. Per the comment, "ink already re-renders the
    entire tree on SIGWINCH" — but the precise ordering is not
    guaranteed, especially under setInterval ticks.
  - Tests calling popup FCs as plain functions (not via render()):
    the docstring's rationale points at a real test pattern, but
    grep shows that pattern is mostly used by simple smoke tests
    (`expect(typeof BlockedPopup).toBe("function")`). The real
    behaviour tests use ink's render() which DOES provide
    useStdout context. So the rationale ("FCs called as plain
    functions") is mostly motivated by tests that don't actually
    care about the rendered width.
  - The popup docs say "popup is fullscreen" — at fullscreen the
    relevant width IS process.stdout.columns. But the same
    process.stdout.columns is used for cards' fallback too,
    despite cards being COLUMNAR (≠ full width).

PROPOSED FIX:
  Migrate popups to consume `useStdout()` inline (or accept a
  `cols` prop from <App>). One pattern across the cluster:

      function PopupX(props: PopupProps): JSX.Element {
        const { stdout } = useStdout();
        const cols = stdout?.columns ?? 80;
        const contentWidth = contentWidthFromCols(cols);
        ...
      }

  And drop `termColsForLayout()` from columns.ts. Tests that
  mount popups via render() get the right width via the ink
  context; smoke tests that just import-check don't care about
  width.

  Smaller subset (separately shippable): standardise on the
  pattern (everyone uses useStdout); leave termColsForLayout()
  as a back-compat alias deprecated in a comment.

EFFORT NOTE:
  ~0.3d. Touches 7-9 popup files. Risk: a popup test that
  imports the popup directly (no render()) and asserts on
  contentWidth-derived behaviour would break — but the grep
  shows no such test pattern. The test/_card-render.ts helper
  uses render() for visible-text assertions.

  Side benefit: brings popups into line with cards and removes
  the only `process.stdout.columns` read in the cluster (other
  than ink's own).
```

### #2 by "worker-3", 2026-05-13T16:41:38.451Z

```
FILES: src/cli/tui/popups/{agents,all-tasks,blocked,commits,dag,doctor,drill,inprogress,log,ready,recent,tracks,workspaces}.tsx; src/cli/tui/columns.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test (exit 0, 163 files / 2443 tests); npm run build (exit 0); npm run test:fast (exit 0, 91 files / 1383 tests); node dist/cli.js --help (exit 0); node dist/cli.js state --help (exit 0)
FINDINGS: popup component bodies and drill width helper no longer import/call termColsForLayout(); they read Ink stdout columns with fallback 80 and feed contentWidthFromCols(cols).
DECISION: kept termColsForLayout() exported as deprecated back-compat alias, and used contentWidthFromCols(80) as the pure helper default for buildDagBody so non-render tests do not need a hook context.
VERIFIED: four greens plus fast tier and bundle smoke passed.
NEXT: none.
```

### #3 by "worker-3", 2026-05-13T16:41:41.483Z

```
CLOSE: 06ae7ec: popups now use useStdout(); termColsForLayout deprecated
```
