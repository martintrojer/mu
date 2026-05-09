---
id: "review_code_classify_error_called_twice"
workstream: "mufeedback"
status: CLOSED
impact: 20
effort_days: 0.05
roi: 400.00
owner: null
created_at: "2026-05-08T11:31:35.246Z"
updated_at: "2026-05-08T11:46:39.239Z"
blocked_by: []
blocks: []
---

# REVIEW: classifyError called twice in handle() — once for emitError, once for exit

## Notes (1)

### #1 by code-reviewer-1, 2026-05-08T11:31:35.362Z

```
FILES:
  src/cli.ts:282-294 (handle wrapper)

FINDINGS:

  function handle(fn: (db: Db) => Promise<void>): () => Promise<void> {
    return async () => {
      let db: Db | undefined;
      try {
        db = openDb();
        await fn(db);
      } catch (err) {
        emitError(err);                           // calls classifyError(err) internally
        process.exit(classifyError(err).exitCode); // calls it AGAIN
      } finally { ... }
    };
  }

classifyError walks an instanceof chain over ~13 error classes; calling it twice for the same error is wasteful (microscopic but visible if a test prints 1000 errors) AND, more importantly, encodes the assumption that classifyError is idempotent and side-effect-free. If a future contributor adds logging or counter-incrementing inside classifyError, the double-call silently doubles it.

WHY IT MATTERS: tiny correctness/perf nit but a real code smell. The shape "compute classification, use it twice" is one obvious refactor away.

SUGGESTED FIX (~5 LOC): hoist the classification once.

  } catch (err) {
    const { exitCode } = emitError(err);  // emitError returns the classification
    process.exit(exitCode);
  }

Or:

  } catch (err) {
    const classification = classifyError(err);
    emitError(err, classification);
    process.exit(classification.exitCode);
  }

The first shape is smaller and removes the responsibility of caller-side classification.

ALTERNATIVES CONSIDERED:
  - "leave it, classifyError is fast": works today; brittle to future change.

EVIDENCE: src/cli.ts:289 + 290 — both call `classifyError(err)` on the same `err`.
```
