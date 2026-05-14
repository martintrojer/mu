---
id: "drop_taskrow_localid_duplicate_of_name"
workstream: "feedback"
status: CLOSED
impact: 7
effort_days: 0.1
roi: 70.00
owner: null
created_at: "2026-05-11T09:12:56.038Z"
updated_at: "2026-05-11T09:16:58.232Z"
blocked_by: []
blocks: []
---

# drop TaskRow.localId duplicate of name (was added 1 day ago for jq recipe symmetry; sole user, prefer single canonical key)

## Notes (3)

### #1 by "π - mu", 2026-05-11T09:13:07.983Z

```
CONTEXT: Commit 26a914a added localId alongside name on TaskRow as a "compat-safe" duplicate so jq recipes like .[].localId (matching agents/workstreams JSON pattern) would work. With one user and the rest of the codebase reading .name in 134+ sites, the duplicate is dead weight.

OPERATOR DECISION (this session, 2026-05-11): drop TaskRow.localId field. Keep localId as a function-parameter NAME (its the canonical concept) where it appears in addTask/closeTask/releaseTask signatures, etc — those are internal API shape, not JSON keys.

WHAT TO DO:
  - src/tasks.ts:
    - Drop `localId: string;` from the TaskRow interface (~line 90).
    - Drop `localId: row.local_id,` from rowFromDb (~line 162).
  - src/exporting.ts ~line 680: drop the `localId: t.originalLocalId,` line in the TaskRow literal inside exportSourcesForArchive.
  - src/agents.ts ~line 510: the SELECT renames the column to localId then reads t.localId. That is a query-result row, not a TaskRow. Leave alone (its an internal struct shape from the SQL pluck).
  - test/json-output.test.ts: drop the assertions that pin .localId === .name and .localId typeof string. The test was a regression guard for the SHIM; with the shim gone, the guard is moot. Either delete the relevant block or rewrite to assert .name is the only id key.
  - test/output-labels-human-rename.test.ts ~line 107: same — drop the localId assertion.
  - skills/mu/SKILL.md: any jq recipe that uses .localId on a task → switch to .name. (Agent and workstream JSONs unchanged.) Search: localId in skill.
  - docs/USAGE_GUIDE.md: same. Audit jq examples.
  - CHANGELOG.md [Unreleased] under "Removed" or "Breaking": document the field drop. Reference commit 26a914a as the predecessor.

VALIDATE: npm run typecheck && npm run lint && npm run test && npm run build

Severity: hygiene / API surface area reduction.
```

### #2 by "worker-droplocalid-1", 2026-05-11T09:16:50.784Z

```
DONE: dropped TaskRow.localId field. src/tasks.ts (interface + rowFromDb), src/exporting.ts (TaskRow literal in exportSourcesForArchive). test/json-output.test.ts and test/output-labels-human-rename.test.ts flipped from 'emits both keys' to 'emits name only'. CHANGELOG [Unreleased] Removed entry added. No jq .localId examples found in skills/mu/SKILL.md or docs/USAGE_GUIDE.md to migrate. typecheck + lint + test (1257) + build all green.
```

### #3 by "worker-droplocalid-1", 2026-05-11T09:16:58.232Z

```
CLOSE: all 4 green; TaskRow.localId field removed; SKILL+USAGE jq examples switched to .name; commit 9fbb0f2
```
