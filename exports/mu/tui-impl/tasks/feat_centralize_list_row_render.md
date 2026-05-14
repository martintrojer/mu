---
id: "feat_centralize_list_row_render"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-12T06:24:45.608Z"
updated_at: "2026-05-12T07:20:00.681Z"
blocked_by: []
blocks: []
---

# FEAT: centralize popup/card list-row rendering — extract a <ListRow cells contentWidth selected colors=...> primitive (sibling of CursorRow); every popup + card row JSX collapses to one component use, eliminating the copy-paste class of bugs (column drift, wrap-on-overflow, missing width pin)

## Notes (2)

### #1 by "π - mu", 2026-05-12T06:25:40.732Z

```
MOTIVATION (verbatim user)
--------------------------
"the unaligned columns is another example of copy-paste smell. we
should do all this centrally."

Plus the in-progress / recent VIEWPORT=20 hardcode bug
(bug_tui_inprogress_recent_drill_viewport_clipped) is the SAME
pattern: every popup re-derives the same bookkeeping; one popup
forgets one line; the resulting bug is invisible until you look at
that exact pane.

THE CURRENT STATE — 18 NEAR-IDENTICAL ROW JSX BLOCKS
----------------------------------------------------
Every popups/*.tsx (9) and every cards/*.tsx (9) renders rows like:

    <Box key={t.name} /* sometimes width=... sometimes not */>
      <Text wrap="truncate">
        <Text color="cyan">{glyph}</Text>
        {"  "}
        <Text bold>{name}</Text>
        {"  "}
        <Text dimColor>{owner}</Text>
        {"  "}
        ...
      </Text>
    </Box>

Selected rows are routed through CursorRow (popups/cursor-row.tsx) —
the ONE primitive we already centralised. CursorRow:
  - pins width={contentWidth}   ← the missing piece on non-selected rows
  - joins cells with COL_GUTTER
  - wraps in <Text inverse wrap="truncate">

The non-selected branch has 18 hand-rolled near-duplicates of:
  - the gutter literal {"  "}
  - the wrap="truncate" attribute
  - the optional width prop (some have it, some don't — bug class)
  - per-cell colour mapping

The result: every list-rendering bug recurs 18× before someone
notices. We've shipped two such bugs already
(bug_tui_log_card_columns_misaligned, bug_tui_log_popup_columns_misaligned)
and the VIEWPORT=20 copy-paste is a sibling pattern in the drill
path.

PROPOSAL — <ListRow> PRIMITIVE
------------------------------
Add src/cli/tui/popups/list-row.tsx (or src/cli/tui/list-row.tsx
if cards consume it too — both clusters live under src/cli/tui/, so
top-level placement is fine). Sibling of CursorRow:

    export interface ListRowProps {
      cells: ReadonlyArray<string>;             // already padded by renderRow
      contentWidth: number;
      colors?: ReadonlyArray<CellColor>;        // per-cell colour spec
      selected?: boolean;                        // when true, defers to CursorRow
    }

    export type CellColor =
      | { color?: string; bold?: boolean; dimColor?: boolean }
      | undefined;

    export function ListRow({ cells, contentWidth, colors, selected }: ListRowProps): JSX.Element {
      if (selected) return <CursorRow cells={cells} contentWidth={contentWidth} />;
      const gutter = " ".repeat(COL_GUTTER);
      return (
        <Box width={contentWidth}>
          <Text wrap="truncate">
            {cells.flatMap((cell, i) => {
              const c = colors?.[i] ?? {};
              const node = (
                <Text key={`c${i}`} color={c.color} bold={c.bold} dimColor={c.dimColor}>
                  {cell}
                </Text>
              );
              return i === 0 ? [node] : [<Text key={`g${i}`}>{gutter}</Text>, node];
            })}
          </Text>
        </Box>
      );
    }

This single component now owns:
  - the width pin (fixes wrap-on-overflow bug class once)
  - the gutter (impossible to drift)
  - wrap="truncate" (impossible to forget)
  - per-cell colour palette (declarative, not JSX-baked)
  - selected → CursorRow delegation (no per-popup if-branch)

Each popup / card body collapses from ~25 lines of JSX to ~8 lines:

    {tasks.map((t, i) => {
      const row = rows[i];
      if (row === undefined) return null;
      const padded = renderRow(row, widths, COLUMN_SPECS);
      return (
        <ListRow
          key={t.name}
          cells={padded}
          contentWidth={contentWidth}
          colors={COLOR_SPECS_FOR_INPROGRESS}
          selected={i === safeCursor}
        />
      );
    })}

COLOR_SPECS lives next to COLUMN_SPECS in the same file — same shape,
declarative.

COMPATIBILITY WITH CURRENT TESTS
--------------------------------
- test/tui-card-render-width.test.ts asserts every renderRow consumer
  uses wrap="truncate" + canonical {"  "} gutter. After this refactor,
  consumers no longer call wrap="truncate" themselves; the assertion
  needs reframing to "every consumer routes through ListRow OR
  CursorRow". Update the test accordingly.
- test/tui-cursor-row.test.ts unchanged (CursorRow stays).
- New test/tui-list-row.test.ts: unit tests for ListRow's join math,
  per-cell colour application, selected-delegation, and the same
  width-pin assertion CursorRow already has.

THIS SUBSUMES TWO QUEUED BUGS
-----------------------------
- bug_tui_log_popup_columns_misaligned (per-row Box width pin) becomes
  free-by-construction once ListRow lives.
- The "kind" sibling of bug_tui_inprogress_recent_drill_viewport_clipped
  (VIEWPORT=20 hardcode) is logically the SAME class of copy-paste
  bug; the user's centralisation request applies there too. The fix
  task already exists and dispatches a usePopupViewport() hook —
  same shape of solution. Coordinate so both land before any new
  popup/card author can re-introduce either pattern.

OPTION TO STAGE
---------------
Roll out incrementally:
  Commit 1: introduce <ListRow> + tests; migrate ONE popup
            (recommend popups/log.tsx — the user's repro).
  Commit 2: migrate the other 8 popups.
  Commit 3: migrate the 9 cards.

OR ship as one commit (~150 LOC removed across 18 files, ~50 LOC
added in list-row.tsx + tests). Implementer's call; I'd prefer the
3-commit stage so each lands with isolated test coverage and any
visual regression is bisectable per-card.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file; centralisation REDUCES total LOC.
- Conventional commit prefix: tui:
- Four greens before EACH commit.
- Suggested commit titles:
    tui: introduce <ListRow> primitive — single source for popup/card
         row JSX (gutter, width pin, wrap=truncate, selected delegation)
    tui: migrate every popup row JSX to <ListRow>
    tui: migrate every card row JSX to <ListRow>

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): one bullet under TUI internals
  describing the centralisation + the bug class it eliminates.
- docs/ARCHITECTURE.md: src/cli/tui/list-row.tsx row in the module
  table; mention the "every list row goes through ListRow OR
  CursorRow" invariant.
- (Optional) skills/mu/SKILL.md: not user-facing, no entry needed.

OUT OF SCOPE
------------
- Don't change the column allocator (layoutColumns / renderRow / 
  COL_GUTTER). The fix here is consumer-side; the allocator math is
  correct.
- Don't refactor the Shell / TitledBox plumbing (worker-3 owns
  nit_tui_drill_inset_title_and_hints; coordinate by avoiding the
  Shell JSX).
- Don't add a styling system or theme provider — pass colors as
  declarative arrays per call site; no global config.

⚠️ FINAL ACTION ⚠️
After the staged commits land green, run from the workspace dir:
    mu task close feat_centralize_list_row_render -w tui-impl --evidence "<sha-list>: <terse summary>"
```

### #2 by "worker-2", 2026-05-12T07:20:00.681Z

```
CLOSE: 40c0b4c: centralise every popup/card row JSX (18 hand-rolled blocks) through new <ListRow> primitive — owns width pin, COL_GUTTER, wrap=truncate, selected→CursorRow delegation; per-cell colors pass declaratively as sibling of COLUMN_SPECS. test/tui-list-row.test.ts unit-tests primitive; test/tui-card-render-width.test.ts reframed to assert 'every renderRow consumer routes through ListRow OR CursorRow; no hand-rolled <Box><Text wrap=...> remains'. CHANGELOG [0.4.0] under new 'TUI internals' subheading; docs/ARCHITECTURE + AGENTS.md tree updated. Four greens verified (typecheck + lint + 1898 tests + build).
```
