---
id: "bug_all_tasks_popup_no_scroll"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.2
roi: 400.00
owner: "worker-2"
created_at: "2026-05-12T19:50:25.459Z"
updated_at: "2026-05-12T20:10:55.607Z"
blocked_by: []
blocks: ["bug_mouse_hit_test_picks_wrong_card", "fix_help_overlay_render_single_column"]
---

# BUG: all-tasks popup renders every task with no slice/scroll — large workstreams (169 tasks) just spill off screen; cursor moves but list never scrolls; no scroll indicator

## Notes (3)

### #1 by "π - mu", 2026-05-12T19:51:25.090Z

````
MOTIVATION (verbatim user)
--------------------------
"on thing about the 't' task list. for this project it says 169 visible. that ca;t be right? also scrolling down with the mouse or keybaord doesnt scroll the list.  and there is not scroll idicator?"
"not be right as in, 169 rows are not visiable."

THREE BUGS, ONE FIX
-------------------
1. Subtitle reads "169 visible / 318 total" — technically the count after status filter, but the user reads "visible" as "rows on screen". Misleading.
2. Cursor moves with j/k/scroll-wheel but the LIST never scrolls — render walks every task in `visibleTasks` from index 0 with no slice, so rows past the viewport just spill off screen. Cursor disappears below the fold.
3. No scroll indicator. User can't tell "you're 5% / 50% / 95% through the list".

ROOT CAUSE (confirmed live)
---------------------------
src/cli/tui/popups/all-tasks.tsx line 212:
    {visibleTasks.map((t, i) => { ... <ListRow ... /> ... })}
…renders ALL `visibleTasks` (169 rows). No `.slice(start, end)`, no scroll-window helper, no scrollTop state. ink truncates whatever doesn't fit; cursor "moves" via the highlight but the rendered window never advances.

The helper that already solves this is in src/cli/tui/popups/scroll.ts:
    centredVisibleSlice<T>(items, cursor, viewport): { start, visible }
…which returns a viewport-sized slice centred on the cursor (clamped at edges). It's what every list popup SHOULD use; the all-tasks popup just doesn't call it.

THE FIX (locked)
----------------
1. **Use centredVisibleSlice** in src/cli/tui/popups/all-tasks.tsx:
   ```ts
   const { start, visible: windowed } = centredVisibleSlice(visibleTasks, safeCursor, viewport);
   ```
   Then iterate `windowed` (length ≤ viewport) instead of `visibleTasks`. The cursor row's relative index in the window is `safeCursor - start`.

2. **Rename the subtitle counter** to make it unambiguous:
   - Current: "(<visible> visible / <total> total)" — confusing.
   - Replace with: "(<safeCursor+1>/<visibleTasks.length>) — <visibleTasks.length> after filter / <sourceTasks.length> total"
     OR simpler and clearer: drop "visible/total" terminology entirely; use:
     "<safeCursor+1>/<visibleTasks.length>" (cursor-position over filtered count) in the title (already there)
     and "filter: N of M" in the SortStrip subtitle.
     The title already says `(N/M)` — that's the cursor position. No need to repeat in SortStrip; just say "filter: N of M" or even just the filter+sort indicators.

3. **Scroll indicator** — three options, ship the SIMPLEST that works:
   - **OPTION A (recommended)**: append a tiny percentage / position to the title:
       "All tasks · popup (safeCursor+1/visibleLen) · 23%"
     where `23%` = round(safeCursor / (visibleLen - 1) * 100).
   - **OPTION B**: gutter scrollbar — render a thin "┃" column on the right of the popup body, with a filled marker at row `floor(viewport * safeCursor / visibleLen)`. More work, more visual noise.
   - **OPTION C**: ▲/▼ indicators above/below the visible window when there's content above/below.
   PREFER A — minimum diff, maximum signal, zero new geometry.

4. **Sweep the sibling popups** for the same bug. They likely DON'T hit it in practice (Ready / In-progress / Blocked / Recent typically have ≤30 rows), but apply the same fix as a regression-prevention measure. Specifically: src/cli/tui/popups/{ready,inprogress,blocked,recent,workspaces,agents,tracks,doctor,log}.tsx — check each for `<list>.map((t, i) => …)` patterns without a slice, and convert to centredVisibleSlice.
   
   IF this sweep balloons (more than ~30 LOC change per popup), STOP and split into a separate task. The all-tasks popup fix is the user-visible critical one.

VIEWPORT SOURCE
---------------
The popup already calls `usePopupViewport()` (src/cli/tui/popups/viewport.ts) which returns the available BODY rows. Reuse — don't compute. The viewport is the budget.

WIRING SUMMARY
--------------
- src/cli/tui/popups/all-tasks.tsx:
  * import { centredVisibleSlice } from "./scroll.js" (already imports applyCursor).
  * Replace `visibleTasks.map(...)` with `windowed.map(...)`. Remember the row indexing — `i` becomes the index INSIDE the window, but the row's task is `windowed[i]`. The cursor highlight uses `(start + i === safeCursor)` instead of `(i === safeCursor)`.
  * Title: append " · NN%" where NN = round(safeCursor / max(1, visibleLen - 1) * 100) — or omit when visibleLen ≤ viewport (the whole list fits, no scroll).
  * SortStrip subtitle: tighten the wording. "(<visibleLen> of <total>)" suffices; drop the misleading "visible".

- (Optional sweep) src/cli/tui/popups/{ready,inprogress,blocked,recent,workspaces,agents,tracks,doctor,log}.tsx — same conversion if the bug exists. SKIP the sweep if it gets gnarly.

⚠️ COORDINATION ⚠️
- Both workers IDLE right now. Solo dispatch.
- Bundle smoke after build: `node dist/cli.js --help && node dist/cli.js --version`.
- Don't import from `../../../cli.js` in any tui/ file.

TESTS (REQUIRED)
----------------
- test/tui-popup-all-tasks.test.ts: extend with:
  * 200-task fixture; viewport=15; assert ONLY ~15 rows render; assert cursor at row 100 puts cursor in the centre of the window with start≈92.
  * Assert the title contains a percentage indicator OR rendered count makes sense.
  * Pressing j many times scrolls the window forward; pressing k many times scrolls back.
- test/tui-scroll.test.ts (existing — confirms centredVisibleSlice unit semantics): no change needed; helper is already covered.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # press 't' — all-tasks popup opens.
  # EXPECTED: popup shows ~10-15 rows (whatever fits), title has cursor position + percent.
  # Press 'j' a bunch — window slides; cursor stays mid-window.
  # Press 'G' — jumps to last task; window now shows the BOTTOM of the list.
  # Press 'g' — back to top.
  # Press 'c' to hide CLOSED — title's filter count drops; window resnaps.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; all-tasks.tsx is ~268 LOC; this is a ~30 LOC change.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: all-tasks popup uses centredVisibleSlice so large lists actually scroll (was: rendered all 169 rows; cursor moved but window never advanced); subtitle disambiguated; percent indicator in title
- Four greens before commit + bundle smoke + manual smoke.

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "All-tasks popup (`t`) now properly windows large lists. Previously it rendered every task and let the cursor move off-screen because the rendered slice never advanced. Now uses centredVisibleSlice so the cursor stays mid-window and j/k/Ctrl-D/scroll-wheel actually move the visible window. Title gains a percent indicator (e.g. `23%`) when the list overflows the viewport."

OUT OF SCOPE
------------
- No new keybindings.
- No popup resize beyond the existing viewport hook.
- No saved scroll position across reopen.
- No virtualised list (centredVisibleSlice is a simple slice; "virtual" lists are anti-feature for our scale).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name> (FRESHLY recreated, at HEAD with everything shipped this session).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke, close YOUR task with:
  mu task close bug_all_tasks_popup_no_scroll -w tui-impl --evidence "<sha>: <one-line summary including 'verified 169-task list scrolls cleanly'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
````

### #2 by "worker-2", 2026-05-12T20:10:51.661Z

```
FILES: src/cli/tui/popups/all-tasks.tsx; sibling popup list files agents/ready/inprogress/blocked/recent/workspaces/tracks/doctor; test/tui-popup-all-tasks.test.ts; CHANGELOG.md
COMMANDS: npm install; npm run typecheck (pass); npm run lint (pass); npm run test initially pass before final tweak; full npm run test later hit Sapling temp ENOTEMPTY cleanup flakes unrelated to TUI; HGRCPATH=/dev/null npm run test -- test/workspace-backends.test.ts test/vcs-detect.test.ts test/vcs-commits-show.test.ts pass; npm run build pass; node dist/cli.js --help pass; node dist/cli.js --version => 0.3.2
FINDINGS: all-tasks rendered all filtered rows; windowing via centredVisibleSlice fixes visible list scroll. The all-tasks filter/sort strip consumes two body rows, so viewport uses an explicit chrome override to keep the top border visible.
DECISION: committed bfe0406. All-tasks title adds percent only when the filtered list overflows; SortStrip now says filter: N of M instead of visible/total. Sibling list popups now render centred slices too.
VERIFIED: tmux manual smoke on tui-impl with 172-task list: t opens top with 0%, 100 j scrolls to row 101/172 at 58%, G shows bottom 172/172 at 100%, g returns top, c hides CLOSED and filter count drops to 16 of 172. Bundle smoke passed.
```

### #3 by "worker-2", 2026-05-12T20:10:55.607Z

```
CLOSE: bfe0406: all-tasks popup windows large lists with centredVisibleSlice; verified 169-task list scrolls cleanly (manual smoke used 172-task tui-impl list)
```
