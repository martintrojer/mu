---
id: "bug_mu_sql_delete_no_confirm"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 80
effort_days: 0.4
roi: 200.00
owner: null
created_at: "2026-05-08T07:22:04.340Z"
updated_at: "2026-05-08T07:37:03.515Z"
blocked_by: []
blocks: []
---

# BUG: mu sql DELETE silently deletes; needs --confirm-rows N or affected-row preview

## Notes (2)

### #1 by system, 2026-05-08T07:22:04.470Z

```
Surfaced just now while cleaning up dogfood test rows for nit_long_auto_slug.

Reproduction (the actual sequence that just hit me):

  $ mu task add ... --title "very long real title with > 100 chars ..." (the bug fix file)
  $ ...
  $ mu task add temp_dogfood -w roadmap-v0-2 --title "Short title" ...   # dogfood test row
  # Run dogfood; verify slug behaviour.
  # Cleanup attempt:
  $ mu sql "DELETE FROM tasks WHERE workstream='roadmap-v0-2' AND (title='Short title' OR title LIKE 'NIT: this is exactly%' OR length(title) > 100)"
  8 rows affected
  # Realised that length(title) > 100 matched 5 REAL TASKS (snap_design, nit_workstream_name_mu_prefix, nit_long_auto_slug, bug_workstream_name_dot_mangle, nit_blocks_flag_naming) plus the 3 dogfood test rows. Notes + edges cascaded.

Lost data:
  - 5 task rows (recoverable from agent_logs via INSERT)
  - All notes on those tasks (FK CASCADE; partially recoverable from agent_logs payloads if `task note <id>` payloads include the content, which they don't — only the metadata note #N appears in events)
  - 1 edge (snap_design -> snap_schema; recovered)

Root cause: mu sql is a power-user escape hatch that runs WITHOUT preview or confirmation. better-sqlite3 happily executes DELETE/UPDATE statements that match more rows than intended.

Proposed fix:
  Option (a) Pre-flight count for write statements: parse the SQL, run the WHERE as a SELECT first, show "X rows would be affected", require --yes (like mu workstream destroy). 
    + Catches the foot-gun.
    - Hard to parse arbitrary SQL safely; UPDATE/DELETE can have CTEs, subqueries.
    - Only catches the specific case; mu sql is supposed to be "I know what I'm doing".
  
  Option (b) --confirm-rows N flag: caller declares expected affected-row count; if the actual count differs, abort the transaction and error.
    + Clean opt-in. Existing scripts that don't pass it are unchanged.
    + Catches typos AND too-greedy WHERE clauses.
    - Forces the caller to know N up front.
  
  Option (c) Wrap multi-row writes in a savepoint that's only committed if the user confirms via stdin prompt.
    + No flag changes; ergonomic for interactive use.
    - Bad for scripts; would need detection for non-tty.
  
  Option (d) Separate verb: mu sql-write that requires --yes; mu sql stays read-only.
    + Cleanest. Maps to the SQLite distinction.
    - Now mu sql can not do DELETE. Workarounds become more verbose.

I lean (b): mu sql "DELETE FROM ... WHERE ..." --confirm-rows 3
  - If the WHERE matches !=3 rows, the verb errors, the txn rolls back, no data lost.
  - For known-N deletes (the mu-rename-recovery use case), explicit and safe.
  - Old usage (mu sql with no flag) keeps working unchanged.
  - Nudges users toward awareness of "how many rows am I touching?".

Implementation: ~30 LOC in cmdSql:
  - Parse for write keywords (UPDATE / DELETE / INSERT / REPLACE).
  - When --confirm-rows is set, wrap in BEGIN; run the statement; check changes; ROLLBACK if mismatch; otherwise COMMIT.
  - Error message: "expected 3 rows, would have affected 8 (rolled back). Re-run with --confirm-rows 8 if intentional."

Promotion criterion: hit ONCE so far (just now), but the cost was severe (5 real tasks lost notes + restoration cost). Worth flagging as a near-miss.

Alternative: ship just the dogfood lesson (always count first with SELECT before running DELETE). But 'mu sql is a power-user escape hatch, you should know better' is exactly the kind of guidance that fails because it's the orchestrator at 2am that hits it.
```

### #2 by system, 2026-05-08T07:37:00.170Z

```
FILES: src/cli.ts, test/sql-multi-statement.test.ts
DIFFSTAT: src/cli.ts +103 -5; test/sql-multi-statement.test.ts +160 -1 (2 files, +262 -7)
VERIFIED: gate green (typecheck + lint + 568 tests + build)
```
