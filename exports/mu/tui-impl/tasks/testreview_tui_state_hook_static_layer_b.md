---
id: "testreview_tui_state_hook_static_layer_b"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.3
roi: 166.67
owner: "worker-4"
created_at: "2026-05-13T12:54:23.133Z"
updated_at: "2026-05-13T14:31:03.238Z"
blocked_by: []
blocks: []
---

# REVIEW med: tui-state-hook-rerender Layer B + refreshNonce blocks are pure source-greps over state.ts

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:54:25.394Z

```
FILE(S):
  test/tui-state-hook-rerender.test.ts:228-255 ("Layer B" describe)
  test/tui-state-hook-rerender.test.ts:262-279 ("refreshNonce — wired" describe)
  test/tui-state-hook-rerender.test.ts:286-298 ("app.tsx — refresh-now wiring" describe)
  src/cli/tui/state.ts:139-171 (the actual hook)

FINDING (fake testing / weak assertions):
  Three of the test groups in tui-state-hook-rerender are pure
  source-greps over state.ts and app.tsx. The Layer B group
  itself acknowledges this:

    > "The hook isn't cheap to drive without ink-testing-library;
    >  the structural markers are clear enough that grep is
    >  adequate."

  Specific assertions:

    expect(src).toMatch(/useState\s*\(\s*0\s*\)/);
    expect(src).toMatch(/setLastTickMs\s*\(/);
    expect(src).not.toMatch(/setSnap\s*\(\s*\{\s*data\s*,\s*lastTickMs/);
    expect(src).toMatch(/refreshNonce\s*=\s*0/);
    expect(src).toMatch(/\[db,\s*workstream,\s*tickMs,\s*enabled,\s*refreshNonce,\s*loaders\]/);
    expect(src).toMatch(/useDashboardSnapshot\s*\(\s*db\s*,\s*workstream\s*,\s*tickMs\s*,\s*true\s*,\s*refreshNonce\s*\)/);
    expect(src).not.toMatch(/void\s+refreshNonce\s*;/);

  The actual BEHAVIOUR being asserted:
    - Layer B: `lastTickMs` updates 1×/sec WITHOUT triggering
      the cards to re-render (i.e. the `data` reference stays
      stable when snapshotKey is unchanged).
    - refreshNonce: bumping the nonce in <App> tears down +
      restarts the poll-loop interval, which fires `tick()`
      synchronously.
    - app.tsx wiring: there's no leftover no-op `useEffect(() =>
      void refreshNonce, ...)` block.

WHY IT'S A PROBLEM:
  - Trivially evadable: a refactor that uses
    `const [tick, setTick] = useState(0)` instead of `setLastTickMs`
    breaks the regex though behaviour is identical.
  - Trivially false-positive-able: the `not.toMatch(/void
    refreshNonce/)` test was added because the previous app.tsx
    had a NO-OP useEffect that contained `void refreshNonce;` and
    did nothing. But the same `void refreshNonce;` line appears in
    state.ts itself (line 167-176) as a load-bearing line that
    forces biome/exhaustive-deps to recognise the dep. Subtle
    distinction between "no-op effect using `void X`" vs
    "load-bearing dep-list anchor using `void X`". The TEST
    can't distinguish.
  - The snapshotKey() / snapshotKeyString() unit tests in the
    same file (lines 1-225) ARE good: they're real behaviour
    tests on a pure function. The Layer B / refreshNonce /
    app.tsx wiring blocks at the bottom are vestigial source
    greps from an era when behaviour testing was unavailable.
    Now that the CaptureStream-based ink render tests work
    elsewhere in the suite, these can be retired.

PROPOSED FIX:
  Replace the three static-grep blocks with one behaviour test
  that uses the existing `useDashboardSnapshot` `loaders`
  injection seam:

    1. `LAYER A behaviour`: drive useDashboardSnapshot with two
       successive returns of byte-equal-but-non-identity
       snapshots (same snapshotKey). Assert that the React
       state's `data` reference is preserved across ticks (=
       no card re-renders). Use a counter on the loader's fast
       call to verify it fires every tick.

    2. `LAYER B behaviour`: same setup, but assert that
       `lastTickMs` advances on every tick even though `data`
       reference is preserved.

    3. `refreshNonce behaviour`: render the hook with
       refreshNonce=0; bump to 1 mid-interval and assert the
       loader fires synchronously (within 5ms of the bump),
       not on the next interval tick.

  All three become ~30 LOC tests using react-hooks/test or just
  direct useReducer-style state machine inspection by mounting a
  trivial consumer in CaptureStream.

EFFORT NOTE:
  ~0.3d. The existing unit tests for snapshotKey / clampTick
  stay; only the bottom 3 describe blocks change. Net LOC
  change: similar (real tests are slightly longer than greps
  but combine multiple greps into one assertion).

  Side benefit: the refactored tests will catch real regressions
  (e.g. a future change that subtly breaks snapshotKey reference
  stability).
```

### #2 by "worker-4", 2026-05-13T14:31:03.238Z

```
CLOSE: 18ccb7f: 3 source-grep blocks in tui-state-hook-rerender (Layer B / refreshNonce / app.tsx wiring) converted to 4 behaviour assertions that mount useDashboardSnapshot through ink with a controllable loader; verified each catches a deliberate state.ts regression (key short-circuit removed; setFastTickNonce removed; nonce dropped from effect dep list); four greens (typecheck+lint+test:fast+build) clean, full fast suite 88 files / 1359 tests pass
```
