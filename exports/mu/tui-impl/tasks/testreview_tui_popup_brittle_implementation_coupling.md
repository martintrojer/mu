---
id: "testreview_tui_popup_brittle_implementation_coupling"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "worker-3"
created_at: "2026-05-13T12:54:28.160Z"
updated_at: "2026-05-13T14:17:21.418Z"
blocked_by: []
blocks: []
---

# REVIEW med: popup tests pin specific identifiers + dep-list shapes via regex (brittle, evadable)

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:54:29.932Z

```
FILE(S):
  test/tui-popup-workspaces.test.ts:131-143 (show-mode wiring assertions)
  test/tui-popup-workspaces.test.ts:158-167 (Esc/q in show-mode)
  test/tui-popup-doctor.test.ts:60-77 (sourcegrep on `loadDoctorChecks`)
  test/tui-popup-recent.test.ts:80-89 (filter blob regex)
  test/tui-popup-blocked.test.ts:91-101 (filter blob regex)
  test/tui-popup-inprogress.test.ts:91-101 (filter blob regex)
  test/tui-popup-all-tasks.test.ts:181-200 (renders centred slice)
  test/tui-popup-commits.test.ts:121-149 (everything in the source-invariants describe)

FINDING (brittle tests / implementation coupling):
  Many popup test files assert specific implementation details
  via regex over source:

    expect(SRC).toMatch(/case "drill":\s*\{[^}]*setShowSha\(c\.sha\)/);
    expect(SRC).toMatch(/if \(inShow && focused !== undefined && showSha !== null\)/);
    expect(SRC).toMatch(/loadShow\(focused\.path,\s*showSha\)/);
    expect(SRC).toMatch(/\[inShow, focused, showSha, loadShow, slowTickNonce\]/);
    expect(SRC).toMatch(/\$\{t\.name\} \$\{t\.title\} \$\{t\.ownerName \?\? ""\}/);
    expect(SRC).toContain("centredVisibleSlice(visibleTasks, safeCursor, viewport)");
    expect(SRC).toContain("windowed.map");
    expect(SRC).toContain("start + i === safeCursor");
    expect(SRC).not.toContain("visibleTasks.map((t, i)");
    expect(showHookBlock?.[0]).toContain("onClose: () => setShowSha(null)");
    expect(showHookBlock?.[0]).not.toContain("onClose()");

  Each one pins a specific identifier, a specific argument
  ordering, and in some cases a specific dep-list shape. They
  fail on harmless renames AND pass on broken behaviour as
  long as the literal still appears.

WHY IT'S A PROBLEM:
  - Any refactor that renames a local — `setShowSha` →
    `setShowCommit`; `windowed` → `visibleSlice`; `inShow` →
    `showOpen` — fails dozens of tests across the popup suite
    even though no user-observable behaviour changes.
  - The tests are doing TS's job (asserting prop names exist)
    and React's job (asserting hook deps are correct) in
    string-match form. TS already type-checks these; biome's
    exhaustive-deps lint already enforces dep lists.
  - Negative assertions (`not.toContain("visibleTasks.map")`)
    are particularly brittle: they ban specific implementation
    sketches without testing the behaviour the ban exists to
    protect (e.g. "doesn't render every task on every render"
    is a perf claim that should be measured, not grep-banned).
  - The "show mode" reset behaviour in workspaces.tsx is
    asserted entirely through source greps over a 5-line block
    extracted by regex match. The actual behaviour — does the
    show body get cleared when focus moves to a different
    workspace? — is unverified.
  - The cascade: when a real bug surfaces and a fix changes
    these implementation details slightly, the test suite goes
    red. The author's options become (a) update the regex (most
    common), (b) skip the test, (c) drop the assertion. Path
    (a) re-pins the new implementation and the cycle continues.

PROPOSED FIX:
  Replace each implementation-coupled regex with a behaviour
  assertion using the CaptureStream + ink render pattern (or
  the existing `_card-render.ts` helper for card-level cases).
  Examples:

    `setShowSha(c.sha)` regex →
      "After mounting workspaces popup, switching to drill mode,
       and pressing Enter on a focused commit, the rendered output
       contains the commit's diff body."

    `centredVisibleSlice(visibleTasks, safeCursor, viewport)` →
      "With 200 tasks, cursor at 100, viewport 15: rendered
       output contains task_100 highlighted with cursor and
       includes task_093 through task_107."

    Filter blob regex →
      "Mount the popup with [a, b, c] tasks; type '/abc'; assert
       only matching task is rendered."

  Each conversion is small (~10-30 LOC) and replaces a regex
  that's prone to drift with an assertion against actual user
  experience. Nine popups × ~5 conversions each = ~45 conversions;
  realistic 0.3-0.5d per popup = ~3d total.

  Smaller subset (separately shippable): convert just the
  `centredVisibleSlice` / `windowed.map` regex family in
  test/tui-popup-all-tasks.test.ts to behaviour. ~0.3d, removes
  the worst of the implementation-pinning examples and
  demonstrates the migration pattern for follow-up tasks.

EFFORT NOTE:
  Large overall but trivially split per-popup. Combine triage
  with the umbrella `testreview_tui_static_source_grep_pervasive`
  finding.
```

### #2 by "worker-3", 2026-05-13T14:17:15.737Z

```
FILES: test/tui-popup-all-tasks.test.ts; test/_ink-render.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run build (exit 0); targeted npx vitest run test/tui-popup-all-tasks.test.ts (exit 0); deliberate off-by-one in src/cli/tui/popups/all-tasks.tsx verified new render assertions fail, then reverted
FINDINGS: centredVisibleSlice/windowed.map source-grep family replaced with Ink render behaviour assertions. With 200 tasks and cursor driven to 100, tests assert task_093..task_107 render, task_100 is centered/focused via title+yank hint, and task_000/task_092/task_108/task_199 are absent from latest frame.
DECISION: kept existing pure scroll unit coverage for applyCursor/centredVisibleSlice but removed static source coupling for popup render behaviour. Added small shared input/latest-frame helpers to _ink-render.ts to support the pattern.
NEXT: remaining 8 popup source-grep families stay follow-up scope per task brief.
VERIFIED: commit 1871561; four requested greens passed.
ODDITIES: full npm run test optional per brief and not run.
```

### #3 by "worker-3", 2026-05-13T14:17:21.418Z

```
CLOSE: 1871561: tui-popup-all-tasks centredVisibleSlice regex family converted to behaviour; pattern demonstrated for the other 8 popups
```
