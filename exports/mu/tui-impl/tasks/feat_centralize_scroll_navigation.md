---
id: "feat_centralize_scroll_navigation"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.3
roi: 216.67
owner: null
created_at: "2026-05-12T05:23:40.304Z"
updated_at: "2026-05-12T08:14:33.269Z"
blocked_by: []
blocks: ["feat_tui_mouse_input", "nit_tui_drill_inset_title_and_hints", "review_tui_code_and_tests"]
---

# FEAT: centralize j/k/Ctrl-D/Ctrl-U/g/G/PgUp/PgDn nav into one shared primitive — every list/drill view consumes it instead of re-implementing 6 case branches

## Notes (5)

### #1 by "π - mu", 2026-05-12T05:24:40.527Z

```
GOAL
----
Centralize the scroll/navigation key dispatch into one shared
primitive. Every list view, drill scrollback view, and notes
detail view consumes it. No more per-popup reimplementation of
the same 6 case branches.

WHY
---
Inconsistencies the user has hit this session:

  - Some popups list-mode supports `g`/`G` for jump-top/jump-bottom;
    drill-mode in those popups also supports it (consistent).
  - Other popups DO support those bindings BUT only inside one
    of the two modes.
  - `Ctrl-D`/`Ctrl-U` half-page is only wired in some drill
    branches (popups/ready.tsx drill yes; popups/log.tsx no).
  - Page-Up/Page-Down keys are present in the dispatcher but
    inconsistently consumed.
  - Whether `0`/`$` (line-jump shortcuts in vim) work anywhere
    depends on which file shipped first and whether it copied
    them across.

Root cause: each popup's useInput body has its OWN switch over
PopupAction.kind with the same scroll cases:

  case "moveDown":   setCursor((c) => Math.min(N-1, c + 1));
  case "moveUp":     setCursor((c) => Math.max(0, c - 1));
  case "jumpTop":    setCursor(0);
  case "jumpBottom": setCursor(Math.max(0, N - 1));
  case "pageDown":   setCursor((c) => clampScrollTop(c + step, N+1, 1));
  case "pageUp":     setCursor((c) => clampScrollTop(c - step, N+1, 1));

…with `N` being events.length, tasks.length, agents.length,
workspaces.length, drillTasks.length, etc. The math is identical
modulo the variable name. Same for the scrollback-style branches
that operate on `scrollTop` instead of `cursor`.

Counted:
  popups/agents.tsx       6 case branches
  popups/blocked.tsx      6
  popups/doctor.tsx       6
  popups/inprogress.tsx   6
  popups/log.tsx          3 (only list-mode)
  popups/ready.tsx        12 (list-mode + drill-mode)
  popups/recent.tsx       6
  popups/tracks.tsx       9 (list + drill + task-detail)
  popups/workspaces.tsx   6 (list + commits-drill)

Total: ~60 near-duplicate switch arms across 9 files. Every new
popup adds 6+ more. Inevitable drift.

DESIGN — one shared primitive, two consumer flavours
----------------------------------------------------

The two flavours of scrollable view in the TUI:

  CURSOR-BASED  (the LIST mode of every popup): a focused row
                index that the user moves with j/k; the visible
                rows centre or pan around the cursor; Enter on the
                cursor row drills.

  SCROLL-BASED (DrillScrollView and similar): a scrollTop offset
                that the user pages through; no per-row focus;
                the body is pre-formatted text or fixed-cell rows.

Both consume the same KEYS but apply them to different state.

PROPOSED API
------------
Add src/cli/tui/scroll.ts (no ink/react imports — pure logic):

    /**
     * Apply a scroll/navigation action to a cursor-based view.
     * Returns the new cursor position, clamped.
     *
     *   total      length of the underlying collection
     *   viewport   visible row count (for page semantics)
     *   cursor     current cursor index
     *   action     a parsed nav action (kind + half flag)
     */
    export function applyCursor(
      cursor: number,
      action: NavAction,
      total: number,
      viewport: number,
    ): number { ... }

    /**
     * Same shape, but for scrollTop-based views (DrillScrollView).
     *
     *   totalLines length of the underlying body in lines
     */
    export function applyScroll(
      scrollTop: number,
      action: NavAction,
      totalLines: number,
      viewport: number,
    ): number { ... }

    export type NavAction =
      | { kind: "moveUp" | "moveDown" | "jumpTop" | "jumpBottom" }
      | { kind: "pageUp" | "pageDown"; half: boolean };

Wire from src/cli/tui/keys.ts dispatchPopupKey: the existing
PopupAction.kind values "moveUp"/"moveDown"/"jumpTop"/"jumpBottom"/
"pageUp"/"pageDown" already match. Just type-narrow them as
NavAction and re-export so consumers can call the helpers without
re-walking the union.

CONSUMER PATTERN
----------------
Each popup's useInput handler shrinks from this:

  switch (action.kind) {
    case "moveDown":   setCursor((c) => ...); return;
    case "moveUp":     setCursor((c) => ...); return;
    case "jumpTop":    setCursor(0); return;
    case "jumpBottom": setCursor(Math.max(0, N - 1)); return;
    case "pageDown":   setCursor((c) => clampScrollTop(c + step, ...)); return;
    case "pageUp":     setCursor((c) => clampScrollTop(c - step, ...)); return;
    case "yank":       /* per-popup */
    case "drill":      /* per-popup */
    case "close":      onClose();
  }

…to this:

  if (isNavAction(action)) {
    setCursor((c) => applyCursor(c, action, items.length, viewport));
    return;
  }
  switch (action.kind) {
    case "yank":  /* per-popup */
    case "drill": /* per-popup */
    case "close": onClose();
  }

Each popup loses ~30 lines.

DrillScrollView consumers (popups/ready.tsx drill, popups/agents.tsx
drill, popups/tracks.tsx task-detail mode, popups/workspaces.tsx
commits drill) consume `applyScroll` instead:

  if (isNavAction(action)) {
    setScrollTop((s) => applyScroll(s, action, totalLines, viewport));
    return;
  }
  ...

CONFIRM CONSISTENCY
-------------------
After this lands, every consumer trivially supports:
  j / Down       moveDown
  k / Up         moveUp
  g              jumpTop
  G              jumpBottom
  Ctrl-D         pageDown half
  Ctrl-U         pageUp half
  PageDown       pageDown full
  PageUp         pageUp full

…because dispatchPopupKey already binds those AND every consumer
funnels them through the same applyCursor / applyScroll helper.
No drift possible.

BONUS — DOCUMENT THE KEYMAP IN STATUS BAR
-----------------------------------------
status-bar.tsx popup-mode hint cluster (per nit_tui_status_bar_popup_shift_range)
should reflect the canonical nav set. Today it shows just \"j/k nav\"; widen to
either \"j/k g/G nav · Ctrl-D/U page\" or just \"j/k nav · g/G top/bottom · Ctrl-D/U page\"
depending on what fits at typical widths.

Help overlay (help.tsx) similarly: show every nav key.

LINE-PRECISE FILES TO TOUCH
---------------------------
NEW:
  src/cli/tui/scroll.ts            (~80 LOC, pure)
  test/tui-scroll.test.ts          (~60 LOC, exhaustive boundaries)

EDIT (each file shrinks):
  src/cli/tui/popups/agents.tsx
  src/cli/tui/popups/blocked.tsx
  src/cli/tui/popups/doctor.tsx
  src/cli/tui/popups/inprogress.tsx
  src/cli/tui/popups/log.tsx
  src/cli/tui/popups/ready.tsx
  src/cli/tui/popups/recent.tsx
  src/cli/tui/popups/tracks.tsx
  src/cli/tui/popups/workspaces.tsx
  src/cli/tui/popups/drill.tsx     (clampScrollTop helper relocates to scroll.ts)
  src/cli/tui/keys.ts              (export NavAction type narrowing)
  src/cli/tui/help.tsx             (legend extends)
  src/cli/tui/status-bar.tsx       (popup-mode hint extends)

EDIT (tests):
  test/tui-keys.test.ts            (no behaviour change; isNavAction smoke)
  test/tui-popup-shells.test.ts    (no change)
  test/tui-popup-*.test.ts         (each consumer's source no longer has
                                    the 6 case arms; static-source check)

CONSTRAINTS
-----------
- scroll.ts has NO ink/react imports (pure functions). Keep it
  testable as plain TS.
- Conventional commit prefix: tui:
- Four greens before commit.
- Two-commit option: (1) extract the helpers + add tests, (2)
  rewire all 9 popups + drill.tsx + status-bar + help. Or one
  commit if the diff stays under ~400 LOC net (it should — the
  consumer reduction is bigger than the helper).
- Suggested commit message:
    tui: centralize j/k/g/G/Ctrl-D/U/PgUp/PgDn nav into shared
         applyCursor + applyScroll helpers (was 60 near-duplicate
         switch arms across 9 popups)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish or v0.4.1): bullet under TUI
  consistency.
- docs/ARCHITECTURE.md src/cli/tui/ table: add a row for scroll.ts.
- skills/mu/SKILL.md TUI keymap section: enumerate the canonical
  scroll set.

VERIFY
------
After landing:
  node dist/cli.js state --tui -w tui-impl
  Open every popup (Shift+1..Shift+9). In each:
    - j/k moves cursor or scrolls
    - g jumps to top
    - G jumps to bottom
    - Ctrl-D / Ctrl-U half-pages
    - PageDown / PageUp full-pages
  All bindings work in BOTH list-mode AND drill-mode where each exists.

OUT OF SCOPE
------------
- Don't add Vim-style multi-key motions (5j, gg, etc). The current
  binding set is already richer than most TUIs.
- Don't change the dispatchPopupKey API — only the consumer side.
- Don't promote the helper to a generic \"vim-like reducer\" — two
  concrete consumers is the right depth (cursor + scrollTop).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_centralize_scroll_navigation -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "reaper", 2026-05-12T07:34:40.350Z

```
[reaper] previous owner worker-3 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

### #3 by "reaper", 2026-05-12T07:42:12.208Z

```
[reaper] previous owner worker-3 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

### #4 by "reaper", 2026-05-12T07:59:56.543Z

```
[reaper] previous owner worker-3 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

### #5 by "worker-3", 2026-05-12T08:14:33.269Z

```
CLOSE: ec2a077: centralized j/k/g/G/Ctrl-D/U/PgUp/PgDn nav into pure applyCursor+applyScroll helpers in popups/scroll.ts; collapsed ~60 switch arms across 9 popups + drill into single isNavAction-gated call; net -267 LOC; new tui-scroll.test.ts (19 unit tests) + reframed log/workspaces popup tests; CHANGELOG + ARCHITECTURE updated; 4 greens (typecheck+lint+1918 tests+build)
```
