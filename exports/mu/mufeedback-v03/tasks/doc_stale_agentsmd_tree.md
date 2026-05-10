---
id: "doc_stale_agentsmd_tree"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-4"
created_at: "2026-05-10T13:20:07.444Z"
updated_at: "2026-05-10T13:35:28.261Z"
blocked_by: []
blocks: []
---

# docs: AGENTS.md src/ tree lists removed src/cli/hud.ts + nonexistent src/migrations.ts; missing archive/exporting/importing/state/etc

## Notes (1)

### #1 by reviewer-3, 2026-05-10T13:20:20.613Z

```
FILES: AGENTS.md:73 (src/cli/hud.ts), AGENTS.md:65 (src/migrations.ts)
FINDING: AGENTS.md repo-tree block lists `src/cli/hud.ts` (REMOVED in merge_state_into_hud_render_mode — folded into src/cli/state.ts) and `src/migrations.ts` (does not exist — migration ladder was removed in schema_v5_drop_migrations_ts; src/db.ts is the only schema entrypoint). The cli/ subdir block is also out of date: missing `archive.ts`, `state.ts`, `format.ts`, `handle.ts`, plus the `src/cli/tasks/` sub-cluster. Root src/ block missing `archives.ts`, `exporting.ts`, `importing.ts`. Also `src/agents/` and `src/tasks/` sub-clusters (errors + spawn/adopt/lifecycle/wait files) absent.
WHY: AGENTS.md is the agent orientation file ("Read these first") — every coding agent loads this on day 0. Wrong tree = wrong mental map for every new agent in v0.3+.
FIX-SKETCH: rewrite the src/ tree block from `ls src src/cli src/cli/tasks src/agents src/tasks`. Drop hud.ts, migrations.ts; add state.ts, format.ts, handle.ts, archive.ts; add the tasks/ + agents/ subdirs (mirror docs/ARCHITECTURE.md row for src/cli/tasks/*.ts). Update test count from "17 test files; 443 tests" to current `find test -name "*.ts" | wc -l` = 60 files / ~57 .test.ts / ~996 it()/test() calls.
```
