# tui — task index

| id | status | impact | effort | ROI | title |
| --- | --- | --- | --- | --- | --- |
| [`audit_state_ts`](tasks/audit_state_ts.md) | CLOSED | 70 | 1 | 70.00 | Audit current state.ts (907 LOC) — what to keep, port, delete |
| [`design_card_agents`](tasks/design_card_agents.md) | CLOSED | 70 | 0.5 | 140.00 | Design Agents card: summary table (name/status/task/idle/ws-behind) |
| [`design_card_iface`](tasks/design_card_iface.md) | CLOSED | 85 | 1 | 85.00 | Design Card and Popup interfaces (one file per card+popup pair) |
| [`design_card_log`](tasks/design_card_log.md) | CLOSED | 75 | 0.5 | 150.00 | Design Activity-log card: tail-following with auto-scroll-pause |
| [`design_card_ready`](tasks/design_card_ready.md) | CLOSED | 60 | 0.5 | 120.00 | Design Ready card: top-N tasks by impact/effort ROI |
| [`design_card_tracks`](tasks/design_card_tracks.md) | CLOSED | 75 | 0.5 | 150.00 | Design Tracks card: parallel-track tree (port from current state.ts) |
| [`design_complete`](tasks/design_complete.md) | CLOSED | 95 | 0.5 | 190.00 | DESIGN COMPLETE umbrella — all design tasks closed, ready to write-plan |
| [`design_global_keymap`](tasks/design_global_keymap.md) | CLOSED | 80 | 0.5 | 160.00 | Design global keymap: 1-9 toggle, Shift+1-9 popup, +/- tick, q quit, ? help |
| [`design_help_overlay`](tasks/design_help_overlay.md) | CLOSED | 55 | 0.5 | 110.00 | Design help overlay (?): shows global + popup-local keymap |
| [`design_json_compat`](tasks/design_json_compat.md) | CLOSED | 60 | 0.5 | 120.00 | Design --json on mu state: keep current shape; bare mu still defaults to TUI |
| [`design_locked`](tasks/design_locked.md) | CLOSED | 90 | 0.5 | 180.00 | Locked design decisions (brainstorm output) |
| [`design_module_layout`](tasks/design_module_layout.md) | CLOSED | 80 | 0.5 | 160.00 | Design module layout: src/cli/state.ts vs src/tui/ subdir |
| [`design_non_tty_fallback`](tasks/design_non_tty_fallback.md) | CLOSED | 70 | 0.5 | 140.00 | Design non-TTY fallback: detect isTTY, fall back to mu state |
| [`design_poll_loop`](tasks/design_poll_loop.md) | CLOSED | 70 | 0.5 | 140.00 | Design poll loop: 1s default, +/- live adjust, floor 100ms ceiling 10s |
| [`design_popup_agents`](tasks/design_popup_agents.md) | CLOSED | 75 | 1 | 75.00 | Design Agents popup: scrollback drill, y/c/s/k yank commands, / filter |
| [`design_popup_lifecycle`](tasks/design_popup_lifecycle.md) | CLOSED | 85 | 0.5 | 170.00 | Design fullscreen popup lifecycle: open/restore-state/close/single-popup invariant |
| [`design_popup_log`](tasks/design_popup_log.md) | CLOSED | 60 | 0.5 | 120.00 | Design Log popup: full event timeline with filter by kind/agent |
| [`design_popup_tasks`](tasks/design_popup_tasks.md) | CLOSED | 80 | 1 | 80.00 | Design Tasks popup: notes/tree/blockers, yank claim/close/release commands |
| [`design_popup_tracks`](tasks/design_popup_tracks.md) | CLOSED | 70 | 1 | 70.00 | Design Tracks popup: drill into a track's task tree + notes preview |
| [`design_resize`](tasks/design_resize.md) | CLOSED | 50 | 0.5 | 100.00 | Design terminal-resize handling: ink onresize + reflow rules |
| [`design_sdk_seam`](tasks/design_sdk_seam.md) | CLOSED | 85 | 1 | 85.00 | Design SDK seam: getStateCard() and friends as the only TUI data source |
| [`design_tests`](tasks/design_tests.md) | CLOSED | 65 | 1 | 65.00 | Design test strategy: ink-testing-library + integration tests with $TMUX guard |
| [`design_yank_flow`](tasks/design_yank_flow.md) | CLOSED | 65 | 0.5 | 130.00 | Design yank flow: clipboard detect, toast in popup, footer on dashboard (A3') |
| [`docs_changelog`](tasks/docs_changelog.md) | CLOSED | 50 | 0.5 | 100.00 | Draft CHANGELOG.md entry under upcoming version |
| [`docs_roadmap_amend`](tasks/docs_roadmap_amend.md) | CLOSED | 80 | 0.5 | 160.00 | Draft ROADMAP.md amendment: retire 'no render layer beyond cli-table3' pledge |
| [`docs_usage_guide`](tasks/docs_usage_guide.md) | CLOSED | 60 | 0.5 | 120.00 | Draft USAGE_GUIDE.md update: new TUI section + remove --hud refs |
| [`docs_vision_amend`](tasks/docs_vision_amend.md) | CLOSED | 80 | 0.5 | 160.00 | Draft VISION.md amendment: short-lived-process pillar gets TUI exception |
| [`docs_vocab_amend`](tasks/docs_vocab_amend.md) | CLOSED | 60 | 0.5 | 120.00 | Draft VOCABULARY.md additions: card, popup, tick, yank, footer-toast |
| [`investigate_bundle_size`](tasks/investigate_bundle_size.md) | CLOSED | 40 | 0.5 | 80.00 | Measure ink bundle size impact on tsup output |
| [`investigate_clipboard`](tasks/investigate_clipboard.md) | CLOSED | 50 | 0.5 | 100.00 | Investigate clipboard backends (pbcopy/xclip/wl-copy) |
| [`investigate_render_lib`](tasks/investigate_render_lib.md) | CLOSED | 80 | 1 | 80.00 | Investigate ink + alternatives, lock render lib |
