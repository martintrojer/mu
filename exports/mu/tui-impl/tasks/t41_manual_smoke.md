---
id: "t41_manual_smoke"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.2
roi: 400.00
owner: null
created_at: "2026-05-11T11:56:03.938Z"
updated_at: "2026-05-12T11:07:56.382Z"
blocked_by: ["bug_tui_log_card_columns_misaligned", "bug_tui_popup_cursor_highlight_color_leak", "bug_tui_tab_switch_stale_render", "t40_four_greens"]
blocks: ["t50_final_greens"]
---

# T41: manual smoke in real TTY (checklist)

## Notes (1)

### #1 by "π - mu", 2026-05-12T11:07:56.382Z

```
CLOSE: user manually smoked the TUI throughout the session: drilled tasks/git show/log payload/agent scrollback/doctor remediation; exercised Tab between workstreams, every popup (Shift+1..9), j/k navigation, /-filter, Enter drill chains, y yanks. Bugs surfaced + fixed: drill double hints, drill text wrap, dashboard top-card scroll-off, log-popup column drift, viewport=20 hardcode in inprogress/recent drills. User explicitly confirmed 'looks good to me right now' after the central drill TitledBox-drop fix landed (commit 5e334f6).
```
