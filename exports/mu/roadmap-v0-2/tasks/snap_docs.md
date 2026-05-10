---
id: "snap_docs"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-07T17:51:41.907Z"
updated_at: "2026-05-08T14:27:28.382Z"
blocked_by: ["snap_undo_verb"]
blocks: []
---

# Docs: snapshots in CHANGELOG + ROADMAP move to shipped + SKILL undo pattern

## Notes (1)

### #1 by π - mu, 2026-05-08T14:27:28.283Z

```
FILES: docs/USAGE_GUIDE.md, docs/ROADMAP.md, skills/mu/SKILL.md, docs/VOCABULARY.md, README.md, CHANGELOG.md
DECISION: kept SKILL.md terse per skills convention (verb-list block + 4-line workstream-destroy + 1-clause irreversible + 6-line recover-from-destructive); USAGE_GUIDE got the worked examples; ROADMAP got the design rationale.
VERIFIED: typecheck + lint + 704/704 + build all clean (docs-only change but ran the gate anyway).
SHIPPED: commit 8afe300 on main.
```
