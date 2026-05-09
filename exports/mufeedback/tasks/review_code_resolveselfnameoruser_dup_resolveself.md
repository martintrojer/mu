---
id: "review_code_resolveselfnameoruser_dup_resolveself"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: "worker-mf-1"
created_at: "2026-05-09T08:35:53.409Z"
updated_at: "2026-05-09T09:39:18.157Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: resolveSelfNameOrUser in approve.ts duplicates the front half of resolveSelf

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:36:16.629Z

```
FILES: src/cli/approve.ts:213-219 (resolveSelfNameOrUser), src/cli.ts:481-498 (resolveSelf), src/tasks/claim.ts:331-340 (resolveActorIdentity)

FINDINGS: Three different "who am I right now?" helpers, each with subtly different fallback behaviour:

1. resolveSelf (src/cli.ts) — for `mu whoami`, `mu my-tasks`, `mu my-next`. Throws UsageError if $TMUX_PANE missing or pane isn't a registered agent. The strict variant.

2. resolveSelfNameOrUser (src/cli/approve.ts) — for `mu approve add/grant/deny`. Returns the agent name if pane is registered; otherwise falls back to `'user'`. The lenient variant — never throws.

3. resolveActorIdentity (src/tasks/claim.ts) — for `mu task claim --self` and `mu task note --author`. Resolution: $MU_AGENT_NAME → pane title (parsed) → $USER → 'orchestrator'. The env-aware variant.

Three different fallback chains for the same conceptual question. None of them lives next to the others. The recently-shipped commit 97eb014 was specifically the inline of resolveSelfActor (a fourth, just-killed, version), explicitly because of this fragmentation.

Distinct from review_code_resolve_self_actor_redundant (closed, was about a 4th instance): this one notes the surviving 3 still don't share a clear hierarchy. 

Specifically: resolveSelfNameOrUser in approve.ts re-implements the agent-by-pane lookup that resolveSelf already does — just with a different "no agent found" branch. The bottom of resolveSelf could trivially become:
  if (!agent && allowFallback) return null;
  if (!agent) throw new UsageError(...);
  return agent;
And resolveSelfNameOrUser becomes a one-liner: `(await resolveSelfOptional(db))?.name ?? 'user'`.

WHY IT MATTERS: 25. Smell. The existence of 3 helpers across 3 files is a sign nobody knows which one to call next. Future verbs that need self-identification will pick by proximity; the convention will continue to drift.

SUGGESTED FIX (~15 LOC):
1. In src/cli.ts, add a `resolveSelfOptional(db: Db): AgentRow | null` helper that's the same as resolveSelf but returns null instead of throwing.
2. Have resolveSelf call `resolveSelfOptional` then narrow.
3. Replace src/cli/approve.ts:213-219 with: `const agent = resolveSelfOptional(db); return agent ? agent.name : "user";`
4. Leave resolveActorIdentity alone (it's a different question — actor name as a string, not an agent row, with env-var precedence the agent-row variants don't honour).

Effort 0.05 if just steps 1-3; 0.1 if you also re-examine whether resolveActorIdentity should share the pane-lookup half.

ALTERNATIVES CONSIDERED:
- Single mega-helper that takes a "fallback" arg: resolveSelf(db, { fallback: 'throw' | 'null' | 'user-string' }). Uglier; spreads the union type into every caller's signature.
- Leave as-is; document the three contracts in a single comment block. Doesn't reduce code; might earn its keep.

EVIDENCE:
- src/cli.ts:481-498 (resolveSelf, throws).
- src/cli/approve.ts:213-219 (resolveSelfNameOrUser, fallback "user").
- src/tasks/claim.ts:331-340 (resolveActorIdentity, env-aware string).
- Git history: commit 97eb014 inlined resolveSelfActor at its single call site, explicitly to reduce this pattern's count from 4 to 3.
```
