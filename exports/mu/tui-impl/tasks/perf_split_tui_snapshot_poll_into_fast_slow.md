---
id: "perf_split_tui_snapshot_poll_into_fast_slow"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.4
roi: 187.50
owner: "worker-2"
created_at: "2026-05-12T20:21:00.594Z"
updated_at: "2026-05-12T20:49:36.860Z"
blocked_by: []
blocks: []
---

# PERF: split TUI snapshot poll into fast-SQL (1s) and slow-subprocess (10s) tiers — tmux liveness + git/jj/sl + workspace dirty currently dominate every tick (p50 385ms; SQL is already <1ms, subprocesses are 245ms of that)

## Notes (3)

### #1 by "π - mu", 2026-05-12T20:21:00.971Z

```
PROFILING (live, against the user's real DB on tui-impl)
--------------------------------------------------------
loadWorkstreamSnapshot('tui-impl', full opts):
  p50=385ms  p95=491ms  p99=579ms  max=579ms  mean=389ms

Cost attribution (each opt isolated; same db, same ws):
  bare snapshot (no withDirty/Doctor/Commits): ~142ms
  + withDirty:                                  ~45ms incremental
  + withDoctor:                                 ~3ms incremental
  + withRecentCommits (limit=25):              ~200ms incremental

Per-call SQL queries (warm cache):
  listLiveAgents (status-only):  p50=43ms  p95=118ms  ← the bare-snapshot bottleneck
  getParallelTracks:              p50=0.30ms
  listReady:                      p50=0.05ms
  listInProgress:                 p50=0.03ms
  listBlocked:                    p50=0.09ms
  listRecentClosed:               p50=0.16ms
  listWorkspaces:                 p50=0.02ms
  listLogs (kind=event, limit=200): p50=0.21ms

CONCLUSION: SQL is already trivial. ZERO indexes needed. The cost is
SUBPROCESS work — tmux for liveness/orphan detection, git/jj/sl for
recent commits and dirty-workspace status. 245ms of every 389ms snapshot
(63%) is spent in tmux + git subprocesses.

A fast SQL re-render every tick (~1s) is fine. A subprocess re-poll
every tick is wasteful — tmux pane state changes seconds-to-minutes
apart, and project commits change minute-to-hours apart.

DESIGN — TWO-TIER SNAPSHOT POLL
--------------------------------
Decouple the snapshot poll into TWO parallel intervals in the TUI:

  FAST tick (existing 1s, configurable via +/- like today):
    - Pure-SQL fields: tracks, ready, inProgress, blocked, recentClosed,
      workspaces (without dirty), workspaceOrphans, recent (events).
    - Cheap (~0.7ms total). No subprocesses. Already free.

  SLOW tick (NEW, default 10s, NOT user-configurable per the
            "no config file" pledge — hardcoded constant):
    - Subprocess-backed fields:
      * view (live tmux liveness + orphan detect from listLiveAgents)
      * workspaces.dirty (per-workspace `git status --porcelain`)
      * recentCommits (project-root `git log` / `jj log` / `sl log`)
    - Runs in the background; the snapshot's STALE values from the last
      slow-tick are served on every fast-tick render (so cards never
      flicker between "loading…" and "data").
    - On TUI launch, fire one slow-tick eagerly so first render has
      fresh data.

DASHBOARD TICK INDICATOR
------------------------
Status bar today shows the FAST tick rate (e.g. "1.00s ⏱"). After this
change:
  - Keep showing the fast tick rate (it's what +/-/=/0 controls).
  - Dim the indicator slightly when ANY slow-tick field is mid-fetch
    (a tiny visual signal so the user knows the slow refresh is in
    flight).
  - Optionally surface the slow-tick interval somewhere — e.g.
    "1.00s ⏱ · 10s ⟲" — but only if it doesn't clutter the bar.
    Defer if cluttery.

REFRESH-NOW (`r` / F5) BEHAVIOUR
--------------------------------
Today `r` triggers a refresh nonce that forces an immediate fast tick.
After this change: `r` should ALSO trigger an immediate slow tick.
Operator's "I want fresh everything NOW" intent is preserved.

DEFAULTS (locked)
-----------------
SLOW_TICK_MS = 10_000  (10× the default fast tick)
SLOW_TICK_FLOOR_MS = 2_000  (operator can't sneak it below 2s via env)
SLOW_TICK_CEILING_MS = 60_000

Per the no-config pledge: NO env var to tune the slow tick (hardcoded
constant). If the user ever pushes back asking for tuning, promote then.

EDGE CASES
----------
- Workstream switch (Tab / Shift-Tab): trigger an immediate slow-tick
  for the new workstream so the user doesn't see stale subprocess data
  from the old workstream for up to 10 seconds.
- Snapshot first load: subprocesses haven't run yet → cards render with
  empty arrays + "loading…" placeholders. Today's behaviour is fine; a
  fast first-render with empty subprocess fields is BETTER than a
  blocking 200ms wait.
- `mu agent send` from another shell while the TUI is open → the
  Activity log card refreshes instantly (fast tick / pure SQL); the
  Agents card's tmux-derived status takes up to 10s to update. ACCEPTABLE
  (slot 1's data is "is the agent alive?", which is a slow-changing
  property anyway).

WIRING
------
- src/cli/tui/state.ts useDashboardSnapshot:
  * Split the existing tick loop into `fastTick` (tracks every snapshot
    field via the existing path) and `slowTick` (runs the
    `withDirty`/`withDoctor`/`withRecentCommits` opts only and returns
    JUST those derived fields; merges into the snapshot).
  * Slow-tick state held in its own useRef; merged into the fast-tick
    snapshot before returning.
  * Existing `tickMs` continues to control the fast tick.
  * NEW SLOW_TICK_MS constant + interval. Cleared on unmount.
  * `r` / refresh nonce triggers BOTH ticks immediately.
- src/state.ts loadWorkstreamSnapshot: add a `withSubprocessFields?: boolean`
  flag (default false) — when false, listLiveAgents's reconcile step is
  bypassed (just `listAgents(db, ...)` for cached state) and the
  withDirty/withDoctor/withRecentCommits opts are no-ops. The slow-tick
  caller passes withSubprocessFields=true; the fast-tick caller false.
  
  ALTERNATIVELY: more surgical — split into TWO functions:
    loadWorkstreamSnapshotFast(db, ws, opts):  pure-SQL fields
    loadWorkstreamSnapshotSlow(db, ws, opts):  subprocess-backed fields
  …and have useDashboardSnapshot compose them. Cleaner; recommended.
  
  Per-call cost:
    fast: ~0.7ms (SQL only — already measured)
    slow: ~250ms (tmux + per-workspace git status + project git log)
  Both run on independent intervals; the TUI never blocks.

⚠️ DON'T MERGE STATE BACKWARDS ⚠️
The fast-tick path also needs the WorkstreamSnapshot type to carry the
slow-tick fields (so cards don't have a "data may be missing" branch).
Easiest: the snapshot type stays as today; the slow-tick last-known
values are merged into every fast-tick render via a useRef
(useDashboardSnapshot returns the merged shape). Cards see one
WorkstreamSnapshot. No type churn.

TESTS (REQUIRED)
----------------
- src/state.ts: new unit tests for the split — `loadWorkstreamSnapshotFast`
  must return ALL pure-SQL fields and EMPTY for subprocess fields;
  `loadWorkstreamSnapshotSlow` must return the subprocess fields only.
- src/cli/tui/state.ts useDashboardSnapshot: extend tests in
  test/tui-state-hook.test.ts (or new test/tui-state-slow-tick.test.ts)
  to assert:
  * Fast-tick interval calls the fast loader.
  * Slow-tick interval calls the slow loader.
  * `r` refresh nonce triggers BOTH.
  * Workstream switch triggers an immediate slow-tick.
  * Slow-tick subprocess values persist across fast-ticks (cards see
    them, not "loading…").
  * Mock the loaders via dependency injection (the hook signature can
    accept overrides for testability — match the existing pattern).
- Existing test/state-render.test.ts: snapshot shape unchanged.
- Existing test/tui-acceptance.test.ts: must still pass.

VERIFY MANUALLY
---------------
After build, in a real terminal:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Watch the tick indicator — should still show "1.00s ⏱".
  # Watch the dashboard for ~30 seconds; pure-SQL cards (Ready / Blocked /
  # Activity log) should refresh every second; subprocess cards
  # (Agents status, Workspaces dirty, Commits) refresh every 10s.
  # Press `r` — every card should refresh now.
  # Tab to a different workstream — subprocess cards should refresh
  # within 1 second (eager slow-tick on switch).

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
PROFILE BEFORE AND AFTER:
  Before: 385ms p50 per snapshot
  After:  expect ~1ms p50 per fast snapshot, ~250ms p50 per slow snapshot
          (only every 10s — invisible to the user).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap. state.ts is ~200 LOC; new useDashboardSnapshot
  fast/slow split adds ~50 LOC.
- Conventional commit prefix: `tui:` or `state:`.
- Suggested commit:
    state: split the TUI snapshot poll into fast-SQL (1s) and slow-subprocess (10s) tiers; tmux liveness + git/jj/sl commits + workspace dirty no longer block the per-tick render
- Four greens before commit + bundle smoke + manual smoke per checklist.

DOCS
----
- CHANGELOG.md [Unreleased] under "Performance":
  * "TUI snapshot poll split into a fast SQL-only tick (1s) and a slow
    subprocess tick (10s). Tmux liveness, per-workspace dirty status,
    and project recent-commits no longer block every fast tick. p50
    snapshot cost dropped from ~385ms to <1ms; the 10s slow tick
    handles the subprocess work in the background. `r`/F5 still refreshes
    everything immediately. Workstream tab switch triggers an eager slow
    tick so the new workstream's subprocess data is fresh within 1s."
- docs/USAGE_GUIDE.md TUI section: brief note on the two-tier polling
  contract.
- docs/ARCHITECTURE.md src/cli/tui/state.ts row: extend with the split.

OUT OF SCOPE
------------
- No SQL indexes. Profiling showed SQL is already trivial.
- No `MU_TUI_SLOW_TICK_MS` env var (anti-feature pledge: no configs).
- No on-demand subprocess fetch when a card is opened (defer; today
  every popup re-renders from the snapshot).
- No per-card slow-tick budget. All subprocess fields share one
  interval.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>
(at HEAD with all session changes live).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke +
profile-after-fix delta (note in evidence), close YOUR task with:
  mu task close perf_split_tui_snapshot_poll_into_fast_slow -w tui-impl --evidence "<sha>: profile delta — fast tick now <1ms, slow tick (10s) ~250ms; verified by …"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
```

### #2 by "worker-2", 2026-05-12T20:49:36.560Z

```
FILES: src/state.ts; src/cli/tui/state.ts; src/index.ts; test/state-helpers.test.ts; test/tui-state-slow-tick.test.ts; test/tui-state-hook-rerender.test.ts; CHANGELOG.md; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md
COMMANDS: mu task notes perf_split_tui_snapshot_poll_into_fast_slow -w tui-impl; node /tmp/profile-snap.mjs (before in this workspace: full p50 352.5ms); npm run typecheck && npm run lint && npm run test && npm run build (pass, 150 files / 2262 tests); node dist/cli.js --help; node dist/cli.js --version; tmux manual smoke launching node dist/cli.js -w tui-impl and quitting with q; after profile via dist/index.js fast/slow loaders (fast p50 0.92ms, slow p50 249.83ms)
FINDINGS: SQL slices are fast; old TUI hook called full loadWorkstreamSnapshot on every tick, paying tmux status + workspace dirty + recent commit subprocess cost. Static mu state still needs workspace staleness, so back-compat wrapper composes fast + staleness + slow while the TUI uses fast/slow loaders directly.
DECISION: Added loadWorkstreamSnapshotFast/loadWorkstreamSnapshotSlow/mergeSnapshotFastSlow and SLOW_TICK_MS=10000. TUI hook runs fast tick on tickMs, slow tick on SLOW_TICK_MS, refreshNonce triggers both, and workstream change clears slow cache so the new workstream eager-fetches slow fields.
VERIFIED: Four greens pass; bundle smoke passes; manual tmux TUI smoke passes; profile delta: baseline task notes 385ms p50 (local before 352.5ms), after fast tui tick p50 0.92ms and slow subprocess tick p50 249.83ms.
ODDITIES: script(1) non-raw-stdin smoke fails Ink raw-mode, so manual smoke used a real tmux pane.
```

### #3 by "worker-2", 2026-05-12T20:49:36.860Z

```
CLOSE: 6506a65: profile delta — fast tick p50 0.92ms (was 385ms baseline; local before 352.5ms), slow tick (10s) p50 249.83ms; verified by npm run typecheck && npm run lint && npm run test && npm run build, bundle smoke node dist/cli.js --help/--version, tmux manual TUI smoke
```
