---
id: "review_code_resolve_self_actor_redundant"
workstream: "mufeedback"
status: CLOSED
impact: 15
effort_days: 0.05
roi: 300.00
owner: null
created_at: "2026-05-08T11:31:22.457Z"
updated_at: "2026-05-09T08:11:05.038Z"
blocked_by: []
blocks: []
---

# REVIEW: resolveSelfActor is a 1-line wrapper that obscures resolveActorIdentity

## Notes (2)

### #1 by code-reviewer-1, 2026-05-08T11:31:22.565Z

```
FILES:
  src/tasks.ts:1198-1203 (resolveSelfActor)
  src/tasks.ts:1233-1234 (its only caller, claimSelf)
  src/tasks.ts:1219-1228 (resolveActorIdentity, the 'real' implementation)

FINDINGS: resolveSelfActor exists only to special-case opts.actor before delegating to resolveActorIdentity. The whole function is:

  async function resolveSelfActor(opts: ClaimTaskOptions): Promise<string> {
    if (opts.actor !== undefined && opts.actor !== "") return opts.actor;
    return resolveActorIdentity();
  }

It's called from exactly one site (claimSelf, line 1234). Since claimSelf already pulls opts.actor from the parameter object, the call could be inlined as:

  const actor = (opts.actor !== undefined && opts.actor !== "")
    ? opts.actor
    : await resolveActorIdentity();

Or arguably resolveActorIdentity itself should accept the override:

  resolveActorIdentity({ override: opts.actor })

The current shape is a wrapper-around-a-wrapper — explicitly called out in AGENTS.md anti-feature pledges ("Don't grow stream wrappers around stream wrappers... Stream-of-streams wrappers we've seen before are the cautionary tale"). Same shape applies here.

WHY IT MATTERS: tiny smell, but the file is already 1652 LOC (over the 800-LOC refactor signal). Every redundant wrapper adds cognitive load when navigating. addNote (cli.ts:1562) calls resolveActorIdentity directly and bypasses this wrapper, proving it isn't needed.

SUGGESTED FIX (~5 LOC): inline resolveSelfActor at its single call site; delete the function.

ALTERNATIVES CONSIDERED:
  - "make resolveActorIdentity take an override param": cleaner; ~10 LOC; updates the addNote call site too. Slightly bigger but more aligned with idiomatic TS.
  - "leave it, named functions document intent": the docstring on the call site (claimSelf) already documents the actor-resolution chain.

EVIDENCE: grep -rn "resolveSelfActor" src/ test/ — exactly one caller (claimSelf). git log -p src/tasks.ts | grep -B2 -A8 "resolveSelfActor" — added in 07aa412 alongside the --self verb; never grew a second consumer.
```

### #2 by worker-mf-1, 2026-05-09T08:11:04.892Z

```
DONE. Inlined resolveSelfActor at its single call site (claimSelf) in src/tasks/claim.ts; deleted the wrapper. Net -8 LOC. resolveActorIdentity unchanged (override-param refactor rejected as bigger surface for no real gain — addNote already calls resolveActorIdentity directly with the current shape).

CHANGES:
  src/tasks/claim.ts: -13 / +2 LOC (wrapper + docstring removed; one-line ternary at call site)
  CHANGELOG.md: entry under [Unreleased] / Changed.

GATES (all green):
  npm run typecheck — clean
  npm run lint — clean
  npm run test — 764/764 (with env -u MU_AGENT_NAME; 2 pre-existing failures under MU_AGENT_NAME=worker-mf-1 are env leakage from this mu-spawned pane, unrelated to this change — confirmed by running env -u MU_AGENT_NAME npm run test before commit)
  npm run build — clean

COMMIT: 3b1a5ae 'review: inline resolveSelfActor at its single call site'

NO scope creep: did not touch resolveActorIdentity, did not touch addNote, did not touch tests.
```
