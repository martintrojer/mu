---
id: "doc_stale_omnibus_minor"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.2
roi: 125.00
owner: "worker-5"
created_at: "2026-05-10T13:23:38.601Z"
updated_at: "2026-05-10T13:52:17.199Z"
blocked_by: []
blocks: []
---

# docs: omnibus — small staleness nits across SKILL/USAGE_GUIDE/ROADMAP not worth their own task

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:23:59.527Z

```
FILES + FINDINGS (one-liners; pick up as polish):
  - skills/mu/SKILL.md:431-434 SQL escape-hatch table-count: lists "9 core tables" then enumerates 9 names INCLUDING `schema_version`, but `schema_version` is the meta table (src/db.ts comment block calls out 8 core + 1 meta). Either list 8 core + 1 meta separately, or accept the conflation but note it. Same paragraph correctly enumerates 5 archive tables.
  - docs/USAGE_GUIDE.md:13 "(`mu state` — default / `--hud` / `--mission` render modes)" header is correct — but :312 example still shows `mu hud` migration prose without flagging that the `mu hud` verb is REMOVED post-v0.3 (it shows the migration but doesnt say bare `mu hud` will exit 1 unknown command); a reader skimming the example might think both forms still work.
  - docs/USAGE_GUIDE.md:702-708 `--reopen` semantics described correctly here ("force OPEN from CLOSED/REJECTED/DEFERRED") — confirms VOCABULARY.md:151 is right and SKILL.md:183/287/408 are the lagging ones.
  - docs/ROADMAP.md:181 "snapshots table + auto-snapshot before mutation — SHIPPED in v0.2 (schema v4; tables carried into v5)" should add "v6/v7 carry forward unchanged".
  - docs/ROADMAP.md:267 "Schema normalization — SHIPPED in v0.2 (schema v5)" — fine but the doc never mentions v6 (archive_*) or v7 (drop approvals) elsewhere; a "post-v5 evolution" line would help.
  - docs/ARCHITECTURE.md:28 ASCII box has an `eval/` panel that does not exist in src/. (Cosmetic; the box is illustrative, not literal.)
  - docs/ARCHITECTURE.md:413 references "Every public SDK function that takes such a name also" — sentence is fine but the row at :297 already documents `agents/` directory which doesnt exist (covered in doc_stale_arch_modules_table).
  - docs/USAGE_GUIDE.md:160 "`mu task list`, `mu task next`, and `mu approve list`" — covered in doc_stale_usage_guide_v02.
  - skills/mu/SKILL.md:350 `mu state [-w X[,Y]... | -w X -w Y | --all] [--hud | --mission] [--json]` — correct; no fix needed (just logging that this section IS up-to-date).
WHY: Each is too small for its own task but worth noting in one batch; closer to copy-edit than refactor.
FIX-SKETCH: trivial line edits per item.
```
