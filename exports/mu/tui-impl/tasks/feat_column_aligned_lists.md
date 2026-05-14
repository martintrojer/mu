---
id: "feat_column_aligned_lists"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-11T13:17:47.382Z"
updated_at: "2026-05-11T14:06:05.934Z"
blocked_by: ["bug_tui_render_ghosting"]
blocks: ["feat_card_5_workspaces", "feat_card_6_inprogress", "feat_card_7_blocked", "feat_card_8_recent", "feat_card_9_doctor", "feat_popup_enter_drill", "tui_impl_complete"]
---

# FEAT: column-aligned list rendering inside cards/popups for legibility (no grid borders; just consistent column widths)

## Notes (3)

### #1 by "π - mu", 2026-05-11T13:17:47.704Z

```
Today every card renders rows as free-flowing <Text> chunks separated
by spaces. With variable-width fields (agent names, task ids, status
words, ROI values) the rows visually drift and become hard to scan:

  CURRENT (drifty):
    ✓ worker-1 task-1 —
    ⚠ scout-2 ⊕3 ⚠ idle
    ✓ designer-1 task-build-thing —

  WANTED (column-aligned):
    ✓ worker-1     task-1            —
    ⚠ scout-2      ⊕3                ⚠ idle
    ✓ designer-1   task-build-thing  —

Match `mu task list` and `mu agent list` static-CLI conventions: each
column gets a fixed width based on the widest cell in the visible
rows; pad with spaces. We DO NOT need cli-table3-style ascii grid
borders (they're noisy in a TUI that already has the outer rounded
border) — pure column padding is enough.

WHERE THIS APPLIES (v0):
  - Agents card (cards/agents.tsx): name | task | idle
  - Ready card (cards/ready.tsx):   name | ROI | title | owner
  - Activity-log card (cards/log.tsx): ts | source | verb | rest
  - Tasks popup (popups/ready.tsx):    name | status | owner | title
  - Agents popup (popups/agents.tsx):  status | name | role
  - Tracks popup (popups/tracks.tsx):  N | goals | counts
  - Log popup (popups/log.tsx):        seq | ts | source | verb | rest

DESIGN:

A small `src/cli/tui/columns.ts` helper:

  export interface Column {
    /** Header label (rendered above the first row). Optional. */
    header?: string;
    /** Per-row cell value (string, after colour stripping). */
    width: number;  // computed by the caller after measuring max cell
    align?: "left" | "right";  // default "left"
  }

  export function alignRows(
    rows: ReadonlyArray<ReadonlyArray<string>>,
    align?: ReadonlyArray<"left" | "right">,
  ): string[][];  // padded cells, ANSI-stripped widths

Or even simpler: a `padRight(s, n)` / `padLeft(s, n)` helper plus
a per-card "compute column widths" pass before rendering. Don't
over-engineer; <100 LOC total.

GOTCHAS:
- ANSI escape sequences in cells must NOT count toward width. Use
  `string-width` from the existing transitive deps (chalk pulls it
  in), or strip-ansi + `string.length` for the simple case.
- Emoji + glyphs (✓ ⚠ ⊕ ⋈) have variable display width depending on
  terminal/font. `string-width` handles this; bare `.length` does not.
  Use string-width to be safe.
- Within ink, render each padded cell as a separate <Text> chunk so
  per-cell colour still works (don't pre-concatenate the whole row).

INTERACTION WITH OTHER TASKS:
- Lands BEFORE feat_responsive_layout (alignment is per-card; layout
  is between-card). Doesn't conflict.
- Lands AFTER bug_card_header_inset / feat_card_header_digit_prefix
  if convenient (TitledBox internals stable by then) — but
  independent.
- Future v0.next "true grid borders" (full cli-table3-style with
  vertical lines) is OUT OF SCOPE here; promote separately if real
  friction emerges.

SCOPE GUARDS:
- No new dep beyond string-width (already transitive).
- Don't introduce ascii box-drawing INSIDE the rounded card — the
  outer border is the only visible structure; rows are just padded
  text.
```

### #2 by "π - mu", 2026-05-11T13:18:34.275Z

```
ADDITIONAL SCOPE: cell clipping policy.

Cells that exceed their column budget must be clipped (not wrapped —
wrapping breaks the row-per-row visual rhythm and confuses the j/k
cursor in popups). Use the existing src/cli/format.ts truncate()
helper or string-width-aware equivalent.

But: NOT every cell deserves equal clipping treatment. Some carry
identity (you can't `mu task claim` a clipped task id) and must be
preserved verbatim. Others (titles, payloads, prose) are descriptive
and degrade gracefully under truncation.

PROTECTED CELLS — never clip:
  - task ids        (Ready, Tasks popup, Activity-log popup)
  - agent names     (Agents card/popup; Activity-log popup .source)
  - track numbers   (Tracks card/popup)
  - status tokens   (OPEN/IN_PROGRESS/CLOSED/REJECTED/DEFERRED)
  - workstream names (when displayed; rare in single-ws TUI today)
  - timestamps      (HH:MM:SS — already short)
  - status emoji    (always 1-2 cells wide)
  - ROI numbers     (always small)
  - event verbs     (always short — `task add`, `agent close`, etc.)

CLIPPABLE CELLS — truncate with `…` suffix:
  - task titles
  - event payloads (the `rest` after classifyEventVerb's verb token)
  - agent role descriptions (long custom roles)
  - workspace paths (in the future Workspaces card; common case is
    the path is the LAST cell so absolute-path cropping is fine)
  - track goal names (when there are >1 root → `goal-a, goal-b, …`
    becomes `goal-a, goal-…` if needed)
  - notes preview (Tasks popup detail pane)

ALGORITHM:

1. Compute every cell's natural width (string-width).
2. Split columns into protected vs clippable.
3. Width budget = total available - sum(protected widths) - inter-cell padding.
4. Distribute remaining budget across clippable columns:
   - Equal share by default
   - For the LAST clippable column, give it any leftover (it usually
     anchors the row visually, e.g. the title)
5. Within a cell, truncate to its budget using truncate(s, n) which
   already produces `…` correctly for visible widths.
6. EDGE: if even the protected cells overflow (terminal too narrow for
   the table at all), fall through to the existing terminal-too-small
   guard in App.tsx (the responsive-layout task will eventually pack
   to fewer columns first; until then, this is the last resort).

WHY THIS MATTERS:
- Without protection, a `mu task claim <id>` yank produces an unusable
  command when the id was visually `t05_snapsh…` and the user yanked
  it without thinking.
- Cards are glanceable; titles being clipped is fine and expected
  (the popup shows full text). Task IDs being clipped destroys the
  primary affordance of the surface.

INTEGRATION:

The columns.ts helper grows one more knob:

  export interface Column {
    header?: string;
    align?: "left" | "right";
    /** When true, never truncate this column's cells; let the row go
     *  wider than the budget if needed. Default false. */
    protected?: boolean;
  }

Or even simpler: callers tag each column as `"protect"` or `"clip"`
in a flat array per row.

LANDING ORDER:
- Same PR as the alignment work; clipping is the natural complement
  to "give every column a fixed width".
- Test surface: assert long titles get clipped, but task ids don't,
  given a constrained terminal width fixture.
```

### #3 by "worker-3", 2026-05-11T14:06:05.934Z

```
CLOSE: commit 7667fa3: src/cli/tui/columns.ts (protect/clip layout), refactored 4 cards + 4 popups to use column-aligned rendering, +19 tests in tui-columns.test.ts. All 4 greens (typecheck/lint/1369 tests/build).
```
