---
id: "schema_v5_cleanups"
workstream: "mufeedback"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: "worker-mf-1"
created_at: "2026-05-09T10:41:21.597Z"
updated_at: "2026-05-09T15:12:17.607Z"
blocked_by: ["bug_v5_name_clash_silent_misroute", "schema_v5_cli_boundary", "schema_v5_sdk_signatures"]
blocks: ["audit_cleanups_post_schema_v5_wave", "docs_staleness_review_capstone"]
---

# schema v5: delete workarounds made defunct by surrogate-PK landing

## Notes (1)

### #1 by worker-mf-3, 2026-05-09T10:41:21.693Z

```
Per docs/SCHEMA_v5_DESIGN.md "Obsoleted workarounds" table.

Targets to delete after schema_v5_sdk_signatures lands:

  1. slugify_collision_truncates collision-loop in idFromTitle.
     With per-workstream UNIQUE on (workstream_id, local_id), collision
     scope is one workstream; loop simplifies to a "uniquify within
     workstream" check (or even a UNIQUE constraint failure + retry
     with a numeric suffix, no preemptive scan).

  2. mu_ reserved-prefix gymnastics in TaskIdInvalidError.
     Today TaskIdInvalidError sanitises a leading mu_ -> t_mu_ to dodge
     a global-namespace reservation. With per-workstream local_id, this
     reservation has no purpose. Delete the sanitiser; allow mu_foo as
     a valid local_id.

  3. cross_workstream_claim_for pre-check in src/tasks/claim.ts.
     The FK from tasks.owner_id -> agents.id plus per-workstream UNIQUE
     on agents (workstream_id, name) makes cross-ws ownership naturally
     impossible. Simplify back to "FK rejects garbage; the existence of
     the agent in the right workstream is what the FK validates".

  4. lastClaimActor brittle prefix-match (review_code_last_claim_actor_brittle).
     Today does prefix-matching against free-text event payloads using
     local_id strings. Surrogate-id lookup is exact: emit an event row
     with the surrogate task_id + agent_id; lookup is SELECT exact match.

Each cleanup removes a workaround entry from docs/USAGE_GUIDE.md
"workarounds" table (if present) and any ROADMAP.md item that points
at these as deferred. Add a CHANGELOG entry under Removed for each.

Net delta: ~-80 LOC.

Scope: ~0.5 days. Blocked by schema_v5_sdk_signatures.
Gate: typecheck + lint + test + build green; tests that pinned the
workaround behaviour (e.g. slugify collision suffixes, the mu_ ->
t_mu_ rewrite, cross-ws claim guard) get rewritten or removed and that
fact is called out in commit messages.
```
