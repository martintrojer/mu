---
id: "testreview_tui_static_source_grep_pervasive"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.8
roi: 100.00
owner: null
created_at: "2026-05-13T12:54:17.390Z"
updated_at: "2026-05-13T16:40:46.446Z"
blocked_by: ["tests_tui_capture_stream_seam_helper", "tests_tui_convert_agents_log_recent", "tests_tui_convert_ready_inprogress_blocked", "tests_tui_convert_workspaces_commits_doctor", "tests_tui_seam_doc_addendum"]
blocks: []
---

# REVIEW high: ~30 TUI test files lean on readFileSync source-grep instead of behaviour testing

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:54:18.668Z

```
FILE(S):
  test/tui-popup-blocked.test.ts (most of the file)
  test/tui-popup-doctor.test.ts (most of the file)
  test/tui-popup-recent.test.ts (most of the file)
  test/tui-popup-inprogress.test.ts (most of the file)
  test/tui-popup-tasks.test.ts (~2/3 of the file)
  test/tui-popup-workspaces.test.ts (~3/4 of the file)
  test/tui-popup-tracks.test.ts (entire file)
  test/tui-popup-agents.test.ts (entire file)
  test/tui-popup-log.test.ts (entire file)
  test/tui-popup-commits.test.ts (last describe block)
  test/tui-popup-all-tasks.test.ts (last 3 it() blocks)
  test/tui-popup-task-detail.test.ts (last describe block)
  test/tui-popup-shells.test.ts (entirely static-source)
  test/tui-popup-viewport-no-hardcode.test.ts (entirely static-source)
  test/tui-app.test.ts (entirely static-source)
  test/tui-app-frame-height.test.ts (entirely static-source)
  test/tui-acceptance.integration.test.ts:135-176 (last 4 of 5 tests)
  test/tui-state-hook-rerender.test.ts:228-298 (Layer B + refresh-now blocks)
  test/tui-card-footer-inset.test.ts (entirely static-source)
  test/tui-card-render-width.test.ts (entirely static-source)
  test/tui-cursor-row.test.ts:114-143 (last describe block)
  test/tui-columns.test.ts:163-261 (last describe block)
  test/tui-dashboard-layout.test.ts (uses readFileSync)
  test/tui-drill-no-wrap.test.ts (uses readFileSync)
  test/tui-drill-keymap.test.ts (uses readFileSync)
  test/tui-keymap-consistency.test.ts (treats spec as a snapshot in a different way — closer to behaviour, but still source-shape grep)

FINDING (test smell / fake testing — pervasive across shard):
  The TUI test suite leans HEAVILY on
  `readFileSync(...)` + `expect(src).toContain("...")` /
  `expect(src).toMatch(/regex/)` over `.tsx` source files. Counts:
  ~30 of the 65 TUI test files contain `readFileSync` of source.
  Several test entire popup behaviours through static-source
  greps: tui-popup-agents.test.ts is 24 lines of "src contains
  'mu agent send'" / "src contains 'readAgent'" assertions.
  tui-popup-blocked.test.ts has ~140 lines of source-greps.
  tui-popup-shells.test.ts is 123 lines of source patterns
  asserting shell consumption.

  The pattern was previously flagged for the BARE-CLI shard:
  see review_repo_unused_zod_dependency / testreview_static_source_assertions
  in this same workstream — that finding rewrote two specific
  files (state-dispatch.test.ts, state-render.test.ts) as
  behaviour tests. The TUI shard is a much bigger version of the
  same problem.

WHY IT'S A PROBLEM:
  - Static-source assertions PASS WHEN BEHAVIOUR IS BROKEN. A
    popup whose `mu agent send` literal appears in the file but
    whose useInput callback's `case "verb"` was deleted by a
    refactor → the test still passes because the literal still
    appears in a comment, a different switch arm, or a yank
    template that's never reached.
  - They FAIL ON HARMLESS REFACTORS. Renaming `setShowSha` to
    `setShowCommit` breaks tui-popup-workspaces.test.ts even
    though behaviour is identical. Splitting a ternary across
    lines breaks the regex `/\$\{t\.name\} \$\{t\.title\}/`.
    Moving the `void fastTickNonce;` line breaks state-hook-rerender's
    `not.toMatch(/void\s+refreshNonce\s*;/)` etc.
  - They can't catch real bugs that the TUI shard has
    historically produced — render ghosting, stale snapshot
    after tab swap, popup viewport clipping. Each of those needed
    REAL render testing or REAL state-machine driving; the
    static-source greps were powerless to detect them in advance,
    and the post-fix regression guards (per Layer 2 of
    bug_tui_render_ghosting_v2) are themselves more source greps.
  - They breed "test the wrong thing" inertia: when a real bug
    surfaces (e.g. mouse doubleclick races, internal_eventEmitter
    breakage, tick-skipping during tab switch), the test pattern
    under most popup tests doesn't extend; the developer has to
    invent a behaviour test from scratch.

  The core issue: ink-testing-library is unavailable
  (network-blocked per the comment in tui-app.test.ts), so
  testers reached for source greps as the next-best
  approximation. That made sense as a temporary measure; it has
  calcified into the dominant pattern.

PROPOSED FIX:
  This is a multi-task umbrella. Smaller subsets that ship
  independently:

  1. ENABLE BEHAVIOUR TESTING SEAM. The codebase already has
     test/_ink-render.ts with `CaptureStream` + `waitForInkOutput`
     + `collectRenderedLines` (used by some card tests). It also
     uses ink's `render({stdout, stdin, debug, patchConsole})`
     directly — which IS ink-testing-library-equivalent for
     read-only assertions. So the seam EXISTS; it's just not
     widely adopted. Document the seam in test/AGENTS.md
     (or test/_ink-render.ts header) and add the input-driving
     side: `simulateInput(stdin, "j")` / `simulateInput(stdin,
     ESCAPE)`. ~80 LOC, ships independently.

  2. CONVERT 2-3 EXEMPLAR FILES TO BEHAVIOUR TESTS.
     Pick popups/agents.tsx, popups/log.tsx (no DB needed for
     the empty-snapshot path), and popups/recent.tsx. For each:
     mount the popup with a fixture WorkstreamSnapshot, simulate
     j/k/Enter/y, capture output via CaptureStream, assert
     visible-text + spy on the yank() callback. Drop the
     readFileSync greps that asserted those literals.
     Each conversion ~80-120 LOC delta; total ~0.8d.

  3. DELETE THE NOW-REDUNDANT STATIC GREPS in the converted
     files. Keep the App ↔ keys wiring greps (those pin
     architectural invariants and are a different kind of test
     — see separate finding).

  4. WRITE A test/AGENTS.md or test/README.md NOTE: "Prefer
     CaptureStream-based behaviour tests over readFileSync-based
     source greps for popup behaviour. Source greps belong
     ONLY in: (a) keymap-spec ↔ help-pane consistency,
     (b) anti-regression guards for previously-shipped fixes
     where the fix is a structural invariant (e.g.
     overflow=hidden on root Box), (c) wiring assertions
     across module boundaries (App imports X, X is a
     function)."

EFFORT NOTE:
  Multi-task umbrella, candidates above ship in <300 LOC each.
  Total to convert all 30 files would be 1.5-2d. Recommend
  splitting into 4-5 follow-up tasks (one per "popup-bundle")
  triaged separately. The umbrella itself is the highest-impact
  single observation in this sweep.

  Do not delete tui-keymap-consistency.test.ts — it asserts
  cross-module *spec* consistency which is genuinely structural.
```

### #2 by "π - mu", 2026-05-13T16:40:46.446Z

```
CLOSE: all 5 sub-tasks shipped: seam helper (9f9128d) + 3 popup-bundle conversions (1d26435/d763e16/worker-4 ready-cluster) + seam doc README (50372132). Pattern demonstrated and documented for future popups.
```
