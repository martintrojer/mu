---
id: "review_substrate_tsconfig_test_unused"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: null
created_at: "2026-05-13T12:43:27.828Z"
updated_at: "2026-05-13T14:12:36.855Z"
blocked_by: ["tests_typecheck_capture_stream", "tests_typecheck_keyflags_status_drift", "tests_typecheck_misc_finalwiring", "tests_typecheck_unused_imports", "tests_typecheck_workstream_field_drift"]
blocks: []
---

# REVIEW med: tsconfig.test.json is dead; tests escape npm run typecheck

## Notes (3)

### #1 by "worker-1", 2026-05-13T12:43:28.114Z

```
FILE(S):
  tsconfig.test.json (the whole file, 7 lines)
  package.json scripts (typecheck, lint)

FINDING (dead code):
  tsconfig.test.json exists with `"include": ["src/**/*", "test/**/*"]`
  but no script references it. `npm run typecheck` runs
  `tsc --noEmit` which uses the bare `tsconfig.json` — and that
  file has `"exclude": ["node_modules", "dist", "test"]`.

WHY IT'S A PROBLEM:
  - Test files are NOT type-checked by `npm run typecheck`.
    AGENTS.md's "before you commit" gate runs typecheck + lint +
    test + build, but typecheck silently skips test/. A test
    that introduces a real type error (calling a renamed SDK
    function with wrong args, casting away noUncheckedIndexedAccess)
    is only caught when vitest evaluates the file at runtime —
    after a successful typecheck.
  - tsconfig.test.json is dead: nothing invokes it. New
    contributors who notice it assume it runs in CI, get
    misled, and don't realise their `as any` shortcut survives
    typecheck because the file is excluded.
  - Biome catches some of this via `lint`, but biome doesn't
    do TS type analysis.

PROPOSED FIX:
  Pick one:
  (a) Delete tsconfig.test.json + clarify the typecheck contract
      by adding a comment to tsconfig.json explaining "tests are
      type-checked at vitest run-time, not by tsc --noEmit".
  (b) Wire it: add `"typecheck:tests": "tsc -p tsconfig.test.json"`
      and call it from the four-greens recipe in AGENTS.md.
      Also update the typecheck script to run BOTH:
      `"typecheck": "tsc --noEmit && tsc -p tsconfig.test.json"`.

  Recommend (b): there's no good reason to leave tests
  un-typechecked. The file already exists; just hook it up.

EFFORT NOTE:
  Trivial (~5 LOC). Run typecheck:tests once to find any
  long-buried test type errors. Risk: cascade of test fixes
  if test files have drifted (likely 0-3 small fixes).
```

### #2 by "worker-1", 2026-05-13T13:38:29.113Z

```
CASCADE PROBE RESULT — STOPPING per task contract (>5 fixes budget).

DISCOVERY:
  tsconfig.test.json was BROKEN (in addition to unused). It had:
    "include": ["src/**/*", "test/**/*"]
  but inherited from tsconfig.json which says:
    "exclude": ["node_modules", "dist", "test"]
  TypeScript applies the parent's `exclude` when the child doesn't
  override it, so test/** was filtered back out: bare
  `tsc -p tsconfig.test.json --noEmit` ran ONLY src/ files and
  reported 0 errors — exactly what the original probe note saw, and
  why the file looked "harmless dead code".

  Confirmed via `tsc --listFiles`: no test/ files appear in the
  emitted file list with stock tsconfig.test.json.

  Adding `"exclude": ["node_modules", "dist"]` (overriding parent)
  to tsconfig.test.json makes test/ actually visible to tsc.
  That's the change required before any of this is meaningful.

CASCADE WHEN test/ IS VISIBLE TO tsc:
  48 errors across 27 files in 9 categories. WAY past the 0-3 / >5
  STOP budget. Reverted tsconfig.test.json to the broken-but-stable
  state and dropping this scope note.

ERROR HISTOGRAM (tsc code → count → kind):
   TS6133  12  unused locals/imports (Db, Database, alice, revv,
                args, defaultStateDir, afterEach, beforeEach,
                CaptureSnapshotResult, ...)
   TS2740   9  CaptureStream missing 60+ WriteStream members
                (test/_ink-render.ts harness drift; ink stream stub
                is no longer assignable to NodeJS.WriteStream)
   TS2551   6  test/cli-qualified-ref.integration.test.ts uses
                `.workstreamName` on shapes that expose `workstream`
   TS2322   5  Mixed: AgentStatus mismatches ("alive"/"running" not
                in enum), commitsBackend stringly typed instead of
                VcsBackendName, Snapshot fixtures missing fields
   TS2345   4  WorkspaceRow fixtures using `agent`/`workstream`
                instead of `agentName`/`workstreamName`
                (workspace-staleness-mem, workspace-sdk)
   TS4114   2  override modifier missing on overridden Writable
                methods (test/_ink-render.ts, tui-titled-box-render)
   TS2559   2  KeyFlags shape drift (`{f1: true}`, `{backspace: true}`
                no longer assignable) — tui-keys, tui-use-popup-filter
   TS2339   2  RegExpStringIterator.toArray (Node 22 typings missing)
   TS18046  2  test/_jsx-find.ts: n.props is unknown (needs narrowing)
   TS2741   1  tui-card-doctor: snapshot fixture missing recentCommits
   TS2353   1  state-helpers: report:{reaped,pruned} doesn't match
                ReconcileReport shape (THIS is the
                testreview_substrate_workstream_snapshot_compile_check
                receipt — confirmed but blocked behind the same wiring)
   TS2352   1  tui-popup-all-tasks: bad cast to WorkstreamSnapshot
   TS1484   1  type-only import violation under verbatimModuleSyntax

FILES TOUCHED (27):
  test/_ink-render.ts test/_jsx-find.ts test/acceptance.integration.test.ts
  test/cli-agent-kick.integration.test.ts test/cli-qualified-ref.integration.test.ts
  test/cli-task-add-blocked-by.integration.test.ts test/cli-task-close-if-ready.integration.test.ts
  test/cli-task-close.integration.test.ts test/cli-task-delete-two-phase.integration.test.ts
  test/db.test.ts test/snapshots.integration.test.ts test/state-helpers.integration.test.ts
  test/tui-app.test.ts test/tui-card-commits.test.ts test/tui-card-doctor.test.ts
  test/tui-drill-refresh.integration.test.ts test/tui-keys.test.ts
  test/tui-popup-all-tasks.test.ts test/tui-popup-task-detail.test.ts
  test/tui-popup-tasks.test.ts test/tui-row-budget-overflow.integration.test.ts
  test/tui-state-hook-rerender.test.ts test/tui-titled-box-render.test.ts
  test/tui-use-notes-drill.test.ts test/tui-use-popup-filter.test.ts
  test/workspace-sdk.integration.test.ts test/workspace-staleness-mem.integration.test.ts

NATURAL FOLLOW-UP SPLIT (each is its own task; ordering only matters
where noted):
  1. test_typecheck_unused_imports  (TS6133 ×12, ~9 files)
       Mechanical biome-style cleanup. Could even be `--fix` style.
  2. test_typecheck_capture_stream  (TS2740 ×9, TS4114 ×2)
       Centralised: test/_ink-render.ts CaptureStream needs to either
       implement the WriteStream surface or be cast-cleanly through
       `as unknown as NodeJS.WriteStream` ONCE in the harness, with
       an `override` keyword on overridden Writable methods. Fixes
       most TUI test compile errors cascade-wide.
  3. test_typecheck_workstream_field_drift  (TS2551 ×6, TS2345 ×4)
       Tests still call rows `workstream`/`agent`; SDK has moved to
       `workstreamName`/`agentName`. Sibling to worker-2's data work
       — coordinate before landing or it'll merge-conflict.
  4. test_typecheck_keyflags_and_status_enum_drift  (TS2559 ×2,
                                                     TS2322 ×2 status,
                                                     TS2741)
       AgentStatus / KeyFlags / fixture-completeness drift. Small.
  5. test_typecheck_misc  (TS2339 ×2, TS18046 ×2, TS2352, TS1484,
                           TS2353, TS2322 ×3 commitsBackend)
       Includes the WorkstreamSnapshot reaped/pruned receipt
       (testreview_substrate_workstream_snapshot_compile_check).
       Cleanest to land alongside #1.

PROPOSED SEQUENCING:
  Land #1 first (smallest; gates everything else) then #2 (TUI
  harness; biggest LOC) in parallel with #3 (data drift).
  #4 + #5 can roll up into the same final commit that flips the
  package.json switch and updates AGENTS.md / CHANGELOG.md.

  ONLY THEN does this task — wiring tsconfig.test.json into
  npm run typecheck — become a one-line PR. Doing it now would
  paint over a 48-error landmine.

NEXT (suggested, requires orchestrator decision):
  - mu task add tests_typecheck_unused_imports -w tui-impl ...
  - mu task add tests_typecheck_capture_stream -w tui-impl ...
  - mu task add tests_typecheck_workstream_field_drift -w tui-impl ... (coordinate w/ worker-2)
  - mu task add tests_typecheck_keyflags_status_drift -w tui-impl ...
  - mu task add tests_typecheck_misc_finalwiring -w tui-impl ...
    (closes review_substrate_tsconfig_test_unused +
     testreview_substrate_workstream_snapshot_compile_check)
  - mu task block tests_typecheck_misc_finalwiring \
      --by tests_typecheck_unused_imports \
      --by tests_typecheck_capture_stream \
      --by tests_typecheck_workstream_field_drift \
      --by tests_typecheck_keyflags_status_drift

NOT TOUCHED THIS PASS:
  - package.json: typecheck script unchanged
  - AGENTS.md: four-greens recipe unchanged (still accurate today)
  - CHANGELOG.md: unchanged (no behaviour change to log)
  - tsconfig.test.json: REVERTED to its pre-probe state (still
    broken/dead — but no half-working state landed)

VERIFIED:
  - npx tsc -p tsconfig.test.json --noEmit (broken include): exit 0
  - npx tsc -p tsconfig.test.json --noEmit (with exclude override):
    exit nonzero, 48 TS errors as histogrammed above
  - git status: clean (revert applied)
```

### #3 by "π - mu", 2026-05-13T14:12:36.855Z

```
CLOSE: 1657f05: tsconfig.test.json now wired into npm run typecheck (commits 8787d16, 7c6077f, 1672177, ac2bd65, d3873ea = 5-step cascade plus 1657f05 follow-up)
```
