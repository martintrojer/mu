---
id: "review_dedup_age_ms"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-12T08:31:56.501Z"
updated_at: "2026-05-12T09:02:05.313Z"
blocked_by: []
blocks: []
---

# REVIEW low: Hoist ageMs helper (2 identical copies in cards/inprogress + cards/recent)

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:31:56.812Z

```
FILES + LINES:
  - src/cli/tui/cards/inprogress.tsx:165-169 — exported ageMs(t, now)
  - src/cli/tui/cards/recent.tsx:148-152     — exported ageMs (verbatim copy with comment "intentionally duplicated; single call site per card, not worth a shared helper")
CATEGORY: duplication
SEVERITY: low
FINDING: The header comment in cards/recent.tsx claims "single call site per card, not worth a shared helper", but the popups/inprogress.tsx + popups/recent.tsx popups now ALSO consume `ageMs` (each imports it from the matching card). That's 4 consumers, not 1, so the original "not worth it" rationale no longer holds. The helper is 4 LOC of pure date math — moving it to src/cli/tui/columns.ts (or a sibling ./time.ts) eliminates the duplication and the now-stale comment.
SUGGESTED FIX: hoist `ageMs(t, now)` into a shared module; both cards re-export it for back-compat OR the popups import it directly. Drop the misleading "intentionally duplicated" comment.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:02:05.313Z

```
CLOSE: 22357168850814352e34a151b5baf972a493a220: bundled hoist
```
