---
id: "review_code_assert_in_workstream_smell"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-09T08:35:29.219Z"
updated_at: "2026-05-09T09:50:56.533Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: assertAgentInWorkstream / assertTaskInWorkstream / assertApprovalInWorkstream are 3 copies

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:35:49.721Z

```
FILES: src/cli.ts:716-727 (assertAgentInWorkstream), src/cli.ts:735-746 (assertTaskInWorkstream), src/cli/approve.ts:217-225 (assertApprovalInWorkstream)

FINDINGS: Three near-identical workstream-scope assertions:

  function assertXInWorkstream(db, id, workstream): void {
    if (!workstream) return;
    const x = getX(db, id);
    if (x && x.workstream !== workstream) {
      throw new XNotInWorkstreamError(id, workstream, x.workstream);
    }
  }

The assertion shape is identical; only the lookup function (getAgent / getTask / getApproval) and the typed error class change. Of the three:
- assertAgentInWorkstream and assertTaskInWorkstream live in src/cli.ts (visible to every CLI sub-module)
- assertApprovalInWorkstream lives privately in src/cli/approve.ts

Two issues:

1. Layering: the first two are in cli.ts (visible to all), the third is hidden in cli/approve.ts. Future verbs that need an "in this workstream?" assertion on a different entity type (snapshots? logs? workspaces by agent?) will pick one of the three and copy. The fourth instance is overwhelmingly likely.

2. Generic shape: this is exactly the case where a tiny generic helper saves three copies:
   function assertInWorkstream<T extends { workstream: string | null }>(
     entity: T | undefined,
     id: string,
     workstream: string | undefined,
     ErrorClass: new (id, expected, actual) => Error,
   ): void { ... }

But: the skill warns against premature abstraction. Three copies is the canonical "rule of three" trigger for extracting; one more new entity type would be the fourth. Since the code is small and the abstraction is straightforward, this is a deletion-favored refactor.

WHY IT MATTERS: 30. Smell + future-bug surface. Will become drift the next time the assertion shape needs adjustment (e.g. a workstream-rename feature that needs the assertion to also check renamed-to/renamed-from).

SUGGESTED FIX (~25 LOC):
Two reasonable shapes:

Option A — generic helper:
  // src/cli.ts (lives next to the two existing asserts)
  function assertInWorkstream<T extends { workstream: string | null }>(
    entity: T | undefined,
    id: string,
    workstream: string | undefined,
    makeError: (actual: string | null) => Error,
  ): void {
    if (!workstream) return;
    if (entity && entity.workstream !== workstream) {
      throw makeError(entity.workstream);
    }
  }
  // The three call sites become:
  assertInWorkstream(getAgent(db, name), name, workstream, (actual) => new AgentNotInWorkstreamError(name, workstream, actual ?? "—"));

Option B — extract just the assertApprovalInWorkstream into src/cli.ts so all three live in one file. Doesn't dedupe; just colocates. ~5 LOC.

Recommend Option A for the cleanup-effort budget.

ALTERNATIVES CONSIDERED:
- Leave alone. The skill warns against premature abstraction; three is the trigger but each copy is small (~6 LOC). Net gain from Option A is ~10 LOC + future-proofing.
- Move the assertion INTO the lookup functions (getAgent, getTask, getApproval) as an optional `expectInWorkstream?` parameter. Mixes lookup with validation; couples concerns.

EVIDENCE: 3 grep hits for "assertXInWorkstream"; all share the same control flow.
```
