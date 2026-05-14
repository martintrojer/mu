---
id: "task_list_multi_status_union"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.15
roi: 233.33
owner: null
created_at: "2026-05-10T07:24:24.756Z"
updated_at: "2026-05-10T08:12:04.099Z"
blocked_by: []
blocks: []
---

# feat: mu task list --status accepts multi (repeat or comma-separate); returns the union

## Notes (2)

### #1 by "π - mu", 2026-05-10T07:25:02.789Z

```
mu task list --status accepts multi; returns the union.

═══ THE FRICTION ═══

Today: --status takes ONE value (OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED). Common operator queries:

  - "show me everything that's still actionable": OPEN ∪ IN_PROGRESS
  - "show me everything that's done one way or another": CLOSED ∪ REJECTED ∪ DEFERRED
  - "show me everything except CLOSED": OPEN ∪ IN_PROGRESS ∪ REJECTED ∪ DEFERRED

Per-call workaround today is N invocations or `mu sql`. Both wasteful for what should be one flag.

═══ THE TARGET SHAPE ═══

Per cli_audit_plurality_uniformity convention (already shipped):
  --status OPEN                              # single (today's behavior)
  --status OPEN,IN_PROGRESS                  # CSV (NEW)
  --status OPEN --status IN_PROGRESS         # repeat (NEW)
  --status OPEN,CLOSED --status REJECTED     # mixed (NEW)
Result: union of the listed statuses. Empty/missing --status: today's "no filter" behavior unchanged.

═══ MECHANICS ═══

1. Change the option declaration in src/cli/tasks/wire.ts:71:
     .option("--status <status...>", "filter by lifecycle status (OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED; case-insensitive; repeat or comma-separate; or both)")
2. In the handler (src/cli/tasks/list.ts or wherever cmdTaskList lives), read opts.status as `string[] | undefined`, run through parseCsvFlag (already on main; import from src/cli.ts), then validate each value via parseStatusOption (existing helper; one call per array element). Result: TaskStatus[] (deduped).
3. SDK in src/tasks.ts (or wherever listTasks lives): extend listTasks() to accept an OPTIONAL `statuses?: TaskStatus[]` (or extend the existing options bag). When provided, query becomes `WHERE status IN (?, ?, ...)` (parameterized). When absent: today's no-filter query.
4. CLI handler passes the parsed TaskStatus[] to the SDK.

═══ EDGE CASES ═══

  - --status with one entry: behaves identically to today (back-compat byte-for-byte).
  - --status with N>1 entries: WHERE IN parameterised; returned in the existing sort order (--sort still applies).
  - Duplicate values (--status OPEN --status open): dedup case-insensitively (parseStatusOption normalises to upper); pass through Set.
  - Invalid status in the list: existing parseStatusOption error path; report which element failed.
  - --status '' or whitespace only: parseCsvFlag drops empties; if the resulting array is empty, treat as no filter (matches today's "no --status given" behavior).

═══ CARRY THE PATTERN TO OTHER --status USES? ═══

Survey:
  - mu task list --status              ← THIS task: promote to multi.
  - mu task next --status              ← src/cli/tasks/wire.ts:408. SAME shape, same friction. Promote in the SAME PR (~10 LOC delta).
  - mu approve list --status           ← src/cli/approve.ts:283. SAME shape (filter on a status enum). Promote in the SAME PR.
  - mu task wait --status              ← single-value semantically (the wait target IS one status; "wait until any of these" is a different feature scoped out elsewhere). DON'T promote; carve-out documented in note.

So the promote scope is THREE flag declarations + the SDK signatures behind them. Worth it: one consistent pattern across every --status.

═══ SCOPE ESTIMATE ═══

  src/cli/tasks/wire.ts: 2 option-decl line changes (list + next).
  src/cli/approve.ts: 1 option-decl line change.
  src/cli/tasks/list.ts (or wherever cmdTaskList is): handler reads array, dedups, passes to SDK.
  src/cli/tasks/next.ts: same.
  src/cli/approve.ts handler: same.
  src/tasks.ts: listTasks(...) signature extension (statuses?: TaskStatus[]).
  src/tasks.ts: listReady or listNext or whatever next reads — same extension if it filters status.
  src/approvals.ts: listApprovals signature extension.
  
Tests:
  test/cli-task-list.test.ts (extend): single --status (back-compat), multi via CSV, multi via repeat, mixed, dedup, invalid.
  test/cli-task-next.test.ts (or similar): same matrix, briefer.
  test/cli-approve-list.test.ts: same.

Total ~80 LOC code + ~120 LOC tests.

═══ ANTI-FEATURES ═══

  - Don't promote mu task wait --status. The wait target is semantically singular (the verb means "wait until reaches THIS status"). "Wait for any of N statuses" is a separate feature; file as new task only when friction surfaces.
  - Don't auto-detect "if --status is missing, default to OPEN ∪ IN_PROGRESS" or similar smart-default. Today's "no --status = no filter" is honest; don't change it.

═══ PROMOTION ═══

  - Real-user friction: filed by operator after multiple per-status invocations during the v0.3 wave.
  - Substrate ready: parseCsvFlag, parseStatusOption, IN-clause via better-sqlite3 (use varargs binding via .all(...arr)).
  - Fits in <300 LOC: yes (~200).

PROMOTE for v0.3.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_list_multi_status_union -w mufeedback-v03 --evidence 'multi --status on task list / task next / approve list; SDK + CLI + tests + docs'
```

### #2 by "reaper", 2026-05-10T07:45:50.970Z

```
[reaper] previous owner worker-4 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```
