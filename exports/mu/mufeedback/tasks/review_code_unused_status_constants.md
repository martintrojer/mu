---
id: "review_code_unused_status_constants"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-08T11:33:17.656Z"
updated_at: "2026-05-08T11:46:38.935Z"
blocked_by: []
blocks: []
---

# REVIEW: STATUSES_THAT_UNBLOCK is unused dead-code; SQL hardcodes 'CLOSED' instead

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-08T11:33:17.769Z

```
FILES:
  src/tasks.ts:35-37 (STATUSES_THAT_UNBLOCK definition)
  src/index.ts:95 (the only re-export)
  src/db.ts:411-417, 424-430, 442-447 (the views that should reference it)

FINDINGS: STATUSES_THAT_UNBLOCK is exported from src/tasks.ts and re-exported from src/index.ts but NEVER USED. It exists alongside STATUSES_TERMINAL_OR_PARKED, which IS used (src/tracks.ts:23,53; listTasksByOwner). The constant's docstring claims "Statuses that satisfy a `--blocked-by` edge — only CLOSED" — but every place that actually needs that knowledge (the ready/blocked SQL views in db.ts and migrations.ts) hardcodes the string "CLOSED" inline:

  WHERE b.status <> 'CLOSED'

Three places in db.ts plus six places across migrations.ts (v1->v2 + v2->v3) hardcode the same literal. The constant exists as if to centralise this, but it can't be plumbed into a SQLite view's CHECK clause from TypeScript anyway — at best you'd template-literal the const into the CREATE VIEW SQL, which is brittle.

WHY IT MATTERS: dead code in the public SDK surface (src/index.ts re-export). A consumer who imports STATUSES_THAT_UNBLOCK and writes `if (STATUSES_THAT_UNBLOCK.includes(t.status)) ...` would get correct behaviour today, but the codebase signals "this is the source of truth" while no internal code agrees.

SUGGESTED FIX (~5 LOC):
  Either:
    A) DELETE STATUSES_THAT_UNBLOCK + its export. The semantic ("CLOSED unblocks") is a single-element constant that doesn't need its own name; the comment in db.ts already documents it.
    B) Use it: render the views' SQL string from a TS template that interpolates STATUSES_THAT_UNBLOCK. Adds complexity for a one-element set; option A is the smallest fix.

Pick A.

ALTERNATIVES CONSIDERED:
  - "keep for forward-compat in case more statuses unblock": violates the "no anticipatory abstractions" pledge and the comment "only CLOSED" makes it clear no expansion is planned.

EVIDENCE: grep -rn "STATUSES_THAT_UNBLOCK" src/ test/ — only definition + re-export, no consumers. STATUSES_TERMINAL_OR_PARKED was a similar 3-element constant that DID earn its keep (3 call sites); STATUSES_THAT_UNBLOCK is the cargo-cult sibling.
```
