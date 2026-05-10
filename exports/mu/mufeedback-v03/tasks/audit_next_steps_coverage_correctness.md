---
id: "audit_next_steps_coverage_correctness"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: "worker-5"
created_at: "2026-05-10T13:25:12.869Z"
updated_at: "2026-05-10T13:36:12.515Z"
blocked_by: []
blocks: []
---

# audit: every CLI verb's success/error nextSteps — verify (1) presence on every verb (2) correctness post-v0.3 (no removed verbs / wrong flags)

## Notes (2)

### #1 by π - mu, 2026-05-10T13:26:04.440Z

```
Audit every CLI verb's success and error nextSteps: presence + correctness post-v0.3.

═══ THE FRAMING ═══

Every mu verb is supposed to print a 'Next:' block on success and an 'errorNextSteps()' block on typed errors. That contract was set in selfdoc_design (v0.2). Post-v0.3 + the doc-staleness review surfaced lots of 'verbs cited that don't exist' / 'flags renamed' issues — same risk applies to nextSteps payloads. Bad nextSteps point operators at non-existent verbs.

═══ DELIVERABLE ═══

PART 1 — COVERAGE AUDIT (every verb has nextSteps)
  - Find every command registration in src/cli.ts + src/cli/*.ts (every program.command(...) and subcommand .action()).
  - For each: verify the success path emits a nextSteps array (printNextSteps() in plain mode; nextSteps field in --json).
  - For each typed error in src/*/errors.ts: verify it implements HasNextSteps and the errorNextSteps() returns ≥1 hint.
  - File ONE finding task per missing-coverage gap (verb without success nextSteps; typed error without errorNextSteps).

PART 2 — CORRECTNESS AUDIT (every nextSteps hint is current)
  Check every hint string for stale references:
  - Removed verbs: mu hud, mu approve *, mu whoami, mu my-tasks, mu my-next
  - Renamed flags / removed flags: --workstreams (replaced by -w variadic), --reopen (rescoped to un-close only; bare release auto-flips IN_PROGRESS→OPEN now)
  - Schema column references (mu sql snippets in nextSteps): use surrogate-id form (workstream_id, owner_id, from_task_id, to_task_id), NOT the v4 tasks.owner / from_task / to_task / task_notes.task_id forms
  - Verb subcommand existence (e.g. mu archive search exists post-Phase-4b; verify hints don't suggest verbs from a draft design)

  File ONE task per stale reference.

PART 3 — STYLE / CONSISTENCY (low priority; only if structurally off)
  - Hint phrasing convention: 'Verb to call' (intent) + 'shell command' (command). Verify the JSON shape uses { intent, command }.
  - One-line shell commands (no embedded shell loops; multi-line should be a recipe in USAGE_GUIDE, not a hint).
  - Don't suggest deprecated patterns (e.g. raw sqlite3 instead of mu sql).

═══ HOW TO AUDIT ═══

Find every emit:
  grep -rEn 'printNextSteps|nextSteps:|errorNextSteps' src/

For each verb: read the surrounding context to understand intent; verify hints match current main.

Cross-check against SKILL.md verb list (post-v0.3) and CHANGELOG.md ### Removed list. Anything cited in nextSteps not in SKILL = stale.

═══ FILE-AS-SEPARATE-TASKS PATTERN (mirror reviewer-1/2/3) ═══

For each finding:
  mu task add <auto-id> -w mufeedback-v03 --title 'nextsteps-audit: <one-liner>' --impact <N> --effort-days <N>
  mu task note <id> -w mufeedback-v03 'FILES: src/...:LINE
FINDING: ...
CURRENT-HINT: ...
STALE-BECAUSE: ...
FIX-SKETCH: ...'

Cap ~12 filings; quality > quantity.

═══ EXPECTED VOLUME ═══

Likely findings: ~5-15. The doc-staleness reviewer already noted 'mu sql snippets in SKILL/USAGE_GUIDE/ROADMAP/VERB_AUDIT use v4 columns' — same drift will appear in nextSteps strings. The renamed --reopen / removed mu approve will also show up.

═══ SCOPE ═══

  src/cli.ts, src/cli/*, src/agents/errors.ts, src/tasks/errors.ts, src/db.ts errors, src/snapshots.ts, src/workspace.ts, src/exporting.ts, src/importing.ts, src/archives.ts errors, src/workstream.ts errors. Comprehensive but each file is small.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am 'docs/audit: <summary>' THEN mu task close audit_next_steps_coverage_correctness -w mufeedback-v03 --evidence 'audited N verbs + M typed errors; filed K finding tasks'

(If you only file finding-tasks and don't change code, the commit is just the SUMMARY note + close; no git commit needed.)
```

### #2 by worker-5, 2026-05-10T13:36:02.646Z

```
SUMMARY (worker-5):
Audited every CLI verb (~50 verbs across src/cli/*.ts) and every typed error class (~25 classes across src/{tasks,agents}/errors.ts, src/{snapshots,workspace,workstream,archives,importing,db,tmux}.ts) for nextSteps coverage + correctness.

═══ COVERAGE (PART 1) ═══
- Every TYPED ERROR has errorNextSteps() implementing HasNextSteps. 0 gaps. ✅
- Every MUTATING verb prints a Next: block on success. 0 gaps. ✅
- Most READ-ONLY verbs print NO Next: block. ~17 verbs. SKILL.md asserts the contract universally; reality is mutating-only. Filed as 1 task (coverage/clarification gap).

═══ CORRECTNESS (PART 2) ═══
4 stale references found (filed 1 task each):
  1. nextsteps_audit_task_not_found_workstream_col — TaskNotFoundError SQL recipe references tasks.workstream (v4 column; v5+ uses workstream_id INTEGER FK). RUNTIME-BREAKING. impact 70.
  2. nextsteps_audit_cross_workstream_edge_v4_columns — CrossWorkstreamEdgeError ditto: TWO mu sql hints reference tasks.workstream + workstreams rename without UNIQUE-collision check. RUNTIME-BREAKING + DATA-LOSS RISK. impact 60.
  3. nextsteps_audit_sql_db_flag_does_not_exist — SnapshotVersionMismatchError suggests `mu sql --db <path>`; flag does not exist on `mu sql`. RUNTIME-BREAKING. impact 50.
  4. nextsteps_audit_workspace_orphans_phantom_verb — `mu workspace orphans` hint suggests `mu workspace adopt` (admits "deferred; see roadmap" but nothing in ROADMAP.md). impact 30.

═══ STYLE (PART 3) ═══
1 borderline finding filed:
  5. nextsteps_audit_snapshot_show_raw_sqlite3 — cmdSnapshotShow + SnapshotVersionMismatchError both suggest raw sqlite3 against snapshot files. Lukewarm: technically works (snapshot is a different DB) but contradicts the "no raw sqlite3" convention. Pairs with #3. impact 25.

═══ NO-FINDING NEGATIVES (good news) ═══
- No removed-verb references found. SKILL.md "Removed in v0.3" list (`mu hud`, `mu approve`, `mu whoami`, `mu my-tasks`, `mu my-next`) does NOT appear in any nextSteps `command` string. (References to `mu hud` exist in COMMENTS at src/output.ts, src/reconcile.ts, src/agents.ts, src/tmux.ts, src/tasks.ts but those are doc comments, not nextSteps payloads.)
- No `--workstreams` (replaced by -w variadic) references in nextSteps.
- `--reopen` references (1 in src/tasks/errors.ts:349 StallDetectedDuringWaitError, 1 in src/cli/tasks/wire.ts:287 the flag itself) match the RESCOPED semantics post-`review_release_open_in_progress_inconsistency` — the StallDetected hint correctly invokes --reopen on a CLOSED-target wait abandonment, which is exactly the un-close escape-hatch case the rescope kept.
- Hint shape uniformly { intent, command }. No multi-line shell loops in any hint. ✅
- All hints under cap (single-line shell commands).

═══ TOTAL ═══
Filed 6 finding tasks (under the cap of ~12). 4 are real correctness issues (3 v4-schema-drift + 1 phantom verb); 1 is style/borderline; 1 is a coverage/doc clarification gap. Recommend tackling #1, #2, #3, #4 as a single 1-day batch (all <30 LOC each, share the v5-schema-recipe fix vocabulary).
```
