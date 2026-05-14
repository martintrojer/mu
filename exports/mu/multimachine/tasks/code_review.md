---
id: "code_review"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: null
created_at: "2026-05-14T08:09:01.438Z"
updated_at: "2026-05-14T09:56:39.654Z"
blocked_by: ["archive_cleanup", "remove_ws_import"]
blocks: []
---

# Code review: db-sync + archive-restore (file findings as new blockers of umbrella)

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:09:35.656Z

```
TASK
====
Read the diff for the multi-machine sync feature (schema_v8 → db_export → db_import → db_replay → archive_restore → remove_ws_import). File every actionable finding as a NEW task in this workstream and block the umbrella with it. Do NOT fix anything yourself; you are a reviewer.

PRECONDITION
============
All impl tasks (db_import, db_replay, archive_restore, remove_ws_import) closed and cherry-picked onto main. The orchestrator will claim this task only after that.

SCOPE OF REVIEW
===============
- src/db.ts schema additions (machine_identity, workstream_sync).
- src/db-sync.ts (export, import, replay logic).
- src/cli/db.ts (verb wiring, --apply / --force-source / --dry-run defaults).
- src/archives/restore.ts (or wherever restore landed).
- src/cli/archive.ts changes for restore.
- src/cli/workstream.ts removal of import.
- src/index.ts re-export hygiene.

WHAT TO LOOK FOR
================
Use the code-reviewer skill mental model:
- Dead code, duplication, non-idiomatic patterns.
- Error types: are typed errors mapped to distinct exit codes via handle()? No untyped throws.
- Transaction boundaries: every multi-table mutation should be in one tx.
- noUncheckedIndexedAccess discipline: no unsafe array indexing.
- No `any`, no non-null assertions.
- LOC caps respected (1500 hard / 800 refactor signal per AGENTS.md).
- Cluster discipline: src/db-sync.ts under 800 LOC; src/cli/db.ts thin.
- Anti-feature pledges respected: no daemon, no config, no row-level merge in import.
- `--workstream` flag handling on db verbs (should be machine-wide; no per-ws scoping).
- File copy correctness: VACUUM INTO vs raw copy with WAL — was the right primitive picked?
- Auto-snapshot wired before every destructive write.
- Error messages include nextSteps blocks per repo convention.
- Bucket export untouched (it's now read-only output; no unintended changes).

SIDECAR-PARK CHECKS
===================
- Does parking handle the case where the divergence dir doesn't exist yet? Should mkdir -p.
- Sidecar filename collision (same-second runs)? Should include a unique suffix.
- Does park happen BEFORE the destructive replace, in a way that's atomic-enough that a crash mid-import doesn't lose data?

DRIFT-DETECTION CHECKS
======================
- Is the per-machine seq map keyed correctly (source.machineId, not local)?
- Clean-machine import (W only in source, no local rows): does it short-circuit straight to IMPORT, not CONFLICT?
- Workstream that exists locally but not in source: untouched? (cross-workstream collateral protection).

OUTPUT
======
For each finding:
1. `mu task add cr_<short_slug> -w multimachine --title "Code review: <one-line finding>" --impact <n> --effort-days <d>`
2. `mu task note cr_<short_slug> -w multimachine "<full finding: file/line, what's wrong, suggested fix, severity>"`
3. `mu task block umbrella --by cr_<short_slug> -w multimachine`

If you find ZERO actionable issues, drop a note on this task documenting what you reviewed and why nothing fired, then close.

CONSTRAINTS
===========
- Do NOT edit production code. Reviewers read; the umbrella's blocker tasks are how fixes get done.
- Do NOT close this task until you have either filed findings (and blocked umbrella) or documented a clean review.
- Use the code-reviewer skill if you have it loaded.

VERIFY
======
- All filed finding-tasks block umbrella.
- This task's note section lists the files reviewed.

⚠️ FINAL ACTION
==============
mu task note code_review -w multimachine "FILES: <list>
FINDINGS: <count>, <comma-separated cr_ ids>
VERDICT: <ship/block>"
mu task close code_review -w multimachine --evidence 'reviewed N files, filed M finding tasks (cr_*)'
```

### #2 by "π - mu", 2026-05-14T09:46:30.203Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `code_review`.

YOUR TASK: code_review — review the full multimachine sync feature diff. File findings as NEW tasks (cr_<slug>) that block the umbrella. Do NOT fix anything yourself; you are a reviewer.

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w multimachine
  mu task notes code_review -w multimachine

The code_review task note has the full review checklist (typed errors / tx boundaries / noUncheckedIndexedAccess / LOC caps / anti-feature pledges / sidecar-park atomicity / drift detection correctness / clean-machine import / cross-workstream collateral protection / etc).

STEP 2 — read the diff — these are the commits since the start of this work:
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git log --oneline c84abc1..HEAD
  git diff c84abc1..HEAD --stat
  git diff c84abc1..HEAD -- src/db.ts
  git diff c84abc1..HEAD -- src/db-sync.ts
  git diff c84abc1..HEAD -- src/db-sync-replay.ts
  git diff c84abc1..HEAD -- src/cli/db.ts
  git diff c84abc1..HEAD -- src/archives/restore.ts
  git diff c84abc1..HEAD -- src/cli/archive.ts
  git diff c84abc1..HEAD -- src/cli/handle.ts
  git diff c84abc1..HEAD -- src/cli/workstream.ts

  (Read the diff per-file; don't try to ingest the whole thing in one shot.)

STEP 3 — apply the code_review checklist. For each ACTIONABLE finding:

  mu task add cr_<short_slug> -w multimachine \
    --title "Code review: <one-line finding>" \
    --impact <50-80> --effort-days <0.1-0.5>

  mu task note cr_<short_slug> -w multimachine "FILE: <path>:<line>
WHAT'S WRONG: <description>
WHY IT MATTERS: <impact>
SUGGESTED FIX: <concrete change>
SEVERITY: <high/medium/low>"

  mu task block umbrella --by cr_<short_slug> -w multimachine

THINGS WORTH SPECIFICALLY CHECKING (NOT EXHAUSTIVE; use full checklist in your task note):
  - src/db-sync.ts is 849 LOC — over the 800 refactor signal. Is the file legitimately one cohesive cluster, or is there a clean cut into src/db-sync/{plan,execute,park}.ts?
  - Sidecar park atomicity: does parkLocalWorkstream complete BEFORE the destructive replace begins? If process dies between park and replace, are we OK?
  - Drift detection: is the per-machine seq map keyed by source.machineId (not local)? Test the algorithm against the 5 case branches mentally.
  - Clean-machine import: does an empty local DB import without error? The IMPORT branch should fire, not CONFLICT. Does the local machine_identity row stay intact (NOT overwritten by source's identity)?
  - Cross-workstream collateral: workstream existing locally but not in source — left alone after import?
  - All multi-table writes wrapped in a transaction?
  - Typed errors mapped to distinct exit codes via handle()?
  - No `any`, no `!`, no unsafe array indexing?
  - Anti-feature pledges respected: no daemon, no config, no row-level merge in import?

If you find ZERO actionable issues, drop a note on this task documenting what you reviewed and why nothing fired, then close.

STEP 4 — verify your filed-findings:
  mu task tree umbrella -w multimachine    # all your cr_* tasks should appear as blockers of umbrella

STEP 5 — final note + close:
  mu task note code_review -w multimachine "FILES REVIEWED:
- src/db.ts
- src/db-sync.ts
- src/db-sync-replay.ts
- src/cli/db.ts
- src/archives/restore.ts
- src/cli/archive.ts
- src/cli/handle.ts
- src/cli/workstream.ts
- src/index.ts
- (any others touched in c84abc1..HEAD)

FINDINGS: <count>, <comma-separated cr_ ids>
VERDICT: <ship-with-fixes | ship-clean | block-on-major-issue>"

⚠️ FINAL ACTION
==============
mu task close code_review -w multimachine --evidence 'reviewed N files, filed M finding tasks (cr_*)'

CONSTRAINTS
- DO NOT EDIT PRODUCTION CODE. You are a reviewer. Filed findings are how fixes get done.
- DO NOT COMMIT ANYTHING in this task. The reviewer task itself produces no commits — only new mu tasks + notes.
- DO NOT close until findings filed (and umbrella blocked) OR clean-review note dropped.
- If you have the code-reviewer skill loaded, USE IT.
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (recreated; HEAD = 5c358ee remove_ws_import).

COORDINATION WARNING
- worker-2 is in parallel on test_review (test diff). Different review surface. No file-touch from either of you, so no conflict.
```

### #3 by "worker-1", 2026-05-14T09:56:36.625Z

```
FILES REVIEWED:
- src/db.ts
- src/db-sync.ts
- src/db-sync-replay.ts
- src/cli/db.ts
- src/archives/restore.ts
- src/cli/archive.ts
- src/cli/handle.ts
- src/cli/workstream.ts
- src/index.ts
- src/archives.ts
- src/workstream.ts
- src/logs.ts
- src/cli.ts
- src/agents/errors.ts
- docs/ROADMAP.md
- docs/ARCHITECTURE.md
- docs/USAGE_GUIDE.md
- docs/VOCABULARY.md
- CHANGELOG.md

FINDINGS: 3, cr_import_owners_dropped, cr_docs_stale_sync_surface, cr_db_import_nextstep_invalid
VERDICT: ship-with-fixes
```

### #4 by "worker-1", 2026-05-14T09:56:39.654Z

```
CLOSE: reviewed 18 files, filed 3 finding tasks (cr_import_owners_dropped, cr_docs_stale_sync_surface, cr_db_import_nextstep_invalid)
```
