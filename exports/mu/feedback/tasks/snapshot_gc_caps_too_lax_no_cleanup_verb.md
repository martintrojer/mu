---
id: "snapshot_gc_caps_too_lax_no_cleanup_verb"
workstream: "feedback"
status: CLOSED
impact: 35
effort_days: 0.5
roi: 70.00
owner: null
created_at: "2026-05-10T15:50:51.705Z"
updated_at: "2026-05-10T16:15:50.533Z"
blocked_by: []
blocks: []
---

# snapshot GC: AND-of-caps is too lax; no manual cleanup verb; defaults outgrow disk on busy days

## Notes (2)

### #1 by "π - mu", 2026-05-10T15:52:35.474Z

```
OBSERVED 2026-05-10 right after the feedback-ws dispatch wave.

REPRO:
  $ mu snapshot list -n 1 --json | jq '.[0] | .id'
  458
  $ du -sh ~/.local/state/mu/snapshots/
  731M
  $ ls ~/.local/state/mu/snapshots | wc -l
  458

  -> 458 snapshots, ~2.2MB each, **731MB on disk**, all from a few
     hours of dogfooding. No retention policy ever fired.

ROOT CAUSE (src/snapshots.ts:484 gcSnapshots):
  GC keeps a snapshot if EITHER cap is satisfied:
    - row is among the GC_MAX_COUNT (=100) most recent, OR
    - row is younger than GC_MAX_AGE_DAYS (=14)

  The SQL: `WHERE created_at < cutoff AND id NOT IN (latest 100)`.
  Translation: a snapshot is deleted only if it's BOTH old AND past
  the count cap. With heavy mutation in one day, all 458 rows are
  <14 days old, so the date filter eliminates everything regardless
  of the count cap. The 100-row cap NEVER FIRES under bursty use.

  This is the AND/OR bug in retention-policy form: defaults read as
  "keep at most 100 rows OR things <14 days old"; the impl is
  "delete only if both old AND past 100". Operator-facing intent is
  the union; implementation is the intersection.

THREE FAILURE MODES:
  1. **AND-of-caps lets snapshots accumulate without bound during a
     bursty session.** 458 rows / 731MB after one day's dogfood.
  2. **No manual cleanup verb.** `mu snapshot list` exists; `mu
     snapshot show` exists; there is no `mu snapshot prune` /
     `mu snapshot gc` / `mu snapshot delete <id>`. Operators who
     notice the disk-fill have to reach for `rm -rf
     ~/.local/state/mu/snapshots/*.db` + `mu sql DELETE FROM
     snapshots`. Both are scary; both bypass the schema-version
     check that keeps `mu undo` honest.
  3. **No env-var override of the caps.** Defaults baked in as
     `const`; tests would have to monkey-patch the module to
     exercise behaviour. (We have `MU_SPAWN_LIVENESS_MS` and
     `MU_IDLE_THRESHOLD_MS` precedent for this kind of knob.)
  4. **`mu snapshot list` does not show schema_version** even
     though it's stored per-row (`snapshots.schema_version`,
     populated since src/snapshots.ts:262). After a schema bump,
     every pre-bump snapshot is unrestorable (SnapshotVersionMismatch
     on `mu undo`), but the operator can't see this until they try
     to restore one. Stale-version snapshots are pure dead weight
     on disk after a v-bump.

FIX OPTIONS (smallest first; recommend doing ALL of A+B+C+D — they
compose):

  A. Fix the AND-of-caps. Change gcSnapshots to OR:
       DELETE WHERE id NOT IN (latest GC_MAX_COUNT) OR
                   created_at < cutoff
     i.e. drop a row if it's past the count cap OR past the age
     cap, whichever fires first. This matches the docstring intent
     ("Drop snapshots that are BOTH older ... AND beyond the
     GC_MAX_COUNT most-recent rows. Whichever cap is more
     permissive wins.") — note the docstring already promises OR
     semantics; the impl is the bug.

  B. Add `mu snapshot prune` (NEW verb). Two modes:
       mu snapshot prune              # run the GC policy now
                                      # (same as the auto-call)
       mu snapshot prune --keep-last N # keep only the N most-recent
       mu snapshot prune --older-than 7d
       mu snapshot prune --stale-version  # NEW: drop snapshots
                                          # whose schema_version
                                          # != CURRENT_SCHEMA_VERSION
       mu snapshot prune --all        # nuke everything (--yes
                                      # required; auto-snapshots
                                      # the live DB first as a
                                      # safety net)
     `--dry-run` default for the destructive flags; `--yes` to
     commit. JSON output for scripting.

  C. Add `mu snapshot delete <id>` for surgical removal. Mirrors
     `mu task delete <id>`. Removes the row + the on-disk .db file.

  D. Show schema_version in `mu snapshot list`:
     ┌─────┬─────┬───────────┬────────────┬─────────┬────────┐
     │ id  │ ver │ label     │ workstream │ created │ size   │
     ├─────┼─────┼───────────┼────────────┼─────────┼────────┤
     │ 458 │ v7  │ ...       │ ...        │ ...     │ 2.2 MB │
     │ 421 │ v6  │ (stale)   │ ...        │ ...     │ 2.2 MB │ (dim)
     Stale-version rows render dimmed (same pattern as
     `task_show_blocked_by_renders_closed`'s satisfied bucket).
     `--json` already exposes `schemaVersion`; the table form is
     the missing piece.

  E. Make the caps env-tunable:
       MU_SNAPSHOT_KEEP_LAST   (default 100)
       MU_SNAPSHOT_MAX_AGE_DAYS (default 14)
     Two new env vars, same pattern as MU_SPAWN_LIVENESS_MS.

  F. (Optional, lower priority — DEFERRED unless A-E land easily)
     Lower the defaults. 14 days × 100 rows is generous for a tool
     where one workday can produce 400+ snapshots. Suggested:
       KEEP_LAST: 50  (was 100)
       MAX_AGE_DAYS: 3 (was 14)
     With the OR fix from A, this gives "the 50 most recent OR
     anything from the last 3 days, whichever is more rows". On a
     quiet day you keep ~50; on a busy day you keep the day's burst.

CONSTRAINTS:
  - DO NOT remove auto-GC. It's load-bearing for unattended use.
  - DO NOT change the on-disk layout (snapshots are flat files
    referenced by `snapshots.db_path`; restore semantics depend on
    file-swap).
  - DO NOT add a config file. Env-var-only knobs.
  - PRESERVE the schema-version safety check in restoreSnapshot;
    `mu snapshot prune --stale-version` should help with the
    accumulation, not bypass the check.

VERIFIED: live system. 458 snapshots / 731MB on disk after ~6h of
dogfooding the v0.3 codebase. None GC'd. Prediction: by week 1 of
heavier use, this exceeds 5GB without intervention.
```

### #2 by "worker-2", 2026-05-10T16:15:06.623Z

```
FILES:
  src/snapshots.ts                          (A: AND→OR fix in gcSnapshots; B: pruneSnapshots+computeGcVictims/computeKeepLastVictims/computeOlderThanVictims; C: deleteSnapshot; D: isStaleVersion exported helper; E: gcMaxCount/gcMaxAgeDays env readers replacing const GC_MAX_*)
  src/cli/snapshot.ts                       (B: cmdSnapshotPrune + wireSnapshotCommands prune subverb; C: cmdSnapshotDelete + delete subverb; D: ver column in cmdSnapshotList + dim-stale rows + stale-version Next: hint; helpers: formatSchemaVersion, parseOlderThanDays, formatBytes now exported + GB tier)
  src/cli/handle.ts                         (PruneOptionsInvalidError → exit 2 via the UsageError-class bucket)
  src/index.ts                              (SDK re-exports: deleteSnapshot, gcMaxAgeDays, gcMaxCount, isStaleVersion, PruneOptionsInvalidError, PruneMode, PruneOptions, PruneResult, pruneSnapshots, DeleteSnapshotResult)
  test/snapshots.test.ts                    (count-cap regression test for A; mode='*' tests for pruneSnapshots; deleteSnapshot tests; isStaleVersion tests; env-tunable tests for E)
  test/cli-snapshot.test.ts                 (CLI tests for prune in every mode + dry-run/--yes split + --json + safety-net for --all + UsageError mutex check; CLI tests for delete + missing-id 3 + JSON shape; ver column header + stale-row Next: hint)
  CHANGELOG.md                              (0.3.0 § Added: prune+delete; § Fixed: AND→OR, ver column, env tunables)
  skills/mu/SKILL.md                        (verb list: ver column in list one-liner; new prune + delete one-liners)
  docs/USAGE_GUIDE.md                       (snapshot section: prune + delete recipes; ver column + stale-version note; GC docstring updated to OR semantics + env vars)
  docs/VOCABULARY.md                        (new prune verb row alongside snapshot)

COMMANDS:
  npm run typecheck   exit 0
  npm run lint        exit 0
  npm run test        exit 0  (1102 / 1102; +25 new tests across snapshots + cli-snapshot)
  npm run build       exit 0
  Smoke ran on /tmp DB: list/prune (every mode)/delete/safety-net/mutex all behave as documented.

FINDINGS:
  - The prior gcSnapshots WHERE was `created_at < cutoff AND id NOT IN (top-100)` — "delete only if BOTH old AND past the count cap". Under bursty use every row was younger than the 14-day age cap, so the date filter spared everything regardless of row count and the 100-row cap NEVER fired. One-line flip to `id NOT IN (top-N) OR created_at < cutoff` matches the docstring intent ("keep top-N AND younger-than-D; delete the rest").
  - The existing GC tests had to be rewritten because they encoded the AND semantics (e.g. "all 60 fresh survived; 40 of the OLD set are also count-protected" — the count cap protecting OLD rows was the bug). Replaced with OR-aware tests + a dedicated count-cap regression for the bug-report scenario (105 fresh rows → 5 victims, 100 survive).
  - For `mu snapshot list` dimming, every cell on a stale row gets pc.dim wrapped (matches the satisfied-blockers pattern from worker-4's 082f12c). Non-stale rows preserve the historical `<whole-DB>` dim treatment for the workstream column.
  - `mu snapshot prune --all --yes` captures the safety-net snapshot AFTER computing victims (so the safety-net itself isn't in the victim set) and BEFORE the DELETE (so `mu undo --to <safety-net-id>` can roll back to the pre-wipe state). The safety-net row carries workstream=NULL like other whole-DB snapshots.
  - parseOlderThanDays uses commander's InvalidArgumentError so bad input exits via commander's usage-error path; mutex flag-conflict uses our own UsageError → exit 2. PruneOptionsInvalidError (SDK-level) also maps to exit 2.

DECISION:
  - Skipped F (defaults change) per task instructions; the existing 100/14 defaults behave correctly under OR.
  - `deleteSnapshot` does NOT auto-snapshot first per task spec — the point is to delete one stepping-stone, and that can't break `mu undo`.
  - `--all` is two-phase (dry-run by default, --yes commits, safety-net taken only on commit) — matches `mu workstream destroy --yes` precedent.
  - `gcMaxCount` / `gcMaxAgeDays` mirror `idleThresholdMs` / `defaultSpawnLivenessMs` exactly: env override > default-on-bad-input > no throw. Tests pin every fallback path.

NEXT:
  - Item F (default tightening to 50 / 3) deferred per task spec; revisit if dogfood data shows the defaults are still too loose under OR semantics.
  - The `pre-restore of snapshot N` row inserted by restoreSnapshot does NOT currently get the `safety-net` label treatment in any pruning UI — orthogonal to this task; flag if it shows up in feedback.

VERIFIED:
  - All 1102 tests pass (was 1077; added 25). The new count-cap regression test demonstrates the bug repro from the dogfood note: >GC_MAX_COUNT fresh rows now get the count cap to fire (was not firing pre-fix).
  - End-to-end smoke against a real /tmp DB: created 5 task-close snapshots, exercised list (id+ver+label+ws+created_at+size), prune --keep-last 2 (dry-run + --yes), delete <id>, prune --all (dry-run + --yes captures safety-net #6), prune --all --keep-last 1 (UsageError exit 2), bumped a row to v6 + listed (dim + stale-version Next: hint visible).
```
