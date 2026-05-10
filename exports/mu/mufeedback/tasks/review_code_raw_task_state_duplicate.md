---
id: "review_code_raw_task_state_duplicate"
workstream: "mufeedback"
status: CLOSED
impact: 40
effort_days: 0.2
roi: 200.00
owner: null
created_at: "2026-05-08T11:29:57.586Z"
updated_at: "2026-05-09T08:23:51.373Z"
blocked_by: []
blocks: []
---

# REVIEW: RawTaskRowForState + rawTaskRowToTask duplicate src/tasks.ts machinery

## Notes (2)

### #1 by code-reviewer-1, 2026-05-08T11:29:57.699Z

```
FILES:
  src/cli.ts:3232-3247 (state's IN_PROGRESS / recent_closed inline queries)
  src/cli.ts:3322-3344 (RawTaskRowForState interface + rawTaskRowToTask)
  src/cli.ts:3402-3407 (hud's IN_PROGRESS query, same pattern)
  src/tasks.ts:75-115 (RawTaskRow + rowFromDb already exist, private)

FINDINGS: RawTaskRowForState in cli.ts is byte-identical to RawTaskRow in tasks.ts; rawTaskRowToTask is byte-identical to rowFromDb. The duplication exists because tasks.ts keeps RawTaskRow private. The duplication justifies itself with a comment ("re-query the tasks table directly with status + ordering not exposed by listTasks") — but the row-shape converter has nothing to do with the missing query; only the SQL query needs to live here.

The SAME duplication appears for cmdHud's in-progress query (cli.ts:3402-3407, also using RawTaskRowForState). So the price has been paid twice and the row-mapping logic is now in three places.

WHY IT MATTERS: when (not if) TaskRow gains a field — owner_role, deadline, anything — three converters must be updated in lockstep. With strict TS the third converter would be caught by the TaskRow type at the assignment site, but the duplicate type definition silences that signal (RawTaskRowForState would happily exclude the new column).

SUGGESTED FIX (~15 LOC):
  Option A (smallest): export `rowFromDb` + `RawTaskRow` from src/tasks.ts; delete RawTaskRowForState + rawTaskRowToTask in cli.ts; the inline queries become `(db.prepare(...).all(workstream) as RawTaskRow[]).map(rowFromDb)`.
  Option B (better): add a `listTasksByStatus(db, workstream, status, opts: { orderBy?, limit? })` to src/tasks.ts that handles the IN_PROGRESS / recent_closed cases (cli.ts already has all the call sites). Pushes the row-shape conversion behind a single primitive; no exported raw-row type leakage.

ALTERNATIVES CONSIDERED:
  - "expose listTasks with all the order-by knobs": would explode the listTasks signature for two specific consumers; option B is narrower.
  - "leave it, the duplication is small": three copies of the same shape = the next field add silently breaks a pretty-print path with no compiler help.

EVIDENCE: diff -q the converter functions: identical word-for-word (snake_case → camelCase, same field set). cli.ts comment at line 3320 admits the choice was deliberate but doesn't justify the converter duplication, only the query ownership.
```

### #2 by worker-mf-1, 2026-05-09T08:23:51.256Z

```
DECISION: Option B (SDK helpers), per the reviewer note's recommendation. RawTaskRowForState was a *type* duplicate, not just a converter duplicate — the row shape was byte-identical to the private RawTaskRow inside src/tasks.ts. Option A (export raw row + converter) would have leaked the snake_case shape into the SDK surface; Option B keeps the raw shape private and adds two narrow named helpers that match the existing listReady/listBlocked/listGoals pattern, so callers compose with withRoiAll / formatTaskListTable / sortTasks like every other list slice.

CONSOLIDATION:
  - src/tasks.ts +27 LOC: listInProgress(db, ws) and listRecentClosed(db, ws, limit=5) — both use the existing private rowFromDb path. Queries are byte-identical to the inline ones they replace (same WHERE/ORDER BY/LIMIT). Doc comments cite review_code_raw_task_state_duplicate.
  - src/index.ts +2 LOC: export both helpers from the SDK surface.
  - src/cli.ts -30 LOC: delete RawTaskRowForState interface + rawTaskRowToTask helper. Brings src/cli.ts from 945 -> 915 LOC (still above the 800-LOC refactor signal, but trending right).
  - src/cli/state.ts -17 net LOC: drop the two inline SELECT-and-map blocks (cmdState IN_PROGRESS + recent_closed) and the 'lives in src/cli.ts so cmdHud can use it' comment; replace with listInProgress(db, ws) + listRecentClosed(db, ws). Imports lose RawTaskRowForState + rawTaskRowToTask, gain listInProgress + listRecentClosed.
  - src/cli/hud.ts -8 net LOC: drop the inline SELECT-and-map block in cmdHud; replace with listInProgress(db, ws). Imports lose RawTaskRowForState + rawTaskRowToTask, gain listInProgress.
  - CHANGELOG.md +20 LOC: entry under [Unreleased] / Changed describing the consolidation, the LOC delta, and the 'no SQL projections changed' guarantee.

LOC DELTA: net -26 LOC (-30 / -25 / +27 / +2). One fewer exported CLI symbol; one fewer place that has to learn about future TaskRow columns. The reviewer note's worst-case scenario (next field add silently breaks a pretty-print path) is now compiler-enforced: TaskRow flows through rowFromDb in exactly one place.

GATES: typecheck + lint + build green. Test suite: 765/767 pass; the 2 failures (claimTask --self resolves actor from $USER) are pre-existing on main HEAD a4febdd — verified by 'git stash; npm run test -- test/tasks.test.ts; git stash pop'. They're an env-leak from running the suite inside a worker pane where $USER is overridden by the agent harness.

WHAT WAS NOT CHANGED:
  - TaskRow itself (out of scope per task brief).
  - SQL projections in state.ts/hud.ts (out of scope per task brief; the new SDK helpers wrap the same SELECTs verbatim).
  - The private RawTaskRow + rowFromDb in src/tasks.ts (kept private; only the new list-by-status helpers cross the SDK boundary).

DOCS UPDATED: CHANGELOG.md only. VOCABULARY.md not touched (no new vocabulary; listInProgress / listRecentClosed are direct siblings of the existing listReady/listBlocked vocabulary). USAGE_GUIDE.md not touched (no new CLI verb; pure internal refactor invisible to users). ARCHITECTURE.md not touched (no architectural seam change; the cli/* -> tasks.ts import direction was already documented).

COMMIT: 79288dd on review_code_raw_task_state_duplicate.
```
