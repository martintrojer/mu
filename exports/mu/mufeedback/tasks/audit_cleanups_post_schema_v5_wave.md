---
id: "audit_cleanups_post_schema_v5_wave"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 1
roi: 50.00
owner: null
created_at: "2026-05-09T11:24:24.337Z"
updated_at: "2026-05-09T15:29:53.025Z"
blocked_by: ["schema_v5_cleanups"]
blocks: ["docs_staleness_review_capstone"]
---

# audit cleanups wave: ship the 5 deferred MERGE/REMOVE follow-ups after schema_v5_cleanups lands

## Notes (1)

### #1 by "π - mu", 2026-05-09T11:24:43.362Z

```
WAVE-ORCHESTRATING TASK. Tracks the 5 audit follow-ups that were deferred until schema_v5 lands.

═══ WHY DEFER THEM ═══

The audit (closed as audit_verbs_typed_vs_sql, see docs/VERB_AUDIT.md) flagged 5 verbs for MERGE/REMOVE:
  - audit_remove_task_blocked     (REMOVE; SELECT against blocked view)
  - audit_remove_task_goals       (REMOVE; SELECT against goals view)
  - audit_remove_task_search      (REMOVE; LIKE query)
  - audit_merge_task_ready_into_next   (MERGE; ready = next -n 0)
  - audit_merge_self_verbs_into_mu_me  (MERGE; whoami/my-tasks/my-next → mu me [tasks|next])

All 5 are currently DEFERRED. Reason: schema_v5_sdk_signatures rewrites every public SDK function signature (adds workstream context). Doing the audit removals now means the removal commits get re-touched during schema_v5; doing them after lands a smaller diff against a cleaner base.

═══ DELIVERABLE OF THIS TASK ═══

When claimed, the worker:
  1. Verifies schema_v5_cleanups (the last schema task in the chain) is CLOSED.
  2. Re-opens each deferred audit task (`mu task open <id>`).
  3. Runs them as a wave (one commit per disposition is fine, OR group the 3 REMOVEs into one commit and the 2 MERGEs into another — operator's call).
  4. Each individual task closes when its commit lands.
  5. Closes THIS wave-task only when all 5 children are CLOSED.

═══ EDGES ═══

Blocks: docs_staleness_review_capstone (so the docs reflect the post-cleanup verb surface).
Blocked by: schema_v5_cleanups (so we land cleanups in the right order).

═══ ALTERNATIVE: just close as DEFERRED indefinitely ═══

If by the time schema_v5_cleanups lands the operator decides NOT to do the audit cleanups (e.g. the verbs proved valuable in real use), close THIS task with evidence pointing at the deferred children's notes. The 5 deferred tasks stay DEFERRED as historical record. Capstone unblocks regardless.

═══ OUT OF SCOPE ═══

Adding new verbs from the audit's findings. The audit is advisory; this wave only ships the disposition-already-decided changes.
```
