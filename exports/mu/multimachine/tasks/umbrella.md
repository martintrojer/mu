---
id: "umbrella"
workstream: "multimachine"
status: CLOSED
impact: 80
effort_days: 0.1
roi: 800.00
owner: null
created_at: "2026-05-14T08:04:48.645Z"
updated_at: "2026-05-14T10:31:38.231Z"
blocked_by: ["cr_db_import_nextstep_invalid", "docs_pass", "test_review", "tr_db_import_lossless_rows", "tr_db_sync_error_inventory", "tr_fast_tier_heavy_fs", "tr_import_replaces_local_agents", "tr_sidecar_lossless_coverage"]
blocks: []
---

# Multi-machine sync: db export/import + archive restore (umbrella)

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:05:45.461Z

```
GOAL
====
Enable a single user to work a workstream alternately on two machines (laptop ↔ devserver) over multi-day stretches by shipping the SQLite DB file between them. Lossless. Detects when the hard rule was broken (concurrent edits to the same workstream) and refuses by default; sharp --force-source clobbers but parks the loser to a sidecar so nothing is lost.

USE CASE
========
- Days/weeks at a time on machine A → ship DB → days/weeks on machine B.
- Hard rule the user agreed to: NEVER work the same workstream on both machines concurrently. Other workstreams may continue locally on both sides during those stretches.
- Pure markdown bucket round-trip is too lossy (no event log, drifts on re-import).

DESIGN OVERVIEW
===============
1. New verbs: `mu db export <file>` and `mu db import <file>`.
   - Export = SQLite copy + tiny manifest (machine_id, per-ws latestSeq, mu version, schema version).
   - Import = per-workstream drift detection (using machine_identity + workstream_sync tables) → fast-forward / refuse / require --force-source.
   - Sharp on conflict: refuse by default; --force-source clobbers the workstream BUT first dumps local divergent state to ~/.local/state/mu/divergence/<ws>-<ts>.db.
   - --dry-run is the default first behaviour; user passes --apply to commit.
2. New verb: `mu archive restore <label> --as <new-ws> [--source <orig-ws>]`.
   - Lossless un-archive directly from archived_* tables (no bucket round-trip).
   - Refuses if --as collides; auto-snapshot before.
3. Removed verb: `mu workstream import` (replaced by mu db import + mu archive restore).
4. Bucket export (mu workstream export, mu archive export) stays — read-only artifact for humans / git.
5. Schema v8: machine_identity (one row, picked once per ~/.local/state/mu) + workstream_sync (last seen peer seq map per workstream).

DIRECTIONAL VERB MAP (target state)
===================================
| direction                                    | verb                              |
|----------------------------------------------|-----------------------------------|
| workstream → archive                         | mu archive add (existing)         |
| archive → workstream                         | mu archive restore (NEW)          |
| workstream → bucket markdown (read-only)     | mu workstream export (existing)   |
| archive → bucket markdown (read-only)        | mu archive export (existing)      |
| db → file (whole-machine sync)               | mu db export (NEW)                |
| file → db (whole-machine sync)               | mu db import (NEW)                |

DAG ORDER (what blocks what)
============================
roadmap_entry → schema_v8 → db_export → db_import → db_replay
roadmap_entry → archive_restore
{db_import, archive_restore} → remove_ws_import
{db_import, db_replay, archive_restore, remove_ws_import} → docs_pass → umbrella

Two parallel tracks after roadmap_entry: (A) db sync chain (5 tasks), (B) archive_restore (1 task). They converge at remove_ws_import.

OPEN DECISIONS (resolved)
=========================
- Granularity of "source wins": WHOLE WORKSTREAM REPLACE (atomic, simple, aligns with hard rule).
- Best-effort import: SHARP (refuse → --force-source clobbers but parks loser to sidecar; no auto-merge).
- Bucket export/import: EXPORT-ONLY going forward; bucket becomes read-only artifact.
- Unarchive path: NEW first-class verb mu archive restore (no bucket round-trip).

NON-GOALS (anti-feature alignment)
==================================
- No live sync / watcher / daemon.
- No conflict UI.
- No row-level merge; whole-workstream replace only.
- No automatic re-application of parked sidecar state (manual cherry-pick via `mu db replay`).
- No remote backend; the user owns the transport (rsync/scp/syncthing/git-lfs).

PILLAR CHECK
============
- Pillar "small, typed, no daemons": holds. Schema bump is 2 tables, no new processes.
- Anti-feature pledge "no config file": holds. machine_id is auto-generated, persisted in DB.
- Anti-feature pledge "no anticipatory abstractions": holds. Two real concrete impls (export/import).
- Existing bucket substrate is preserved as read-only output, not load-bearing for round-trips.
```

### #2 by "π - mu", 2026-05-14T08:10:23.521Z

```
ADDENDUM: workstream PK across machines + clean-machine import
==============================================================
- We do NOT enforce identical workstreams.id PKs across machines. PKs are local autoincrement; the user-facing identity is workstreams.name (UNIQUE TEXT). Import is name-keyed (tasks rewired by local_id, edges by local_id pair). A workstream re-allocated to a different local id on the destination machine is observably indistinguishable.
- Clean-machine import (no priors): falls out for free. openDb() seeds machine_identity on first open. Every imported workstream falls in the "W only in source, not local → IMPORT (replace = create new)" branch with no possible conflict; workstream_sync rows are written with last_known_peer_seqs[source.machineId] = source_seq.

ADDENDUM: review gates added to DAG
===================================
After all impl tasks (db_import, db_replay, archive_restore, remove_ws_import) close, two parallel reviewers run:
  - code_review: reads the diff; files findings as cr_<slug> tasks; each blocks umbrella.
  - test_review: reads the test diff; files findings as tr_<slug> tasks; each blocks umbrella.
docs_pass blocks on both reviewers, AND on any cr_*/tr_* finding tasks (since they block umbrella, they also gate docs_pass via docs_pass → umbrella). Umbrella now has direct blockers: docs_pass + code_review + test_review (+ any review-finding tasks workers add at runtime).
```

### #3 by "π - mu", 2026-05-14T10:31:37.117Z

```
SESSION SUMMARY — multimachine sync feature SHIPPED
====================================================

11 commits shipped to origin/main this session (in order):

  8fc4780  tui+task-tree: shorten DAG recurrence marker to dim '(↻)'
  1a71b99  docs: ROADMAP entry — multi-machine sync (db export/import + archive restore)
  e9ef316  schema: v8 — machine_identity + workstream_sync (multi-machine sync substrate)
  c62d821  archive: mu archive restore — lossless un-archive (no bucket round-trip)
  6f8625c  db: mu db export <file> — whole-DB SQLite copy + manifest
  41a5e8b  archive: help-text audit + test conversion (archive add → archive restore)
  5cf34ef  db: mu db import <file> — drift detection + sharp --force-source with sidecar park
  51a794e  db: mu db replay <sidecar> — manual cherry-pick of parked divergent state
  5c358ee  workstream: remove mu workstream import (replaced by mu db import + mu archive restore)
  015c040  cli+tests: db-sync nextStep + error inventory coverage (review fix wave B)
  8c615e4  tests: db-sync test-tier discipline + content fidelity (review fix wave A)
  d917e54  tui: `l` shortcut shells out to lazygit from the Commits popup       [unrelated mid-session feature]
  ea8e545  docs: multi-machine sync — CHANGELOG + USAGE_GUIDE + VOCABULARY + ARCHITECTURE + SKILL + AGENTS + ROADMAP

FEATURES DELIVERED
==================
1. mu db export <file> + manifest sidecar (machine_id + per-ws latestSeq).
2. mu db import <file> with 5-branch drift detection (IDENTICAL / FAST_FORWARD / LOCAL_AHEAD / CONFLICT / IMPORT-on-clean), dry-run by default, sharp --force-source with sidecar park.
3. mu db replay <sidecar> for manual cherry-pick of parked divergent state.
4. mu archive restore <label> --as <new-ws> for lossless un-archive (no bucket round-trip).
5. Schema v8 — machine_identity (one-row uuid+hostname) + workstream_sync (per-ws drift state).
6. Removed mu workstream import (-1500 LOC). Bucket exports now read-only artifacts for humans/git/docs.
7. Help-text audit across archive verb cluster pointing to mu archive restore as the reverse-of-record.
8. (mid-session) `l` shortcut from Commits popup → lazygit; `(↻)` dim recurrence marker in DAG view.

REVIEWERS
=========
code_review filed 3 findings; test_review filed 5. Triage:
  REJECTED:
    - cr_import_owners_dropped: owner_id is FK into machine-local agents; design says agents not carried; hard rule = no live claims at ship time. Mitigated in docs.
    - cr_docs_stale_sync_surface: duplicate of docs_pass scope.
  ACCEPTED + FIXED in two waves:
    Wave A (worker-1, 1 commit): test-tier discipline (heavy → .integration.test.ts), content-fidelity round-trip, sidecar park content assertions, dest-side local cleanup on FAST_FORWARD/CONFLICT.
    Wave B (worker-2, 1 commit): nextStep --dry-run typo fix; classifyError + nextSteps inventory now scans db-sync + db-sync-replay.

TEST COUNTS (final)
===================
- Fast tier: 1408 passing (94 files) — 14s
- Full tier: 2478 passing (169 files) — ~110s
- Heavy db-sync export/import/replay/archive-restore flows correctly live in *.integration.test.ts now.

OPEN ITEMS
==========
- None directly blocking. Future enhancement (~10 LOC, no schema): on import, surface former owner of each task as a system note in the imported workstream — would let users know who held a claim at export time. Currently tracked only in this summary; promote if real friction surfaces.

DESIGN PRINCIPLES UPHELD
========================
- No daemon, no watcher, no live sync, no remote backend, no config file, no row-level merge — all anti-feature pledges intact.
- Schema additions are CREATE TABLE IF NOT EXISTS (no migration script needed).
- machine_id is generated and stored in SQLite, not configured.
- Conflict handling is sharp + whole-workstream: refuse, or --force-source after parking the loser sidecar.
- VOCABULARY updated before code where possible; final docs_pass synchronised everything.

ORCHESTRATOR LOOP IMPROVEMENTS
==============================
- Mid-session policy change: workers run fast-tier only (npm run test:fast) as their commit gate; orchestrator runs full tier + bundle smoke ONCE before push. Same safety property at push gate, ~2min saved per task. Updated in all dispatch prompts from db_replay onwards.

HEAD: ea8e545
```

### #4 by "π - mu", 2026-05-14T10:31:38.231Z

```
CLOSE: ea8e545 multimachine sync feature shipped: 13 commits, 1408 fast / 2478 full tests green, all 8 review findings resolved (6 fixed, 2 rejected with rationale)
```
