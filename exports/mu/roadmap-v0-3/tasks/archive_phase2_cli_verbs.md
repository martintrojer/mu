---
id: "archive_phase2_cli_verbs"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 75
effort_days: 0.7
roi: 107.14
owner: null
created_at: "2026-05-09T17:14:41.643Z"
updated_at: "2026-05-10T05:48:44.426Z"
blocked_by: ["archive_phase1_schema_sdk"]
blocks: ["archive_phase3_destroy_integration", "archive_phase4_export_renderer_unified", "archive_phase4b_search"]
---

# Phase 2: mu archive create/list/show/add/remove/delete CLI verbs (src/cli/archive.ts)

## Notes (2)

### #1 by π - mu, 2026-05-09T17:16:34.836Z

```
Phase 2 — mu archive create/list/show/add/remove/delete CLI verbs.

DEPENDS ON: Phase 1 (archive_phase1_schema_sdk) must close — schema + SDK must be live.

═══ CLI SHAPE (src/cli/archive.ts, NEW file, ~250 LOC including help text) ═══

Mounted under `mu archive <subcommand>` in src/cli.ts (one new program-level subcommand registration; same pattern as `mu workspace`).

Verbs:
  mu archive create <label> [--description "..."]
  mu archive list                                       # tabular: label | tasks | sources | created | last_added
  mu archive show <label>                               # detail card: per-source-ws task count + dates + status breakdown
  mu archive add <label> -w <workstream> [--destroy]    # archive ws content; --destroy cascades to mu workstream destroy --yes after success
  mu archive remove <label> -w <workstream>             # un-archive a single source ws (rare; recovery)
  mu archive delete <label> [--yes]                     # destructive; dry-run by default; auto-snapshot first

Every verb gains --json (universal flag); JSON shape matches the SDK's return type, camelCase keys throughout.

═══ PER-VERB SPEC ═══

`mu archive create <label> [--description "..."]`
  → SDK: createArchive(db, label, description)
  → Output: "Created archive <label>." + Next: hints (mu archive add <label> -w <ws>; mu archive list)
  → Errors:
      ArchiveAlreadyExistsError → exit 4, hint: mu archive show <label>
      ArchiveLabelInvalidError → exit 2

`mu archive list`
  → SDK: listArchives(db)
  → Empty: "(no archives)" + Next: mu archive create <label>
  → Tabular: label | tasks | sources | created | last_added (relative-time formatting like mu task ready)

`mu archive show <label>`
  → SDK: getArchive(db, label)
  → Output: detail card (label, description, created, last-added, total tasks, per-source-workstream summary table)
  → Errors: ArchiveNotFoundError → exit 3

`mu archive add <label> -w <workstream> [--destroy]`
  → Required: --workstream (or qualified: <archive>/<ws-or-something>; KEEP IT SIMPLE — require -w explicitly).
  → SDK: addToArchive(db, label, workstream)
  → If --destroy: after success, call destroyWorkstream(db, { workstream }) WITH --yes semantics; print combined report.
  → Output: "Added <ws> to archive <label> (added=N, skipped_existing=S)." + Next: hints
  → Errors:
      ArchiveNotFoundError → exit 3, hint: mu archive create <label>
      WorkstreamNotFoundError → exit 3
  → KEY: DO NOT auto-create the archive on add. Operator must explicitly create. Anti-feature pledge: no "default" archive.

`mu archive remove <label> -w <workstream>`
  → SDK: removeFromArchive(db, label, sourceWorkstream)
  → Output: "Removed <ws> from archive <label> (removed_tasks=N, removed_edges=M, removed_notes=K)." + Next
  → Errors: ArchiveNotFoundError → exit 3

`mu archive delete <label> [--yes]`
  → Dry-run by default (mirror mu workstream destroy two-phase pattern).
  → --yes: captureSnapshot first; SDK deleteArchive(db, label).
  → Output: dry-run mode prints what would be cleaned (count of tasks/edges/notes/events); --yes prints "Deleted archive <label>."
  → Errors: ArchiveNotFoundError → exit 3

═══ CLI INTEGRATION POINTS (src/cli.ts) ═══

  - One new `program.command('archive')` registration that delegates to src/cli/archive.ts (mirror src/cli/workspace.ts wiring).
  - The --workstream (-w) flag works via command.optsWithGlobals() per the AGENTS.md commander gotcha.
  - handle() wrapping: ArchiveNotFoundError, ArchiveAlreadyExistsError, ArchiveLabelInvalidError get added to classifyError() with their exit codes.

═══ TESTS (test/archive-cli.test.ts, ~150 LOC) ═══

Drive each verb via the CLI entrypoint (or via the SDK + format-result helpers if the existing test pattern prefers SDK-level coverage; mirror test/workspace-cli.test.ts shape).

  1. create + list + show round-trip; verify JSON shape.
  2. create with invalid label → ArchiveLabelInvalidError; exit 2.
  3. create duplicate → ArchiveAlreadyExistsError; exit 4.
  4. add + remove + show: per-source-ws counts.
  5. add --destroy: workstream gone after add succeeds; archive intact.
  6. add --destroy where archive doesn't exist: errors WITHOUT destroying the workstream (atomicity invariant).
  7. delete dry-run: archive still exists; delete --yes: cascade-cleans every archived_* row + records snapshot.

═══ DOCS ═══

  docs/USAGE_GUIDE.md: new "Archives" section between "Workstreams" and "Snapshots". Include the bucket-pattern example (Pattern A/B/C from anchor-task addendum).
  docs/VOCABULARY.md: confirm Phase 1's vocab additions land before this PR.
  skills/mu/SKILL.md: add the 6 archive verbs to the verb list.
  CHANGELOG.md: extend the v0.3 section with "Archives — feature complete (verbs + SDK)".

═══ ANTI-FEATURE GUARDRAILS ═══

  - DO NOT add `mu archive auto-add-on-destroy`. Explicit per-call.
  - DO NOT add `mu archive merge` or `mu archive rename`. Operator-managed via mu sql.
  - DO NOT add `mu archive un-archive` (re-import to live workstream). Out of scope; operator can do it via mu sql + mu workstream init + mu task add. Documented in anti-features.
  - DO NOT auto-detect archive label vs workstream name. Separate verb namespaces.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close archive_phase2_cli_verbs -w roadmap-v0-3 --evidence 'typecheck + lint + test + build green; six verbs + tests + docs'
```

### #2 by worker-1, 2026-05-10T05:48:27.828Z

```
FILES
  src/cli/archive.ts (NEW, 482 LOC incl comments+wiring): cmdArchiveCreate / List / Show / Add / Remove / Delete + wireArchiveCommands. Mirrors src/cli/workspace.ts wiring shape; subcommand group mounted via wireArchiveCommands(program). --json on every verb. Two-phase delete (dry-run by default, --yes captures pre-delete snapshot via captureSnapshot then calls deleteArchive). add --destroy: precheck via getArchive() FIRST so a missing archive errors WITHOUT touching the source workstream (atomicity invariant), then addToArchive, then destroyWorkstream. add/remove use optsWithGlobals() per AGENTS.md commander gotcha.
  src/cli.ts: registered wireArchiveCommands(program) after wireWorkstreamCommands; added 3 archive errors to classifyError() — ArchiveNotFoundError → exit 3, ArchiveAlreadyExistsError → exit 4, ArchiveLabelInvalidError → exit 2.
  test/archive-cli.test.ts (NEW, 363 LOC): 13 tests via runCli() — 7-case coverage from the task design note (round-trip + JSON shape; invalid label exit 2; duplicate exit 4; show missing exit 3; add+remove with per-source counts; --destroy cascade; --destroy with missing archive — atomicity check; delete dry-run vs --yes + snapshot capture).
  CHANGELOG.md: appended "mu archive create/list/show/add/remove/delete — feature complete (6 verbs + tests + docs)" entry to v0.3.0 unreleased section.
  docs/USAGE_GUIDE.md: NEW §15.5 "Archives — cross-workstream preservation of task graphs" between Cleanup and the demo script. Includes Pattern A/B/C bucket-pattern examples per anchor-task addendum and the three "anti-features" callouts.
  skills/mu/SKILL.md: NEW "Archives (6)" verb-list block after "Snapshots + undo (3)" — same one-liner style.

COMMANDS
  npm install (worktree had no node_modules; standard for fresh worktrees)
  npm run typecheck && npm run lint && npm run test && npm run build
  Smoke: rm -f /tmp/mu-archive-smoke.db && MU_DB_PATH=/tmp/mu-archive-smoke.db node dist/cli.js archive create demo / list / show --json — verified table render + JSON shape + the 3 typed-error exit codes (2/3/4) fire as designed.

FINDINGS
  - addNote signature in test setup: source uses (db, taskLocalId, content, { workstream, author }) NOT (db, id, ws, author, content). First test run blew up on "no such task: design"; one-line fix.
  - Biome's useTemplate rule would otherwise have suggested unsafe template-literal rewrites on multi-line `'...' + pc.dim('...')` patterns; I rewrote them to single template literals manually (per AGENTS.md "do NOT run biome --unsafe").
  - The task note suggested the SDK already exposes everything needed — verified: src/archives.ts ships getArchive (used as the precheck), addToArchive, removeFromArchive, deleteArchive plus the 3 typed errors. No SDK additions needed in Phase 2.
  - destroyWorkstream returns a DestroyResult with deletedTasks/deletedAgents/etc fields; I plumbed the relevant ones into the --destroy human + JSON output. Skipped the auto-export (`mu workstream destroy`'s exportWorkstream hook) deliberately for the --destroy cascade — the archive already preserves the structured state, exporting markdown to disk would be redundant noise. Documented inline.
  - delete --yes captures a snapshot with workstream=null (machine-wide) — same convention as workstream destroy's pre-mutation snapshot. snap_design "EDGE CASES > WORKSTREAM DESTROY" rationale applies verbatim to archives.

DECISION
  - cmdArchiveAdd does an explicit getArchive() precheck even though addToArchive() throws ArchiveNotFoundError on its own. Reason: the precheck guarantees the --destroy short-circuit cannot fire when the archive is missing. addToArchive's check is inside its transaction, which would still throw before destroy runs, but the explicit precheck makes the atomicity invariant easier to read AND lets test 6 (the "atomicity" test) assert the invariant directly via the exit code.
  - I used optsWithGlobals() for add/remove (the two -w-taking verbs). workspace.ts uses .opts() since each subcommand declares its own -w; tasks/wire.ts uses optsWithGlobals(). Both work; I matched tasks/wire.ts for two reasons: (1) consistency with the most-recently-added verb cluster, and (2) it lets `mu -w foo archive add bar` work when -w appears at the program level. opts() would force -w to come AFTER the subcommand.
  - Re-exported the 3 Archive*Error classes from src/cli/archive.ts so test files have one place to import from. Optional but matches the cli/snapshot.ts re-export shape.

NEXT
  Phase 3: hook addToArchive into destroyWorkstream via a `mu workstream destroy --archive <label>` flag. The cli.ts plumbing is straightforward — destroyWorkstream gains an opts.archive param; the cli/workstream.ts wrapper calls addToArchive BEFORE destroyWorkstream when --archive is supplied. ~30 LOC per the design note.
  Phase 4: extend exportWorkstream renderer to render archive contents (one .md per archived_tasks row, grouped by source_workstream).
  Phase 4b: mu archive search verb (LIKE over archived titles + notes).

VERIFIED
  npm run typecheck: clean.
  npm run lint: clean (biome + 2 grep guards).
  npm run test: 897 tests passing across 35 files (13 new in test/archive-cli.test.ts).
  npm run build: ESM dist/cli.js + dist/index.js + dist/index.d.ts all green.
  Smoke against real binary: typed-error exit codes 2/3/4 all fire as designed; --json shape verified parses cleanly.

ODDITIES
  - Worktree had no node_modules on first cd (had to npm install); same pattern Phase 1 worker-1 noted.
  - The .action(this) commander pattern is sensitive: optsWithGlobals() vs opts() vs Command.opts() all return slightly different shapes. Stayed consistent with cli/tasks/wire.ts for the -w-taking verbs.
```
