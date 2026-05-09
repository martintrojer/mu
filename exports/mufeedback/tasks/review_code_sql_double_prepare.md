---
id: "review_code_sql_double_prepare"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: null
created_at: "2026-05-08T11:32:53.157Z"
updated_at: "2026-05-08T13:06:39.366Z"
blocked_by: []
blocks: []
---

# REVIEW: cmdSql prepares query twice on the single-statement path (probe + run)

## Notes (1)

### #1 by code-reviewer-1, 2026-05-08T11:32:53.271Z

```
FILES:
  src/cli.ts:2895-2908 (the probe block) + 2976/3000/3026 (re-prepare sites)

FINDINGS: cmdSql probes whether `query` is a single statement by calling `db.prepare(trimmed)` inside a try/catch; if it doesn't throw "more than one statement", we then THROW AWAY the prepared statement and re-prepare via `db.prepare(trimmed).all()` / `.run()` further down.

  let isMulti = false;
  try {
    db.prepare(trimmed);              // <-- result discarded
  } catch (err) {
    ... isMulti = true ...
  }

  if (isMulti) { ... db.exec(...) ... }
  else if (isRead) {
    const rows = db.prepare(trimmed).all();   // <-- prepared a SECOND time
  } else {
    const result = db.prepare(trimmed).run(); // <-- third site, also re-prepares
  }

WHY IT MATTERS: cosmetic perf cost (negligible — better-sqlite3 caches statements internally) but the real smell is that the comment at line 2898 says "Otherwise re-prepare in-line below so TS keeps type inference" — which is admitting the design isn't right ("we re-do work for type inference"). better-sqlite3's Statement IS the typed handle; capturing it once would be more idiomatic and remove the pattern of "throw away the result of prepare()".

SUGGESTED FIX (~10 LOC): capture the statement when probing:

  let stmt: ReturnType<typeof db.prepare> | undefined;
  let isMulti = false;
  try {
    stmt = db.prepare(trimmed);
  } catch (err) {
    if (/more than one statement/i.test(...)) isMulti = true;
    else throw err;
  }

  if (!isMulti) {
    // use stmt.all() / stmt.run() directly — already prepared
  }

ALTERNATIVES CONSIDERED:
  - "leave it, prepare is fast": agreed it's not a perf bug, but the "re-prepare for type inference" comment is the wrong design rationale and will mislead future readers.

EVIDENCE: src/cli.ts:2898 comment text. The probe pattern (try/catch on prepare without using the result) is itself suspicious — cmdSql is the only place in the codebase that does it.
```
