---
id: "review_code_workspace_kept_dead_field"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.1
roi: 350.00
owner: null
created_at: "2026-05-08T11:29:36.409Z"
updated_at: "2026-05-08T11:46:39.133Z"
blocked_by: []
blocks: []
---

# REVIEW: CloseAgentResult.workspaceKept is dead — always false now

## Notes (1)

### #1 by code-reviewer-1, 2026-05-08T11:29:36.523Z

```
FILES:
  src/agents.ts:983-996 (CloseAgentResult interface)
  src/agents.ts:1019,1049 (the two assignment sites)

FINDINGS: cccba88 made closeAgent refuse-by-default when an agent has a workspace, retaining workspaceKept "for callers (and tests) that branched on the old signal" but the field is now provably ALWAYS false on every reachable code path:

  - early return when no agent: workspaceKept: false
  - WorkspacePreservedError thrown before any return when ws exists & !discardWorkspace
  - successful path always returns workspaceKept: false (see comment on line 1046-1048: "with the new refuse-by-default policy this is always false on the success paths")

So every consumer that reads result.workspaceKept gets false unconditionally. The field is documented as "Backwards-compat alias of `!workspaceFreed && hadWorkspace`" — but with refuse-by-default, hadWorkspace ⟹ either threw OR workspaceFreed=true, so the expression is provably 0.

WHY IT MATTERS: dead field in a public SDK type. Anyone who reads the docstring and writes `if (r.workspaceKept) ...` will get a branch that never fires, silently. The very comment that documents it says it's vestigial — a clear signal the field should have been deleted in the same commit but wasn't. Anti-feature pledge: "no anticipatory abstractions / no wrappers around wrappers" applies to vestigial fields too.

SUGGESTED FIX (~10 LOC):
  1. Drop workspaceKept from CloseAgentResult interface.
  2. Drop both assignment sites in closeAgent.
  3. Update CHANGELOG to note the breaking-change in the upcoming version (the field was added in 0.1.0 timeline; removing it pre-0.2.0 is fine).
  4. Grep test/ for callers (test files excluded from this review per scope) — tests asserting workspaceKept===false are testing nothing useful and should be deleted.

ALTERNATIVES CONSIDERED:
  - "keep for back-compat, document deprecation": mu has no public SDK consumers yet (per VOCABULARY); pre-1.0 keep-back-compat-forever is the wrong default. Anti-feature pledge says no wrappers.
  - "make it actually mean something (true when refused?)": wrong place — refuse case throws, doesn't return.

EVIDENCE: src/agents.ts:1046-1048 inline comment literally says "always false on the success paths". git log --all -p src/agents.ts | grep -n workspaceKept shows the field was added in cccba88 with the refuse-by-default change as a transition-aid that was never cleaned up.
```
