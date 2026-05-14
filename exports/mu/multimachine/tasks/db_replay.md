---
id: "db_replay"
workstream: "multimachine"
status: CLOSED
impact: 50
effort_days: 0.75
roi: 66.67
owner: null
created_at: "2026-05-14T08:05:04.486Z"
updated_at: "2026-05-14T09:34:54.814Z"
blocked_by: ["db_import"]
blocks: ["remove_ws_import"]
---

# mu db replay <sidecar>: manual cherry-pick of parked divergent state

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:07:26.914Z

```
TASK
====
Add `mu db replay <sidecar>` — manual cherry-pick of state parked by `mu db import --force-source`.

CLI
===
mu db replay <sidecar-file> [--apply] [--task <id>...] [--note <task-id>...] [--all] [--json]

Default behaviour is dry-run (lists what's in the sidecar).

ALGORITHM
=========
A sidecar file is itself a single-workstream SQLite snapshot. The replay verb:

1. Reads the sidecar; identifies its source workstream W.
2. Verifies W exists in local DB (else error: "restore W first via mu db import or mu archive restore").
3. Lists local-only items in the sidecar relative to current local W:
   - Tasks present in sidecar but absent locally (by local_id).
   - Notes present in sidecar but absent locally (by content+timestamp tuple — local_id can collide so this needs a stable hash).
   - Edges present in sidecar but absent locally.
4. With no --task/--note flags + no --all: print the dry-run plan, no writes.
5. With --task <id>: re-add that task (and its notes + edges if both endpoints are local).
6. With --all: re-add every local-only item.

Edge cases:
- Sidecar task has same local_id as a current local task with DIFFERENT content → replay refuses for that id, prints both versions, suggests `mu task add` with a renamed id.
- Sidecar note already present (same content + timestamp) → skip silently.

NOTE ON SCOPE
=============
This is intentionally manual. We are NOT auto-merging. The user looks at the diff, picks what they want, replays it. This is the safety valve, not a workflow.

TEST COVERAGE
=============
- Replay --task adds a single task + its notes.
- Replay --all adds everything missing.
- Replay refuses on local_id collision with diverged content.
- Sidecar from a workstream that doesn't exist locally errors clearly.
- Idempotent: running replay twice on the same sidecar is a no-op the second time.

FILES
=====
- src/db-sync.ts            (extend)
- src/cli/db.ts             (extend)
- test/db-sync-replay.test.ts (new)

CONSTRAINTS
===========
- LOC: aim < 200 net added.
- ESM, strict types, no `any`.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
- node dist/cli.js db replay --help

⚠️ FINAL ACTION
==============
git commit -am 'db: mu db replay <sidecar> — manual cherry-pick of parked divergent state' THEN
mu task close db_replay -w multimachine --evidence '<sha> tests pass, idempotent + collision-safe'
```

### #2 by "π - mu", 2026-05-14T09:22:20.053Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `db_replay`.

YOUR TASK: db_replay

STEP 1 — read all design context end-to-end before touching code:
  mu task notes umbrella -w multimachine
  mu task notes db_replay -w multimachine
  mu task notes db_import -w multimachine    # the sidecar park format you'll be reading

The db_replay task note is your spec.

STEP 2 — read the existing pieces:
  - src/db-sync.ts — exportDb, importDb, parkLocalWorkstream (or whatever you named it). The sidecar file format is what you read.
  - src/cli/db.ts — current verbs: export, import. You add: replay.
  - src/cli/handle.ts — typed-error → exit-code map; you add 1-2 new error types.

STEP 3 — implement per the task note. Summary:

  CLI: `mu db replay <sidecar-file> [--apply] [--task <id>...] [--note <task-id>...] [--all] [--json]`
    - Default: dry-run (lists what's in the sidecar relative to current local state).
    - --task <id>: re-add that task (and its notes + edges if both endpoints are local).
    - --all: re-add every local-only item.

  ALGORITHM:
    1. openDb on the sidecar → identify its source workstream W (sidecar contains exactly one ws).
    2. Verify W exists in local DB; else error WorkstreamNotFoundError-style (suggest `mu db import` or `mu archive restore`).
    3. Compute local-only items in the sidecar relative to current local W:
       - Tasks present in sidecar but absent locally (by local_id).
       - Notes present in sidecar but absent locally (use a stable hash of (task_id, content, created_at) since notes have no natural primary key).
       - Edges present in sidecar but absent locally.
    4. With NO --task/--note/--all flags: print the dry-run plan, no writes.
    5. With --task <id>: re-add that task (preserve local_id, status, impact, effort, created_at) + its notes + its edges (only if both endpoints are present locally; if not, skip the edge with a warning).
    6. With --all: do the same for every local-only item.

  EDGE CASES:
    - Sidecar task has same local_id as a current local task with DIFFERENT content (different title or status) → replay refuses for that id, prints both versions, suggests user pass a renamed id (or skip).
    - Sidecar note already present (same hash) → skip silently.
    - Sidecar from a workstream that doesn't exist locally → clear error.

  AUTO-SNAPSHOT before any write (--apply with --task / --all).

  TYPED ERRORS:
    - DbReplayWorkstreamMissingError
    - DbReplayLocalIdConflictError (sidecar id collides with local id with different content)

STEP 4 — tests in a new test/db-sync-replay.test.ts:
  - Replay --task adds a single task + its notes + its eligible edges.
  - Replay --all adds everything missing.
  - Replay refuses on local_id collision with diverged content.
  - Sidecar from a workstream that doesn't exist locally errors clearly.
  - Idempotent: running replay twice on the same sidecar is a no-op the second time (since items are now present locally).
  - Edge with one missing endpoint is skipped (with warning), not errored.
  - Auto-snapshot recoverable.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify FAST GREENS + bundle smoke (NEW POLICY: workers run fast-tier only; orchestrator runs full suite at push gate):
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run build
  node dist/cli.js --help              # bundle smoke; silent stderr = top-level await deadlock; see HANDOVER Gotcha 1
  node dist/cli.js db replay --help    # verb wired
  node dist/cli.js db --help           # all 3 verbs listed (export, import, replay)

  (You do NOT need to run `npm run test` (full suite). The orchestrator runs it at the cherry-pick + push gate. This saves ~2min per task.)

STEP 7 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'db: mu db replay <sidecar> — manual cherry-pick of parked divergent state'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, run EXACTLY:

  mu task close db_replay -w multimachine --evidence '<sha> tests pass (fast tier), idempotent + collision-safe'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (just recreated; HEAD is fresh main = 5cf34ef db_import)
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 250 net added.
- Single commit. No CHANGELOG, no docs files.
- Biome auto-fix is fine; never `--write --unsafe`.
- src/db-sync.ts is already at 835 LOC (over the 800 refactor signal). It's OK to add ~150 more for replay; if you reach 1000 consider extracting parkLocalWorkstream into its own file (src/db-sync/park.ts), but only if it's a clean cut.
```

### #3 by "worker-1", 2026-05-14T09:34:46.488Z

```
FILES: src/db-sync-replay.ts; src/db-sync.ts; src/cli/db.ts; src/cli/handle.ts; src/index.ts; test/db-sync-replay.test.ts
COMMANDS: npx biome check --write src test; npm run lint; npm run typecheck; npm run test:fast; npm run build; node dist/cli.js --help; node dist/cli.js db replay --help; node dist/cli.js db --help
FINDINGS: Added sidecar replay planner/apply path, typed errors, CLI wiring, SDK exports, tests for task/all replay, conflicts, missing workstream, idempotency, skipped edges, undo recovery.
DECISION: Kept replay implementation in a small db-sync-replay module and re-exported through db-sync.ts to avoid growing db-sync.ts past the hard cap.
NEXT: orchestrator cherry-pick.
VERIFIED: fast tier 96 files / 1430 tests pass; build and help smoke pass with stderr_bytes=0.
ODDITIES: none
```

### #4 by "worker-1", 2026-05-14T09:34:54.814Z

```
CLOSE: eb7d5cb tests pass (fast tier), idempotent + collision-safe
```
