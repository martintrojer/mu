---
id: "bug_v5_name_clash_silent_misroute"
workstream: "mufeedback"
status: CLOSED
impact: 85
effort_days: 0.5
roi: 170.00
owner: "worker-mf-1"
created_at: "2026-05-09T13:08:51.672Z"
updated_at: "2026-05-09T13:43:57.352Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "schema_v5_cleanups", "v5_prune_v4_fallback_branches"]
---

# BUG: post-v5 SDK queries by NAME without workstream context silently pick an arbitrary workstream when names clash (worker-1 in wsA + wsB)

## Notes (1)

### #1 by π - mu, 2026-05-09T13:09:42.941Z

```
SURFACED LIVE post-v5: surrogate-id schema introduced per-workstream-unique TEXT names (tasks.local_id, agents.name, approvals.slug). The DB invariant is correct — UNIQUE (workstream_id, local_id) — but the SDK still has many SELECT-by-name-only paths that take the FIRST row and silently misroute to the wrong workstream when the same name exists in multiple workstreams.

═══ THE COMMON CASE THIS HURTS ═══

Two operators run two workstreams. Both spawn the obvious worker name:

  $ mu agent spawn worker-1 -w wsA --workspace
  $ mu agent spawn worker-1 -w wsB --workspace

DB now has 2 agents rows: (workstream_id=A, name=worker-1, id=10) and (workstream_id=B, name=worker-1, id=11). Both legal per UNIQUE (workstream_id, name).

Operator on wsA does:
  $ MU_SESSION=wsA mu task claim some_task --for worker-1

claimTask's pre-check at src/tasks/claim.ts:196-203 runs:
  SELECT a.id, ws.name AS workstream FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = ? LIMIT 1
                                                                                                                ^^^^^^^
                                                                                                                buggy

LIMIT 1 picks ARBITRARY (driven by SQLite's ROWID-by-default, which means usually-first-inserted = wsA's worker-1). Sometimes correct; not by design.

The cross-workstream guard at line 215-225 then fires: if it picked wsB's worker-1, it correctly raises AgentNotInWorkstreamError saying "agent worker-1 is in workstream wsB, not wsA" — confusing because the operator sees TWO worker-1s and mu picked the wrong one.

If the operator's wsA actually had a worker-1 AND mu's LIMIT 1 picked wsA's row (the lucky case), the operation succeeds — but if their next claim picks wsB's row, behaviour flips silently.

═══ EVERY KNOWN OFFENDER (post-v5) ═══

1. src/tasks/claim.ts:188-203 (claimerRow lookup)
   SELECT FROM agents WHERE name = ? LIMIT 1
   FIX: pass workstream context (already known from -w / $MU_SESSION); query becomes WHERE workstream_id = ? AND name = ?.

2. src/tasks/claim.ts:213-225 (taskWsRow lookup)
   SELECT FROM tasks WHERE local_id = ? LIMIT 1
   Same shape. Same fix: scope by workstream_id.

3. getTask(db, localId) — used everywhere. Probably src/tasks.ts.
   SELECT FROM tasks WHERE local_id = ? — no workstream filter at all.
   First match wins. If the operator on wsA does `mu task show design` and `design` exists in BOTH workstreams, mu shows wsB's row (or arbitrary).
   FIX: getTask signature gains workstream context (workstream-id internally). All callers must pass it. This may be the single biggest knock-on; the SDK has many getTask callers.

4. listTasksByOwner(db, ownerName, opts?) at src/tasks.ts:496+
   JOIN by agent NAME means it returns rows from EVERY workstream's "worker-1". Today's "feature" (mu agent owned-by surfaces cross-ws claims via mu sql hand-edits) becomes a MISFEATURE for the common case.
   FIX: signature change — listTasksByOwner(db, workstreamName, agentName) for the in-scope query; keep a separate listTasksByOwnerCrossWorkstream(db, agentName) for the genuine cross-ws use case (rare).

5. resolveAgentByName / similar resolvers that don't take workstream context.

6. Probably more in src/cli/* — every verb that takes a bare entity name and maps it to an SDK call.

═══ DETECTION SHAPE ═══

Run from a test that seeds two workstreams with same-name entities:

  - 2 workstreams (wsA, wsB)
  - same agent name in both (worker-1)
  - same task local_id in both (design)
  - call every public SDK function with the bare name + assert it picked the RIGHT workstream's row given the resolved context

═══ PROPOSED FIX (PATTERN) ═══

Two complementary changes:

  PHASE 1 — every internal lookup-by-name takes workstream_id explicitly.
    The design doc's "boundary discipline" pattern (public SDK takes operator names + workstream context, internal helpers take surrogate ids) MOSTLY landed in schema_v5_sdk_signatures (098aa48), but the CLAIM path's internal SELECTs slipped through. Audit every SELECT in src/ that filters by an entity name and verify it ALSO filters by workstream_id.
    Output: zero "WHERE name = ? LIMIT 1" patterns left in src/. CI grep guard.

  PHASE 2 — typed error when the resolution is ambiguous.
    For SDK calls that take bare names AND can't pin down a workstream from context (e.g. some library callers), add NameAmbiguousError listing the candidate workstreams.
    Less load-bearing; PHASE 1 fixes the common case.

═══ PROMOTION ═══

  - Real-user friction: operator surfaced this immediately post-v5, before shipping any cross-ws work.
  - Substrate ready: schema_v5_sdk_signatures gives us the (workstream, name) → id resolver helpers; we just need to thread workstream consistently to every consumer.
  - Fits in <300 LOC: yes — most internal lookups already take workstream from a parent context; the fix is mostly mechanical signature changes + a few tests.

PROMOTE NOW. Block schema_v5_cleanups on this (the cleanups can't safely delete the cross_workstream_claim_for pre-check while this bug is open — the pre-check is a workaround for exactly this gap).

═══ EDGES ═══

Block: docs_staleness_review_capstone (so docs reflect the post-fix invariants).
Block: schema_v5_cleanups (the cleanups assume per-workstream resolution is honest; can't drop the safety belt while it's still load-bearing).

(Orchestrator action: add edges after filing.)
```
