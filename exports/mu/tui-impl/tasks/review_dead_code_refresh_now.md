---
id: "review_dead_code_refresh_now"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-12T08:33:10.160Z"
updated_at: "2026-05-12T09:17:10.033Z"
blocked_by: []
blocks: []
---

# REVIEW low: Dead useEffect for refreshNonce in app.tsx (intentional but unused side effect)

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:33:10.517Z

```
FILE + LINES:
  - src/cli/tui/app.tsx:248-254
    useEffect(() => {
      // Touch refreshNonce so React tracks the dep; the actual
      // re-fetch happens on the next setInterval tick. v0 accepts
      // this latency; v0.next can wire a refresh-now signal into
      // the hook.
      void refreshNonce;
    }, [refreshNonce]);
CATEGORY: dead-code / unnecessary-complexity
SEVERITY: low
FINDING: The `refreshNonce` state exists, gets bumped by the `r` / F5 keypress, but the only consumer is a no-op useEffect that "touches" it for React's dep array. There is no observable effect — the snapshot poll loop in useDashboardSnapshot doesn't have a refresh-now signal, so `r` does nothing today. The header comment in app.tsx labels this v0.next future work, but the visible affordance ("refresh now") is shipping as a lie.
SUGGESTED FIX:
  Option A (preferred): give useDashboardSnapshot a `refreshNonce` dep so bumping it forces an immediate fetch:
      useEffect(() => { ... }, [db, workstream, tickMs, enabled, refreshNonce]);
  This is one more arg + one dep; trivial. Wire it from app.tsx.
  Option B: drop refreshNonce + the dead useEffect + the `r` / F5 binding from the help overlay until the feature actually lands.
NOTE: ALSO covered in tests indirectly — tui-keys.test.ts asserts `r` returns refreshNow, but no test checks that refreshNow actually re-fetches.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:16:52.283Z

```
FILES:
  - src/cli/tui/state.ts (useDashboardSnapshot: optional refreshNonce param + effect dep + `void refreshNonce` for biome)
  - src/cli/tui/app.tsx (passes refreshNonce as 5th arg; removed dead `void refreshNonce` useEffect)
  - test/tui-state-hook-rerender.test.ts (two new static-source describes: hook deps + app.tsx wiring)
COMMANDS: typecheck/lint/test/build all clean (exit 0). 1944 tests pass.
FINDING: confirmed via grep — only consumer of refreshNonce was the no-op useEffect; the effect's dep array was the missing wire.
DECISION: Option A from the note. Default refreshNonce=0 keeps the `useDashboardSnapshot` signature backward-compatible (one in-tree caller; safer for any external consumer of the SDK seam). Effect tear-down + re-mount on bump fires `tick()` synchronously per the existing `void tick()` line — i.e. an immediate refresh, exactly the affordance the help overlay advertises.
NEXT: none.
VERIFIED: new tests pin the wiring (useDashboardSnapshot signature + dep list + app.tsx 5-arg call + absence of the no-op useEffect).
ODDITIES: biome's useExhaustiveDependencies needed a `void refreshNonce;` line inside the effect body to recognise the dep — kept under a comment that explains it.
```

### #3 by "worker-3", 2026-05-12T09:17:10.033Z

```
CLOSE: 4a848f89d3eaef31d756a40a62dc4c21639b63a8: dead-code bundle
```
