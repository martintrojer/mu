---
id: "bug_git_show_drill_ansi_wrap_breaks_borders"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: "worker-2"
created_at: "2026-05-13T06:14:24.404Z"
updated_at: "2026-05-13T06:36:24.065Z"
blocked_by: []
blocks: []
---

# BUG: git-show drill (--color=always) ANSI escape sequences confuse ink's wrap math; long lines wrap mid-escape and corrupt the popup borders/contents — wrap should respect VISUAL width (strip ANSI for length math) so wrap-within-borders works cleanly

## Notes (2)

### #1 by "π - mu", 2026-05-13T06:15:38.953Z

```
MOTIVATION (verbatim user)
--------------------------
"the new git show can line wrrap"
"the new git show can line wrrap, add a trim"
"actaully, probably bettwe to line wrap, but without messing up the borders of the ui."

ROOT CAUSE
----------
Commit 70ed68e (feat_git_show_drill_color_and_tuicr) switched the 3 VCS backends' showCommit() from `--color=never` to `--color=always`. The drill body now contains ANSI escape sequences for diff colors (red `-`, green `+`, cyan `@@`).

src/cli/tui/popups/drill.tsx renders each line via plain `<Text>` and lets ink's default wrap policy handle width overflow. Ink's `<Text>` wrap counts BYTES of the string, not the visible character width. So:
  - A line "  -  " + 30 bytes of red ANSI escape + 60 chars of code + reset = ink thinks it's ~95 wide.
  - At a 80-col popup width, ink wraps after the 80th BYTE — which falls in the middle of the file content.
  - The wrap break inside an ANSI sequence (or even mid-content while a color is active) breaks the next line's color and visually CORRUPTS the popup chrome (the wrap fragment continues with the wrong color, sometimes overwriting border characters).

LOCKED FIX
----------
Wrap by VISUAL width (strip ANSI for length math) instead of byte count.

Two implementation paths:

OPTION A — pre-wrap the body before passing to DrillScrollView:
  Compute the popup's content width (cols - chrome). For each line in the body:
    - Use a small ANSI-aware wrap helper that breaks on visual width boundaries.
    - Preserve the active color across wrap boundaries (re-emit the active SGR sequence at the start of each continuation line; emit a reset at the end of each).
  
  Output stays a flat string body; DrillScrollView renders unchanged.
  
  Implementation: a `wrapAnsi(line, width)` helper that returns string[]. Tested in isolation. Mirrors the ansi-aware string utilities ecosystem (`wrap-ansi` npm package) — but per ROADMAP we vendor our own ~50 LOC implementation rather than add a dep.

OPTION B — render-time wrap via ink internals:
  Tell ink's `<Text>` to use ANSI-aware width via `wrap="wrap"` (default) but ALSO pass it through the `string-width` measurement. Ink uses `wrap-ansi` internally if the body has ANSI — verify whether `<Text>` with no explicit `wrap` prop already does this correctly. If yes, the bug is somewhere else (e.g. multi-line emit eating border rows). If no, ink's wrap prop set to "wrap" with `chalk`-style content does honour visual width — try toggling wrap prop on the drill's `<Text>`.

START WITH OPTION B (zero-LOC fix if it works). The DrillScrollView's `<Text>` was changed to default wrap (no `wrap="truncate"`) per a prior session. Verify what wrap mode it's in NOW post-70ed68e. If wrap="wrap" + ANSI works in ink's `<Text>` already, the bug may be entirely in the ANSI sequences themselves (e.g. `git show --color=always` emits sequences ink doesn't understand). Inspect the raw bytes via `git show <sha> --color=always | cat -A | head` to confirm.

If OPTION B doesn't work cleanly, FALL BACK to OPTION A.

PROBE FIRST
-----------
Before writing code, INSTRUMENT:
1. Capture a git show output: `git show HEAD --color=always > /tmp/show.txt`
2. Inspect with `cat -A /tmp/show.txt | head -50` to see the actual ANSI sequences.
3. Capture the rendered TUI: open the commits drill in a known-narrow pane (60 cols), navigate to a long-line commit. Use `tmux capture-pane -p -t <pane>` to dump the rendered output. Compare against the raw input.
4. Identify the SPECIFIC bytes that confuse ink (mid-escape wrap? unclosed SGR? something else?).

Then pick OPTION A or B based on the diagnosis.

⚠️ DRILL VIEW TYPE ⚠️
Two specific drills affected:
  - Commits popup (Shift+0) → Enter on a row → git show body.
  - Workspaces popup (Shift+5) → Enter on a workspace's commit row → same git show body.

Both go through src/vcs.ts VcsBackend.showCommit which returns plain text (now with ANSI). Both render via DrillScrollView in src/cli/tui/popups/drill.tsx.

Other drills (TaskDetailDrill notes, agent scrollback) DON'T have ANSI today — the fix should not break them either.

WIRING
------
- src/cli/tui/popups/drill.tsx: try setting `wrap="wrap"` explicitly on the body Text. Or apply the wrapAnsi pre-process.
- src/cli/tui/wrap-ansi.ts (NEW if Option A): a small ANSI-aware wrap helper. ~50 LOC. Use the existing `string-width` package if already a transitive dep (check); else add a minimal in-tree implementation.
  
  Minimal algorithm:
    for each line:
      walk char-by-char tracking visual width (skip ANSI escape sequences for width count)
      when visual width hits the budget, emit a reset escape, emit a newline, emit the active SGR state (track open sequences)
      continue
- src/vcs.ts: NO change. The --color=always stays.

⚠️ COORDINATION ⚠️
Several in-flight tasks touch popups but not drill.tsx specifically:
  - bug_help_overlay_no_scroll_on_low_rows: gates on bug_t_keypress_replays_stale_mouse_dblclick (already shipped); touches help.tsx + app.tsx.
  - feat_color_status_columns_in_task_list_popups: touches list popups (status column color).
  - feat_color_task_notes_drill: gates on feat_git_show_drill_color_and_tuicr (already shipped); touches task-detail.tsx.
  - bug_drill_views_dont_refresh_on_tick: gates on the same; touches every popup.
This task touches drill.tsx + new src/cli/tui/wrap-ansi.ts. ZERO file overlap with the queued popup-touching tasks.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/cli/tui/wrap-ansi.ts (if Option A): unit test in test/tui-wrap-ansi.test.ts:
  * Plain ASCII line longer than width → wrapped at correct visual width.
  * ANSI-decorated line: visual width = N chars, ANSI bytes = M bytes. Wrap at N visual chars, NOT N+M bytes.
  * Wrap inside an active SGR: continuation line starts with the same SGR re-emitted; previous line ends with reset.
  * Multiple SGRs on one line: handled correctly.
  * Empty / whitespace-only line: passthrough.
- test/tui-popup-commits.test.ts (extend): assert that a commits drill body containing ANSI sequences renders without splitting an escape across lines (test by feeding a fixture with ANSI + asserting the rendered body's lines all have valid SGR pairs).

VERIFY MANUALLY
---------------
Apply the fix; build; in a tmux pane with width ~80 cols:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Press Shift+0 (Commits popup), Enter on a row with a long commit message or wide diff context.
  # EXPECTED: long lines wrap inside the popup borders cleanly. Diff colors preserved across wrap boundaries. Popup chrome (top/bottom borders) stays intact.
  # ALSO test at width 60, 100, 140 — wrap should adapt cleanly at each.
  # CURRENT BUG: borders/colors corrupted; wrap mid-escape.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke at multiple pane widths.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; new wrap-ansi.ts ~50 LOC if needed; drill.tsx ~190 LOC.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: git-show drill wraps long lines by visual width (was: ANSI escape bytes inflated ink's wrap math; mid-escape wrap corrupted popup borders + colors)

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "git-show drills (Commits popup + Workspaces popup) now wrap long lines by visual width instead of byte count. Previously the new --color=always ANSI escape sequences inflated ink's wrap math, breaking lines mid-escape and corrupting the popup chrome / colours. Wrap-within-borders is now clean at any pane width."

OUT OF SCOPE
------------
- No truncate (wrap-within-borders is the user-locked behaviour).
- No fold/scroll-horizontal (ink doesn't support hscroll easily).
- No theme-aware ANSI translation (the diff colors stay as the VCS emits them).
- No --color toggle in the popup keymap (ANSI on by default).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke at multiple pane widths, close YOUR task with:
  mu task close bug_git_show_drill_ansi_wrap_breaks_borders -w tui-impl --evidence "<sha>: <one-line summary including 'verified clean wrap at 60/80/100/140 col widths'>"
```

### #2 by "worker-2", 2026-05-13T06:36:24.065Z

```
CLOSE: 1b25564: git-show drills wrap by visual width; verified clean wrap at 60/80/100/140 col widths
```
