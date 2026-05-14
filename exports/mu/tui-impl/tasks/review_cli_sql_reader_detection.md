---
id: "review_cli_sql_reader_detection"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.15
roi: 400.00
owner: "worker-3"
created_at: "2026-05-13T12:38:46.582Z"
updated_at: "2026-05-13T12:56:27.527Z"
blocked_by: []
blocks: []
---

# REVIEW med: mu sql read detection is prefix-based

## Notes (3)

### #1 by "worker-3", 2026-05-13T12:38:46.929Z

```
FILE(S):
  src/cli/sql.ts:101-112

FINDING (non-idiomatic):
  const lower = trimmed.toLowerCase();
  const isRead =
    lower.startsWith("select") || lower.startsWith("with") || lower.startsWith("explain");
  if (opts.confirmRows !== undefined && isRead) {
    throw new UsageError(
      "--confirm-rows is only meaningful on write statements (UPDATE / DELETE / INSERT / REPLACE)",
    );
  }

WHY IT'S A PROBLEM:
  `mu sql` classifies read statements with a hand-written prefix check even though the prepared statement already knows whether it returns rows. Read-only SQL such as `PRAGMA table_info(tasks)` or statements preceded by comments can be routed through `.run()` and produce change-count output instead of rows. That makes the escape hatch less reliable exactly when users are inspecting schema/state.

PROPOSED FIX:
  After `stmt = db.prepare(trimmed)`, use better-sqlite3's statement metadata (`single.reader`) to choose `.all()` vs `.run()` on the single-statement path. Keep the multi-statement `db.exec()` branch unchanged. Add SQL integration tests for `PRAGMA table_info(tasks)` and a comment-prefixed SELECT to prove the read path emits rows and `--confirm-rows` rejects them.

EFFORT NOTE:
  Small localized change in `src/cli/sql.ts`; verify against `test/sql-multi-statement.integration.test.ts` because that file already exercises single vs multi-statement behavior.
```

### #2 by "worker-3", 2026-05-13T12:56:27.153Z

```
FILES: src/cli/sql.ts; test/sql-multi-statement.integration.test.ts; CHANGELOG.md
COMMANDS: npm install (exit 0); npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run test -- test/sql-multi-statement.integration.test.ts (exit 0); npm run build (exit 0); node dist/cli.js --help (exit 0); manual dist smoke for PRAGMA/comment-prefixed SELECT (exit 0, rows returned)
FINDINGS: better-sqlite3 Statement.reader is true for PRAGMA table_info(...) and comment-prefixed SELECT; prefix detection was the misroute.
DECISION: Single-statement mu sql now uses stmt.reader for --confirm-rows validation and all() vs run() routing; multi-statement db.exec branch unchanged. Added allowUnknownOption on sql so a quoted SQL query beginning with -- reaches the handler.
VERIFIED: targeted integration test covers PRAGMA rows, comment-prefixed SELECT rows, and --confirm-rows rejection on PRAGMA; fast/typecheck/lint/build green.
NEXT: none.
ODDITIES: npm install ran prepare/build because node_modules was absent in this workspace.
```

### #3 by "worker-3", 2026-05-13T12:56:27.527Z

```
CLOSE: 29a7e93: stmt.reader routes single-stmt path; PRAGMA + comment-prefixed SELECT now return rows
```
