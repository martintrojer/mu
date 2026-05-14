---
id: "roadmap_entry"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.25
roi: 280.00
owner: null
created_at: "2026-05-14T08:05:03.174Z"
updated_at: "2026-05-14T08:18:02.359Z"
blocked_by: []
blocks: ["archive_restore", "schema_v8"]
---

# ROADMAP entry: multi-machine sync (db export/import + archive restore + workstream import removal)

## Notes (3)

### #1 by "π - mu", 2026-05-14T08:05:57.370Z

```
TASK
====
Write a ROADMAP.md entry for "Multi-machine sync (mu db export/import)" that:
- Articulates the problem clearly (single user, two machines, hard rule = no concurrent edit per workstream).
- Lays out the proposed verbs (db export, db import, db replay, archive restore) and the workstream import removal.
- Lists promotion criteria per the repo convention (real-user friction count ≥ 2, fits substrate, < 300 LOC for at least one subset).
- Calls out anti-feature alignment explicitly (no daemon, no config, no live sync, no row-level merge).
- Notes the schema v8 bump.

WHY ROADMAP FIRST
=================
AGENTS.md and ROADMAP.md both require new features to land in ROADMAP.md before code, with promotion criteria. This task is the first gate.

FILES
=====
- docs/ROADMAP.md          (add new entry; check existing structure for tone)

REFERENCE
=========
- See `mu task notes umbrella -w multimachine` for the full design context.

OUT OF SCOPE
============
- No code changes.
- No CHANGELOG entry yet (deferred to docs_pass).

VERIFY
======
- `npm run lint` clean (no markdown-related rules but be safe).
- Diff is < 80 lines added.

⚠️ FINAL ACTION
==============
git commit -am 'docs: ROADMAP entry — multi-machine sync (db export/import + archive restore)' THEN
mu task close roadmap_entry -w multimachine --evidence '<sha> docs/ROADMAP.md +N lines'
```

### #2 by "π - mu", 2026-05-14T08:13:50.332Z

```
You are worker-1 in workstream `multimachine`. Claim is already set on you.

YOUR TASK: roadmap_entry

  Add a ROADMAP.md entry for "Multi-machine sync (mu db export/import + archive restore)" — DOCS ONLY, NO CODE.

STEP 1 — read the full design context (this is critical, don't skip):
  mu task notes umbrella -w multimachine
  mu task notes roadmap_entry -w multimachine

The umbrella note has the full design (verbs, schema, anti-feature alignment, directional verb table). The roadmap_entry note has your specific scope.

STEP 2 — read the existing ROADMAP shape so your entry matches tone + structure:
  Read docs/ROADMAP.md end-to-end. Note the per-item structure (problem, sketch, promotion criteria, anti-feature alignment).

STEP 3 — write the entry.
  - Single new section, slotted in the appropriate place (probably "next" / unreleased tier).
  - Cover: problem, sketch (the directional verb table from the umbrella note IS the sketch — copy it), promotion criteria (≥2 user friction events / fits substrate / <300 LOC for a subset), anti-feature alignment (no daemon, no config, no live sync, no row-level merge), schema bump call-out (v8 = machine_identity + workstream_sync).
  - Be small. Aim for 60-80 lines added.
  - DO NOT touch CHANGELOG.md or any other doc — that's docs_pass's job.

STEP 4 — commit:
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add docs/ROADMAP.md
  git commit -m 'docs: ROADMAP entry — multi-machine sync (db export/import + archive restore)'

STEP 5 — verify:
  npm run lint
  (typecheck/tests not strictly needed for a docs-only commit, but run `npm run typecheck` anyway for hygiene.)

⚠️ FINAL ACTION
==============
After commit + verify clean, run EXACTLY:

  mu task close roadmap_entry -w multimachine --evidence '<sha> docs/ROADMAP.md +N lines'

Skipping `mu task close` will hang the orchestrator's wait. Do it as your literal last action.

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
- Single file change: docs/ROADMAP.md
- Single commit
- No CHANGELOG, no other docs (deferred to docs_pass)
```

### #3 by "worker-1", 2026-05-14T08:18:02.359Z

```
CLOSE: 7814bfd docs/ROADMAP.md +73 lines
```
