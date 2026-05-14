---
id: "tr_fast_tier_heavy_fs"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: null
created_at: "2026-05-14T09:51:19.130Z"
updated_at: "2026-05-14T10:08:27.554Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: filesystem-heavy sync tests are in fast tier

## Notes (3)

### #1 by "worker-2", 2026-05-14T09:51:19.422Z

```
FILE: test/db-sync-export.test.ts, test/db-sync-import.test.ts, test/db-sync-replay.test.ts, test/archive-restore.test.ts: file-moving export/import/replay/restore tests
WHAT'S MISSING/WRONG: The new db-sync/archive-restore suites are plain *.test.ts, so npm run test:fast will run VACUUM INTO exports, DB import replacement, snapshot capture, and real mu undo/restore flows. AGENTS.md explicitly reserves filesystem-heavy export/import/snapshot paths for *.integration.test.ts and keeps fast-tier pure/in-process with real SQLite only in temp DBs.
WHY IT MATTERS: The fast tier is the concurrency-safe dev loop. Putting multi-file export/import/snapshot flows there can slow or flake concurrent worker runs and erodes the fast/full test boundary the repo relies on.
SUGGESTED FIX: Split these suites: keep pure branch-classification/build-plan unit tests in *.test.ts, and move filesystem-heavy apply/export/undo/replay/archive-restore flows to *.integration.test.ts (or rename the whole file if all cases are heavy).
SEVERITY: high
```

### #2 by "π - mu", 2026-05-14T10:02:45.109Z

```
You are worker-1 in workstream `multimachine`. You have FOUR task claims:
  1. tr_fast_tier_heavy_fs       (HIGH severity — test tier discipline)
  2. tr_db_import_lossless_rows  (HIGH severity — content fidelity assertions)
  3. tr_sidecar_lossless_coverage (HIGH severity — sidecar park content assertions)
  4. tr_import_replaces_local_agents (MEDIUM — destination-side cleanup test)

These are bundled because they all touch test/db-sync-*.test.ts and would conflict if split across workers. Land them as ONE commit.

STEP 1 — read the orchestrator design context AND each finding's note:
  mu task notes umbrella -w multimachine
  mu task notes tr_fast_tier_heavy_fs -w multimachine
  mu task notes tr_db_import_lossless_rows -w multimachine
  mu task notes tr_sidecar_lossless_coverage -w multimachine
  mu task notes tr_import_replaces_local_agents -w multimachine

Each finding's note has FILE / WHAT'S MISSING / WHY IT MATTERS / SUGGESTED FIX. Treat the SUGGESTED FIX as the spec.

STEP 2 — read the existing tests + production code you'll touch:
  test/db-sync-export.test.ts
  test/db-sync-import.test.ts
  test/db-sync-replay.test.ts
  test/archive-restore.test.ts
  src/db-sync.ts        (for the importDb / replaceWorkstreamFromSource / parkLocalWorkstream signatures)

STEP 3 — implement the four fixes. Prefer keeping them tightly scoped; do NOT refactor unrelated tests.

  FIX 1 — tr_fast_tier_heavy_fs (RENAME / SPLIT to integration tier):
    AGENTS.md says the fast tier excludes filesystem-heavy export/import/snapshot flows. The four test files above all do real VACUUM INTO + DB-replace + snapshot-capture in the fast tier.
    - Split each file into pure plan/classification cases (stay in *.test.ts) vs apply/export/undo/replay flows (move to *.integration.test.ts).
    - Concretely: rename each file's heavy half to test/db-sync-{export,import,replay}.integration.test.ts and test/archive-restore.integration.test.ts. If a file is ENTIRELY heavy, just rename the whole file. If it has a clear split, keep classification/plan-shape unit tests in the *.test.ts file.
    - Verify post-rename: `npm run test:fast` no longer touches them; `npm run test` still does.

  FIX 2 — tr_db_import_lossless_rows (CONTENT FIDELITY assertions):
    Add a new test (or extend an existing one) in test/db-sync-import.integration.test.ts:
    - Seed source workstream with: tasks of varied status (OPEN, IN_PROGRESS, CLOSED, REJECTED, DEFERRED), varied impact (1, 50, 100), varied effort_days (0.1, 1.5, 30), notes with NULL author and non-NULL author, edges, controlled created_at/updated_at timestamps.
    - Apply IMPORT (clean dest) and FAST_FORWARD (existing-with-prior-sync dest).
    - Compare destination rows by local_id against source for: tasks (status, impact, effort_days, created_at, updated_at; owner_id intentionally NULL), edges, notes (content, author, created_at).
    - This is a property-style test: build a known fixture set on source, deep-equal subset against dest after import.

  FIX 3 — tr_sidecar_lossless_coverage (PARK FILE CONTENT assertions):
    In test/db-sync-import.integration.test.ts (or wherever the --force-source CONFLICT test lives):
    - Before --force-source, seed the local-divergent workstream with: a local-only note (different content from any source note), a local-only edge, a local-only agent_log entry, a workstream_sync row populated from a prior sync, a local agent row, a vcs_workspaces row.
    - After --force-source applies, openDb on the parked sidecar file and assert: the local-only note is present, the local-only edge is present, the local-only agent_log is present, the workstream_sync row is present, the local agent row is present, the vcs_workspaces row is present. (The whole point of "park before clobber" is forensic completeness.)
    - Also assert the LIVE destination has only the source winner — no leftover local agent or vcs_workspaces row for that workstream (this overlaps fix 4 but the live-side assertion belongs here too).

  FIX 4 — tr_import_replaces_local_agents (DEST-SIDE LOCAL CLEANUP on FAST_FORWARD/CONFLICT):
    Likely a behaviour bug if not already done. Check src/db-sync.ts replaceWorkstreamFromSource:
    - When replacing a workstream (FAST_FORWARD or --force-source CONFLICT), the destination's existing agents + vcs_workspaces rows for that workstream MUST be deleted as part of the tx (they're machine-local and the workstream is being wholesale replaced).
    - If the production code already does this, just add the test asserting it (a regression guard).
    - If the production code does NOT do this, add the DELETE in the same tx as the workstream replace, then add the test. NOTE: you ARE allowed to modify src/db-sync.ts for this one fix only — the bug is in the production code, the test would just expose it.
    - Test: seed a local workstream + add a destination agent row and a vcs_workspaces row for it. Apply FAST_FORWARD. Assert those rows are gone. Apply --force-source CONFLICT. Same.
    - Also seed an UNRELATED workstream's agent + vcs_workspaces row. Apply FAST_FORWARD on the first workstream. Assert the unrelated rows are untouched.

STEP 4 — clean up:
  npx biome check --write src test

STEP 5 — verify FAST GREENS + bundle smoke (workers run fast-tier only):
  npm run typecheck
  npm run lint
  npm run test:fast              # MUST be faster now (heavy tests moved out)
  npm run build
  node dist/cli.js --help        # bundle smoke

  Optional sanity (do NOT block on full suite — orchestrator handles): one-off run of an integration file you renamed:
    npm run test -- test/db-sync-import.integration.test.ts

STEP 6 — commit (single commit covering all four fixes):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'tests: db-sync test-tier discipline + content fidelity (review fix wave A)

- Move filesystem-heavy export/import/replay/restore flows to .integration.test.ts (fast tier was running VACUUM INTO + snapshots; AGENTS.md reserves these for integration tier).
- Add content-fidelity round-trip test: tasks (status/impact/effort/timestamps), notes (content/author/timestamp), edges all preserved through IMPORT + FAST_FORWARD.
- Enrich --force-source park test to assert sidecar contains local notes/edges/logs/sync row/agents/workspaces (forensic completeness).
- Assert FAST_FORWARD/CONFLICT delete dest-side local agents + vcs_workspaces for the replaced workstream (and leave unrelated workstreams untouched).

Closes tr_fast_tier_heavy_fs / tr_db_import_lossless_rows / tr_sidecar_lossless_coverage / tr_import_replaces_local_agents.'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, close ALL FOUR tasks, in this order, with the same commit sha:

  mu task close tr_fast_tier_heavy_fs -w multimachine --evidence '<sha> heavy tests moved to .integration.test.ts; fast tier no longer touches export/import/snapshot flows'
  mu task close tr_db_import_lossless_rows -w multimachine --evidence '<sha> content fidelity round-trip test added (status/impact/effort/timestamps/notes/edges)'
  mu task close tr_sidecar_lossless_coverage -w multimachine --evidence '<sha> sidecar contents asserted: notes/edges/logs/sync/agents/workspaces all preserved'
  mu task close tr_import_replaces_local_agents -w multimachine --evidence '<sha> FAST_FORWARD/CONFLICT delete dest-side local agents + vcs_workspaces for replaced ws; unrelated rows untouched'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (recreated; HEAD = 5c358ee remove_ws_import).
- ONE commit covering all four fixes (they all touch the same test surface).
- ESM, strict types, no `any`, no non-null assertions.
- No CHANGELOG, no docs files (deferred to docs_pass).
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT touch src/cli/db.ts or src/cli/handle.ts (worker-2 is in those for fix wave B).

COORDINATION WARNING
- worker-2 is in parallel on fix wave B (src/cli/db.ts nextStep fix + classifyError/nextSteps test extension). Different files; no conflict expected.
```

### #3 by "worker-1", 2026-05-14T10:08:27.554Z

```
CLOSE: 7bcccee heavy tests moved to .integration.test.ts; fast tier no longer touches export/import/snapshot flows
```
