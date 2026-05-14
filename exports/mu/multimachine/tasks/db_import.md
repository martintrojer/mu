---
id: "db_import"
workstream: "multimachine"
status: CLOSED
impact: 80
effort_days: 1.5
roi: 53.33
owner: null
created_at: "2026-05-14T08:05:04.150Z"
updated_at: "2026-05-14T09:18:52.869Z"
blocked_by: ["db_export"]
blocks: ["db_replay"]
---

# mu db import <file>: drift detection, sharp --force-source, sidecar park

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:07:10.189Z

```
TASK
====
Add `mu db import <file>` — drift-detecting, sharp-on-conflict whole-workstream merge from an exported DB.

PRECONDITION
============
schema_v8 + db_export must be landed (workstream_sync table + machineId substrate exist; export sidecar manifest is the input format).

CLI
===
mu db import <file> [--apply] [--only-ws <names>] [--force-source] [--json]

Default behaviour is dry-run. Pass --apply to commit. (--dry-run by default is the safety net the user explicitly asked for.)

ALGORITHM
=========
For each workstream `W` present in EITHER source DB (`<file>`) OR local DB:

  source_seq   = source.workstreams[W].latestSeq    (from manifest; or 0 if not in source)
  local_seq    = latestSeq(localDb, W)              (or 0 if W not local)
  last_synced  = local.workstream_sync[W].last_known_peer_seqs[source.machineId]   (or 0)

  source_advanced = source_seq > last_synced
  local_advanced  = local_seq  > last_synced

  CASE:
    !source_advanced && !local_advanced  →  IDENTICAL (no-op)
    source_advanced && !local_advanced   →  FAST_FORWARD (replace W from source)
    !source_advanced && local_advanced   →  LOCAL_AHEAD (refuse: source is stale; print "re-export from this machine")
    source_advanced && local_advanced    →  CONFLICT
                                              if --force-source:
                                                park local W to ~/.local/state/mu/divergence/<W>-<ts>.db (a tiny SQLite with only W's rows)
                                                then replace W from source
                                              else: refuse with diff summary

  W only in source, not local → IMPORT (replace = create new)
  W only in local, not source → LEAVE_ALONE (this is the cross-workstream collateral protection)

After successful apply for each W: update workstream_sync[W].last_known_peer_seqs[source.machineId] = source_seq.

REPLACE SEMANTICS
=================
"Replace workstream W from source" means atomically (one tx):
  - DELETE everything in local W: tasks, task_edges, task_notes, agent_logs (filtered by workstream_id), workstream row.
  - INSERT all of W from source: workstream row, tasks (preserve local_id), task_edges (rewire by local_id pair), task_notes, agent_logs (renumber seq locally; original seq tracked in payload if needed).
  - DO NOT carry over agents rows or workspace_path data: those are machine-local. Source's agents rows are dropped on import.
  - DO NOT carry over snapshots.
  - workstream_sync row is rewritten.

DIVERGENCE PARK
===============
The sidecar at ~/.local/state/mu/divergence/<W>-<ts>.db is itself a small SQLite file with just W's rows (same shape as a one-workstream export). Import prints its path. `mu db replay <sidecar>` (separate task) is the manual cherry-pick path.

DRY-RUN OUTPUT
==============
Per-workstream classification table + a Next: block. JSON shape:
{
  "machineId": "...",
  "sourceFile": "...",
  "summary": [
    {"workstream": "alpha", "decision": "FAST_FORWARD", "delta": {"tasks": "+3 ~1", "notes": "+12", "edges": "+1"}},
    {"workstream": "beta",  "decision": "CONFLICT",     "localChanges": {...}, "sourceChanges": {...}, "needs": "--force-source"},
    {"workstream": "gamma", "decision": "LOCAL_AHEAD",  "needs": "re-export from this machine"}
  ]
}

AUTO-SNAPSHOT
=============
Before --apply commits ANY change, take a full snapshot via existing snapshot SDK. So `mu undo --yes` saves the user.

ERROR TYPES
===========
- DbImportSchemaTooOldError (source schema < CURRENT_SCHEMA_VERSION)
- DbImportSchemaTooNewError (source schema > CURRENT_SCHEMA_VERSION; tells user to upgrade local mu)
- DbImportSourceStaleError (LOCAL_AHEAD case)
- DbImportConflictError (CONFLICT without --force-source)
- DbImportManifestMissingError

Each maps to a distinct exit code via handle().

TEST COVERAGE
=============
- Each of the 5 CASE branches.
- Cross-workstream collateral: W exists locally but not in source → untouched.
- workstream_sync state correctly updated post-apply.
- Divergence park file is a valid SQLite that openDb can read.
- Auto-snapshot recoverable: import then `mu undo --yes` returns to pre-import state.
- Schema-version mismatch (both directions).
- agents rows from source are dropped on import.

FILES
=====
- src/db-sync.ts            (extend; this is the meaty addition)
- src/cli/db.ts             (extend)
- test/db-sync-import.test.ts (new)

OUT OF SCOPE
============
- mu db replay (separate task: db_replay).
- Removing mu workstream import (separate task: remove_ws_import).
- archive restore (separate task: archive_restore).

CONSTRAINTS
===========
- LOC: aim < 400 net added in src/db-sync.ts; refactor signal at 800 (per AGENTS.md).
- ESM, strict types, no `any`.
- Run `npx biome check --write src test` before committing.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
- node dist/cli.js db --help
- Manual smoke: export to /tmp/foo.db, mutate local, `mu db import /tmp/foo.db` → dry-run report; --apply.

⚠️ FINAL ACTION
==============
git commit -am 'db: mu db import <file> — drift detection + sharp --force-source with sidecar park' THEN
mu task close db_import -w multimachine --evidence '<sha> src/db-sync.ts +N lines, all 5 case branches tested'
```

### #2 by "π - mu", 2026-05-14T08:10:24.265Z

```
CLARIFICATION: clean-machine import path
========================================
The "W only in source, not local → IMPORT" branch is the ONLY path that fires when the destination machine has zero priors (no workstreams of any name). No special-cased "first-import" logic needed.

Concretely: on a DB whose only row is the seeded machine_identity, every source workstream is W-not-in-local. For each:
  1. Create the workstream row from source.
  2. Insert tasks (preserve local_id), edges, notes, agent_logs.
  3. Write workstream_sync[W].last_known_peer_seqs[source.machineId] = source.workstreams[W].latestSeq.

Verify with a dedicated test in test/db-sync-import.test.ts: import a non-trivial DB into an empty one; assert all workstreams + counts match; assert workstream_sync rows are populated; assert the local machine_identity row is NOT overwritten by source's identity (the local machine keeps its OWN id).
```

### #3 by "π - mu", 2026-05-14T08:53:52.941Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `db_import`.

YOUR TASK: db_import — THE MEATIEST TASK IN THIS FEATURE

STEP 1 — read all design context end-to-end before touching code:
  mu task notes umbrella -w multimachine
  mu task notes db_import -w multimachine
  mu task notes schema_v8 -w multimachine
  mu task notes db_export -w multimachine

The db_import task note is your spec — the FULL algorithm (5 case branches), the divergence-park pattern, and the typed errors are all in there. The umbrella has the broader context. The schema_v8 note explains machine_identity + workstream_sync (already on main). The db_export note shows the manifest format you'll be reading.

STEP 2 — read the existing pieces you'll touch or build on:
  - src/db-sync.ts — exportDb is here; you will add importDb to the same file.
  - src/cli/db.ts — current verbs: export. You add: import. (replay is a separate later task.)
  - src/db.ts — machine_identity, workstream_sync table shapes; openDb signature.
  - src/snapshots/ — capture pattern. CALL the existing snapshot SDK before any destructive write.
  - src/cli/handle.ts — typed-error → exit-code map. You add multiple new error types here.
  - src/logs.ts — latestSeq() function.
  - src/workstream.ts — workstream creation/deletion + the cascade behaviour for tasks/edges/notes/agent_logs.
  - src/archives/restore.ts — recently-landed code that does whole-workstream insert. Same pattern (read source rows, insert preserving local_id, rewire edges by local_id pair) applies to your "FAST_FORWARD" and "IMPORT" cases.

STEP 3 — implement per the task note. Critical points:

  CLI: `mu db import <file> [--apply] [--only-ws <names>] [--force-source] [--json]`
    - Default behaviour is DRY-RUN. --apply commits.
    - --only-ws can be repeated or comma-separated; restricts which workstreams are touched.
    - --force-source enables CONFLICT → clobber-with-park.

  ALGORITHM (5 cases, per workstream W in either side):
    source_seq   = source.workstreams[W].latestSeq    (from manifest; or 0 if not in source)
    local_seq    = latestSeq(localDb, W)              (or 0 if W not local)
    last_synced  = local.workstream_sync[W].last_known_peer_seqs[source.machineId]   (or 0)

    source_advanced = source_seq > last_synced
    local_advanced  = local_seq  > last_synced

    !src && !loc                         → IDENTICAL  (no-op)
    src && !loc                          → FAST_FORWARD (replace W from source)
    !src && loc (ws was on local before) → LOCAL_AHEAD (refuse: source is stale; print "re-export from this machine")
    src && loc                           → CONFLICT
                                              if --force-source:
                                                park local W to ~/.local/state/mu/divergence/<W>-<ts>.db
                                                then replace W from source
                                              else: refuse with diff summary

    W only in source, not local at all → IMPORT (the clean-machine import path; create new ws).
    W only in local, not source        → LEAVE_ALONE (cross-workstream collateral protection).

  REPLACE SEMANTICS for "replace W from source" (one tx):
    - DELETE everything in local W: tasks, task_edges, task_notes, agent_logs (filtered by workstream_id), workstream row.
    - INSERT all of W from source: workstream row, tasks (preserve local_id), task_edges (rewire by local_id pair into newly-allocated local task ids), task_notes, agent_logs (renumber seq locally; original seq tracked in payload if needed).
    - DO NOT carry over `agents` rows or workspace_path data: machine-local, drop them.
    - DO NOT carry over snapshots.
    - workstream_sync row is rewritten: last_known_peer_seqs[source.machineId] = source_seq.

  DIVERGENCE PARK:
    - Park file: ~/.local/state/mu/divergence/<W>-<ISO8601>.db
    - The file is itself a small SQLite with ONLY W's rows (same shape as a one-workstream export).
    - Use VACUUM INTO into a temp file then ATTACH the source's W-only rows? Or reuse the existing exportDb pattern with a workstream filter? You decide; minimum viable: a SQLite copy filtered to W via a temp table dance, OR a fresh openDb on a temp path + insert W's rows.
    - Park MUST happen BEFORE the destructive replace, atomically enough that a crash mid-import doesn't lose data.
    - mkdir -p the divergence dir if missing.
    - Filename includes a unique suffix in case of same-second runs.

  AUTO-SNAPSHOT:
    - Before --apply commits any change, take a full snapshot via existing snapshot SDK. So `mu undo --yes` saves the user.

  TYPED ERRORS (each maps to a distinct exit code via handle()):
    - DbImportSchemaTooOldError (source schema < CURRENT_SCHEMA_VERSION)
    - DbImportSchemaTooNewError (source schema > CURRENT_SCHEMA_VERSION; tells user to upgrade local mu)
    - DbImportSourceStaleError (LOCAL_AHEAD case; one or more local workstreams are ahead of source)
    - DbImportConflictError (CONFLICT case without --force-source; lists conflicting ws + suggests --force-source)
    - DbImportManifestMissingError (sidecar manifest not found)

  DRY-RUN OUTPUT (textual + --json):
    Per-workstream classification table + a Next: block. JSON shape per umbrella note's spec:
    {
      "machineId": "...",
      "sourceFile": "...",
      "summary": [
        {"workstream": "alpha", "decision": "FAST_FORWARD", "delta": {...}},
        {"workstream": "beta",  "decision": "CONFLICT",     "needs": "--force-source"},
        ...
      ]
    }

STEP 4 — tests in a new test/db-sync-import.test.ts:
  - Each of the 5 CASE branches has positive AND negative assertions.
  - Cross-workstream collateral: W exists locally but not in source → untouched after import.
  - workstream_sync state correctly updated post-apply (assert the row, not just task counts).
  - Divergence park file is a valid SQLite that openDb can read.
  - Auto-snapshot recoverable: import then `mu undo --yes` returns to pre-import state.
  - Schema-version mismatch (both directions).
  - agents rows from source are dropped on import.
  - Clean-machine import (empty local DB except for seeded machine_identity): imports cleanly, local machine_identity is NOT overwritten by source's identity.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify ALL FOUR GREENS + bundle smoke:
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run test
  npm run build
  node dist/cli.js --help              # bundle smoke; silent stderr = top-level await deadlock; see HANDOVER Gotcha 1
  node dist/cli.js db --help           # both export + import listed
  node dist/cli.js db import --help    # verb wired

  Manual smoke (against /tmp DBs only — DO NOT touch the real default DB):
    node dist/cli.js db export /tmp/src.db --force
    node dist/cli.js db import /tmp/src.db   # dry-run print
    node dist/cli.js db import /tmp/src.db --apply --json | jq .

STEP 7 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'db: mu db import <file> — drift detection + sharp --force-source with sidecar park'

⚠️ FINAL ACTION
==============
After commit + 4-green verify clean, run EXACTLY:

  mu task close db_import -w multimachine --evidence '<sha> all 5 case branches tested, divergence park + auto-snapshot recoverable'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (just recreated; HEAD is fresh main = 6f8625c db_export)
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 400 net added in src/db-sync.ts; refactor signal at 800 (per AGENTS.md).
- Single commit. No CHANGELOG, no docs files (deferred to docs_pass).
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT modify src/archives/* or src/cli/archive.ts (worker-2 is in those).

COORDINATION WARNING
- worker-2 is in parallel on `archive_cleanup` (help-text touchups + test conversion in src/cli/archive.ts + src/archives.ts + tests). Different files; should be no overlap. If worker-2 modifies src/cli/handle.ts (typed errors / next-steps), the orchestrator (me) handles the conflict on cherry-pick.

DESIGN NUDGE — KEEP IT FLAT
- It is OK to put importDb + buildImportPlan + executeImportPlan + parkLocalWorkstream all in src/db-sync.ts. The 800 LOC refactor signal is fine; we'll cluster later if needed.
- If you reach for an abstract "PlanExecutor" interface, STOP and use a concrete switch on decision instead. AGENTS.md says no anticipatory abstractions.
```

### #4 by "worker-1", 2026-05-14T09:18:52.869Z

```
CLOSE: de59f3f all 5 case branches tested, divergence park + auto-snapshot recoverable
```
