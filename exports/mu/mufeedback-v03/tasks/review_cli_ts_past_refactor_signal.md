---
id: "review_cli_ts_past_refactor_signal"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.5
roi: 70.00
owner: null
created_at: "2026-05-10T11:38:33.138Z"
updated_at: "2026-05-10T12:44:07.708Z"
blocked_by: []
blocks: []
---

# review: src/cli.ts at 1318 LOC well past 800-LOC refactor signal

## Notes (1)

### #1 by "reviewer-1", 2026-05-10T11:38:33.240Z

```
FILES: src/cli.ts (1318 LOC); src/cli/state.ts (914); src/tasks.ts (1115); src/archives.ts (940); src/importing.ts (823); src/tmux.ts (807)

FINDING: Six files exceed the 800-LOC refactor signal in AGENTS.md. The wire-out v0.3 refactor moved verb impls into src/cli/* but src/cli.ts still hosts ~1318 LOC of: error mapping (~150), output helpers (~600 — formatAgentsTable, formatTaskListTable, formatWorkspacesTable, formatTracks, etc.), workstream resolution + parseQualifiedRef helpers (~150), table-renderers, NextStep glue. The output helpers in particular (table renderers) feel like they belong next to muTable in src/output.ts or in a sibling src/cli/format.ts.

WHY: AGENTS.md "refactor signal at 800; hard cap 1500". cli.ts is still everyone's import hub and adding new shared helpers worsens the import-fan-in. cli/state.ts is also bloated (914 LOC; includes hud + mission + full + JSON shaping + 6 hud table formatters) and would benefit from extracting hud/* into a sibling file.

FIX-SKETCH: 1) Move every `format*Table` + truncate/relTime/colorStatus into src/cli/format.ts (pure rendering); cli.ts re-exports for back-compat. ~600 LOC out. 2) Move classifyError + emitError + handle into src/cli/handle.ts. ~150 LOC out. 3) Split cli/state.ts hud renderers into cli/state/hud.ts. ~400 LOC out.

DONT-FIX: Don't pre-emptively split tasks.ts/archives.ts/tmux.ts/importing.ts — they're cohesive; the warning sign is just "watch for further bloat".
```
