---
id: "bug_tui_top_align"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.1
roi: 650.00
owner: null
created_at: "2026-05-11T13:20:05.058Z"
updated_at: "2026-05-11T13:38:08.923Z"
blocked_by: []
blocks: ["bug_tui_render_ghosting", "feat_responsive_layout", "feat_status_bar", "feat_tui_multi_workstream", "tui_impl_complete"]
---

# BUG: TUI dashboard should align to the TOP of the pane by default (currently appears to render mid-pane / bottom)

## Notes (2)

### #1 by "π - mu", 2026-05-11T13:20:05.387Z

```
On launch the dashboard appears NOT pinned to the top of the
terminal/pane — there's blank space above the first card. Should be
flush with row 0.

Likely cause: ink's render mode + alt-screen behaviour. ink v5 by
default uses the inline render path which puts output where the
cursor was when render() was called (typically below the prompt).

FIX: pass `patchConsole: false` (already off) and consider using
`render(<App/>, { stdout, stdin, exitOnCtrlC: true, debug: false })`
+ explicit cursor positioning, OR enter the alt-screen via the
`\x1b[?1049h` sequence on mount (and `\x1b[?1049l` on unmount).

Alt-screen is the lazygit/htop/btop convention: TUI takes over the
whole pane, restores it on quit. ink doesn't do this automatically.

IMPLEMENTATION OPTIONS:

Option A: alt-screen (preferred, matches the visual target):
  In src/cli/tui/index.ts runTui:
    process.stdout.write("\x1b[?1049h");  // enter alt-screen
    const { waitUntilExit } = render(...);
    try { await waitUntilExit(); }
    finally {
      process.stdout.write("\x1b[?1049l");  // restore on any exit path
    }
  Pro: dashboard is full-screen, prompt is preserved on quit, no
       drift, matches lazygit/htop/btop muscle memory.
  Con: lose-the-output: scrollback during the TUI session is on a
       separate buffer; users can't scroll back through pre-TUI shell
       history without quitting first. (This is normal alt-screen
       behaviour and what users expect.)

Option B: inline + cursor reset:
  Push a clear-and-move-cursor on each render. Hacky; flickers; and
  still leaves output below in the scrollback. Don't do this.

PICK OPTION A.

Test surface: hard to unit-test alt-screen escape sequences (they're
TTY-only side effects). A static-source assertion in
test/tui-acceptance.test.ts that runTui writes the alt-screen enter
+ exit sequences is enough.

INTERACTION:
- Lands BEFORE feat_responsive_layout (alt-screen gives the layout
  task a full-pane canvas to reflow into).
- Lands AFTER bug_popup_q_esc_quits_app (so testing alt-screen
  behaviour doesn't fight the popup-quit bug).
- Independent of bug_card_header_inset / column-alignment / digit-
  prefix work.
```

### #2 by "worker-2", 2026-05-11T13:38:08.923Z

```
CLOSE: 1c69e20: alt-screen enter/exit in runTui; acceptance test asserts both escapes + finally
```
