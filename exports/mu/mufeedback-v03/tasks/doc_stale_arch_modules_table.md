---
id: "doc_stale_arch_modules_table"
workstream: "mufeedback-v03"
status: CLOSED
impact: 55
effort_days: 0.3
roi: 183.33
owner: "worker-3"
created_at: "2026-05-10T13:20:24.858Z"
updated_at: "2026-05-10T13:52:00.447Z"
blocked_by: []
blocks: []
---

# docs: ARCHITECTURE.md module table — schema v6 (now v7); src/cli/hud.ts; src/cli/agents.ts comment; pi-extension/prompts/agents/ ghosts

## Notes (1)

### #1 by reviewer-3, 2026-05-10T13:20:46.191Z

```
FILES: docs/ARCHITECTURE.md:271-297, :329, :440-466
FINDING: Multiple drifts in the module table + appendix:
  (1) :271 "Flat src/ directory; ~12 files" — no longer flat. src/ now has src/agents/ and src/tasks/ subclusters; root has 18 .ts files. AGENTS.md already documents the cluster rule.
  (2) :276 src/db.ts row says "15 tables + 3 views, schema v6". CURRENT_SCHEMA_VERSION = 7 (src/db.ts:347); approvals table dropped → 14 tables. Update to "14 tables + 3 views, schema v7 — v6 archive_* additive layer plus v7 drop of approvals". Also "v5 → v6 in-place bump on open" should mention v6 → v7 (drops approvals via applySchema).
  (3) :286 src/archives.ts row says "Phase 1 SDK; CLI in Phase 2" — Phase 2/3/4 all SHIPPED (cli/archive.ts is 645 LOC; mu archive create/list/show/add/remove/delete/search/export are wired; CHANGELOG [Unreleased] confirms "feature complete (6 verbs + tests + docs)").
  (4) :290 src/snapshots.ts row says "schema v4" — snapshots table is carried into v5/v6/v7 unchanged; either drop the parenthetical or say "schema v4; carried forward".
  (5) :293 src/cli/*.ts list still includes `hud.ts` (REMOVED in merge_state_into_hud_render_mode — see CHANGELOG [Unreleased] Removed entry). It should list state.ts only and add archive.ts.
  (6) :329 "ship a one-shot migration script (the v4→v5 transition was the canonical example)" but v6 (additive) and v7 (DROP TABLE in applySchema) both happened in-place with no script — mention that two of the three post-v5 bumps were script-free (additive or destructive-via-applySchema).
  (7) :297 row "agents/ — Two builtin agent .md role docs" — directory does not exist in repo (`ls agents` fails). Same for :466 "skills/mu/SKILL.md, agents/*.md, prompts/*.md — bundled assets" and :464 "dist/pi-extension.js — pi extension entry" (no pi-extension entry in tsup.config.ts; tsup builds only index + cli).
WHY: ARCHITECTURE.md is the developer onboarding map. Stale schema version + ghost files send new contributors looking for code that doesnt exist.
FIX-SKETCH: regenerate the module table from `wc -l src/*.ts src/cli/*.ts src/cli/tasks/*.ts` + bump v6→v7, drop hud.ts, fix archives.ts to "feature complete", drop the "agents/" and "prompts/" + "pi-extension.js" rows.
```
