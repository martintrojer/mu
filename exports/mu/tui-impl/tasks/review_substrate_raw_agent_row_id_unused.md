---
id: "review_substrate_raw_agent_row_id_unused"
workstream: "tui-impl"
status: CLOSED
impact: 20
effort_days: 0.05
roi: 400.00
owner: "worker-2"
created_at: "2026-05-13T12:42:24.220Z"
updated_at: "2026-05-13T14:26:03.474Z"
blocked_by: []
blocks: []
---

# REVIEW low: RawAgentRow.id field is dead — selected per call, never read

## Notes (3)

### #1 by "worker-1", 2026-05-13T12:42:24.542Z

```
FILE(S):
  src/agents.ts:167-180 (RawAgentRow.id field)
  src/agents.ts:184-194 (SELECT_AGENT_COLS includes a.id AS id)
  src/agents.ts:200-213 (rowFromDb discards id)

FINDING (dead code):
  `RawAgentRow.id` is declared and populated via SELECT_AGENT_COLS,
  with the comment:

      /** Surrogate id (v5). Carried through so internal helpers don't have
       *  to re-resolve when they need it. */
      id: number;

  But `rowFromDb` does NOT include `id` in the returned AgentRow.
  Every internal helper that needs the id calls `agentIdByName`
  (which re-runs a SELECT id query), e.g. deleteAgent at line 497.

  The "carried through so helpers don't re-resolve" claim is just
  not true — there is no AgentRow consumer reading the field. The
  surrogate id round-trips through the JOIN for nothing.

WHY IT'S A PROBLEM:
  - Misleading comment: future readers add a field assuming
    `agent.id` is plumbed through, then waste time discovering
    that AgentRow strips it.
  - Wasted SELECT column on every list/get path.
  - The deleteAgent path actually demonstrates the cost: it has
    to do a redundant `agentIdByName` lookup + SELECT before
    DELETE, even though the agent row was already fetched inline
    by `getAgent` in callers like closeAgent.

PROPOSED FIX:
  Two flavours, pick one:
  (a) Drop the `id` field from RawAgentRow, drop `a.id AS id`
      from SELECT_AGENT_COLS, delete the misleading comment.
      Safer minimal change — no behavioural delta.
  (b) Plumb id all the way through to AgentRow as an internal
      `_id` (or rename the SDK-public type) and use it in
      deleteAgent / closeAgent so they skip the agentIdByName
      lookup. Bigger but pays for itself.

  Recommendation: (a) for this sweep. (b) is a separate refactor
  if a future hot-path needs it.

EFFORT NOTE:
  Trivial (a): ~5 LOC. Run typecheck — TS will catch any
  consumer that tries to read `row.id` (none, per grep).
  No test changes needed.
```

### #2 by "worker-2", 2026-05-13T14:26:03.156Z

```
FILES: src/agents.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (initial exit 1 because node_modules was missing ink after fresh workspace checkout; ran npm install; rerun exit 0); npm run build (exit 0); node dist/cli.js --version (exit 0); node dist/cli.js agent list -w tui-impl --json (exit 0 bundle smoke)
FINDINGS: RawAgentRow.id and SELECT_AGENT_COLS a.id were unused; rowFromDb never exposed id and no reader emerged under typecheck.
DECISION: Applied flavour (a): remove raw id field, remove selected column, delete misleading comment. Left agentIdByName explicit id resolution unchanged.
NEXT: none.
VERIFIED: commit 55b41a9; four greens after npm install plus bundle smoke.
```

### #3 by "worker-2", 2026-05-13T14:26:03.474Z

```
CLOSE: 55b41a9: dropped RawAgentRow.id + SELECT_AGENT_COLS a.id; tsc confirms no readers
```
