---
id: "archive_phase1_schema_sdk"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 80
effort_days: 1
roi: 80.00
owner: null
created_at: "2026-05-09T17:14:34.888Z"
updated_at: "2026-05-09T17:32:34.643Z"
blocked_by: []
blocks: ["archive_phase2_cli_verbs"]
---

# Phase 1: schema migration v5→v6 (4 archive tables) + SDK module src/archives.ts

## Notes (2)

### #1 by "π - mu", 2026-05-09T17:15:59.102Z

```
Phase 1 — schema migration v5→v6 + SDK module.

DESIGN INHERITED FROM: mufeedback-v03/workstream_archive_verb (notes 1+2). Read both before claiming.

═══ SCHEMA (v6 — new tables, additive only — NO EXISTING TABLES TOUCHED) ═══

archives (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT UNIQUE NOT NULL,        -- operator-chosen, globally unique (not per-workstream — archives outlive workstreams)
  description   TEXT,                        -- optional one-liner
  created_at    TEXT NOT NULL,               -- first add timestamp
  last_added_at TEXT NOT NULL                -- bumped on every successful add (additive accumulation invariant)
)

archived_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id          INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream   TEXT NOT NULL,         -- intentionally TEXT (the source ws may be gone post-destroy)
  original_local_id   TEXT NOT NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL,
  impact              INTEGER NOT NULL,
  effort_days         REAL NOT NULL,
  owner_name          TEXT,                  -- snapshotted at archive time (TEXT, agents.name doesn't survive)
  archived_at_status  TEXT NOT NULL,         -- pinned-at-archive status (in case we add re-add semantics)
  archived_at         TEXT NOT NULL,
  original_created_at TEXT NOT NULL,
  original_updated_at TEXT NOT NULL,
  UNIQUE (archive_id, source_workstream, original_local_id)
)

archived_edges (
  archive_id        INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  from_archived_id  INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  to_archived_id    INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (archive_id, from_archived_id, to_archived_id)
)

archived_notes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id       INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  archived_task_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  author           TEXT,
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL              -- original creation time
)

archived_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id        INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream TEXT NOT NULL,
  seq               INTEGER NOT NULL,         -- original seq from agent_logs
  source            TEXT NOT NULL,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL
)

Indexes:
  CREATE INDEX idx_archived_tasks_archive ON archived_tasks (archive_id);
  CREATE INDEX idx_archived_tasks_source  ON archived_tasks (archive_id, source_workstream);
  CREATE INDEX idx_archived_notes_task    ON archived_notes (archived_task_id);
  CREATE INDEX idx_archived_events_archive ON archived_events (archive_id, source_workstream);

EXPECTED_TABLES (src/db.ts) gains: archived_edges, archived_events, archived_notes, archived_tasks, archives.

═══ MIGRATION STRATEGY: AGGRESSIVE (mirrors v4→v5) ═══

v6 is purely additive (5 new tables; no existing column changed; no FK altered). This means:
  - In-process migration is SAFE and SIMPLE: applySchema's CREATE-IF-NOT-EXISTS handles fresh DBs; for v5 DBs we just need to bump schema_version.
  - DO NOT need a separate scripts/migrate-v5-to-v6.ts script. The v4→v5 transition needed one because v5 reshaped every PK; v6 is additive.
  - In src/db.ts: bump CURRENT_SCHEMA_VERSION = 6; add the five CREATE TABLE blocks to CURRENT_SCHEMA; gate the v<5 loud-fail to v<5 (NOT v<6). v5 DBs are forward-compatible: applySchema runs the new CREATE TABLEs idempotently and bumps schema_version to 6.
  - Specifically: in detectExistingSchemaVersion's caller, the old check `if (detectedVersion !== null && detectedVersion < CURRENT_SCHEMA_VERSION) throw SchemaTooOldError` becomes `< 5` (the floor stays v5; we don't refuse v5 DBs).
  - applySchema gains a one-shot `UPDATE schema_version SET version = ? WHERE id = 1 AND version < ?` to bump v5 → v6 in place after the new CREATE TABLEs land.

═══ SDK SHAPE (src/archives.ts, ~300 LOC) ═══

  // Types
  export interface Archive { id, label, description?, createdAt, lastAddedAt }
  export interface ArchiveSummary extends Archive { sourceWorkstreams: { name, taskCount, addedAt }[]; totalTasks: number }
  export interface ArchivedTaskRow { id, archiveLabel, sourceWorkstream, originalLocalId, title, status, impact, effortDays, ownerName?, archivedAt, ... }
  export interface AddToArchiveResult { addedTasks, skippedTasks, addedEdges, addedNotes, addedEvents }
  export interface RemoveFromArchiveResult { removedTasks, removedEdges, removedNotes, removedEvents }

  // SDK
  export function createArchive(db, label, description?): Archive          // throws ArchiveAlreadyExistsError
  export function listArchives(db): ArchiveSummary[]
  export function getArchive(db, label): ArchiveSummary                    // throws ArchiveNotFoundError
  export function deleteArchive(db, label): void                           // takes a snapshot first
  export function addToArchive(db, label, workstream): AddToArchiveResult  // IDEMPOTENT (skip if already present); bumps last_added_at
  export function removeFromArchive(db, label, sourceWorkstream): RemoveFromArchiveResult
  export function listArchivedTasks(db, label, opts?: { sourceWorkstream? }): ArchivedTaskRow[]

  // Errors (typed; map to exit codes via cli.ts handle())
  export class ArchiveNotFoundError extends Error implements HasNextSteps   // exit 3 (not found)
  export class ArchiveAlreadyExistsError extends Error implements HasNextSteps  // exit 4 (conflict)
  export class ArchiveLabelInvalidError extends Error implements HasNextSteps  // exit 2 (validation)

LABEL VALIDATION: same rule as workstream names but allow the same character set ([a-z][a-z0-9_-]{0,63}). Reuse isValidWorkstreamName-style checker.

═══ ADDITIVE INVARIANT (LOAD-BEARING) ═══

addToArchive(label, ws):
  1. resolveWorkstreamId(ws) — throws WorkstreamNotFoundError if gone (you must archive BEFORE destroy).
  2. For each task in the workstream:
       INSERT OR IGNORE INTO archived_tasks (archive_id, source_workstream, original_local_id, ...) VALUES (...)
     The OR IGNORE is the idempotency lever — re-running addToArchive(label, ws) is a no-op for tasks already present.
  3. For each edge: INSERT OR IGNORE — both endpoints resolve via (archive_id, source_workstream, original_local_id).
  4. For each note: INSERT (always; notes don't have a natural unique key beyond auto-id; re-running addToArchive on the same ws creates duplicates). MITIGATION: after step 2's OR IGNORE returns 0 added rows for a (source_workstream), skip notes/events for that ws. This makes addToArchive truly idempotent at the (archive, source_workstream) granularity.
  5. For each kind='event' row in agent_logs: INSERT into archived_events (only events; full message log is huge and rarely queried; recover via snapshot+undo if needed).
  6. UPDATE archives SET last_added_at = now() WHERE label = ?.
  7. Emit event (workstream=null since archive ops are machine-wide): `archive add ${label} -w ${ws} (tasks=N, edges=M, notes=K, events=E, skipped_existing=S)`.

═══ TESTS (test/archives.test.ts, ~200 LOC) ═══

Round-trip:
  1. Create workstreams A and B with tasks (A: 3 tasks with edges; B: 2 tasks).
  2. createArchive('w'); addToArchive('w', 'A'); addToArchive('w', 'B').
  3. Verify archived_tasks count = 5; archived_edges preserved; cross-source distinguishable via source_workstream column.
  4. Re-run addToArchive('w', 'A') — verify zero new rows (idempotency).
  5. Add a new task to A; re-run addToArchive('w', 'A') — verify the new task is added; existing tasks unchanged.
  6. removeFromArchive('w', 'A') — verify only A's rows gone; B's rows intact.
  7. deleteArchive('w') — verify cascade cleans every archived_* row.
  8. addToArchive against a destroyed workstream → throws WorkstreamNotFoundError (no resurrection).
  9. createArchive with a duplicate label → throws ArchiveAlreadyExistsError.

Migration:
  10. Open a DB with schema_version=5 (no archived_* tables); call openDb. Verify the v5→v6 in-place migration: tables now exist, schema_version=6, no other tables touched, existing data (workstreams + tasks) intact.
  11. Pre-v5 DB still throws SchemaTooOldError (the floor stays v5).

═══ FILES TO TOUCH ═══

  src/db.ts            : +5 CREATE TABLE blocks, +4 indexes, bump CURRENT_SCHEMA_VERSION to 6, extend EXPECTED_TABLES, add v5→v6 in-place migration (~70 LOC additive).
  src/archives.ts      : NEW (~300 LOC).
  src/index.ts         : re-export src/archives.ts symbols.
  test/archives.test.ts: NEW (~200 LOC).
  test/db.test.ts      : extend EXPECTED_TABLES assertions if they exist; verify CURRENT_SCHEMA_VERSION=6.
  CHANGELOG.md         : new "Schema v6" entry under v0.3.0 section (terse: 5 new tables, additive only).
  docs/VOCABULARY.md   : add "archive", "archived task", "archive label" entries.
  docs/ARCHITECTURE.md : new row in module table for src/archives.ts.

DO NOT TOUCH IN PHASE 1: the CLI (Phase 2), workstream destroy (Phase 3), the export renderer (Phase 4). Keep this PR pure schema + SDK.

═══ SCOPE CAP ═══

Target ~350 LOC of code + ~200 LOC of tests. Hard cap at 1500 per file (src/archives.ts well under).

═══ SCRIPTS GUARDS ═══

scripts/grep-name-without-workstream.sh: archives.label is a TEXT UNIQUE column — your SELECTs on (label) WITHOUT a workstream filter will trip the guard. The guard's allowlist needs a few new entries for archive label lookups. Mirror the workstream lookup allowlist pattern.

scripts/grep-v4-references.sh: shouldn't fire (no v4 mentions in v6 work).

═══ FINAL ACTION REMINDER ═══

⚠️ When done: git commit -am '...' THEN mu task close archive_phase1_schema_sdk -w roadmap-v0-3 --evidence 'typecheck + lint + test + build green; new tables + SDK + tests'
```

### #2 by "worker-1", 2026-05-09T17:32:12.272Z

```
FILES
  src/db.ts            : +5 CREATE TABLE blocks (archives, archived_tasks, archived_edges, archived_notes, archived_events) + 4 indexes; CURRENT_SCHEMA_VERSION 5\u21926; new MIN_ACCEPTED_SCHEMA_VERSION=5 floor; v5\u2192v6 in-place UPDATE in applySchema; EXPECTED_TABLES gains 5 new entries.
  src/archives.ts      : NEW (~735 LOC). Types: Archive, ArchiveSummary, ArchiveSourceSummary, ArchivedTaskRow, AddToArchiveResult, RemoveFromArchiveResult. SDK: createArchive / listArchives / getArchive / deleteArchive / addToArchive (idempotent at (archive, source_workstream) granularity) / removeFromArchive / listArchivedTasks. Errors: ArchiveNotFoundError, ArchiveAlreadyExistsError, ArchiveLabelInvalidError. Label rule: /^[a-z][a-z0-9_-]{0,63}$/ (wider than workstream-name).
  src/index.ts         : re-exports the 7 fns + 3 errors + 5 types + isValidArchiveLabel.
  src/logs.ts          : EVENT_VERB_PREFIXES gains 'archive create/delete/add/remove' (otherwise hud test guards regress).
  test/archives.test.ts: NEW (~359 LOC). 9 tests covering all 11 cases from task note. End-to-end round-trip is one big it() (cases 1\u20137); 4 unit cases (8, 9, validation, removeFromArchive no-op); 2 migration cases (case 10 v5\u2192v6 in-place; case 11 pre-v5 still throws SchemaTooOldError).
  test/db.test.ts      : EXPECTED_TABLES assertions extended (15 tables now, alphabetical); test name 'nine expected tables' \u2192 'expected tables (v6)'.
  test/cli-snapshot.test.ts: schemaVersion expectation bumped 5\u21926.
  CHANGELOG.md         : new v0.3.0 (unreleased) section with Schema + Added subsections.
  docs/VOCABULARY.md   : added 'archive', 'archived task', 'archive label' rows.
  docs/ARCHITECTURE.md : src/db.ts row updated (15 tables, schema v6); new src/archives.ts row added.
  scripts/grep-v4-references.allowlist: line-number drift in src/db.ts (CURRENT_SCHEMA_VERSION docstring grew); allowlist re-pinned.

COMMANDS
  npm install (no node_modules in worktree initially)
  npm run typecheck && npm run lint && npm run test && npm run build

FINDINGS
  - The task spec said scripts/grep-name-without-workstream.sh would fire for archives.label SELECTs; it does NOT, because the guard greps for local_id/slug/name only \u2014 archives.label slips past unflagged. No allowlist additions needed. (Verified by running the script after adding the new SDK file.)
  - The hud.test.ts EVENT_VERB_PREFIXES audit walks every emitEvent callsite; missing the new 'archive *' prefixes broke it on first run. Adding them to src/logs.ts EVENT_VERB_PREFIXES fixed it. Standard pattern; documented in the maintenance contract on that constant.
  - test/cli-snapshot.test.ts had a hard-coded schemaVersion=5 expectation. Bumped to 6.
  - The line-number based allowlist for grep-v4-references is brittle to additions in src/db.ts. Updated.

DECISION
  - Notes + events are ONLY copied when at least one new task was added for the (archive, source_workstream) pair. This is the load-bearing idempotency invariant from the task design note. Re-running addToArchive against an already-archived workstream is a true no-op (zero new tasks/notes/events); adding a new task to the source ws and re-running picks up only the new task's notes (existing tasks' notes untouched).
  - addToArchive runs in a single transaction so partial failure leaves the archive untouched.
  - removeFromArchive deletes archived_events EXPLICITLY (the cascade is from archives, not from archived_tasks; events are siblings of tasks at the archive level).
  - kept resolveWorkstreamId import in archives.ts; uses it to throw WorkstreamNotFoundError when the source ws is gone (case 8 in tests).
  - migration in applySchema is one extra UPDATE statement (UPDATE schema_version SET version=? WHERE id=1 AND version<?). Forward-only and idempotent.
  - Did NOT add a separate migrate-v5-to-v6 script; v6 is purely additive so the in-process path is safe (per task design note).

NEXT
  - Phase 2 (orchestrator): wire src/cli/archive.ts (commander glue), surface 'mu archive add/list/show/free/free-all', add HUD/--json rendering. Out of scope here.
  - Phase 3: hook addToArchive into destroyWorkstream ("--archive <label>" flag at destroy time).
  - Phase 4: extend exporter to render archive contents.

VERIFIED
  - npm run typecheck: clean.
  - npm run lint: clean (biome + grep guards).
  - npm run test: 884 tests passing across 34 files (9 new in test/archives.test.ts; 2 pre-existing fixed for v6 bump).
  - npm run build: ESM dist/cli.js + dist/index.js + dist/index.d.ts all green.

ODDITIES
  - Worktree had no node_modules on first cd (had to npm install).
  - Task note's claim about grep-name-without-workstream firing for archives.label was incorrect (no allowlist additions needed). The note was right about the principle (label is global, not per-ws) but the specific grep-guard doesn't catch it because 'label' isn't in its trigger token list. Worth flagging if the guard is ever generalised.
```
