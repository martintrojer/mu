---
id: "test_review"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: null
created_at: "2026-05-14T08:09:01.741Z"
updated_at: "2026-05-14T09:51:30.457Z"
blocked_by: ["archive_cleanup", "remove_ws_import"]
blocks: ["docs_pass", "umbrella"]
---

# Test review: db-sync + archive-restore (file findings as new blockers of umbrella)

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:09:57.716Z

```
TASK
====
Read the test diff for the multi-machine sync feature. File every test-quality concern as a NEW task in this workstream and block the umbrella with it. Do NOT add new tests yourself; you are a reviewer.

PRECONDITION
============
All impl tasks closed and cherry-picked onto main. Orchestrator claims after that.

SCOPE OF REVIEW
===============
- test/db.test.ts (schema_v8 additions)
- test/db-sync-export.test.ts
- test/db-sync-import.test.ts
- test/db-sync-replay.test.ts
- test/archive-restore.test.ts
- Any deleted-or-rewritten tests caused by removing mu workstream import.

WHAT TO LOOK FOR
================
Use the test-reviewer skill mental model — false confidence is the enemy:
- Behavioural coverage vs implementation coverage. Are tests asserting OBSERVABLE outcomes (returned objects, DB state, exit codes, stderr nextSteps), or just checking internal field plumbing?
- Excessive mocking: anything that mocks the SDK functions under test is suspect.
- Meaningless assertions: `expect(x).toBeDefined()` after a function obviously returns; `expect(arr.length).toBeGreaterThan(0)` without checking content.
- Edge cases for db_import's 5 case branches (IDENTICAL, FAST_FORWARD, LOCAL_AHEAD, CONFLICT, IMPORT-on-clean): is each tested with a positive AND negative assertion?
- Schema-version mismatch (both directions) explicitly tested?
- agents-row-dropped-on-import explicitly asserted?
- Cross-workstream collateral (local-only ws untouched after import) explicitly asserted?
- workstream_sync row state asserted post-apply (not just task counts)?
- Auto-snapshot recoverability tested via real `mu undo`, not by asserting a snapshot was created?
- Round-trip property test for archive_restore (counts + ids + statuses match) present and meaningful?
- Concurrency-safety: do tests use unique temp DBs / unique session names per AGENTS.md?
- Fast-tier vs integration-tier discipline: heavy filesystem flows in *.integration.test.ts, not the fast tier?
- Sleeps > 50ms in fast-tier? Reject.

OUTPUT
======
Same as code_review:
1. `mu task add tr_<short_slug> -w multimachine --title "Test review: <one-line finding>" --impact <n> --effort-days <d>`
2. `mu task note tr_<short_slug> -w multimachine "<full finding: file/test name, what's missing or wrong, suggested fix>"`
3. `mu task block umbrella --by tr_<short_slug> -w multimachine`

Clean review = note + close.

CONSTRAINTS
===========
- Do NOT edit tests yourself.
- Do NOT close until findings filed (and umbrella blocked) or clean-review note dropped.
- Use the test-reviewer skill if loaded.

⚠️ FINAL ACTION
==============
mu task note test_review -w multimachine "FILES: <list>
FINDINGS: <count>, <comma-separated tr_ ids>
VERDICT: <ship/block>"
mu task close test_review -w multimachine --evidence 'reviewed N test files, filed M finding tasks (tr_*)'
```

### #2 by "π - mu", 2026-05-14T09:46:30.496Z

```
You are worker-2 in workstream `multimachine`. Claim is set on you for `test_review`.

YOUR TASK: test_review — review the full multimachine sync feature TEST diff. File findings as NEW tasks (tr_<slug>) that block the umbrella. Do NOT add tests yourself; you are a reviewer.

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w multimachine
  mu task notes test_review -w multimachine

The test_review task note has the full review checklist (false-confidence patterns / behavioural-vs-implementation coverage / edge case completeness for db_import 5-branch algorithm / etc).

STEP 2 — read the test diff — only test files since the start of this work:
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2
  git log --oneline c84abc1..HEAD
  git diff c84abc1..HEAD -- test/db.test.ts
  git diff c84abc1..HEAD -- test/db-sync-export.test.ts
  git diff c84abc1..HEAD -- test/db-sync-import.test.ts
  git diff c84abc1..HEAD -- test/db-sync-replay.test.ts
  git diff c84abc1..HEAD -- test/archive-restore.test.ts
  git diff c84abc1..HEAD -- test/archive-cli.integration.test.ts
  git diff c84abc1..HEAD -- test/cli-help-sorted.test.ts
  git diff c84abc1..HEAD -- test/cli-classify-error.test.ts
  git diff c84abc1..HEAD -- test/error-nextsteps.test.ts

  Plus: any test files DELETED by remove_ws_import — check git log --diff-filter=D for those.

STEP 3 — apply the test_review checklist. For each ACTIONABLE finding:

  mu task add tr_<short_slug> -w multimachine \
    --title "Test review: <one-line finding>" \
    --impact <50-80> --effort-days <0.1-0.5>

  mu task note tr_<short_slug> -w multimachine "FILE: <test file>:<test name>
WHAT'S MISSING/WRONG: <description>
WHY IT MATTERS: <what bug could escape>
SUGGESTED FIX: <concrete test case to add or change>
SEVERITY: <high/medium/low>"

  mu task block umbrella --by tr_<short_slug> -w multimachine

THINGS WORTH SPECIFICALLY CHECKING (NOT EXHAUSTIVE; full checklist in your task note):
  - db_import has FIVE case branches (IDENTICAL, FAST_FORWARD, LOCAL_AHEAD, CONFLICT, IMPORT-on-clean). Each tested with a positive AND negative assertion?
  - Cross-workstream collateral protection: explicit test that workstream W exists locally + not in source → left alone after import?
  - workstream_sync row state asserted post-apply (not just task counts)?
  - Schema-version mismatch (BOTH directions) tested?
  - Auto-snapshot recoverability tested via real `mu undo`, not just by asserting a snapshot was created?
  - agents-row-dropped-on-import explicitly asserted?
  - Sidecar park file is a valid SQLite that openDb can read?
  - Round-trip property test for archive_restore (counts + ids + statuses match)?
  - Idempotency: db_replay run twice on same sidecar = no-op second time?
  - Local_id collision with diverged content: db_replay refuses?
  - Tests use unique temp DBs / unique session names per AGENTS.md?
  - Fast-tier vs integration-tier discipline: heavy filesystem flows in *.integration.test.ts, not the fast tier?
  - No fixed sleeps > 50ms in fast tier?
  - Excessive mocking? Mocking the SDK functions under test is a smell.

If you find ZERO actionable issues, drop a note + close.

STEP 4 — verify your filed-findings appear in the umbrella tree:
  mu task tree umbrella -w multimachine

STEP 5 — final note + close:
  mu task note test_review -w multimachine "TEST FILES REVIEWED:
- test/db.test.ts (schema_v8 additions)
- test/db-sync-export.test.ts
- test/db-sync-import.test.ts
- test/db-sync-replay.test.ts
- test/archive-restore.test.ts
- test/archive-cli.integration.test.ts (touched by archive_cleanup)
- test/cli-help-sorted.test.ts
- test/cli-classify-error.test.ts
- test/error-nextsteps.test.ts
- (deleted: test/importing.integration.test.ts and any other ws-import-only tests)

FINDINGS: <count>, <comma-separated tr_ ids>
VERDICT: <ship-with-fixes | ship-clean | block-on-major-issue>"

⚠️ FINAL ACTION
==============
mu task close test_review -w multimachine --evidence 'reviewed N test files, filed M finding tasks (tr_*)'

CONSTRAINTS
- DO NOT EDIT TEST OR PRODUCTION CODE. You are a reviewer.
- DO NOT COMMIT ANYTHING in this task. The reviewer task itself produces no commits — only new mu tasks + notes.
- DO NOT close until findings filed OR clean-review note dropped.
- If you have the test-reviewer skill loaded, USE IT.
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-2 (recreated; HEAD = 5c358ee remove_ws_import).

COORDINATION WARNING
- worker-1 is in parallel on code_review (production-code diff). Different review surface. No file-touch from either of you, so no conflict.
```

### #3 by "worker-2", 2026-05-14T09:51:30.147Z

```
TEST FILES REVIEWED:
- test/db.test.ts (schema_v8 additions)
- test/db-sync-export.test.ts
- test/db-sync-import.test.ts
- test/db-sync-replay.test.ts
- test/archive-restore.test.ts
- test/archive-cli.integration.test.ts (touched by archive_cleanup)
- test/cli-help-sorted.test.ts
- test/cli-classify-error.test.ts
- test/error-nextsteps.test.ts
- test/cli-snapshot.integration.test.ts (schema-version touch)
- test/state-render.integration.test.ts (workstream import removal touch)
- (deleted: test/importing.integration.test.ts)

FINDINGS: 5, tr_fast_tier_heavy_fs, tr_db_import_lossless_rows, tr_sidecar_lossless_coverage, tr_db_sync_error_inventory, tr_import_replaces_local_agents
VERDICT: ship-with-fixes
```

### #4 by "worker-2", 2026-05-14T09:51:30.457Z

```
CLOSE: reviewed 12 test files, filed 5 finding tasks (tr_*)
```
