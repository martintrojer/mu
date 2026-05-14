---
id: "nit_task_list_sort_by_recency"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.3
roi: 83.33
owner: null
created_at: "2026-05-08T10:46:10.143Z"
updated_at: "2026-05-09T07:03:24.514Z"
blocked_by: []
blocks: []
---

# NIT: mu task list / next / ready could sort by recency (created_at / updated_at already in schema)

## Notes (2)

### #1 by "π - mu", 2026-05-08T10:46:10.273Z

```
USE CASE
"What did I touch most recently?" / "What's gone stale?" — neither is queryable from the typed list verbs today. The columns exist; the surfacing doesn't.

CURRENT STATE
- tasks.created_at and tasks.updated_at are populated correctly (ISO 8601, written by addTask/setTaskStatus/updateTask/etc).
- mu task show DOES display them.
- mu task list / next / ready do NOT show them and have no --sort flag.
- ROI is the only sort key; default is local_id ASC.

WORKAROUND
mu sql "SELECT local_id, status, datetime(updated_at, 'localtime') FROM tasks WHERE workstream='X' ORDER BY updated_at DESC LIMIT 10"

PROPOSED
1. Add a 'last' or 'updated' column to formatTaskListTable, abbreviated (e.g. "2h" / "3d" / "1w" relative). Maybe behind --show-time so default stays narrow.
2. Add --sort to mu task list (and maybe next/ready):
     --sort roi (default), recency, age, id
   Where recency = updated_at DESC, age = created_at ASC.
3. JSON shape unchanged (consumers can sort themselves; columns already there).

Optional bonus: --since '1d' / --since '2026-05-01' filter (server-side, cheap with the existing index).

ESTIMATE
~30 LOC + 4 tests. Promotion criterion: "what did I touch most recently / what's stale" surfaces ≥2 more times in real workflows. Filed during roadmap-v0-2 design pass.
```

### #2 by "worker-mf-1", 2026-05-09T07:03:22.642Z

```
Implemented in worker-mf-1 (commit b6585eb).

WHAT SHIPPED
- --sort <roi|recency|age|id> on mu task list / next / ready.
  Defaults: list -> id (preserves prior local_id order); next/ready -> roi.
- Under --sort recency / --sort age the table view gains a trailing
  'updated' / 'created' column with compact relative-time strings
  (12s / 5m / 3h / 2d / 2w). No separate --show-time flag — the user
  opts in by choosing a time-based sort.
- JSON shape unchanged: --sort only reorders rows. createdAt/updatedAt
  were already on every TaskRow.
- New SDK helpers: TASK_SORT_KEYS, parseSortOption, sortTasks,
  relTimeBasisForSort. relTime moved from src/cli/hud.ts to src/cli.ts
  (added 'Nw' bucket for stale tasks measured in weeks); hud.ts now
  imports it instead of defining its own.

TESTS
- test/tasks.test.ts: sortTasks across all four keys + non-mutation
  + parseSortOption (accept all keys, reject unknown) + relTime
  buckets (s/m/h/d/w + clock-skew clamp).
- test/json-output.test.ts: each verb x each key (recency, age, roi
  default, ready re-sorted) + table column toggle on/off across
  recency/age/default/roi + unknown-key error path + JSON shape
  invariant (no extra computed fields).

GATES (all green): typecheck, lint, test (758 passed), build.

DOCS
- skills/mu/SKILL.md verb list shows --sort and the relative-time column.
- docs/USAGE_GUIDE.md 'Prefer the typed verb' table gets a row for
  the 'most recent / stale' use case (no longer a mu sql workaround).
- docs/VOCABULARY.md adds a 'sort key' row.
- CHANGELOG.md [Unreleased] has an entry under Added.

OPTIONAL BONUS NOT SHIPPED (out of budget)
- --since <duration|date> filter. Defer-followup-worthy if real
  users hit it; current four sort keys cover the stated use case
  ('what did I touch most recently / what's gone stale').
```
