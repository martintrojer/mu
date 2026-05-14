---
id: "docs_pass"
workstream: "multimachine"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-14T08:05:05.491Z"
updated_at: "2026-05-14T10:20:22.369Z"
blocked_by: ["remove_ws_import", "test_review"]
blocks: ["umbrella"]
---

# Docs: USAGE_GUIDE + VOCABULARY + ARCHITECTURE + SKILL.md + CHANGELOG

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:08:16.923Z

```
TASK
====
Comprehensive documentation pass for the multi-machine sync feature. All docs in one commit so vocab + verb table + skill + changelog stay synchronised.

PRECONDITION
============
db_import + db_replay + archive_restore + remove_ws_import all landed.

FILES TO UPDATE
===============
1. CHANGELOG.md (under [0.5.0] — unreleased; create the section if it doesn't exist):
   - Added: mu db export, mu db import, mu db replay, mu archive restore.
   - Added: schema v8 (machine_identity + workstream_sync).
   - Removed: mu workstream import.
   - Behaviour notes: bucket export is now read-only output.

2. docs/USAGE_GUIDE.md:
   - New section: "Multi-machine sync" between archives and snapshots, ~30 lines.
   - Workflow: ship DB file laptop → devserver, run `mu db import --apply`, work, ship back.
   - Hard rule (no concurrent edit per workstream) called out as a user contract.
   - Show the dry-run output and the sharp `--force-source` recovery.
   - Remove any mention of `mu workstream import`; point to `mu archive restore` for the un-archive case.
   - Update the "What's NOT in <version>" table accordingly.

3. docs/VOCABULARY.md:
   - Add: machine_id, divergence sidecar, db sync.
   - Add operations rows for mu db export / import / replay / archive restore.
   - Remove operations row for mu workstream import.

4. docs/ARCHITECTURE.md:
   - Add row(s) for src/db-sync.ts and src/cli/db.ts.
   - Update or remove src/importing.ts row as appropriate.
   - Add a brief paragraph in the "key seams" section about the cross-machine sync model.

5. skills/mu/SKILL.md:
   - Update the CLI overview to mention `mu db {export,import,replay}` and `mu archive restore`.
   - Drop `mu workstream import` from any examples.
   - Add a brief paragraph (~5 lines) on the multi-machine workflow under a new sub-heading.

6. AGENTS.md:
   - Schema bump: bump the "current schema version is **vN**" line to v8 in the "Update the schema" section.

7. docs/ROADMAP.md:
   - Move/mark the multi-machine sync entry as Shipped (per promotion criteria).

VERIFY
======
- npm run lint
- npm run typecheck
- npm run test:fast && npm run test
- npm run build
- Spot-read each doc; cross-references should still resolve.

⚠️ FINAL ACTION
==============
git commit -am 'docs: multi-machine sync — CHANGELOG + USAGE_GUIDE + VOCABULARY + ARCHITECTURE + SKILL + AGENTS' THEN
mu task close docs_pass -w multimachine --evidence '<sha> docs synchronised across 7 files'
```

### #2 by "π - mu", 2026-05-14T10:12:06.355Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you for `docs_pass`.

YOUR TASK: docs_pass — comprehensive docs sync for the multimachine sync feature.

This is the LAST task before umbrella closes. Doing it well matters: it's where the feature becomes discoverable to humans + future agents.

STEP 1 — read context end-to-end:
  mu task notes umbrella -w multimachine
  mu task notes docs_pass -w multimachine

The docs_pass task note has the full file checklist (CHANGELOG, USAGE_GUIDE, VOCABULARY, ARCHITECTURE, SKILL.md, AGENTS.md, ROADMAP.md).

STEP 2 — read the diff to understand what shipped:
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git log --oneline c84abc1..HEAD

  Commits to summarize in CHANGELOG:
  - 8fc4780 tui+task-tree: shorten DAG recurrence marker to dim '(↻)'           [unrelated tui polish, mention briefly]
  - 1a71b99 docs: ROADMAP entry — multi-machine sync                              [skip; already a docs commit]
  - e9ef316 schema: v8 — machine_identity + workstream_sync                       [Schema bump call-out]
  - c62d821 archive: mu archive restore — lossless un-archive                     [Added]
  - 6f8625c db: mu db export <file> — whole-DB SQLite copy + manifest             [Added]
  - 41a5e8b archive: help-text audit + test conversion                            [Behaviour: bucket export now read-only]
  - 5cf34ef db: mu db import <file> — drift detection + sharp --force-source     [Added]
  - 51a794e db: mu db replay <sidecar> — manual cherry-pick of parked state      [Added]
  - 5c358ee workstream: remove mu workstream import                              [Removed]
  - 015c040 cli+tests: db-sync nextStep + error inventory coverage               [polish]
  - 8c615e4 tests: db-sync test-tier discipline + content fidelity               [polish]

STEP 3 — DOCS WORK. Land all of this in ONE commit so vocab + verb table + skill + changelog stay synchronised.

  FILE 1 — CHANGELOG.md:
    Find or create the [0.5.0] — unreleased section. Add:
    ### Added
    - `mu db export <file>` — write the whole SQLite DB to <file> (VACUUM INTO) plus a `<file>.manifest.json` sidecar (machineId, schemaVersion, per-workstream latestSeq).
    - `mu db import <file>` — drift-detecting per-workstream merge from an exported DB. Dry-run by default; `--apply` commits. Five case branches (IDENTICAL / FAST_FORWARD / LOCAL_AHEAD / CONFLICT / IMPORT-on-clean). On CONFLICT, refuses by default; `--force-source` clobbers but parks the local divergent state to `<state-dir>/divergence/<ws>-<ts>.db` for later inspection.
    - `mu db replay <sidecar>` — manual cherry-pick of parked divergent state. Dry-run by default; `--task <id>` / `--all` apply. Idempotent; refuses on local_id collision with diverged content.
    - `mu archive restore <label> --as <new-ws> [--source <orig-ws>]` — lossless un-archive from `archived_*` tables directly. No bucket round-trip. Refuses if `--as` collides; auto-snapshots before writing.
    - Schema **v8**: `machine_identity` (one row per `~/.local/state/mu` DB; uuid + hostname seeded on first openDb), `workstream_sync` (per-workstream last-seen-peer-seq map for drift detection).
    ### Changed
    - Bucket exports (`mu workstream export`, `mu archive export`) are now READ-ONLY artifacts for humans / git / docs. The lossless un-archive path is `mu archive restore`; the cross-machine sync path is `mu db {export,import}`.
    - Help text on `mu archive export` and `mu archive add --destroy` now points to `mu archive restore` as the reverse-of-record.
    - Multi-line tasks/notes in TUI DAG popup: recurrence marker shortened to dim `(↻)` (was wordy English).
    ### Removed
    - `mu workstream import` — replaced by `mu db import` (cross-machine sync) and `mu archive restore` (un-archive). Removing the lossy bucket→DB round-trip is the whole point of the new typed surfaces. Removed `src/importing.ts` (~800 LOC).
    ### Known limitations
    - `mu db import` does NOT carry task owners (owner_id is an FK into the machine-local `agents` table). The hard rule for safe operation: no concurrent edits to the same workstream on two machines. Finish or release in-flight claims before `mu db export`. `mu agent list -w <ws>` shows current owners.
    - `mu archive restore` does not restore `agent_logs` (archives don't snapshot the live event log).

  FILE 2 — docs/USAGE_GUIDE.md:
    Add a new "Multi-machine sync" section between archives and snapshots, ~30-40 lines. Cover:
    - Use case: laptop ↔ devserver, multi-day stretches.
    - Hard rule (no concurrent same-workstream edits) called out as user contract.
    - Workflow:
        machine A:    mu db export ~/Dropbox/mu.db --force
                      # ship file (rsync / scp / Dropbox / git lfs / USB)
        machine B:    mu db import ~/Dropbox/mu.db          # dry-run preview
                      mu db import ~/Dropbox/mu.db --apply   # commits
    - Show example dry-run output table (workstream / decision / delta).
    - Show recovery from accidental concurrent edit: `--force-source` + park file + `mu db replay`.
    - Replace any existing "Cross-machine + collab" section that mentioned `mu workstream import`.
    - Update the "What's NOT in <version>" table accordingly (no longer "no cross-machine sync" — that's promoted).
    - Add a "Lossless un-archive" mention near archive section: `mu archive restore <label> --as <new-ws>`.

  FILE 3 — docs/VOCABULARY.md:
    - Add definitions:
      - `machine_id`: per-state-directory uuid seeded on first openDb. Identifies a mu DB across export/import.
      - `divergence sidecar`: SQLite file at `<state-dir>/divergence/<ws>-<ts>.db` parked by `mu db import --force-source` before clobbering local state.
      - `db sync`: the `mu db {export, import, replay}` cluster of verbs.
    - Add operations rows for `mu db export`, `mu db import`, `mu db replay`, `mu archive restore`.
    - Remove operations row for `mu workstream import`.
    - If "import" appeared as a generic verb tied to `mu workstream import`, redirect to the cluster of verbs that replaced it.

  FILE 4 — docs/ARCHITECTURE.md:
    - Add rows for src/db-sync.ts, src/db-sync-replay.ts, src/cli/db.ts, src/archives/restore.ts.
    - Update the src/archives.ts row to mention re-export of restore.
    - Verify src/importing.ts row is gone (it was deleted).
    - In the "key seams" section add ~5 lines on the cross-machine sync model: machine_identity + workstream_sync + per-workstream drift detection + sharp conflict + sidecar park.

  FILE 5 — skills/mu/SKILL.md:
    - In the CLI overview, add `mu db {export, import, replay}` and `mu archive restore`.
    - Drop `mu workstream import` from any examples.
    - Add a brief paragraph (~5-8 lines) on the multi-machine workflow under a new sub-heading like "Multi-machine workflow (laptop ↔ devserver)".
    - Mention the hard rule + the owner-drop limitation.

  FILE 6 — AGENTS.md:
    - In the "Update the schema" section, bump the "current schema version is **v7**" line to **v8**, mention the additive nature (machine_identity + workstream_sync are CREATE TABLE IF NOT EXISTS; openDb seed for machine_identity).

  FILE 7 — docs/ROADMAP.md:
    - Move/mark the "Multi-machine sync" entry as Shipped in v0.5.0 (or wherever shipped items go in the roadmap structure). Don't delete; leave a small line referencing the version it shipped in.

STEP 4 — clean up:
  npx biome check --write src test    # docs files don't need biome but it's safe to run

STEP 5 — verify:
  - Spot-read each doc; cross-references should still resolve.
  - npm run lint                       # in case any of the docs introduce things that fail lint (unlikely)
  - npm run typecheck                  # docs-only changes shouldn't affect this; sanity check
  - npm run test:fast                  # docs-only shouldn't affect this; sanity check

  Optional: rg -n "workstream import" docs/ skills/    # only historical/changelog mentions remain

STEP 6 — commit (single commit covering all 7 files):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'docs: multi-machine sync — CHANGELOG + USAGE_GUIDE + VOCABULARY + ARCHITECTURE + SKILL + AGENTS + ROADMAP'

⚠️ FINAL ACTION
==============
After commit + verify clean, run EXACTLY:

  mu task close docs_pass -w multimachine --evidence '<sha> docs synchronised across 7 files: CHANGELOG/USAGE_GUIDE/VOCABULARY/ARCHITECTURE/SKILL/AGENTS/ROADMAP'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (recreated; HEAD = 8c615e4 wave A).
- Single commit covering all docs.
- Be precise. Cross-doc consistency matters more than length here. If you say "5 case branches" in one place, say it the same way in all places.
- Do NOT introduce contradictions with the production code. If a flag name has changed, use the actual name.
- Biome auto-fix is fine on any non-doc file; never `--write --unsafe`.
```

### #3 by "worker-1", 2026-05-14T10:20:22.369Z

```
CLOSE: 940893a docs synchronised across 7 files: CHANGELOG/USAGE_GUIDE/VOCABULARY/ARCHITECTURE/SKILL/AGENTS/ROADMAP
```
