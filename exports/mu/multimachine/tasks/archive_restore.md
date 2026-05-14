---
id: "archive_restore"
workstream: "multimachine"
status: CLOSED
impact: 65
effort_days: 0.75
roi: 86.67
owner: null
created_at: "2026-05-14T08:05:04.854Z"
updated_at: "2026-05-14T08:46:11.641Z"
blocked_by: ["roadmap_entry"]
blocks: ["archive_cleanup", "remove_ws_import"]
---

# mu archive restore <label> --as <new-ws>: lossless un-archive (no bucket round-trip)

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:07:46.283Z

```
TASK
====
Add `mu archive restore <label> --as <new-ws-name> [--source <orig-ws-name>]` — lossless un-archive directly from archived_* tables. No bucket round-trip.

WHY
===
Today the only way to "un-archive" is `mu archive export → mu workstream import`, which loses the event log + notes drift. Adding a first-class restore verb removes that lossy path AND lets us delete `mu workstream import`.

CLI
===
mu archive restore <label> --as <new-ws-name> [--source <orig-ws-name>] [--json]

- <label>: existing archive bucket label.
- --as: name of the new workstream to create. Refuses if the name already exists.
- --source: required only when the archive contains multiple source workstreams (most do). When omitted with multiple sources, error lists available --source values.
- Auto-snapshot before any write.

ALGORITHM
=========
1. Resolve archive (label) → fetch archived_tasks + archived_edges + archived_notes for the chosen source.
2. Verify --as workstream does not exist; else error WorkstreamExistsError.
3. In one tx:
   - createWorkstream(--as)
   - insert tasks (preserve original local_id; created_at/updated_at preserved; status preserved)
   - insert task_edges (rewire by local_id pair)
   - insert task_notes (preserve created_at + author)
4. Optionally emit a system event into agent_logs noting the restore.

WHAT WE DON'T RESTORE
=====================
- agents rows (machine-local, irrelevant)
- workspace_path (machine-local)
- agent_logs (archives don't snapshot the live event log; this is a known limitation we surface in --help)

INTERACTION WITH LIVE ARCHIVE
=============================
- Original archive entry untouched. `restore` is non-destructive read.

TEST COVERAGE
=============
- Restore from a single-source archive without --source.
- Restore from a multi-source archive without --source → clear error.
- Restore from multi-source archive with --source → success.
- --as collision with existing workstream → WorkstreamExistsError.
- Round-trip property: `mu archive add → mu archive restore --as <new>` produces a workstream with same task count + edge count + note count + same local_ids + same statuses.
- Auto-snapshot recoverable.

FILES
=====
- src/archives.ts (or src/archives/restore.ts new) — SDK
- src/cli/archive.ts                                — CLI verb
- test/archive-restore.test.ts                      — coverage

CONSTRAINTS
===========
- LOC: < 200 net added in archives cluster.
- ESM, strict types, no `any`.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
- node dist/cli.js archive restore --help
- Manual smoke: archive add an existing ws, restore --as, diff `mu task list`.

⚠️ FINAL ACTION
==============
git commit -am 'archive: mu archive restore — lossless un-archive (no bucket round-trip)' THEN
mu task close archive_restore -w multimachine --evidence '<sha> tests pass, round-trip property green'
```

### #2 by "π - mu", 2026-05-14T08:22:10.413Z

```
You are worker-2 in workstream `multimachine`. Claim is set on you for `archive_restore`.

YOUR TASK: archive_restore

STEP 1 — read the design context end-to-end before touching code:
  mu task notes umbrella -w multimachine
  mu task notes archive_restore -w multimachine

The archive_restore task note is your spec. The umbrella note has the broader feature design (why this verb exists, how it relates to db_import + remove_ws_import).

STEP 2 — read the existing archive cluster:
  - src/archives.ts (hub)
  - src/archives/{addremove,core,delete,query}.ts
  - src/cli/archive.ts (current verbs: add, create, delete, export, list, remove, search, show)
  - src/exporting.ts (for the archive export rendering, just to understand the data shape — DO NOT MODIFY)
  - src/db.ts (look at archived_tasks, archived_edges, archived_notes table shapes)

STEP 3 — implement per the task note. Summary:
  - New SDK function `restoreArchive(db, label, asWorkstream, opts)` in a new file src/archives/restore.ts (or extend an existing file in src/archives/ if cleaner). Re-export via src/archives.ts.
  - New CLI verb `mu archive restore <label> --as <new-ws-name> [--source <orig-ws-name>] [--json]` in src/cli/archive.ts. Use handle() wrapper for typed errors.
  - Algorithm in one tx:
    1. Resolve archive (label) → list its source workstreams.
    2. If multiple sources and --source omitted → error with the available source names.
    3. Verify --as workstream does not exist → else WorkstreamExistsError.
    4. createWorkstream(asWorkstream).
    5. Insert tasks (preserve original local_id, status, created_at, updated_at, impact, effort_days).
    6. Insert task_edges (rewire by local_id pair into the new workstream's task ids).
    7. Insert task_notes (preserve created_at, author, content).
    8. Auto-snapshot before any write.
  - DO NOT carry agents, workspace_path, or agent_logs (archives don't snapshot live event log; surface this in --help).
  - Add typed error classes as needed (WorkstreamExistsError likely exists; ArchiveSourceAmbiguousError or similar may be new).

STEP 4 — tests in a new test/archive-restore.test.ts:
  - Restore from single-source archive without --source: success.
  - Restore from multi-source archive without --source: clear error listing available sources.
  - Restore from multi-source archive with --source: success.
  - --as collision with existing ws: WorkstreamExistsError.
  - Round-trip property: `mu archive add → mu archive restore --as <new>` → new ws has identical task count, edge count, note count, same local_ids, same statuses.
  - Auto-snapshot recoverable: restore then `mu undo --yes` returns to pre-restore state.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify ALL FOUR GREENS + bundle smoke:
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run test
  npm run build
  node dist/cli.js --help    # bundle smoke
  node dist/cli.js archive restore --help   # verify the verb is wired

STEP 7 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2
  git add -A
  git commit -m 'archive: mu archive restore — lossless un-archive (no bucket round-trip)'

⚠️ FINAL ACTION
==============
After commit + 4-green verify clean, run EXACTLY:

  mu task close archive_restore -w multimachine --evidence '<sha> src/archives/restore.ts +N lines, round-trip property green'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2 (fresh from current main: c84abc1 → 1a71b99 (ROADMAP entry))
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 200 net added across SDK + CLI.
- Single commit. No CHANGELOG, no docs files (deferred to docs_pass).
- Biome auto-fix is fine; never `--write --unsafe`.

COORDINATION WARNING
- worker-1 is in parallel on `schema_v8`. Different files (src/db.ts vs src/archives/*). No overlap, no merge conflict expected.
- DO NOT modify src/db.ts schema; you should be calling existing archived_* tables only.
```

### #3 by "worker-2", 2026-05-14T08:46:11.641Z

```
CLOSE: 5725c44 src/archives/restore.ts +150 lines, round-trip property green
```
