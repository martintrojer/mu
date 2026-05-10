---
id: "review_code_evidence_suffix_double_doc"
workstream: "mufeedback"
status: CLOSED
impact: 10
effort_days: 0.02
roi: 500.00
owner: null
created_at: "2026-05-09T08:34:50.161Z"
updated_at: "2026-05-09T08:50:40.014Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: evidenceSuffix has two adjacent JSDoc blocks

## Notes (2)

### #1 by code-reviewer-1, 2026-05-09T08:35:01.273Z

```
FILES: src/tasks/lifecycle.ts:42-50 (evidenceSuffix declaration)

FINDINGS: evidenceSuffix has two consecutive JSDoc blocks:

  /** Render `… evidence="<text>"` suffix when evidence is provided.
   *  Quoted so multi-word strings stay legible in the event payload. */
  /** Render the optional `--evidence "<text>"` payload as the trailing
   *  ' evidence="..."' on every state-changing event. Exported because
   *  claimTask/releaseTask in src/tasks/claim.ts also use it. */
  export function evidenceSuffix(opts: EvidenceOption | undefined): string {

Looks like a refactor artifact: when evidenceSuffix moved out of the legacy tasks.ts during the split, the second comment was added without removing the first. Both describe the same function; only the second mentions the cross-cluster export. TypeScript / Biome happily accept multiple adjacent block comments.

WHY IT MATTERS: 10. Pure nit. The redundancy is harmless to runtime; just confusing for the next reader who has to decide which comment to trust if/when they update behavior.

SUGGESTED FIX (~3 LOC):
Delete lines 42-43 (the first JSDoc); keep the second which is more complete.

EVIDENCE: src/tasks/lifecycle.ts lines 42-50 visible in single read.
```

### #2 by worker-mf-3, 2026-05-09T08:50:39.893Z

```
Merged the two adjacent JSDoc blocks above evidenceSuffix in src/tasks/lifecycle.ts into one (kept the more complete second block describing the --evidence payload + cross-cluster export). Pure cosmetic, -2 LOC.

GATES: typecheck clean, lint clean, build clean. Test suite has 2 pre-existing failures on fresh main HEAD (6f94818) unrelated to this change — both are env-leakage from the agent shell into the test runner ($TMUX_PANE / $USER). Verified by running tests against unmodified main: same 2 failures.

Commit cef280f.
```
