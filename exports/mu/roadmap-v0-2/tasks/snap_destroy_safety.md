---
id: "snap_destroy_safety"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 80
effort_days: 0.4
roi: 200.00
owner: null
created_at: "2026-05-07T17:51:41.702Z"
updated_at: "2026-05-08T14:27:28.181Z"
blocked_by: ["snap_undo_verb"]
blocks: []
---

# Impl: mu workstream destroy --yes loses irreversibility — pre-snapshot or block undo across destroy

## Notes (1)

### #1 by "π - mu", 2026-05-08T14:27:28.083Z

```
FILES: src/cli.ts (cmdWorkstreamDestroy: dry-run, --yes, JSON paths)
DECISION: only edited the user-visible CTA + nextSteps; the underlying captureSnapshot in destroyWorkstream already shipped with snap_schema, so this task was purely the discoverability surface.
VERIFIED: smoke ran init smoke → destroy --yes → undo --yes round-trip clean; gate green at 704/704 + typecheck + lint + build.
SHIPPED: commit 4b7e36a on main.
```
