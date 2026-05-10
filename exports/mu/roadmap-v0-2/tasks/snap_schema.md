---
id: "snap_schema"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: null
created_at: "2026-05-07T17:51:41.507Z"
updated_at: "2026-05-08T13:03:38.258Z"
blocked_by: ["snap_design"]
blocks: ["snap_undo_verb"]
---

# Impl: snapshots table + auto-snapshot hook in writer ops

## Notes (1)

### #1 by worker-1, 2026-05-08T13:03:33.187Z

```
SHIPPED: snap_schema per design note #293.

═══ FILES ═══
NEW:
  src/snapshots.ts        522 lines (288 non-comment, non-blank)
                          captureSnapshot / listSnapshots / restoreSnapshot
                          / gcSnapshots / snapshotsDir / snapshotFileSize
                          + 3 typed errors: SnapshotNotFoundError,
                          SnapshotVersionMismatchError, SnapshotFileMissingError
                          (all extend Error implements HasNextSteps).
  test/snapshots.test.ts  523 lines, 33 tests, all green.

MODIFIED (one-liners + the snapshot import line):
  src/db.ts:170        CURRENT_SCHEMA_VERSION → 4
  src/db.ts:179-188    EXPECTED_TABLES + "snapshots" (alpha order)
  src/db.ts:347-373    snapshots CREATE TABLE + 2 indexes appended to
                       CURRENT_SCHEMA (no FK on workstream — by design)
  src/migrations.ts:32-35   MIGRATIONS map: [4, migrateV3ToV4]
  src/migrations.ts:347-371 migrateV3ToV4 (additive — IF NOT EXISTS so
                            applySchema's prior CREATE doesn't conflict)
  src/agents.ts:21,1029-1033        captureSnapshot + closeAgent hook
  src/tasks.ts:16, closeTask, rejectTask, deferTask, releaseTask, deleteTask
                                    all hook captureSnapshot. Hook is BEFORE
                                    setTaskStatus to avoid double-snapshotting
                                    on cascade (one snapshot per verb call,
                                    not one per cascaded child).
  src/workspace.ts:24,255-260       captureSnapshot + freeWorkspace hook
  src/workstream.ts:23,237-244      captureSnapshot in destroyWorkstream
                                    (workstream=null — whole-DB scope)
  src/approvals.ts:18,228-231       captureSnapshot + decide() hook (covers
                                    grantApproval, denyApproval, timeoutApproval)
  src/index.ts:225-238              re-export the 6 SDK fns + 3 errors + 4 types
  test/db.test.ts                   updated table count from 8 → 9 in two places

═══ COMMANDS ═══
npm install                                  (first run after branch checkout)
npm run typecheck                            (clean)
npm run lint                                 (clean after biome --write)
npm run test                                 (672/674; 2 pre-existing flakes
                                              confirmed via `git stash` round-trip
                                              on src/tasks.ts:711,719 — the
                                              `claimTask --self` $TMUX_PANE/$USER
                                              actor-resolution tests fail on main
                                              at 503a576 too; not mine.)
npm run build                                (clean: dist/cli.js 226KB,
                                              dist/index.js 127KB)
End-to-end smoke (verified by hand):
  rm -rf /tmp/mu-smoke
  MU_STATE_DIR=/tmp/mu-smoke MU_DB_PATH=/tmp/mu-smoke/mu.db \
    node dist/cli.js task add design -w foo --title 'Design' --impact 80 --effort-days 1
  MU_STATE_DIR=/tmp/mu-smoke MU_DB_PATH=/tmp/mu-smoke/mu.db \
    node dist/cli.js task close design -w foo
  ls /tmp/mu-smoke/snapshots/
  → 1.db
  → snapshots row: id=1 label="task close design" db_path=/tmp/mu-smoke/snapshots/1.db schema_version=4

═══ DECISION (deviations from design note #293) ═══

1. VACUUM INTO instead of db.backup() for capture.
   Design said "whole-DB SQLite Online Backup API (db.backup())".
   Reason for the change: db.backup() returns a Promise. Hooking it
   into the synchronous task verbs (closeTask, rejectTask, deferTask,
   releaseTask, deleteTask) would have forced an async refactor of
   five SDK functions AND their callers. VACUUM INTO is synchronous,
   produces an identical standalone .db file, runs page-level on the
   live DB, honours FK integrity, AND drops free-list pages so
   snapshots are smaller. Same on-disk shape; same restore path
   (file copy). The whole-DB-vs-subtree decision in the design is
   preserved verbatim.

2. snapshotsDir() takes an optional Db handle.
   Design implied a single `<state-dir>/snapshots/` location. In
   practice that meant tests sharing `~/.local/state/mu/snapshots/`
   when they don't set MU_STATE_DIR — first test inserts id=1.db,
   next test's fresh DB also tries id=1.db, VACUUM INTO refuses to
   overwrite. Fix: when called with the live Db, snapshotsDir(db)
   returns `<dirname(db-path)>/snapshots/` so snapshots are
   colocated with the DB they back. Falls back to
   `<state-dir>/snapshots/` without a Db (kept for forward
   compatibility with snap_undo_verb's `mu snapshot list` if it
   ever needs to list without an open DB). This also makes the
   layout more honest for non-default MU_DB_PATH users.

3. Pre-unlink stale .db files in captureSnapshot.
   After restoreSnapshot, the DB's AUTOINCREMENT max-id rolls back
   to the snapshot's value. The next captures use ids that may
   collide with files created in the abandoned forward timeline.
   Pre-unlinking the target file before VACUUM INTO is the only
   correct behaviour — the abandoned-timeline file is, by
   definition, unreferenced.

4. Re-stamp the pre-restore snapshot row into the post-restore DB.
   The design promised "undo-of-undo falls out for free: restore
   captures a pre-restore snapshot, so `mu undo` after `mu undo`
   restores that one." But the pre-restore snapshot row lives in
   the LIVE DB which we are about to overwrite — so without
   re-insertion, the row vanishes the moment we file-swap. Fix:
   capture the row's metadata before the swap, open a fresh
   short-lived connection on the post-restore DB, INSERT OR IGNORE
   the row back. The file on disk is what matters; the IGNORE
   handles the case where the snapshot itself recorded the
   pre-restore row (id collision).

5. closeTask/rejectTask/deferTask/releaseTask/deleteTask are
   hooked at the verb level, not inside setTaskStatus.
   The design said "snapshot only on destructive verbs" — fine in
   the abstract, but rejectTask --cascade calls setTaskStatus N
   times (once per dependent). Snapshot inside setTaskStatus would
   produce N snapshots per --cascade. Hook at the wrapper instead:
   one snapshot per user-facing verb invocation regardless of
   cascade fan-out. setTaskStatus stays unhooked so reconcile/test
   plumbing that calls it directly doesn't accidentally snapshot.

═══ NEXT ═══
snap_undo_verb is the natural downstream (already declared as a
blocker on snap_schema). It needs to wire:
  - mu undo [--yes] [--to N]      → SDK: restoreSnapshot(db, id)
                                   + reconcile() + post-restore output
                                   warning the user that tmux state
                                   was NOT rolled back.
  - mu snapshot list [--json]     → SDK: listSnapshots(db)
                                   + table render via cli-table3.
  - mu snapshot show <id>         → SDK: read row + snapshotFileSize().
The SDK exports it needs are all already in src/index.ts. The
typed errors (SnapshotNotFoundError, SnapshotVersionMismatchError,
SnapshotFileMissingError) all carry errorNextSteps() so they map
cleanly through cli.ts handle().

snap_destroy_safety is also unblocked (transitively via
snap_undo_verb): the destroy hook is already in place, so that
task only needs to soften the `cli.ts:2089` "No undo — restore
from backup" line in the destroy confirmation text.

═══ VERIFIED ═══
  - typecheck/lint/test/build gate: GREEN (modulo 2 pre-existing
    flakes confirmed by `git stash` round-trip on main).
  - 33 new tests in test/snapshots.test.ts, all green.
  - End-to-end smoke verifies the snapshot row + .db file land in
    the expected location.
  - Migration v3→v4 verified via test/db.test.ts: existing v1 DBs
    still migrate cleanly (the IF NOT EXISTS on the v4 body
    handles the applySchema-runs-first case).
  - The snapshots table has NO FK on workstream (verified by a
    test asserting pragma_foreign_key_list returns []) — exactly
    as snap_design §SHIP-LIST §1 mandated.
  - Whole-DB integrity: a snapshot's .db file is independently
    openable via better-sqlite3 readonly and contains every table.
  - Cascade behaviour: rejectTask --cascade onto N children
    produces exactly ONE snapshot row labelled "task reject <id>"
    (verified by test).
  - Idempotent no-op handling: closing an already-CLOSED task,
    deleting a missing task, and releasing an unowned non-reopen
    task all skip the snapshot (verified by tests).
  - Test isolation: per-test temp MU_STATE_DIR + the
    snapshotsDir(db) colocation means tests no longer pollute
    ~/.local/state/mu/snapshots/.

═══ LOC BUDGET ═══
DESIGN ESTIMATE: ~245 LOC (per snap_design §PILLAR CHECK).
ACTUAL:
  - src/snapshots.ts     288 (new; non-comment, non-blank)
  - src/db.ts             +27
  - src/migrations.ts     +15
  - src/tasks.ts          +17 (5 verbs × ~3 lines each, snapshot pre-checks)
  - src/agents.ts          +2
  - src/workspace.ts       +2
  - src/workstream.ts      +2
  - src/approvals.ts       +2
  - src/index.ts          +15
  TOTAL                   370 LOC  (+125 over estimate, ~50% over)

OVERRUN HONESTY:
The design's 245 estimate was wrong about three line-items:
  1. The 3 typed-error classes with errorNextSteps() returning
     real per-direction NextStep arrays cost ~80 LOC, not the
     handful the estimate assumed.
  2. The snapshotsDir(db?) overload + the post-restore re-stamp
     logic are surface area that came from real test friction
     (tests sharing ~/.local; the round-trip test catching the
     vanished pre-restore row), not from the design's mental model.
  3. The opportunistic GC ended up costing ~45 LOC including its
     two-cap intersection logic and the file-unlink loop.

The design's "smallest viable subset" §3 listed dropping GC
(-30) and dropping `--to <id>` (-10) as the first cuts. I did
not apply them — GC has no daemon alternative (the design's "no
daemon" pillar means we MUST shed snapshots in-hook), and `--to
<id>` is needed by snap_undo_verb's `mu undo --to N` design.

NET: 370 LOC is honest insurance for a feature that retires the
"Not undoable" line in VISION.md. If snap_undo_verb is leaner than
expected, we're back near the cumulative <300 mark for the whole
snap_* feature; if not, this is a polish-friction conversation,
not a substrate one.

═══ ODDITIES ═══
  - SQLite's VACUUM INTO refuses to overwrite ("output file
    already exists"). Pre-unlink is mandatory. Surfaced by the
    full-suite test run — three workstream-test cases ran in
    sequence with the same shared (default) snapshots dir and
    the second one collided. Fixed in src/snapshots.ts:
    `if (existsSync(dbPath)) unlinkSync(dbPath);` before the
    VACUUM INTO call. Required regardless of restore semantics.
  - Two existing tests on main (test/tasks.test.ts:711,719,
    `claimTask --self` actor resolution from $TMUX_PANE / $USER)
    fail on the unmodified 503a576 branch point too. Not mine,
    but flagged for someone to look at.
  - `applySchema` + migration interaction: applySchema runs
    BEFORE runMigrations and creates the v4 snapshots table from
    CURRENT_SCHEMA's IF-NOT-EXISTS body. Then runMigrations sees
    a v3 DB (because detectExistingSchemaVersion read the version
    BEFORE applySchema, then UPDATE'd it back to 3) and tries to
    run v3→v4 — which would CREATE TABLE without IF NOT EXISTS.
    Fix: the v3→v4 migration body uses IF NOT EXISTS on every
    statement. The same dance was already implicit in v1→v2
    (which CREATEs `_new` suffixed tables, not the plain name)
    so this is the first migration where it matters.
  - The pre-restore snapshot's row has to be re-INSERTED into the
    post-restore DB (not just left in the row set we backed up).
    The snapshot file we restore is from BEFORE the pre-restore
    snapshot was taken, so its snapshots table doesn't have the
    pre-restore row. Caught by the round-trip test on first
    write; fix is a 15-line short-lived-connection re-insert at
    the end of restoreSnapshot.
  - The re-insert uses `new Database(livePath)` directly rather
    than openDb(): openDb would re-run applySchema +
    runMigrations on the freshly-restored file, which is fine but
    adds startup overhead the SDK shouldn't pay (the file is
    already at CURRENT_SCHEMA_VERSION by virtue of having passed
    the version check). The caller of restoreSnapshot
    (snap_undo_verb) will openDb() afterwards anyway.
  - No --no-snapshot flag was added (anti-feature pledge:
    no anticipatory abstractions). If a user ever NEEDS to skip
    the snapshot (huge bulk delete in tests, e.g.) the pattern
    is `MU_DB_PATH=:memory:` or direct `mu sql DELETE`, both of
    which already bypass the SDK verbs.
```
