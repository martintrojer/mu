---
id: "design_locked"
workstream: "tui"
status: CLOSED
impact: 90
effort_days: 0.5
roi: 180.00
owner: null
created_at: "2026-05-11T10:44:45.354Z"
updated_at: "2026-05-11T10:49:59.436Z"
blocked_by: []
blocks: ["audit_state_ts", "design_global_keymap", "design_poll_loop", "docs_roadmap_amend", "docs_vision_amend", "investigate_clipboard", "investigate_render_lib"]
---

# Locked design decisions (brainstorm output)

## Notes (2)

### #1 by "π - mu", 2026-05-11T10:45:45.034Z

```
DECISION: locked design choices from brainstorm session 2026-05-11.

SCOPE: replace `mu state --hud` with an interactive read-only TUI.
Static `mu state` (without --hud) remains the non-TTY fallback.

LOCKED DECISIONS:
- L1-total: TUI fully replaces `mu state --hud`; `mu state` is non-TTY/CI fallback
- R1 read-only: model drives the CLI; act-intents YANK mu commands, never execute
- Render lib: ink (React-for-terminal). Pillar amendment required.
- Card model: btop-style toggleable cards on a glanceable dashboard
- Card v0 set: Agents, Tracks, Ready, Activity log (4 cards). Detail card DROPPED.
- Interaction: 1-9 toggle card visibility on dashboard;
  Shift+1-9 open FULLSCREEN popup for that subject
- Single popup invariant; popup close restores prior dashboard state (toggles + tick)
- No persistence of toggles (pillar-fit; sidesteps no-config-file pledge)
- Poll loop: F1 simple poll, 1s default, +/- live adjust (floor 100ms, ceil 10s)
- Yank flow A3': clipboard if available + transient toast in popup +
  persistent footer line on dashboard ("last: mu agent close worker-1 -w tui [copied]")
- Inside-popup keymap CONSISTENT across popups: j/k g/G Enter / Esc y ?
  Plus per-popup verbs that match the CLI verbs (n=notes, t=tree, b=blockers, etc.)

PILLAR TENSIONS (must be addressed in docs_vision_amend / docs_roadmap_amend):
- "No render layer beyond cli-table3 + picocolors" — retired in favor of "+ ink for TUI"
- "Every invocation is short-lived" — exception carved for `mu`/`mu state` interactive mode
- Drift risk mitigated by: TUI lives in-repo, consumes the same SDK as static renderer

NEXT: investigate_render_lib (ink vs blessed vs hand-rolled, final lock),
audit_state_ts (what to keep/port/delete), design_module_layout.

VERIFIED: brainstorm transcript 2026-05-11 (turn-by-turn record above this note).
```

### #2 by "π - mu", 2026-05-11T10:49:59.436Z

```
CLOSE: decisions recorded as note #971 on 2026-05-11; brainstorm transcript captured
```
