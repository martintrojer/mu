---
id: "archive_cleanup"
workstream: "multimachine"
status: CLOSED
impact: 50
effort_days: 0.25
roi: 200.00
owner: null
created_at: "2026-05-14T08:11:01.395Z"
updated_at: "2026-05-14T09:07:20.305Z"
blocked_by: ["archive_restore"]
blocks: ["code_review", "test_review"]
---

# Archive verb cleanup: help-text audit + round-trip test conversion (archive add → archive restore)

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:11:23.492Z

```
TASK
====
Now that `mu archive restore` exists as a lossless un-archive, audit the archive verb cluster + tests for stale assumptions about the old `archive export → workstream import` round-trip path.

PRECONDITION
============
archive_restore is closed and cherry-picked. (workstream import will be removed in a separate task — remove_ws_import. This task can land BEFORE that one as long as the restore SDK is available.)

WORK
====

1. AUDIT HELP TEXT in src/cli/archive.ts:
   - `archive export`: clarify in description that the bucket is a READ-ONLY artifact for humans/git/docs. The lossless un-archive path is `mu archive restore`, NOT `workstream import` of the bucket. Add this to the verb's long help.
   - `archive add --destroy`: mention `mu archive restore <label> --as <new>` as the reverse-of-record. The destroy path is no longer a one-way trip.
   - `archive remove`: nothing to change unless its help mentions round-tripping.
   - `archive list / show / search / export`: scan for any prose that points users at workstream import.

2. AUDIT TEST FIXTURES + INTEGRATION TESTS for the old round-trip:
   - Find every test that does `archive export → workstream import` (or `workstream export → workstream import` over an archive bucket).
   - Convert to `archive add → archive restore --as <new>` where the test's intent was "verify lossless un-archive".
   - Tests whose intent was "verify bucket markdown is human-readable" stay export-only.
   - Run the audit with: `rg -n "workstream import|importWorkstream" test/`

3. SDK EXPORT HYGIENE in src/cli/archive.ts and src/archives.ts:
   - Make sure `restore` is exported from src/index.ts re-exports next to add/remove/delete.
   - Group restore alongside add in the CLI verb declaration order so `archive --help` reads coherently (add, restore, remove, delete, ...).

4. NEXT-STEPS BLOCKS:
   - Anywhere `archive add --destroy` or `archive delete --yes` prints a Next: block, add a hint about `mu archive restore` as the recovery path.
   - Same for the WorkspacePreservedError-style error paths that mention archives.

OUT OF SCOPE
============
- Removing `mu workstream import` (that's remove_ws_import's job).
- Doc files in docs/ (handled by docs_pass).
- New behaviour beyond help text + test conversion + Next: hints.

VERIFY
======
- `rg -n "workstream import|importWorkstream" test/` after conversion should show only tests that ARE about the workstream-import path itself (and those will be deleted by remove_ws_import).
- `node dist/cli.js archive --help` lists restore and the help text reads coherently.
- `node dist/cli.js archive add --help` mentions restore as the reverse.
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build

⚠️ FINAL ACTION
==============
git commit -am 'archive: help-text audit + test conversion (archive add → archive restore)' THEN
mu task close archive_cleanup -w multimachine --evidence '<sha> N help-text touchups, M tests converted to archive restore'
```

### #2 by "π - mu", 2026-05-14T08:53:53.284Z

```
You are worker-2 in workstream `multimachine`. Claim is set on you for `archive_cleanup`.

YOUR TASK: archive_cleanup (small, low-risk, parallel to db_import)

STEP 1 — read all design context end-to-end before touching code:
  mu task notes umbrella -w multimachine
  mu task notes archive_cleanup -w multimachine
  mu task notes archive_restore -w multimachine    # the SDK + verb you'll be aligning help text with

The archive_cleanup task note is your spec.

STEP 2 — SCOPE: This is help-text + test-conversion work. NO new behaviour.

  WORK ITEM A — Help text in src/cli/archive.ts:
    - `archive export`: clarify in the verb description that the bucket is a READ-ONLY artifact for humans/git/docs. The lossless un-archive path is `mu archive restore`, NOT `mu workstream import` of the bucket.
    - `archive add --destroy`: mention `mu archive restore <label> --as <new>` as the reverse-of-record. The destroy path is no longer a one-way trip.
    - `archive list / show / search / remove / delete`: scan for any prose that points users at workstream import; replace with archive restore.

  WORK ITEM B — Test conversion:
    - `rg -n "workstream import|importWorkstream" test/` to find every test that exercised the old round-trip.
    - For each test whose INTENT was "verify lossless un-archive", convert from `archive export → workstream import` to `archive add → archive restore --as <new>`.
    - Tests whose INTENT was "verify bucket markdown is human-readable" stay as export-only assertions (don't touch).
    - Tests whose intent was specifically about workstream-import-from-bucket (and would be deleted by remove_ws_import anyway) — leave them alone, that's remove_ws_import's job.

  WORK ITEM C — Next-steps blocks:
    - Anywhere `archive add --destroy`, `archive delete --yes`, or `WorkspacePreservedError`-style next-steps mention recovery, add a hint about `mu archive restore` as the recovery path.

  WORK ITEM D — SDK export hygiene:
    - Verify `restoreArchive` is exported from src/index.ts re-exports next to add/remove/delete (it should be — but double-check).
    - Group restore alongside add in the CLI verb declaration order in src/cli/archive.ts so `mu archive --help` reads coherently (add, restore, remove, delete, ...).

STEP 3 — OUT OF SCOPE:
  - Removing `mu workstream import` (that's remove_ws_import's job; will land later).
  - Doc files in docs/ (handled by docs_pass).
  - New behaviour beyond help text + test conversion + next-steps hints.
  - Touching src/db-sync.ts or src/cli/db.ts (worker-1 is there).

STEP 4 — clean up:
  npx biome check --write src test

STEP 5 — verify ALL FOUR GREENS + bundle smoke:
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run test
  npm run build
  node dist/cli.js --help                      # bundle smoke; silent stderr = top-level await deadlock; see HANDOVER Gotcha 1
  node dist/cli.js archive --help              # restore listed near add
  node dist/cli.js archive add --help          # mentions restore as the reverse
  rg -n "workstream import|importWorkstream" test/   # only tests-about-the-import-itself remain

STEP 6 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2
  git add -A
  git commit -m 'archive: help-text audit + test conversion (archive add → archive restore)'

⚠️ FINAL ACTION
==============
After commit + 4-green verify clean, run EXACTLY:

  mu task close archive_cleanup -w multimachine --evidence '<sha> N help-text touchups, M tests converted to archive restore'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2 (just recreated; HEAD is fresh main = 6f8625c db_export)
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 100 net added across CLI + tests (most lines are help-text strings; conversions may delete lines on net).
- Single commit. No CHANGELOG, no docs/ files.
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT modify src/db-sync.ts, src/cli/db.ts, src/archives/restore.ts (recently landed).

COORDINATION WARNING
- worker-1 is in parallel on `db_import` (heavy work in src/db-sync.ts + src/cli/db.ts). NO file overlap with you.
- Both of you may modify src/cli/handle.ts (typed errors / next-steps lists). If conflict on cherry-pick, the orchestrator handles it — concat both halves.
```

### #3 by "worker-2", 2026-05-14T09:07:20.305Z

```
CLOSE: 5cbd6a2 8 help-text touchups, 1 test converted to archive restore
```
