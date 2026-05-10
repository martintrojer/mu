---
id: "audit_verbs_typed_vs_sql"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: null
created_at: "2026-05-09T08:11:38.523Z"
updated_at: "2026-05-09T11:14:03.094Z"
blocked_by: ["agent_close_discipline_gap", "schema_surrogate_pks_for_global_uniqueness"]
blocks: ["docs_staleness_review_capstone"]
---

# audit: every verb honestly reviewed — keep / replace-with-sql-recipe / merge / drop

## Notes (1)

### #1 by π - mu, 2026-05-09T08:12:33.958Z

```
WHY NOW: mu has accreted ~50 verbs across 9 namespaces (see SKILL.md verb list). Some earned their typed shape (claim's atomic CAS; spawn's tmux+workspace dance; wait's polling). Others are thin wrappers around a SELECT or UPDATE that an LLM can compose via `mu sql` in one line. Anti-feature pledge: "no abstractions for hypothetical future flexibility". This task makes us honest about which verbs cleared the bar.

THIS IS AN INVESTIGATION + REPORT TASK. No code changes. Output is a markdown report at docs/VERB_AUDIT.md (committed) + 1-N follow-up tasks for the verbs whose disposition is REMOVE / MERGE / REPLACE-WITH-SQL-RECIPE.

═══ AUDIT METHOD ═══

For EVERY verb in `mu --help` (and every sub-verb), score four dimensions:

  1. ATOMICITY: does the verb encapsulate ≥2 SQL statements that need transaction semantics? (claim's UPDATE-then-INSERT-event must be atomic; `mu task list` is one SELECT.)
  
  2. SIDE-EFFECT BEYOND SQL: does the verb call tmux, fs, vcs, or another non-SQL substrate? (`mu agent spawn` must be tmux-aware; `mu task list` must not.)
  
  3. ERROR-MAPPING VALUE: does the verb produce an actionable typed error (`AgentNotInWorkstreamError`, `TaskAlreadyOwnedError`, ...) that a raw SQL would surface as opaque "FOREIGN KEY constraint failed"? (This is most of mu's value — see cross_workstream_claim_for, just shipped.)
  
  4. NEXTSTEP / OUTPUT VALUE: does the verb produce structured `Next: ...` hints or specially formatted output (cli-table3 column shaping, status emoji, dim/yellow/red coloring) that an LLM benefits from over raw SQL rows? (`mu state` is the obvious yes; `mu task notes <id>` is borderline.)

A verb scoring 0/4 is a candidate for REMOVE-with-sql-recipe-in-skill. A verb scoring 1/4 is a candidate for MERGE-into-larger-verb. A verb scoring ≥2 stays.

═══ OUTPUT FORMAT ═══

Create docs/VERB_AUDIT.md with this shape (~5-10 lines per verb):

  ## mu task list
    SQL surface  : SELECT * FROM tasks WHERE workstream = ? [AND status = ?]
    Atomicity    : 0  (one SELECT)
    Side-effect  : 0
    Error-map    : 0  (no typed errors)
    Output value : 1  (formatTaskListTable + status emoji + ROI sort)
    SCORE: 1/4
    DISPOSITION: KEEP  (output value alone justifies; an LLM benefits from the 
                       formatted table over raw rows when summarising state to 
                       the operator)
    SQL workaround: mu sql "SELECT local_id, status, impact, effort_days, 
                            (impact*1.0/effort_days) AS roi 
                            FROM tasks WHERE workstream='X' [AND status='Y'] 
                            ORDER BY roi DESC"

  ## mu task delete
    SQL surface  : DELETE FROM tasks WHERE local_id = ?  (cascades to edges/notes)
    Atomicity    : 1  (auto-snapshot + delete; the snapshot wraps it)
    Side-effect  : 1  (snapshot file)
    Error-map    : 0
    Output value : 0
    SCORE: 2/4
    DISPOSITION: KEEP (snapshot is load-bearing — raw sql DELETE bypasses undo)

  ## mu task search <pattern>
    SQL surface  : SELECT * FROM tasks WHERE title LIKE '%pattern%' OR id LIKE ...
    Atomicity    : 0
    Side-effect  : 0
    Error-map    : 0
    Output value : 0  (no special formatting; just rows)
    SCORE: 0/4
    DISPOSITION: REMOVE — file as follow-up task `remove_mu_task_search`. 
                 Add the SQL recipe to docs/USAGE_GUIDE.md "what's in 0.1.0" 
                 SQL escape hatch table.
    SQL workaround: mu sql "SELECT local_id, status, title FROM tasks 
                            WHERE workstream='X' AND title LIKE '%foo%'"

═══ DELIVERABLES ═══

  1. docs/VERB_AUDIT.md committed with one entry per verb (use `mu --help` and `mu <ns> --help` to enumerate; aim for completeness over brevity).
  
  2. SUMMARY at the top of VERB_AUDIT.md:
     - Total verbs audited: N
     - KEEP: K
     - MERGE candidates: M (with into-which-verb suggestion)
     - REMOVE candidates: R (with sql-recipe replacement)
     - Each MERGE/REMOVE filed as its own follow-up task with id `audit_<disposition>_<verb_slug>`.
  
  3. CHANGELOG.md entry under [Unreleased] / Changed: "Documented verb audit at docs/VERB_AUDIT.md; N follow-up tasks filed for MERGE/REMOVE candidates."
  
  4. Update docs/ROADMAP.md if any KEEP verbs surface as having unmet "anti-feature pledge" issues that need explicit promotion.

═══ HONESTY GUARDRAILS ═══

  - DON'T inflate scores to justify keeping a verb. If you're tempted to argue "well, the user MIGHT want a typed error someday", that's anti-feature speculation. Score 0.
  - DO be skeptical of OUTPUT VALUE — LLMs read JSON; humans read tables. If a verb has --json AND its prose render is "just the same fields in a table", output-value is at most 1, not 2.
  - DO check the LLM-as-operator angle. mu's primary user IS an LLM (this very session). If the LLM can compose `mu sql "..."` faster than calling a typed verb, that's evidence the verb earned little.
  - DO acknowledge irreversibility. A verb wrapping `mu task delete` or `mu workstream destroy` keeps EVEN IF score=1 because the snapshot wrap is safety machinery the LLM CANNOT replicate via raw sql.
  - DON'T propose new verbs in this audit. That's a different task type.

═══ CALIBRATION POINTS ═══

Based on a quick orchestrator-eye scan, these are my prior beliefs (worker should challenge them, not accept):
  - PROBABLE KEEPs: spawn, send, claim, release, close, open, reject, defer (snapshot+typed errors), workstream destroy/init, undo, snapshot list/show, doctor, hud, state, mission control (`mu`), wait, approve *, log --tail
  - LIKELY REMOVE-WITH-RECIPE: task search, task ready (one SELECT), task blocked (one SELECT against view), task goals (one SELECT against view), task tree (recursive CTE — but the format value might justify), task owned-by (one SELECT), task notes (one SELECT — but format value)
  - LIKELY MERGE: my-tasks/my-next/whoami → "in-pane sugar" probably could be one verb `mu me [next|tasks]`. Or kept as-is for in-pane ergonomics. Worker decides.
  - DEBATABLE: mu task update vs mu sql UPDATE; mu task block/unblock/reparent (atomicity matters); mu workspace path (one SELECT); mu workspace orphans (one fs scan + sql LEFT JOIN — but the format value).

═══ SCOPE GUARD ═══
~0.5 days. The audit IS the work. Don't slip into implementing the removals — file them as follow-up tasks with the SQL recipe in the note, and the disposition column locks the orchestrator's later decision.

═══ NEXT ═══
After shipping VERB_AUDIT.md, the operator (or a follow-up wave) can:
  - Approve specific REMOVEs and ship them as docs/USAGE_GUIDE.md "SQL escape hatch" recipes + verb removal commits.
  - Approve specific MERGEs and ship them.
  - Reject the audit's recommendation per-verb (audit is advisory; the operator has the final say).
```
