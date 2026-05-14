---
id: "doc_stale_vision_namespaces_tables"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.1
roi: 350.00
owner: "worker-2"
created_at: "2026-05-10T13:22:41.228Z"
updated_at: "2026-05-10T13:35:01.136Z"
blocked_by: []
blocks: []
---

# docs: VISION.md "10 tables (schema v5) / three namespaces" pillar drifts

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:22:54.187Z

```
FILES: docs/VISION.md:140, :155, :186
FINDING: Pillar bullets cite stale numbers:
  (1) :140 "noUncheckedIndexedAccess has prevented … three namespaces" — three CLI namespaces is a v0.1-era count; today there are 8+ (workstream/agent/task/workspace/log/snapshot/archive/me/state/bare-mu/sql/doctor/undo/adopt). The point about strict TypeScript still holds; just drop the namespace count.
  (2) :155 "Iteration speed. ~60 typed verbs / 10 tables (schema v5)" — schema is v7; tables = 14 (8 core + 1 meta + 5 archive_*; approvals dropped). "10 tables (schema v5)" should become "14 tables (schema v7)".
  (3) :186 "the orchestrator can compose them (`mu workstream create`, `approve grant`, ...)" — `mu workstream create` is not a verb (its `mu workstream init`); `approve grant` was removed. Replace with two live examples (e.g. `mu workstream init`, `mu archive add --destroy`).
  Note: :400 in the rejected-pillars table already documents the approvals removal correctly, so the pillar narrative is internally consistent on the WHY but not on the verb list.
WHY: VISION is the load-bearing-pillars doc; AGENTS.md routes new agents through it on day 0. Outdated numbers undermine the credibility of the pillars they are supposed to support.
FIX-SKETCH: one-line bumps; numbers come from `wc -l src/db.ts` (CURRENT_SCHEMA_VERSION) + counting CREATE TABLE in src/db.ts.
```
