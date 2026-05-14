---
id: "bug_tui_render_ghosting"
workstream: "tui-impl"
status: CLOSED
impact: 95
effort_days: 0.1
roi: 950.00
owner: null
created_at: "2026-05-11T13:31:58.055Z"
updated_at: "2026-05-11T13:56:57.982Z"
blocked_by: ["bug_tui_top_align"]
blocks: ["bug_card_header_inset", "feat_column_aligned_lists", "feat_more_cards_umbrella", "feat_popup_enter_drill", "feat_responsive_layout", "feat_status_bar", "feat_tui_multi_workstream", "tui_impl_complete"]
---

# BUG: TUI re-renders STACK on top of each other instead of replacing previous frame (border ghosting on every tick)

## Notes (2)

### #1 by "π - mu", 2026-05-11T13:31:58.361Z

```
Reproducer: launch TUI against a workstream that has activity (e.g.
gchatui), let a few ticks pass while tasks/events are being added
and removed. Output ghosts:

  ╭──────────────────────────────────╮   <- frame 1 top
  ╭──────────────────────────────────╮   <- frame 2 top (frame 1 not cleared)
  ╭──────────────────────────────────╮   <- frame 3 top
  ╭──────────────────────────────────╮   <- frame 4 top
  ╭──────────────────────────────────╮   <- frame 5 top (the only "live" frame)
  │ Agents · 1 needs_input · 1 busy  │
  │  worker-1 — —                    │
  │  worker-2 ... —                  │
  ╰──────...

The dashboard's top border is being re-drawn at a NEW row position
each tick, instead of erasing the previous frame and re-rendering
in place. Every tick adds one more ghost border on top.

Likely cause: ink's inline render mode (the default) doesn't reposition
the cursor to the start of its rendered region between renders when
content height changes. When the data shape changes between ticks
(more agents, more events) or when card visibility toggles, ink's
diff algorithm appears to print extra rows above the previous output.

THIS IS THE SAME ROOT FAMILY AS bug_tui_top_align: ink's inline
render mode is the wrong substrate for a live-updating, full-pane
dashboard. Both bugs go away with alt-screen.

FIX: alt-screen + clear-on-mount + restore-on-exit, as already
specified in bug_tui_top_align's note. Specifically:

  src/cli/tui/index.ts runTui:

    process.stdout.write("\x1b[?1049h");  // enter alt-screen
    process.stdout.write("\x1b[H");        // cursor home
    process.stdout.write("\x1b[2J");       // clear alt-screen

    const { waitUntilExit } = render(<App ... />, { exitOnCtrlC: true });
    try { await waitUntilExit(); }
    finally {
      process.stdout.write("\x1b[?1049l");  // restore main screen
    }

In alt-screen, ink's renders are anchored to row 0 column 0, so each
tick just overwrites the previous frame. No ghosting possible.

INTERACTION:
- This bug COLLAPSES into bug_tui_top_align — they're both fixed by
  the same alt-screen patch. Mark this bug as a duplicate / blocker
  edge to top-align, OR fold into top-align's deliverable.
- If we close them together: top-align's note is the canonical fix
  description; this note is the canonical reproducer.

URGENCY: HIGH (this is what users see first; the static card looks
broken-but-working, the TUI looks completely broken).
```

### #2 by "π - mu", 2026-05-11T13:56:57.982Z

```
CLOSE: alt-screen patch in 21b43fe (worker-2 / bug_tui_top_align) fixes both top-align AND ghosting via the same mechanism
```
