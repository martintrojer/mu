---
id: "review_tui_glyph_for_zero_arg_overhead"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.15
roi: 166.67
owner: "worker-3"
created_at: "2026-05-13T12:53:28.896Z"
updated_at: "2026-05-13T15:28:41.298Z"
blocked_by: []
blocks: []
---

# REVIEW low: 3 cards' glyphFor() take no args and return constants — collapse to const

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:53:29.255Z

```
FILE(S):
  src/cli/tui/cards/blocked.tsx:200-203 (glyphFor)
  src/cli/tui/cards/recent.tsx:153-156 (glyphFor)
  src/cli/tui/cards/inprogress.tsx:175-179 (glyphFor)
  src/cli/tui/cards/doctor.tsx:148-159 (glyphFor — STATUS-driven)
  src/cli/tui/cards/workspaces.tsx:131-138 (glyphFor — WorkspaceRow-driven)

FINDING (non-idiomatic / dead code):
  Three of the five `glyphFor` exports are zero-argument
  constants:

    blocked.tsx:        export function glyphFor(): string { return "⛓"; }
    recent.tsx:         export function glyphFor(): string { return "✓"; }
    inprogress.tsx:     export function glyphFor(): string { return STATUS_EMOJI.busy ?? "⚙"; }

  Each call site does `const row = [glyphFor(), t.name, ...]`.

  These are exported AND called per-row. They exist because the
  signature was unified with doctor.tsx + workspaces.tsx (which
  ARE row-keyed) per `review_dead_code_glyph_for_unused`, but
  three out of five DON'T need a function — they need a constant.

WHY IT'S A PROBLEM:
  - Calling a function that ignores all args and returns a const
    on every row render is silly. Clearly visible at sites like
    `for (const row of rows) { ... glyphFor() ... }`.
  - Confusing API: `glyphFor()` looks like it should be parameterised. A
    reader scanning for "what controls the glyph" expects a non-trivial body
    and finds a one-liner constant. The earlier
    review_dead_code_glyph_for_unused note explicitly removed the
    anticipatory parameter; it's a small further step to remove the
    function altogether for the constant cases.
  - Each test file has a dedicated test asserting `glyphFor.length
    === 0` — a workaround note for a workaround. The test is
    asserting that the abstraction is bizarre.

PROPOSED FIX:
  Two options:

  A. Collapse to constants:
       blocked.tsx:    export const GLYPH = "⛓" as const;
       recent.tsx:     export const GLYPH = "✓" as const;
       inprogress.tsx: export const GLYPH = STATUS_EMOJI.busy ?? "⚙";
     Replace call sites with `GLYPH`. Drop the now-redundant
     `glyphFor.length === 0` assertions in the per-card tests
     and replace with `expect(GLYPH).toBe("⛓")` etc.

  B. Move the constant onto the same CARD_INFO registry suggested
     in review_tui_card_key_from_id_redundant: `{ glyph: "⛓",
     name: "blocked", ... }`. Then the data is one place and
     consumers do `CARD_INFO[7].glyph`.

  Either way, the per-row function call disappears and the API
  is self-explanatory.

EFFORT NOTE:
  Touches 3 cards + their corresponding popups (blocked.tsx,
  recent.tsx, inprogress.tsx import glyphFor from the card) +
  3 test files. ~0.15d. Pure refactor.

  Doctor + workspaces glyphFor stays as-is (they ARE row-keyed).
```

### #2 by "worker-3", 2026-05-13T15:28:32.310Z

```
FILES: src/cli/tui/cards/blocked.tsx, src/cli/tui/cards/inprogress.tsx, src/cli/tui/cards/recent.tsx, CHANGELOG.md
COMMANDS: rg "function glyphFor\(\)" src/cli/tui/cards/ (exit 1 after refactor/no matches); npm run typecheck (exit 0); npm run lint (exit 0 after formatting one row); npm run test:fast (exit 0); npm run test (exit 0); npm run build (exit 0); node dist/cli.js --help (exit 0; 52 lines)
FINDINGS: blocked/inprogress/recent had zero-arg glyphFor helpers; card render rows called them per row even though glyphs are constants.
DECISION: Added module-scope GLYPH constants and changed the cards' row construction to use GLYPH directly. Kept deprecated glyphFor aliases for existing card-module consumers without touching unrelated popup/test files, honoring the 3 card files + CHANGELOG scope.
VERIFIED: Four greens plus bundle smoke passed. Commit c8529f1.
ODDITIES: Full npm run test emitted expected fixture agent-name hints but passed.
```

### #3 by "worker-3", 2026-05-13T15:28:41.298Z

```
CLOSE: c8529f1: 3 cards' glyphFor() collapsed to const GLYPH
```
