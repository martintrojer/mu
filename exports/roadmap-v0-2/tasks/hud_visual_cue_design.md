---
id: "hud_visual_cue_design"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: null
created_at: "2026-05-07T17:51:32.903Z"
updated_at: "2026-05-08T10:20:50.383Z"
blocked_by: []
blocks: ["hud_visual_cue_impl"]
---

# Design: visual cue 'you are looking at an agent' to prevent prompt-confusion

## Notes (1)

### #1 by π - mu, 2026-05-08T10:21:15.817Z

```
DESIGN: spawn-time one-line banner

PROBLEM: operator with N panes (workers + own pi + bash + orchestrator) types into wrong pane / runs mu from wrong pane / forgets which pane is which. Long sessions worst.

EXISTING SIGNALS (all weak):
- tmux pane title (small; needs status bar enabled)
- tmux window name (groups by --tab; agents in same tab share name)
- $MU_AGENT_NAME (invisible until echoed)
- mu whoami (invisible until invoked)
- pi prompt (shows pi identity, not mu view)

DECISION: minimum cue is a spawn-time one-line banner sent to the pane via the existing bracketed-paste protocol. After binary is up + after spawn liveness check, send:

  [mu] agent worker-1 - workstream auth - pane %42
  [mu] workspace: ~/.local/state/mu/workspaces/auth/worker-1 (git)   # if --workspace

Lands in scrollback (persists; operator can scroll up; LLM reads it as initial context). One line per fact (workspace line conditional). Opt-out via MU_BANNER_QUIET=1.

WHY BANNER OVER PI-PROMPT-PREFIX:
- Prompt-prefix would need a pi extension (out of mu scope per ROADMAP do-not-bundle-pi)
- Doesn't help non-pi CLIs (--cli sh for tests)
- Banner covers highest-friction case (first 30s after spawn)

WHAT IT DOES NOT SOLVE (separate tasks if friction shows):
- Pane confusion AFTER banner has scrolled offscreen --> prompt-prefix territory
- pi prompt itself --> pi extension territory
- Status bar disabled --> out of scope

IMPLEMENTATION (for hud_visual_cue_impl, ~10 LOC + 2 tests):
- src/agents.ts spawnAgent: after spawn liveness check, if env var unset, sendToPane the banner lines.
- No CLI changes (banner emitted by SDK).
- Test: spawn agent in mocked tmux, assert send-keys received the banner content. MU_BANNER_QUIET=1 path: no send.

RISK: banner lands before binary TUI redraws --> clobbered. The existing 1500ms MU_SPAWN_LIVENESS_MS check is the natural sync point; banner goes after that.

NEXT: implement hud_visual_cue_impl per sketch. ~10 LOC + 2 tests; estimate 0.3-0.5 days.

VERIFIED: pillars (subtractive: reuses sendToPane; no daemon: spawn-time only; short-lived: scrollback persists without watcher). No new flag, no new module, no new dep.

ODDITIES: none yet -- implement and dogfood will surface them.
```
