---
id: "doc_stale_verb_audit_v01"
workstream: "mufeedback-v03"
status: REJECTED
impact: 55
effort_days: 0.4
roi: 137.50
owner: null
created_at: "2026-05-10T13:21:41.059Z"
updated_at: "2026-05-10T13:49:49.125Z"
blocked_by: ["remove_or_shrink_verb_audit_md"]
blocks: []
---

# docs: VERB_AUDIT.md is a v0.1 snapshot — lists removed mu approve + mu hud as KEEP, claims bug_adopt_verb_unwired which is now fixed

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:22:03.707Z

```
FILES: docs/VERB_AUDIT.md:4, :50-52, :58-65, :74, :122-126, :170-184, :889-955, :1063
FINDING: VERB_AUDIT.md is anchored on v0.1 ("HEAD = 3e17bf3, ~50 verbs across 9 namespaces"). Major drifts:
  (1) :50-52 Summary "Total verbs audited: 58 (49 sub-verbs across 7 namespaces + 9 top-level: bare mu, whoami, my-tasks, my-next, state, hud, sql, undo, doctor)". After v0.3:
        - whoami / my-tasks / my-next REMOVED (merged into `mu me [tasks|next]` per audit_merge_self_verbs_into_mu_me).
        - hud REMOVED (merged into `mu state --hud` per merge_state_into_hud_render_mode).
        - 5 approve verbs REMOVED (per remove_approvals_dead_weight).
        - 8 archive verbs ADDED (mu archive create/list/show/add/remove/delete/search/export).
       New count is closer to 55-ish. Re-derive from `grep .command src/cli/`.
  (2) :74 disposition table includes `mu hud` as KEEP — gone.
  (3) :122-126 includes 5 `mu approve *` rows as KEEP — all gone.
  (4) :170-184 entire `### mu hud` subsection is now misleading (verb does not exist).
  (5) :889-955 the "mu approve — REMOVED post-v0.3 wave" historical-record block is fine BUT the table row at :122-126 wasnt updated to match. Either annotate the rows REMOVED in the table or strike them through.
  (6) :58-65 BUG (orphan code) section: cmdAdopt was rewired (src/cli/agents.ts:658 `program.command("adopt …")` lives inside wireAgentCommands now per the comment at :654-656 about bug_adopt_verb_unwired). This bug is FIXED — the audits "BUG (orphan code): 1" should drop to 0 with a "(resolved post-v0.3)" note.
  (7) :1063 anti-feature pledge SDK list mentions `src/{agents,tasks,workstream,workspace,approvals,snapshots,logs}.ts` — `src/approvals.ts` was deleted in remove_approvals_dead_weight. Replace with `archives.ts`.
  (8) :534 mentions `mu state` / `mu hud` consume the `ready` view — should be `mu state` (default + `--hud` mode + `--mission` mode) only.
WHY: VERB_AUDIT is the canonical "is this verb earning its keep" record; readers cite its disposition column when arguing for removals. A stale audit is worse than no audit.
FIX-SKETCH: add a "Post-v0.3 update" preamble at the top, strike the removed rows, drop the `mu hud` subsection (or mark "SUPERSEDED"), and bump the bug count. Real refresh-from-source is best done by re-grepping `src/cli/**` against the table.
```
