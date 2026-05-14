---
id: "db_export"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: null
created_at: "2026-05-14T08:05:03.811Z"
updated_at: "2026-05-14T08:47:25.100Z"
blocked_by: ["schema_v8"]
blocks: ["db_import"]
---

# mu db export <file>: whole-DB copy + manifest

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:06:34.578Z

```
TASK
====
Add `mu db export <file>` — produces a self-contained, importable copy of the entire mu DB plus a sidecar manifest.

WIRE
====
- New module: src/db-sync.ts (SDK for db export + import; will grow as db_import lands).
- New CLI verb namespace: src/cli/db.ts (commander wiring; one verb for now: export. Will add import + replay later).
- Wire into src/cli.ts buildProgram alongside other namespaces.

OUTPUT SHAPE
============
`mu db export ./mu-2026-05-14.db` produces:
  ./mu-2026-05-14.db                (SQLite copy via SQLite VACUUM INTO or a clean file copy if no in-flight tx)
  ./mu-2026-05-14.db.manifest.json  (small JSON sidecar)

MANIFEST FIELDS
===============
{
  "muVersion":      "0.4.0",
  "schemaVersion":  8,
  "machineId":      "<uuid from machine_identity>",
  "hostname":       "<advisory>",
  "exportedAt":     "<ISO>",
  "workstreams":    [
    { "name": "alpha", "tasks": 42, "edges": 17, "notes": 113, "latestSeq": 9821 },
    ...
  ]
}

DESIGN NOTES
============
- Use SQLite's `VACUUM INTO 'path'` to produce a clean, optimised copy in one statement. No locking concerns for a single-user CLI.
- The destination path is the user-chosen file; refuse to overwrite unless --force.
- workstreams[].latestSeq comes from `latestSeq(db, workstreamId)` — must be per-workstream not global.
- Print a textual card + Next steps (how to ship the file, how to import on the other side).
- `--json` for scripting.

CLI
===
mu db export <file> [--force]
  --force overwrite existing target

NO --workstream FLAG
====================
DB export is whole-machine by design. The user can selectively import with `mu db import --only-ws ...` later, but the export is always the whole DB.

TEST COVERAGE
=============
- Round-trip: export to temp file, open the exported file with openDb, assert task counts and a sample task's local_id match.
- Manifest parses, has correct schemaVersion + machineId.
- --force semantics.
- Export refuses without --force when target exists.
- Empty DB exports cleanly.

FILES
=====
- src/db-sync.ts            (new)
- src/cli/db.ts             (new)
- src/cli.ts                (wire namespace)
- src/index.ts              (re-export SDK)
- test/db-sync-export.test.ts (new)

CONSTRAINTS
===========
- ESM, strict types, no `any`.
- Use `handle()` wrapper in CLI for typed errors.
- Run `npx biome check --write src test` before committing.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
- node dist/cli.js db export /tmp/smoke.db --force
- node dist/cli.js db --help

⚠️ FINAL ACTION
==============
git commit -am 'db: mu db export <file> — whole-DB SQLite copy + manifest' THEN
mu task close db_export -w multimachine --evidence '<sha> src/db-sync.ts +N lines, src/cli/db.ts +N lines, tests pass'
```

### #2 by "π - mu", 2026-05-14T08:35:05.002Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `db_export`.

YOUR TASK: db_export

STEP 1 — read the design context end-to-end before touching code:
  mu task notes umbrella -w multimachine
  mu task notes db_export -w multimachine
  mu task notes schema_v8 -w multimachine        # for context on machine_identity / workstream_sync that just landed

The db_export task note is your spec. Schema v8 (machine_identity + workstream_sync) is now on main; you'll read machine_identity in your manifest output.

STEP 2 — read the existing pieces you'll touch or imitate:
  - src/db.ts — note machine_identity / workstream_sync rows; openDb signature.
  - src/snapshots/ — capture/restore patterns; you might NOT use the snapshot SDK, but the file-write atomicity pattern is similar.
  - src/cli/handle.ts — typed-error → exit code wrapper.
  - src/cli/snapshot.ts or src/cli/workstream.ts — examples of clean CLI verb files using commander + handle().
  - src/cli.ts — see how existing verb namespaces are wired in buildProgram (where to add `mu db`).
  - src/index.ts — the SDK re-export hub.
  - src/output.ts — printNextSteps / errorNextSteps for the textual card.

STEP 3 — implement per the task note. Summary:
  - New module src/db-sync.ts with `exportDb(db, file, opts)` SDK function.
  - New CLI namespace src/cli/db.ts with one verb for now: `mu db export <file> [--force] [--json]`.
  - Use SQLite's `VACUUM INTO 'path'` for the copy (one statement, clean & optimised; no locking concerns for single-user CLI).
  - Refuse to overwrite existing file unless --force; raise a typed error.
  - Write a sidecar manifest at `<file>.manifest.json`:
      { muVersion, schemaVersion, machineId, hostname, exportedAt,
        workstreams: [ { name, tasks, edges, notes, latestSeq } ] }
    `latestSeq` is per-workstream from `latestSeq(db, workstreamId)` (already in src/logs.ts).
  - NO --workstream flag; export is whole-machine by design.
  - Use handle() in CLI; return printable next-steps (how to ship the file + how to import on the other side).
  - Wire `db` namespace into src/cli.ts buildProgram.
  - Re-export exportDb from src/index.ts.

STEP 4 — tests in a new test/db-sync-export.test.ts:
  - Round-trip: export → openDb on the exported file → assert task counts, sample task local_id, workstream names, archived_tasks all match the source.
  - Manifest parses; has schemaVersion=8, valid machineId (uuid format), correct per-ws latestSeq, correct workstream count.
  - --force overwrites; without --force on existing target → DbExportTargetExistsError (or whatever you name it).
  - Empty DB exports cleanly (no workstreams); manifest has empty workstreams array.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify ALL FOUR GREENS + bundle smoke:
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run test
  npm run build
  node dist/cli.js --help              # bundle smoke; silent stderr = top-level await deadlock; see HANDOVER Gotcha 1
  node dist/cli.js db --help           # the new namespace must list export
  node dist/cli.js db export /tmp/smoke-export.db --force   # quick smoke against the real default DB

STEP 7 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'db: mu db export <file> — whole-DB SQLite copy + manifest'

⚠️ FINAL ACTION
==============
After commit + 4-green verify clean, run EXACTLY:

  mu task close db_export -w multimachine --evidence '<sha> src/db-sync.ts +N lines, src/cli/db.ts +N lines, all four greens, bundle smoke ok'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (just recreated; HEAD is fresh main = e9ef316 schema v8)
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 250 net added across SDK + CLI + tests.
- Single commit. No CHANGELOG, no docs files (deferred to docs_pass).
- Biome auto-fix is fine; never `--write --unsafe`.

COORDINATION WARNING
- worker-2 is in parallel on `archive_restore`. They're touching src/archives/* and src/cli/archive.ts. NO file overlap with you. Both modify src/index.ts and src/cli.ts as wiring points; if those conflict on cherry-pick, the orchestrator (me) handles it — concat both halves.
```

### #3 by "worker-1", 2026-05-14T08:47:25.100Z

```
CLOSE: 3219385 src/db-sync.ts +154 lines, src/cli/db.ts +55 lines, all four greens, bundle smoke ok
```
