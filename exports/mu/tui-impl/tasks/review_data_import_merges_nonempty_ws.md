---
id: "review_data_import_merges_nonempty_ws"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: "worker-2"
created_at: "2026-05-13T12:44:11.900Z"
updated_at: "2026-05-13T13:10:19.162Z"
blocked_by: []
blocks: []
---

# REVIEW med: import can silently merge into non-task workstream

## Notes (3)

### #1 by "worker-2", 2026-05-13T12:44:12.223Z

```
FILE(S):
  src/importing.ts:750-763
  docs/USAGE_GUIDE.md:1677-1681
  test/importing.integration.test.ts:173-190

FINDING (non-idiomatic):
  const existing = db
    .prepare(
      `SELECT 1 AS x FROM workstreams ws WHERE ws.name = ? AND EXISTS (
         SELECT 1 FROM tasks t WHERE t.workstream_id = ws.id
       )`,
    )
    .get(targetName) as { x: number } | undefined;
  if (existing !== undefined) {
    const err = new WorkstreamAlreadyExistsError(targetName);
    ...
    throw err;
  }

WHY IT'S A PROBLEM:
  The documented contract says import refuses when the target workstream already exists in the DB, but the code only refuses if that workstream already has tasks. A workstream with live agents, a tmux session, or registered workspaces but zero tasks will be merged into silently, adding imported tasks under an existing crew that was intentionally out of scope for import (agents/workspaces are not restored). This is surprising state mixing and contradicts the "refuses silent merges" wording.

PROPOSED FIX:
  Change the preflight to reject any existing workstreams row for the target name, unless the intended contract is explicitly "allow empty workstream rows". If keeping the empty-row exception, narrow and document it as "existing row with zero tasks/agents/workspaces" and include agents/workspaces in the SQL predicate. Add a test that seeds an existing workstream with an agent or workspace but no tasks and verifies import refuses rather than merging imported tasks into it.

EFFORT NOTE:
  Small code change, but decide the exact compatibility contract first. The current test named "imports cleanly into a destroyed-then-recreated empty workstream" actually imports after destroy, not into an existing empty row, so new coverage is needed either way.
```

### #2 by "worker-2", 2026-05-13T13:10:17.986Z

```
FILES: src/importing.ts; test/importing.integration.test.ts; docs/USAGE_GUIDE.md; CHANGELOG.md
COMMANDS: npm test -- --run test/importing.integration.test.ts (exit 0); npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run test (exit 0); npm run build (exit 0); node dist/cli.js --help (exit 0)
FINDINGS: import preflight only checked existing workstreams with tasks, allowing silent merges into existing workstream rows with agents/workspaces and no tasks.
DECISION: changed preflight to SELECT from workstreams by name, matching the documented destroy-or-rename recovery contract.
VERIFIED: commit 0b38cde; integration tests cover existing targets with tasks, agents, and workspaces plus destroy-then-import success.
```

### #3 by "worker-2", 2026-05-13T13:10:19.162Z

```
CLOSE: 0b38cde: import preflight refuses any existing workstream; tests added for non-task occupancy
```
