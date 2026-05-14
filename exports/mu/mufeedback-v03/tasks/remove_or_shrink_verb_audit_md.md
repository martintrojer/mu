---
id: "remove_or_shrink_verb_audit_md"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.2
roi: 150.00
owner: "worker-4"
created_at: "2026-05-10T13:25:13.081Z"
updated_at: "2026-05-10T13:50:04.189Z"
blocked_by: []
blocks: ["doc_stale_skill_schema_sql", "doc_stale_verb_audit_v01"]
---

# decide: docs/VERB_AUDIT.md — 1122 LOC of v0.2-vintage tables; if doc_stale_verb_audit_v01 fixes are >300 LOC, remove instead

## Notes (1)

### #1 by "π - mu", 2026-05-10T13:26:04.567Z

```
docs/VERB_AUDIT.md = 1122 LOC of v0.2-vintage verb-by-verb audit tables (typed-vs-sql / impact-of-removal / output-shape).

reviewer-3 filed doc_stale_verb_audit_v01 against it; the underlying drift is large (every audit row references the v0.2 verb surface; many of those verbs are removed; column references use v4 schema columns).

═══ DECISION RULE ═══

Run a quick grep tally of stale references in VERB_AUDIT.md. If the count of fixes needed is >50% of the doc's content (or if doc_stale_verb_audit_v01's fix-sketch is >300 LOC of edits), REMOVE the doc instead. The audit's job was promotion-decision-time analysis (which verbs to keep / remove / typed-vs-sql); that work has shipped (mu hud removed, mu approve removed, multi-status added, etc) — the doc has no live readers.

If <50% drift: keep + apply doc_stale_verb_audit_v01 fixes per reviewer-3's guidance.

═══ DELIVERABLE ═══

  Step 1: grep / count stale references (removed verbs, renamed flags, v4 columns).
  Step 2: if removal:
    - rm docs/VERB_AUDIT.md
    - drop the link from docs/ROADMAP.md / README.md / wherever it's referenced
    - CHANGELOG.md ### Removed: 'docs/VERB_AUDIT.md — single-purpose v0.2 verb-by-verb audit; promotion decisions shipped; no live readers'
    - mark doc_stale_verb_audit_v01 REJECTED (with note: 'parent doc removed entirely; see remove_or_shrink_verb_audit_md')
  Step 3: if keeping: leave for doc_stale_verb_audit_v01 worker to fix.

═══ PROMOTION ═══

Same rationale as remove_output_labels_audit_md: single-purpose audit doc; work landed; pre-1.0 cleanup. Operator-stated preference: prefer removal if fix is too big.

═══ FINAL ACTION ═══

⚠️ git commit -am '<remove or fix> VERB_AUDIT.md' THEN mu task close remove_or_shrink_verb_audit_md -w mufeedback-v03 --evidence '<chose remove | fixed in place>; doc_stale_verb_audit_v01 <rejected | left>'
```
