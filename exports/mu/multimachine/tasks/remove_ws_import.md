---
id: "remove_ws_import"
workstream: "multimachine"
status: CLOSED
impact: 50
effort_days: 0.25
roi: 200.00
owner: null
created_at: "2026-05-14T08:05:05.166Z"
updated_at: "2026-05-14T09:43:06.188Z"
blocked_by: ["archive_restore", "db_replay"]
blocks: ["code_review", "docs_pass", "test_review"]
---

# Remove mu workstream import (replaced by mu db import + mu archive restore)

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:07:58.860Z

```
TASK
====
Remove `mu workstream import`. Replaced by `mu db import` (machine-machine sync) and `mu archive restore` (un-archive). Bucket exports become read-only artifacts.

PRECONDITION
============
db_import + archive_restore must be landed and tested first.

WORK
====
1. Drop the `mu workstream import` CLI verb from src/cli/workstream.ts.
2. Drop the SDK function importWorkstream from src/workstream.ts (and src/importing.ts if importing.ts becomes empty, delete the file).
3. Update src/index.ts re-exports.
4. Tests: delete or rewrite any tests that exercised the import path.
   - Many round-trip tests currently do export → import; convert them to export-only assertions OR rewrite to use mu db export → mu db import.
5. ARCHITECTURE.md: remove the importing.ts row if the file is gone.

DOCS DEFERRED
=============
Full doc pass (USAGE_GUIDE, VOCABULARY, SKILL.md, CHANGELOG) lives in docs_pass. Just keep ARCHITECTURE.md in sync here since we may delete a row.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
- `node dist/cli.js workstream --help` no longer lists `import`
- `node dist/cli.js workstream import` errors with unknown subcommand

⚠️ FINAL ACTION
==============
git commit -am 'workstream: remove mu workstream import (replaced by mu db import + mu archive restore)' THEN
mu task close remove_ws_import -w multimachine --evidence '<sha> verb removed, importing.ts gone if empty, all tests pass'
```

### #2 by "π - mu", 2026-05-14T09:37:33.841Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `remove_ws_import`.

YOUR TASK: remove_ws_import — remove the now-redundant `mu workstream import` verb.

PRECONDITION CHECK
==================
- mu db import landed (5cf34ef).
- mu db replay landed (51a794e).
- mu archive restore landed (c62d821).
- archive_cleanup converted lossless-un-archive intent tests already (41a5e8b).

So `mu workstream import` is redundant for both use cases.

STEP 1 — read context end-to-end:
  mu task notes umbrella -w multimachine
  mu task notes remove_ws_import -w multimachine
  mu task notes archive_cleanup -w multimachine

STEP 2 — read what you're removing:
  - src/cli/workstream.ts — find the `import` subcommand.
  - src/workstream.ts and src/importing.ts — find importWorkstream + supporting code.
  - src/index.ts — re-exports.
  - docs/ARCHITECTURE.md — find the importing.ts row.

STEP 3 — work:

  WORK ITEM A — Drop the CLI verb:
    - In src/cli/workstream.ts, remove the `import` subcommand wiring entirely.

  WORK ITEM B — Drop the SDK function:
    - In src/workstream.ts, remove importWorkstream (and any helpers used only by it).
    - In src/importing.ts, if the file becomes empty (or all its public exports are unused after removal), delete the file.
    - In src/index.ts, drop the importWorkstream re-export and any orphaned related re-exports.

  WORK ITEM C — Tests:
    - `rg -n "workstream import|importWorkstream|cmdWorkstreamImport" test/` to find tests that exercised this path.
    - Delete any test file (or test cases) whose entire intent was "verify workstream import works" — those tests no longer have anything to test.
    - Tests that incidentally referenced `workstream import` in unrelated assertions (e.g. help-text-sorted tests): update assertions to match the post-removal verb list.

  WORK ITEM D — ARCHITECTURE.md:
    - If src/importing.ts is gone, remove its row from the module table.
    - If you kept a stub, update the row to reflect what's left.

  WORK ITEM E — Verify the workstream namespace still has its other verbs:
    - `node dist/cli.js workstream --help` should list init / list / destroy / export (no longer import).
    - `node dist/cli.js workstream import` should error with "unknown subcommand".

OUT OF SCOPE
============
- Full doc pass (CHANGELOG, USAGE_GUIDE, VOCABULARY, SKILL.md) — that's docs_pass's job.
- Removing `mu archive add --destroy --bucket-import-target` style flags if any (unlikely to exist).
- Adding any new verbs.

STEP 4 — clean up:
  npx biome check --write src test

STEP 5 — verify FAST GREENS + bundle smoke (workers run fast-tier only; orchestrator runs full at push):
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run build
  node dist/cli.js --help
  node dist/cli.js workstream --help                       # no `import` listed
  node dist/cli.js workstream import 2>&1 | head -5         # errors
  rg -n "importWorkstream|workstream import" src/ test/    # no leftovers (modulo any "workstream import" in CHANGELOG history strings, which is fine; deferred to docs_pass)

STEP 6 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'workstream: remove mu workstream import (replaced by mu db import + mu archive restore)'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, run EXACTLY:

  mu task close remove_ws_import -w multimachine --evidence '<sha> verb removed, importing.ts gone if empty, fast tier passes'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (just recreated; HEAD is fresh main = 51a794e db_replay)
- ESM, strict types, no `any`, no non-null assertions.
- Single commit.
- Biome auto-fix is fine; never `--write --unsafe`.
```

### #3 by "worker-1", 2026-05-14T09:43:06.188Z

```
CLOSE: 50532dd verb removed, importing.ts gone if empty, fast tier passes
```
