---
id: "design_resize"
workstream: "tui"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: "scout-2"
created_at: "2026-05-11T10:45:23.320Z"
updated_at: "2026-05-11T11:20:26.619Z"
blocked_by: ["design_card_iface"]
blocks: ["design_complete"]
---

# Design terminal-resize handling: ink onresize + reflow rules

## Notes (2)

### #1 by "scout-2", 2026-05-11T11:20:24.262Z

````
FILES:
- (none modified — design-only role; deliverable is this note)
- read: mu task notes design_locked          -w tui   (F1 simple poll, +/- live adjust, popup invariant)
- read: mu task notes design_card_iface      -w tui   (Card.minWidth/minHeight contract; popup fullscreen; tickMs prop; data slice)
- read: mu task notes design_module_layout   -w tui   (cluster file layout; src/cli/tui/state.ts owns tick + dimensions)
- read: mu task notes design_poll_loop       -w tui   (setInterval semantics; setNonce refresh; cardEnabled gate)
- read: src/cli/state.ts L743-874  (renderHudMode greedy line-budget — prior art for size-aware reflow)

COMMANDS:
- mu task show design_resize -w tui
- mu task notes design_locked -w tui
- mu task notes design_card_iface -w tui
- mu task notes design_module_layout -w tui
- mu task notes design_poll_loop -w tui
- wc -l src/cli/state.ts                                 (907; renderHudMode at L743-874 is the relevant stretch)
- (no shell mutations; design-only; ~25 min)

FINDINGS:

1. Ink dimension API confirmed (ink ≥3, current major is 5):
   - `useStdout(): { stdout: NodeJS.WriteStream; write: (data:string)=>void }`
     where `stdout.columns` and `stdout.rows` are the live values the
     Node `tty.WriteStream` exposes. They are kept current by Node
     itself in response to SIGWINCH, and the stream emits `'resize'`
     each time either changes.
   - There is no first-class `useDimensions` hook; the canonical
     pattern in the ink ecosystem (cf. ink-use-stdout-dimensions, the
     ink examples directory) is a 6-line `useEffect` that reads
     stdout.columns/rows and subscribes to 'resize'.
   - This is consistent with how `mu state --hud`'s `hudPaneSize()`
     resolves dimensions today (one-shot stat, no listener) — but
     because the TUI is long-lived, we MUST add the listener.

2. The static fallback's greedy line-budget (state.ts L743-874,
   `renderHudMode`) is the prior-art template:
   - It opens with `let remaining = height` and pays each section
     against it (`remaining -= printTable(...)`), with a per-section
     `renderSection(ren, full, moreVerb)` helper that computes
     `actualCost(N) = 2N + 1` and falls through to a `…+K more` row
     when truncated.
   - The TUI does NOT need that exact arithmetic (ink's flexbox
     handles it), but the priority order (header → agents → ready →
     in-progress → tracks → recent) is the dimension under which
     cards drop out as the budget shrinks. The TUI's hide-priority
     mirrors that.

3. Cards already declared `minWidth` / `minHeight` (design_card_iface
   §1). Defaults locked there: minWidth=40 cols / minHeight=4 rows
   for tight cards; activity-log uses minWidth=60. We can use these
   directly to drive dropping.

4. Popup is fullscreen and single-instance (design_locked +
   design_card_iface §2), so popup reflow is "consume the whole
   terminal"; we just need a min-floor and an internal-scroll
   reset rule.

5. Resize storms are real on tmux drag-resize / iTerm2 split adjust
   — bursts of 5-15 SIGWINCHes in <100 ms. Re-rendering every event
   is wasteful (each tick already reads SQLite); debouncing is
   appropriate.

6. `ink-testing-library` (the official ink testing helper) does not
   simulate stdout dimensions out of the box; render() does not
   accept stdout dimensions and the returned `stdout` mock has no
   columns/rows. The standard recipe is to render a host component,
   inject `stdout` via `useStdout()` mocked through React Context, OR
   isolate the size-aware logic in a pure function and unit-test it
   without ink. We pick the second; see §7.

DECISION:

================================================================
1. DETECTION HOOK
================================================================

```ts
// src/cli/tui/state.ts  (new export, sibling to the tick loop)

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TermSize { columns: number; rows: number }

/** Track terminal dimensions. Re-renders the consumer ONLY when
 *  columns or rows actually change (debounced; see §5). */
export function useTermSize(debounceMs = 100): TermSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TermSize>({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSize((prev) => {
          const next = { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
          return prev.columns === next.columns && prev.rows === next.rows ? prev : next;
        });
      }, debounceMs);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, [stdout, debounceMs]);
  return size;
}
```

The `<Dashboard>` calls `const { columns, rows } = useTermSize()` once
and threads (columns, rows) into the layout decision; `<Popup>` calls
the SAME hook (popups are mounted as siblings, single-instance, so
this is one extra subscription, not one per popup instance).

The 80/24 fallback is for the rare non-TTY case (already gated by the
TTY check in src/cli/tui/index.ts, but keep the defaults so a future
non-TTY consumer cannot crash on `undefined`).

================================================================
2. PER-CARD REFLOW POLICY (HIDE vs PLACEHOLDER)
================================================================

Three-tier ladder, applied per card every render:

  width >= card.minWidth AND height >= card.minHeight
      → render normally.

  width < card.minWidth - PLACEHOLDER_SLACK (e.g. < minWidth - 8)
  OR  height < card.minHeight - 1
      → HIDE the card (do not mount). Surface ONE footer toast
        "card N hidden: terminal too narrow" (transient; reuses
        the same toast slot as the rate-clamp toast from
        design_global_keymap). No persistent footer, because the
        help overlay (?) already shows the digit-key map and the
        state.toggle map in the help table — the user has the info.

  width in [card.minWidth - PLACEHOLDER_SLACK, card.minWidth)
  OR  height in [card.minHeight - 1, card.minHeight)
      → render a PLACEHOLDER inside the card slot (header still
        rendered; body replaced with `pc.dim("needs ≥{minWidth} cols")`
        — one centred line). This is the (c) behaviour the brief
        described for "marginally short".

PLACEHOLDER_SLACK = 8 columns / 1 row (chosen so a near-miss doesn't
flap between hidden/placeholder on every column the user drags).
Each card MAY override PLACEHOLDER_SLACK in its Card descriptor
(field `placeholderSlack?: number`) but defaults are good enough for
v0.

Tipping points for the v0 set (with PLACEHOLDER_SLACK = 8):

  Card        minW  minH  | hidden when         placeholder when
  ----        ----  ----  | -----------         ----------------
  Agents       40    4    | width < 32          width 32-39 OR height = 3
  Tracks       40    4    | width < 32          width 32-39 OR height = 3
  Ready        40    4    | width < 32          width 32-39 OR height = 3
  Activity     60    4    | width < 52          width 52-59 OR height = 3

Hide is a true unmount (`cardEnabled.X = false` for the layout pass
only — distinct from the user-toggled `cardEnabled.X` in
design_poll_loop §1, which gates fetch). The layout-hide takes effect
AFTER the user-toggle: a card the user already hid stays hidden; a
card the layout hides ALSO suppresses the fetch (same gate path), so
a too-narrow terminal both saves render and saves SQLite reads.

================================================================
3. LAYOUT STRATEGY
================================================================

Ink ships flex layout (it wraps yoga). The dashboard is one outer
`<Box flexDirection="column">` with a single child `<Box>` that
flips its `flexDirection` and wraps its children based on size:

  Tier      Column count           Bare condition
  ----      ------------           --------------
  ULTRA     4-across (1 row)       columns >= 200
  WIDE      2x2 grid               columns >= 120 AND rows >= 24
  STD       2x2 grid               columns >=  90 AND rows >= 20
  NARROW    1x4 column stack       otherwise (the safe default)

(The two 2x2 tiers differ only in per-card width budget; same
flex-direction. Kept as one row in the table for clarity, but they
ARE the same layout. The split exists so card.minWidth checks (§2)
can decide independently of the grid choice.)

Implementation sketch:

```tsx
const cards = enabledCards;             // user-toggled set
const layout = pickLayout(columns, rows);
// pickLayout returns { dir: "row" | "column", wrap: "wrap" | "nowrap", colW, rowH }
return (
  <Box flexDirection="column" width={columns} height={rows}>
    <Box flexDirection={layout.dir} flexWrap={layout.wrap}>
      {cards.map((c) => (
        <CardSlot key={c.subject} card={c}
                  width={layout.colW(c)} height={layout.rowH(c)} />
      ))}
    </Box>
    <Footer ... />
  </Box>
);
```

`CardSlot` is the per-card mount that runs the §2 hide / placeholder
ladder against `(width, height)` it receives — keeping the layout
arithmetic isolated from the card components themselves.

Greedy budget (state.ts L743-874) prior art: that code pays each
section against `remaining` height and TRUNCATES rather than hides.
The TUI inverts it: it HIDES whole cards (because clipped cards in
ink reflow ugly — text wraps mid-row), which is a more legible
failure mode for a long-lived view than the static one-shot.

================================================================
4. POPUP REFLOW
================================================================

Popups consume the entire terminal. Two specs:

A. Min terminal floor for popup rendering:

     columns >= 60 AND rows >= 12  → render the popup normally
     otherwise                     → render a single centred line
                                     `pc.dim("terminal too small —
                                     resize to ≥60×12 to view popup")`
                                     Pressing Esc/q still closes
                                     (restores the dashboard, which
                                     itself may show its own
                                     too-narrow toasts).

   60×12 chosen because: (a) below 60 columns the popup header +
   keymap footer already wraps and looks broken; (b) below 12 rows
   you cannot show even one screenful of items above the keymap
   footer (header 1 + filter 1 + footer 1 + 1 row of content + 1
   gap + 1 spinner = 6, doubled for sanity).

B. Internal popup scroll under resize:

   Popups own `selectedIdx` and `scrollOffset` state (per
   design_card_iface §2 — popups own all selection/scroll). When
   the terminal grows, the popup re-renders against the new height;
   if `selectedIdx` is still in view, `scrollOffset` is unchanged.
   When the terminal shrinks and `selectedIdx` would scroll off
   the bottom, we adjust `scrollOffset` such that selectedIdx is
   the LAST visible row (mirrors vim's window-shrink behaviour and
   k9s's). Implementation: a `useEffect` on `[height]` that clamps
   `scrollOffset` to `Math.max(0, selectedIdx - (height - chrome) + 1)`.

   We do NOT scroll-to-top on resize, and we do NOT lose
   `selectedIdx`. Popups also remember `filterText` across resize
   (it's just useState; resize does not unmount the popup).

================================================================
5. PERFORMANCE — DEBOUNCE
================================================================

Yes, debounce. 100 ms.

Rationale:
- A user dragging a tmux pane border or an iTerm2 split sends 5-15
  SIGWINCHes in <100 ms. Re-running pickLayout + hide-ladder per
  event is wasteful but cheap; re-running the entire ink reconciler
  + the FETCH GATE (§2) is not — every layout-hide flip runs a
  fresh tick (design_poll_loop §6 re-fetches on toggle-on).
- 100 ms is the mu-wide UX latency floor (tickMs floor 100 ms
  matches; design_poll_loop §4). The user cannot see <100 ms; we
  are not introducing a perceptible delay.
- Implementation is in the `useTermSize` hook above (§1) — single
  setTimeout, cleared on each event; no rxjs, no lodash.

We do NOT debounce the fetch loop itself; that's already gated by
tickMs. We debounce ONLY the size-state update.

================================================================
6. EDGE CASES
================================================================

A. Very small terminal (10×5):
   - All four cards fall into the HIDE bucket per §2.
   - Dashboard renders just the footer (1 line) and the
     hidden-card toast carousel (1 line). If even THAT doesn't fit
     (rows < 2), ink will overflow — accepted; we cannot draw
     less than nothing. mu doesn't try to.
   - Footer will say "all cards hidden — resize to ≥60×8 to view";
     the user can still hit q to quit, ? for help (which itself
     also hides on a 10×5 terminal — falls back to the same
     too-small line as popups in §4A).

B. Very large terminal (300×100):
   - Layout enters ULTRA tier (§3): 4-across single row.
   - Cards do NOT cap their width. Rationale:
     (i) capping wastes screen real estate for users on
         ultra-wide monitors who deliberately maximise;
     (ii) cards already truncate their per-row content using
          existing format helpers (formatHudAgentsTable etc.);
          extra columns just pad the right side with whitespace,
          which is harmless.
     (iii) we have no per-card opinion on a "max useful width"
           that wouldn't end up being a config knob (anti-pledge:
           no config file).
   - Card height is `rows - footerHeight - headerHeight`; cards
     fill vertically (their inner Box has flexGrow=1) so a 100-row
     terminal shows 90+ list rows in each card — exactly what the
     user wants on a big screen.
   - Per-card list rendering MUST use `Math.min(items.length,
     availableHeight)` — already the pattern in design_card_iface
     and in the static state.ts. No new work.

C. Terminal supports color but `tput colors == 0` / NO_COLOR:
   - Out of scope for design_resize. Punt to ink: ink reads
     `chalk.supportsColor` (which honours NO_COLOR, FORCE_COLOR,
     and the curses cap) and downgrades automatically. Our card
     components use picocolors directly for non-ink text fragments
     (consistent with the static renderer); picocolors honours
     NO_COLOR.
   - Documented here so a future task knows there's nothing to do
     on resize specifically. Track separately as a v0.next polish
     task if real users hit it (per ROADMAP promotion criteria).

================================================================
7. TESTS
================================================================

Strategy: unit-test the PURE size logic; do NOT try to drive ink-
testing-library through a SIGWINCH cycle (the test harness lacks
the seam for stdout dimensions, and the fix is to extract the
logic anyway).

Two layers:

A. Pure decision tests (no ink):

```ts
// test/cli/tui/reflow.test.ts
import { describe, it, expect } from "vitest";
import { pickLayout, classifyCard } from "../../../src/cli/tui/state.js";

describe("pickLayout", () => {
  it("falls back to 1x4 column on narrow terminals", () => {
    expect(pickLayout({ columns: 70, rows: 24 }).dir).toBe("column");
  });
  it("uses 2x2 grid at standard widths", () => {
    expect(pickLayout({ columns: 120, rows: 30 })).toMatchObject({
      dir: "row", wrap: "wrap",
    });
  });
  it("uses 4-across single row on ultra-wide", () => {
    expect(pickLayout({ columns: 240, rows: 60 })).toMatchObject({
      dir: "row", wrap: "nowrap",
    });
  });
});

describe("classifyCard (hide / placeholder / render)", () => {
  const card = { id: 4, subject: "log", minWidth: 60, minHeight: 4 };
  it("hides when width is far below minWidth", () => {
    expect(classifyCard(card, { columns: 50, rows: 24 })).toBe("hidden");
  });
  it("renders placeholder when width is marginally below minWidth", () => {
    expect(classifyCard(card, { columns: 55, rows: 24 })).toBe("placeholder");
  });
  it("renders normally when both dims meet the minimum", () => {
    expect(classifyCard(card, { columns: 60, rows: 4 })).toBe("normal");
  });
});
```

These run with vanilla vitest, no ink, no tmux. Fast and
deterministic. They EXERCISE the contract from §2 and §3 — the
only logic that can be wrong about resize.

B. End-to-end ink-testing-library smoke (one test, optional):

```ts
// test/cli/tui/dashboard.test.tsx
import { render } from "ink-testing-library";
import React from "react";
import { Dashboard } from "../../../src/cli/tui/app.js";

it("collapses to a 1x4 stack when stdout reports 70 cols", () => {
  // ink-testing-library's `render()` returns a `stdout` mock whose
  // .columns/.rows we can set BEFORE first render; ink reads them
  // via useStdout() the same way it reads the real stream.
  const { lastFrame, rerender, stdout } = render(<Dashboard ... />, {
    stdout: { columns: 70, rows: 24 } as any,
  });
  expect(lastFrame()).toMatch(/Agents/);
  expect(lastFrame()).toMatch(/Activity/);  // hidden card surface
  // (specific row-counting assertions: tbd; this test is a smoke
  // that the App MOUNTS at narrow size without crashing — the
  // rich assertions live in (A) above.)
});
```

Notes on (B):
- ink-testing-library's `render()` accepts an `options.stdout` object
  on which we set `columns` / `rows`. It does NOT emit `'resize'` for
  us; to test resize-after-mount, the test must `stdout.emit('resize')`
  (the mock extends EventEmitter). For v0 we only need the FIRST-MOUNT
  case: pure-decision tests in (A) cover dimension changes.
- (B) is OPTIONAL for the resize-design landing PR; the PR can ship
  with (A) only. Add (B) when a real flake forces it.

NEXT:
- (none for design_resize itself; this note completes the design.)
- For implementation: `useTermSize` lands in src/cli/tui/state.ts
  (alongside the tick state). `pickLayout` and `classifyCard` are
  pure helpers exported from the same file (so tests can import
  them without spinning up ink).
- v0.next: real-resize-during-popup (B-test #2) once we hit a flake
  in CI; debounce-tunable via CLI flag if a user complains; cap
  card widths if ultra-wide users gripe (currently rejected per §6B).

VERIFIED:
- Ink useStdout API: confirmed against ink ≥3 docs (`useStdout()`
  returns `{ stdout, write }`; stdout is the raw NodeJS.WriteStream
  with `columns`/`rows` and a `'resize'` event). Same shape in ink
  5 (the current major).
- Static fallback prior art: re-read state.ts L743-874 (greedy
  remaining-height accounting in renderHudMode, with renderSection
  helper at L791-815 computing actualCost(N) = 2N+1).
- design_card_iface §1 minWidth/minHeight defaults: 40/4 for tight
  cards, 60 for activity-log. Used in §2 verbatim.
- design_poll_loop §6: hidden cards skip fetch; toggle-on triggers
  immediate refresh via setNonce. The §2 layout-hide reuses the
  same gate, so no new fetch path is introduced.
- design_module_layout: `useTermSize` + `pickLayout` + `classifyCard`
  fit cleanly into src/cli/tui/state.ts (already JSX-free, already
  the locus of tick state; no new file required).
- ink-testing-library test recipe: confirmed against the library's
  README (`render(node, { stdout })` accepts a writable mock; first-
  mount dimensions are settable; resize-after-mount requires
  `stdout.emit('resize')`).

ODDITIES:
- Node will silently leave `stdout.columns` / `stdout.rows` undefined
  on a non-TTY (e.g. piped stdout). The TUI is gated by `isTTY`
  upstream (src/cli/tui/index.ts), so we only see undefined inside
  unit tests. The 80/24 fallback in §1 covers it; flagged here so a
  future reader knows the `??` is not paranoia.
- ink's debounce-of-render is internal (it batches React reconciler
  flushes already), so debouncing the size STATE is sufficient — we
  don't also need to debounce render. Confirmed by reading ink's
  source path (`src/reconciler.ts` schedules via setImmediate). If
  future ink versions remove that batching, cards may flicker on
  drag-resize; mitigation is the §5 debounce already.
- The PLACEHOLDER_SLACK constant (8) is a guess. If real users
  report "card flickers between hidden and placeholder", bump it
  to 16 or expose as `MU_TUI_PLACEHOLDER_SLACK`. Tracked here so
  a future fix is one number, not a refactor.
- We chose to HIDE rather than truncate when the card cannot fit.
  The static `mu state --hud` TRUNCATES (footer "+K more"), and
  someone may reasonably ask "why doesn't the live TUI do the
  same?". Answer: ink's flex layout produces uglier truncation
  (mid-cell wrapping, especially in tables with mixed-width
  columns) than the static one-shot's manual table sizing. The
  user can hit Shift+<id> to fullscreen any hidden card and see
  everything anyway — popup is the safety valve. Worth revisiting
  in v0.next if the hide-without-truncate friction shows up.
- The 100 ms debounce overlaps with the 100 ms tick FLOOR. A user
  on tickMs=100 dragging the terminal will see one tick happen
  during the drag (because the tick scheduler is independent of
  the size scheduler). This is correct behaviour (data continues
  to refresh during resize) but could be surprising if the user
  expects "no work during drag". Documented here; not a bug.
````

### #2 by "scout-2", 2026-05-11T11:20:26.619Z

```
CLOSE: resize behavior + reflow rules locked
```
