---
id: "bug_status_detector_pi_solo_misclassifies"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: null
created_at: "2026-05-08T07:38:53.620Z"
updated_at: "2026-05-08T10:18:03.285Z"
blocked_by: []
blocks: []
---

# BUG: status detector misclassifies pi-meta/--solo-wrapped agents as 'needs_input' while they're actively busy

## Notes (1)

### #1 by null, 2026-05-08T07:38:53.741Z

```
SURFACED LIVE during the multi-agent dogfood (3 workers spawned with --command "/Users/mtrojer/.local/bin/pi-meta --solo-name mu-worker-X --solo-force"; user noticed the misclassification mid-session).

Reproduction: spawn an agent whose --command is pi-meta (or any solo-wrapped pi). Observe `mu agent list -w <ws>`:

  ┌────┬──────────┬─────┬─────────────┬──────────┬──────┐
  │    │ name     │ cli │ status      │ window   │ role │
  ├────┼──────────┼─────┼─────────────┼──────────┼──────┤
  │ 💤 │ worker-a │ pi  │ needs_input │ worker-a │      │

…while the pane scrollback clearly shows:

  ⠧ Working...
  ──────────────────────────────────────────────
  edit src/agents.ts
  ──────────────────────────────────────────────

Status SHOULD be 'busy' (worker is processing); instead it shows 'needs_input' (worker is idle, waiting for user). Operationally bad: orchestrator scripts that gate on `agents.status == 'busy'` to track work-in-progress will misfire. The fact that all three workers DID complete their tasks shows the work itself is unaffected — only the visibility/observability is wrong.

Root cause hypothesis (needs verification, but consistent with what's documented in SKILL.md "Status detection lags with custom --command wrappers"):

  src/detect.ts (detectPiStatus) pattern-matches on the rendered prompt shape to decide busy vs needs_input vs free. The patterns are calibrated for vanilla `pi`. pi-meta is a wrapper that:
    1. Changes the model selector header (different ASCII art / branding strip).
    2. Uses solo's per-project lock indicator in the chrome.
    3. Renders a slightly different status bar.

  The 'Working...' spinner is likely emitted on a different terminal column or with a different surrounding glyph (⠧/⠙/⠼/...) than the vanilla-pi pattern expects. detect.ts's regex doesn't match, so it falls back to needs_input.

Evidence in scrollback (from worker-a during the dogfood):
  ⠧ Working...
  ──────────────────────────────────────────────
  ──────────────────────────────────────────────
  ~/.local/state/mu/workspaces/roadmap-v0-2/worker-a (detached)
  ↑10 ↓624 R13k W58k 2.1%/800k (auto)                         (anthropic) claude-opus-4-7 • high

Note the chrome footer with the ↑↓R/W counters — that's pi-meta-specific (or solo-specific) chrome that vanilla pi doesn't render. The detector regex is probably hunting for vanilla-pi's bottom-bar shape.

Why this is HIGH IMPACT (75):
  - mu's whole status story (mission control, agent list, mu state, --tail subscriptions on agent.status) is built on these classifications.
  - Multi-agent orchestration is exactly the case where status visibility matters most (you need to know which workers are still grinding before sending more work).
  - SKILL.md already warns about this ("Status detection lags with custom --command wrappers") — the workaround is "trust scrollback + notes + log" — but a real fix would let the status emoji be load-bearing for monitoring.

Fix options:
  (a) Add a pi-meta-specific detector in src/detect.ts that recognises the wrapper's chrome. Bias toward 'busy' when the spinner glyph is visible.
      + Targeted; doesn't touch vanilla-pi detection.
      - Wrapper-by-wrapper fix; the next wrapper (claude, codex, custom) needs its own detector.

  (b) Generalise the spinner detection: any of the standard braille spinner glyphs (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) or 'Working...' literal anywhere in the last N lines means BUSY, regardless of chrome.
      + One change covers most CLIs.
      + Robust to chrome variations.
      - Could false-positive on agent output that happens to print 'Working...' in a different context.

  (c) Use a heartbeat-of-difference heuristic: if the pane's tail bytes have changed in the last 2-5s, the agent is busy regardless of what the prompt looks like.
      + Detector-agnostic.
      - Requires capture-pane comparison over time; adds I/O cost; needs a stamp in the agents row.

  (d) Per-CLI detector registry: --cli pi_meta uses a pi_meta detector; --cli pi uses the vanilla. The MU_<CLI>_COMMAND env-var convention extends to detection.
      + Clean architecture.
      - Bigger change; needs a new src/detect/<cli>.ts pluggable shape.

I'd lean (b) for short-term cure, (d) for long-term architecture. (a) is a footgun (every new wrapper means a new patch).

Promotion criterion: hit immediately on the first multi-agent real-pi dogfood. Hits every time you spawn pi-meta/solo-wrapped agents. SKILL.md acknowledged this category but didn't have a concrete fix planned. Promote.

Suggested next step: implement (b) — the spinner-glyph fallback — as a high-confidence, low-risk additive heuristic. Falls through to existing detector if no spinner is visible. Estimated 15-25 LOC + 3-5 tests in src/detect.ts and test/detect.test.ts.

Bonus follow-up (separate task): document MU_PI_COMMAND="pi-meta" as a supported configuration in SKILL.md and USAGE_GUIDE — pi-meta is the actual CLI that landed when this dogfood happened.

Live before this fix: orchestrator must rely on scrollback inspection (`mu agent read worker-a -n 30`) to know whether the worker is still busy. The 4-state status emoji is decorative for pi-meta workers.
```
