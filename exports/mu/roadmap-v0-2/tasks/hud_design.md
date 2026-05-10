---
id: "hud_design"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: null
created_at: "2026-05-07T17:51:32.810Z"
updated_at: "2026-05-08T11:05:07.836Z"
blocked_by: []
blocks: ["hud_extension_skeleton"]
---

# Design: pi extension HUD — what to show, refresh strategy, screen real estate

## Notes (1)

### #1 by π - mu, 2026-05-08T11:05:07.731Z

```
DESIGN OUTCOME (in conversation, ratified by code in commits a974775 + this)

Pivoted from the original framing (pi extension HUD widget) to a substrate-native verb:

  mu hud -w <ws>                    # print-once renderer; 5 mode flags
                                    # --line, --small, --mid, --full, --json

Why pivoted:
  - 'don't bundle pi' pillar: pi extensions = mu code in pi-runtime, which is exactly what we
    parked under that pillar.
  - CLI-agnostic: pi-meta, claude, codex operators all benefit from the same verb.
  - Subtractive: no daemon, no auto-spawn, no tmux side effects. mu prints; user composes
    redraw via watch / display-popup / status-right interpolation.

What landed
  - mu hud verb (cli.ts): 5 mutually-exclusive modes + -n N for events-tail length
  - 8 unit tests in test/hud.test.ts
  - SKILL.md verb list grows by one line; no operator-loop changes
  - Live-verified all 5 modes against a real workstream

Companion task hud_visual_cue_impl (also closed): per-pane border + composed pane title carry
mu's interpreted state. Together with mu hud, the orchestrator gets:
  - border on every worker pane (always-visible 'who am I')
  - mu hud --line in their tmux status / dotfile (always-visible 'what's the workstream')
  - mu hud --full in a watch pane or popup (rich card on demand)

REMAINING hud_* TASKS (next move)
  hud_extension_skeleton  REJECT (pi-extension shape rejected per pillar)
  hud_widget_impl         REJECT (same)
  hud_dogfood             KEEP, repurposed for the verb shape (use the verb across a real wave)
```
