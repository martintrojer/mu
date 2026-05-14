---
id: "testreview_tui_app_no_behaviour_coverage"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.6
roi: 125.00
owner: "worker-1"
created_at: "2026-05-13T12:54:19.452Z"
updated_at: "2026-05-13T17:00:21.937Z"
blocked_by: []
blocks: []
---

# REVIEW high: app.tsx (714 LOC, root state machine) has zero behaviour tests; only source-greps

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:54:20.931Z

```
FILE(S):
  test/tui-app.test.ts (185 LOC; entire file)
  src/cli/tui/app.tsx (714 LOC; root state machine)

FINDING (missing coverage / fake testing):
  app.tsx is the load-bearing root component for the TUI:
    - useDashboardSnapshot poll loop
    - card visibility state
    - tick-rate state (+/-/=)
    - single-popup invariant (popup !== null guard on toggleCard / openPopup)
    - help overlay open/close + key swallow
    - mouse hit-test → popup open
    - mouse → emitKey replay (synthetic keystrokes via internal_eventEmitter)
    - frame-height pin / overflow=hidden (anti-ghosting)
    - tab cycling for multi-ws TUI
    - Ctrl-C handling

  test/tui-app.test.ts is 185 LOC and contains:
    - 4 source-grep tests on app.tsx (no behaviour)
    - 1 import-graph smoke test (`expect(typeof App).toBe("function")`)

  ZERO tests actually mount <App> and exercise any of the
  behaviours above. The header comment is honest about it:
  > "ink-testing-library is not installable in this environment
  >  (network-blocked). Rather than gate on it, we test <App>
  >  via a minimal in-process harness that mounts the component
  >  with a piped writable stream and reads the rendered frames."

  But no such harness is actually built; the test file falls
  back entirely to `readFileSync` greps.

WHY IT'S A PROBLEM:
  - The largest, most state-intensive file in the cluster has
    NO behaviour tests. A bug in the popup-suppression guard,
    the single-popup invariant, the help-overlay key swallow,
    or the tick state-restore is invisible to CI until a user
    files a bug.
  - Real production bugs the cluster shipped — render ghosting
    (bug_tui_render_ghosting_v2), tab-switch stale render
    (bug_tui_tab_switch_stale_render), popup-fill-pane
    regression (bug_tui_popups_fill_pane), top-card scroll-off
    (bug_tui_dashboard_top_card_scrolls_off) — all surfaced
    *visually* during dogfood, not from the test suite, then
    got post-hoc source-grep regression guards.
  - The structural assertions in tui-app.test.ts (e.g. the
    allow-list of identifiers in the popup `props` literal) is
    a cargo-cult anti-pattern: it locks down the literal SHAPE
    of the props bag rather than asserting the popup CAN'T
    mutate App-level state. The actual invariant ("popups don't
    receive setVisibility / setTickMs / setFooter") could be
    enforced with a TS interface; the source-grep is a poor
    proxy.

PROPOSED FIX:
  Add `test/tui-app-behaviour.test.ts` that:
    - Mounts <App> with a fixture DB + workstream using ink's
      render({stdout: CaptureStream, stdin: pseudo-tty})
    - Sends keys via `stdin.write("3")`, asserts ReadyCard hides
    - Sends key "?", asserts help overlay appears
    - Sends key "q" while popup is open, asserts popup closes
      but App doesn't quit
    - Sends key "Tab" with multi-ws, asserts active tab changes
    - Sends key "Ctrl+C", asserts exit() called

  The CaptureStream + waitForInkOutput primitives in
  test/_ink-render.ts already exist (used by card tests). The
  missing piece is `simulateInput(stdin, "j")` — small (~30 LOC)
  helper that writes raw bytes including escape sequences for
  arrow keys / Esc.

EFFORT NOTE:
  ~0.6d to bootstrap behaviour testing for App + 5-8 of the most
  important behaviours. Once the seam exists every popup test
  becomes shorter AND more powerful. See the larger umbrella
  finding (testreview_tui_static_source_grep_pervasive).

  Risk: ink's render() in unit tests can leak setIntervals on
  setTimeout; need explicit `instance.unmount()` per test +
  fake timers for the snapshot poll loop. The
  test/_ink-render.ts CaptureStream pattern handles cleanup
  fine; the new piece is keymap input.
```

### #2 by "worker-1", 2026-05-13T17:00:21.937Z

```
CLOSE: 9dbc4f0: tui-app-behaviour.test.ts covers 9 App invariants (initial-render, card-toggle x2, help open/close x2, popup open/Esc-close, tab cycle, Ctrl-C exit, tick-faster); each verified by deliberately regressing the matching app.tsx branch (toggleCard, toggleHelp, openPopup, nextTab, popup onClose, snapshot wiring, tickFaster) and confirming the test fails. Existing tui-app.test.ts source-grep retained as props-bag invariant guard. Four greens (typecheck/lint/test:fast/test/build) clean.
```
