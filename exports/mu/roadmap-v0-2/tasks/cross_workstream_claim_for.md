---
id: "cross_workstream_claim_for"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-08T14:21:21.992Z"
updated_at: "2026-05-09T05:37:53.950Z"
blocked_by: ["snap_dogfood"]
blocks: []
---

# mu task claim --for <agent> succeeds when <agent> is in a different workstream than the task

## Notes (1)

### #1 by worker-1, 2026-05-09T05:37:47.133Z

```
FILES:
  src/tasks.ts                — claimTask() worker path: added pre-FK
                                cross-workstream check; throws existing
                                AgentNotInWorkstreamError (already
                                exit-code-4 in cli.ts handle()).
  test/tasks.test.ts          — +3 regression tests (reject; next-steps;
                                --self unaffected). +1 fix to a pre-existing
                                listTasksByOwner test that was constructing
                                cross-workstream owner state via the buggy
                                claim path; now constructs via direct SQL
                                (the listTasksByOwner cross-ws read contract
                                is unchanged and explicitly pinned).
  test/claim.integration.test.ts — fixed 3 pre-existing tests that were
                                also exercising the buggy claim path
                                (task workstream "test" vs agent workstream
                                "claim-<tag>"); now spawn agents in the
                                task's workstream.
  CHANGELOG.md                — Unreleased > Fixed entry above the
                                snap_undo entry (which is staged uncommitted
                                in this workspace from a prior session;
                                left untouched per brief).

COMMANDS (gate at exit, all green; pre-existing flakes documented):
  npm run typecheck        → 0
  npm run lint             → 0
  unset MU_AGENT_NAME && npm run test  → 0  (714 / 714 passed)
  npm run build            → 0

  Without `unset MU_AGENT_NAME` (i.e. running inside this mu-spawned
  pane where MU_AGENT_NAME=worker-1 is set by spawnAgent), the same
  2 pre-existing flakes the brief warned about hit:
    claimTask > --self resolves actor from $TMUX_PANE when not explicit
    claimTask > --self resolves actor from $USER when no $TMUX_PANE
  Both are caused by resolveActorIdentity() preferring $MU_AGENT_NAME
  over the test's mocked $TMUX_PANE / $USER (well-documented in
  src/tasks.ts:1281-1296). Out of scope for this task.

FINDINGS:
  - The schema FK on tasks.owner is keyed on agents(name) only — no
    workstream qualifier. Adding a composite (name, workstream) FK
    would be the "structural" fix but requires a non-additive schema
    migration; the pre-check in claimTask is a < 30 LOC equivalent
    that makes the wire surface honest without touching the schema.
  - listTasksByOwner intentionally crosses workstream boundaries
    (used by `mu agent owned-by` to surface what an agent is touching
    everywhere). That contract is preserved; only the WRITE-side claim
    is constrained.

DECISION:
  Reused AgentNotInWorkstreamError (smaller surface, already exit 4
  via cli.ts handle()). Did NOT introduce TaskClaimCrossWorkstreamError;
  the existing class semantically matches "this agent is not in this
  workstream" and its errorNextSteps() already point at "use the agent's
  actual workstream" + "list agents in the requested workstream" —
  both directly applicable. Adding a new class would have grown the
  surface for zero behavioural gain.
  Pre-FK ordering is load-bearing: the bare FK error is just
  "FOREIGN KEY constraint failed" which gives the user nothing.

NEXT:
  - The snap_undo work is staged uncommitted in this workspace from
    a prior session (snap_undo_reconcile_destroys_recovered_agents
    by another worker). Per brief I did NOT touch it. The orchestrator
    should dispatch workspace_create_partial_dir_on_failure next as
    planned; the snap_undo work needs its own commit by whoever owns
    that task.
  - The 2 pre-existing claimTask --self flakes are an env-contamination
    issue (MU_AGENT_NAME). Worth filing as its own follow-up if it
    bites again — fix is one line in those tests' withEnv chain
    (add `withEnv("MU_AGENT_NAME", undefined, ...)`). Not filing now;
    not in scope and not surfaced by real users.

VERIFIED:
  - `mu task claim <B-task> -w <B> --for <A-agent>` now throws
    AgentNotInWorkstreamError → exit 4 (verified via the new
    test/tasks.test.ts cases; CLI exit-code path is the same one
    AdoptAgent already traverses, lines 233-235 of src/cli.ts).
  - `mu task claim <task> -w <ws> --self` still works across
    workstreams (orchestrator-direct path); explicit regression
    test added.
  - --for to the SAME workstream still works (existing tests cover).
  - ClaimerNotRegisteredError path (no agent row at all) still
    fires before the new check (existing tests cover).

ODDITIES:
  - The integration tests previously asserted on a task in workstream
    "test" while agents lived in workstream "claim-<tag>" — the bug
    was actually load-bearing for those tests' setup. The brief's
    "fix the bug" instruction and the fact that those tests were
    silently asserting the buggy path is itself a small confirmation
    that the bug had escaped review.
  - The CHANGELOG had an existing snap_undo entry above where I
    added mine; I added the cross_workstream_claim_for entry on top
    (chronological newest-first within the Unreleased > Fixed
    section). When snap_undo gets committed, both entries land
    together cleanly.
```
