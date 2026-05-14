---
id: "testreview_json_shape_weak_assertions"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.3
roi: 116.67
owner: "worker-3"
created_at: "2026-05-12T11:17:43.509Z"
updated_at: "2026-05-12T13:35:33.041Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# TEST REVIEW: JSON shape tests use Array.isArray without constraining content

## Notes (3)

### #1 by "worker-3", 2026-05-12T11:17:50.448Z

```
FILES: test/state-render.test.ts:73-88 and 96-106; test/json-output.test.ts:284-302 and 311-319; test/cli-task-notes-filters.test.ts:234-242; test/workspace-commits.test.ts:303-313.
FINDING: Several JSON contract tests only assert that fields are arrays or strings, not that seeded data is present with the expected semantics. Examples: state --json checks agents/orphans/tracks/etc are arrays but only constrains ready.length; agent list --json accepts any agents/orphans arrays because the fake pane may be pruned; task notes --json checks {items,count} but not note contents in that specific envelope test; jj commitsSinceBase checks CommitSummary field types but no actual commit. These tests can pass if data-producing code silently returns empty arrays or drops fields from seeded rows.
RECOMMENDED FIX: For each JSON shape test, seed deterministic rows and assert at least one representative object per array contains expected names/statuses/titles/workstream fields. Where reconciliation prunes fake agents, use a mocked tmux executor or real tmux integration so agent list can assert a live seeded agent instead of only shape. Keep pure schema-shape checks only as a supplement after content assertions, not as the whole test.
VERIFIED: audit only; no code changed.
```

### #2 by "worker-3", 2026-05-12T13:35:32.295Z

```
FILES: test/state-render.test.ts; test/json-output.test.ts; test/cli-task-notes-filters.test.ts; test/workspace-commits.test.ts; CHANGELOG.md
COMMANDS: npx vitest run test/state-render.test.ts test/json-output.test.ts test/cli-task-notes-filters.test.ts test/workspace-commits.test.ts (pass); npm run typecheck (pass); npm run lint (pass); npm run test (first run exposed unrelated existing cli-task-wait integration timeout, immediate rerun pass); npm run build (pass)
FINDINGS: JSON contract tests were accepting array-shaped output without proving seeded data survived.
DECISION: Seed deterministic agent/task/note/jj-commit rows and assert representative names/titles/statuses/ROI/event/note/commit semantics in JSON envelopes. Mocked tmux for json-output so agent list asserts a live seeded worker rather than fake-pane pruning.
NEXT: Fixed-sleep integration test rewrite remains as separate commit/task.
VERIFIED: Four greens completed after change: typecheck, lint, full test suite rerun, build.
ODDITIES: Full test suite first run timed out in existing cli-task-wait.integration cross-ws case; rerun of npm run test passed all 123 files / 2032 tests.
```

### #3 by "worker-3", 2026-05-12T13:35:33.041Z

```
CLOSE: 04235a3: JSON shape tests assert seeded semantics; four greens passed
```
