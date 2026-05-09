---
id: "review_code_should_overwrite_status_dup"
workstream: "mufeedback"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: "worker-mf-1"
created_at: "2026-05-09T08:30:36.269Z"
updated_at: "2026-05-09T08:55:35.552Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "reconcile_split_dryrun_into_status_only_mode"]
---

# REVIEW: shouldOverwriteAgentStatus duplicated between cli/agents.ts and reconcile.ts

## Notes (2)

### #1 by code-reviewer-1, 2026-05-09T08:30:55.574Z

```
FILES: src/cli/agents.ts:215-225 (shouldOverwriteAgentStatus), src/reconcile.ts:175-181 (shouldOverwrite)

FINDINGS: Two byte-equivalent copies of the same status-overwrite policy live in different files. cli/agents.ts:215-225 explicitly documents itself as a duplicate ("Same shouldOverwrite policy as `reconcile.ts` (kept private there to encapsulate the periodic-reconcile path). Re-implemented here for `mu agent show` ..."). The two predicates are identical:

  if (current === "free") return detected === "busy" || detected === "needs_permission";
  return true;

This is the documented-but-unsolved variant of the smell — the comment at cli/agents.ts:215 admits the duplication but justifies it on encapsulation grounds. The justification doesn't survive scrutiny: the predicate is pure and tiny; encapsulating it inside reconcile.ts buys nothing because cli/agents.ts already imports `detectPiStatus` and `updateAgentStatus` directly. There IS a real risk the two diverge silently — the next `free`-stickiness rule (e.g. "stick on `unreachable` until manual unstick") would land in only one of the two files and the operator would observe drift only on `mu agent show <name>`.

WHY IT MATTERS: 45. Code-smell / duplication; not a bug today. Will become a bug the next time the policy needs adjusting. Bar from skill: "Duplication ... Cases where DRY improves clarity without over-abstraction" — this is exactly that case.

SUGGESTED FIX (~15 LOC):
1. Export `shouldOverwrite` from src/reconcile.ts (rename to `shouldOverwriteStatus` or similar so the export name is more searchable).
2. Replace cli/agents.ts:215-225 with a single import.
3. Net delete: ~10 LOC.

ALTERNATIVES CONSIDERED:
- Move shouldOverwrite into agents.ts (since it's a property of the agent, not of reconcile). Probably better: it's ABOUT status overwrites, not ABOUT reconciliation. Then reconcile.ts and cli/agents.ts both import from agents.ts. Costs the same.
- Fold the inline-reconcile in cmdAgentShow back into reconcile.ts (e.g. `reconcile(db, { workstream, onlyAgent: name, dryRun: false })`). Bigger refactor; doesn't earn its keep unless cmdAgentShow grows further detection logic.

EVIDENCE:
- grep -n "shouldOverwrite" src/ → src/cli/agents.ts:222,258 + src/reconcile.ts:131,175.
- The inline comment at cli/agents.ts:216-220 explicitly flags this as "Re-implemented here for `mu agent show`".
```

### #2 by worker-mf-1, 2026-05-09T08:52:06.842Z

```
Done in 1372dc5. Extracted shouldOverwriteAgentStatus to src/agents.ts (next to updateAgentStatus); both src/reconcile.ts and src/cli/agents.ts now import it. Net -12 LOC. Behaviour unchanged. Gates green: typecheck/lint/build all clean; 2 pre-existing claimTask --self test failures reproduce on main HEAD 6f94818 unchanged (unrelated to this dedup). CHANGELOG updated under [Unreleased]/Changed.
```
