---
id: "tables_truncate_long_cols_audit"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-09T08:29:23.210Z"
updated_at: "2026-05-09T10:46:42.191Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# audit: every Table site sets cli-table3 truncation on its likely-long column(s) so wide cells don't break TUI layout

## Notes (1)

### #1 by "π - mu", 2026-05-09T08:30:08.641Z

```
SURFACED LIVE: `mu workspace list` blew the terminal width during this session — the `path` column rendered the full ~70-char absolute path uncut, pushing the table out to ~200 chars and forcing a horizontal-scrollback or wrap (the wrap actually broke the box-drawing chars in some test/output snapshots). Same shape risk in any verb that emits a Table where one column has user-data of unpredictable length (titles, paths, evidence strings, JSON payloads).

═══ THE FIX SHAPE (cli-table3 truncation) ═══

cli-table3 supports two settings that interact:
  - `colWidths: [w0, w1, ...]` — per-column max width (cells longer than wi are truncated with `…`).
  - `wordWrap: false` — when true (default), cli-table3 word-wraps; when false + colWidths set, it truncates with ellipsis.

The HUD code (src/cli/hud.ts:101) already does this correctly:
  return new Table({ style: { border: [] }, wordWrap: false });
plus src/cli.ts:609 truncate() helper for pre-truncation; combined they guarantee wide cells stay one row tall and don't blow the TUI layout.

The OTHER table sites don't apply this consistently. The ask: audit each Table site, identify its LIKELY-LONG column(s), apply per-column width + wordWrap:false (or pre-truncate via the existing helper).

═══ AUDIT TARGETS ═══

Found via `grep -rn "new Table" src/` — 9 call sites:

  1. src/cli.ts:282    formatAgentsTable
                       Likely-long: window (could be long), role
                       Likely-fine: name (32-char cap), cli, status (emoji)
                       
  2. src/cli.ts:331    formatTaskListTable
                       Likely-long: title  (already pre-truncated via truncate(t.title, titleBudget) — VERIFY budget is set when called outside HUD)
                       Likely-fine: id, status, impact, effort, ROI, owner
                       
  3. src/cli.ts:378    formatWorkspacesTable      ← THE ONE THAT BLEW UP TODAY
                       Likely-long: path (~70 chars on this machine)
                       Likely-fine: agent, workstream, backend, parent_ref, behind, created
                       Recommend: path → relative-to-state-dir? OR truncate to ~40 chars from the FRONT (preserving the trailing "<ws>/<agent>" suffix which is the only useful bit). Front-truncation: ".../mufeedback/worker-mf-1".
                       
  4. src/cli.ts:459    formatWorkstreamsTable
                       Likely-long: name (workstream names are user-chosen)
                       Likely-fine: tmux, agents, tasks, edges, notes (small ints)
                       
  5. src/cli.ts:683    formatTrackTable (or whatever the second cli.ts table is)
                       Inspect during audit — likely the "Tracks (N)" formatter
                       
  6. src/cli/snapshot.ts:266   snapshot list table
                       Likely-long: label (free-text "task close <id> evidence=... long string ...")
                       Likely-fine: id, workstream, created_at, size
                       
  7. src/cli/sql.ts:129       generic SQL result formatter (`mu sql "SELECT ..."`)
                       Likely-long: ANY column (user query). Tricky case.
                       Recommend: per-column truncate to (terminalWidth / numCols) - margin, no smaller than ~12 chars; pre-truncate value via the helper. cli-table3's default behaviour explodes width here.
                       
  8. src/cli/hud.ts:101       newHudTable
                       ALREADY CORRECT (the load-bearing example to mirror).
                       
  9. src/cli/approve.ts:179   approval list table
                       Likely-long: reason (free-text)
                       Likely-fine: slug, status, created_at

═══ SHARED HELPER ═══

Don't sprinkle widths inline. Add a small src/output.ts (or src/cli/_table.ts) helper:

  /** Build a Table with sensible defaults for mu's TUI layout:
   *  wordWrap: false, border styling, and applies the supplied
   *  per-column widths. Caller passes head + widths matching arity.
   */
  export function muTable(opts: {
    head: string[];
    widths?: (number | undefined)[];   // undefined = auto for that col
  }): Table { ... }

Plus a default `terminalWidth()` resolver (or honor a per-table-site choice) — many sites can pick a fixed budget for their long col, but a few (sql, approve, snapshot) want a "fit to terminal" mode.

═══ DON'T ═══

  - Auto-truncate EVERY column. The fix is per-column, on the column the operator is least likely to read in full and most likely to be long.
  - Add wordWrap: true anywhere. The HUD comment explains why.
  - Add a `--full` / `--no-truncate` flag per-verb. Anti-feature; if the operator wants the full path, mu sql or --json gives it.
  - Truncate JSON output. --json must always emit the full value.

═══ TEST PLAN ═══

For each site touched:
  - existing snapshot tests (test/cli-snapshot.test.ts) need NO_COLOR=1 + a fixed terminal width to be deterministic. Set process.stdout.columns in test setup (mirror what test/hud.test.ts does).
  - new test asserting that cells longer than the column width get the `…` suffix.

GATE: typecheck + lint + test + build green. CHANGELOG entry under Changed.

NOTES CONTRACT: standard.

SCOPE GUARD: ~0.3 days. ~20 LOC of helper + ~5 LOC per site (8 sites that need updating, hud already correct) + tests. If the sql.ts case turns out to need a real "fit-to-terminal" algorithm (rather than fixed col widths), file the sql one as a follow-up `tables_truncate_sql_dynamic` and ship the easy 7 first.
```
