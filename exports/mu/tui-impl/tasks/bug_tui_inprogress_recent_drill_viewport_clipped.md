---
id: "bug_tui_inprogress_recent_drill_viewport_clipped"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.15
roi: 466.67
owner: null
created_at: "2026-05-12T06:22:43.780Z"
updated_at: "2026-05-12T06:35:35.347Z"
blocked_by: []
blocks: []
---

# BUG: In-progress popup (Shift+6) and Recent popup (Shift+8) drill mode hardcode VIEWPORT=20 — content clips below the popup body when the pane is taller than 20 rows

## Notes (2)

### #1 by "π - mu", 2026-05-12T06:23:26.680Z

```
SYMPTOM (verbatim user repro)
-----------------------------
"in-progess drill-down popups cover the entire viewport but the
content is clipped. we solved this problem on other drill downs.
this smells like a copy-paste problem. we need to centralize all
this and have each drill-down NOT re-implement everything."

ROOT CAUSE — DEAD-OBVIOUS COPY-PASTE
------------------------------------
src/cli/tui/popups/viewport.ts already exports popupViewport(rows)
that returns rows - chrome (clamped to POPUP_VIEWPORT_FLOOR). The
fix bug_tui_popup_data_doesnt_fill (commit 50296b0) wired it into
EVERY list popup AND most drill paths.

But two popups still carry the legacy hardcoded `const VIEWPORT = 20`
constant AT THE TOP OF THE FILE and pass `VIEWPORT` (literal 20) to
their TaskDetailDrill in drill mode:

  src/cli/tui/popups/inprogress.tsx:64    const VIEWPORT = 20;
  src/cli/tui/popups/inprogress.tsx:221   viewport={VIEWPORT}
  src/cli/tui/popups/recent.tsx:65        const VIEWPORT = 20;
  src/cli/tui/popups/recent.tsx:222       viewport={VIEWPORT}

Plus all six clampScrollTop call sites in each file (lines 126/129/
135/139/144 in inprogress, 127/130/136/140/145 in recent) pass
VIEWPORT instead of the dynamic popupViewport(rows).

Effect: when the user's terminal is taller than 20 rows (which is
true for any normal pane), the drill body fills 20 visible lines
and any extra content sits BELOW the visible rendering — the popup
chrome (cyan border) reaches the pane bottom but the inner notes
text is short. Wider terminals just show more dead space because
the body Box flexGrows past the viewport-bounded content. The
visible result the user reports is "popup covers viewport, content
clipped" — they're seeing the popup's outer border full-pane but
the notes content is truncated to the first 20 visible lines of
text.

For comparison, blocked.tsx / ready.tsx / agents.tsx / tracks.tsx /
log.tsx / workspaces.tsx / doctor.tsx all use:

  import { popupViewport } from "./viewport.js";
  const { stdout } = useStdout();
  const viewport = popupViewport(stdout?.rows ?? 24);

…and pass `viewport` everywhere VIEWPORT used to be passed. This
is the same pattern; the two missed files are pure copy-paste
oversights.

FIX — LINE-PRECISE
------------------
src/cli/tui/popups/inprogress.tsx:
  - Remove the `const VIEWPORT = 20;` line (line 64).
  - Add the popupViewport import + computed `viewport` constant
    next to the existing useStdout() (or grow the import block).
  - Replace EVERY `VIEWPORT` reference in the file with the
    runtime `viewport` constant (lines 126, 129, 135, 139, 144,
    221).

src/cli/tui/popups/recent.tsx:
  - Same edits: remove the `const VIEWPORT = 20;` line (line 65),
    import popupViewport, replace every `VIEWPORT` with `viewport`
    (lines 127, 130, 136, 140, 145, 222).

CENTRALISATION ANGLE
--------------------
The user's suggestion is sound: every popup re-derives the viewport
the same way. Consider opportunistically promoting the dynamic
viewport into a tiny custom hook `usePopupViewport()` in
src/cli/tui/popups/viewport.ts:

  import { useStdout } from "ink";
  export function usePopupViewport(chromeOverride?: number): number {
    const { stdout } = useStdout();
    return popupViewport(stdout?.rows ?? 24, chromeOverride);
  }

…then every popup becomes a single line:

  const viewport = usePopupViewport();

Refactor scope is small (~10 LOC removed per popup, 1 line added).
Optional but tidy. Either ship just the bug fix OR ship the
hook + migrate all 9 popups in the same commit. Implementer's call;
I'd ship both.

VERIFY (CHEAP)
--------------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Resize terminal so it has >25 rows of headroom.
4. Shift+6 → In-progress popup. Pick a task with notes, Enter to
   drill. Body should fill from popup chrome top to popup chrome
   bottom (no dead space). Notes longer than viewport scroll with
   j/k.
5. Repeat for Shift+8 → Recent popup → Enter → drill.
6. Shrink terminal to 12 rows. Drill body should clamp to
   POPUP_VIEWPORT_FLOOR (8 rows) and not collapse below it.

TESTS
-----
- New test/tui-popup-viewport-no-hardcode.test.ts: per-popup
  static-source assertion that `const VIEWPORT =` no longer appears
  in any popup file (regex over src/cli/tui/popups/*.tsx). Catches
  the next copy-paste regression.
- Extend existing tests if they assert on VIEWPORT literal.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: drop hardcoded VIEWPORT=20 from inprogress + recent popup
         drills; reuse popupViewport(rows) like every other popup
         (was clipping notes / dead space below 20-row drill body)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed.

OUT OF SCOPE
------------
- Don't change popupViewport's chrome math.
- Don't refactor the popup Shells (worker-3 is doing that in
  nit_tui_drill_inset_title_and_hints — coordinate by avoiding
  the Shell JSX).
- Don't change the drill-mode keymap.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_inprogress_recent_drill_viewport_clipped -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-12T06:35:35.347Z

```
CLOSE: f057fca4dc8c: usePopupViewport() hook in popups/viewport.ts + all 9 popups migrated; inprogress + recent drop legacy const VIEWPORT=20 (drills now slice from useStdout().rows, not literal 20). New test/tui-popup-viewport-no-hardcode.test.ts glob-asserts no popup re-introduces the literal. typecheck+lint+test(1798)+build all green.
```
