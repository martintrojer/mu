---
id: "test_review"
workstream: "mubugs"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-15T10:51:18.952Z"
updated_at: "2026-05-15T11:39:29.593Z"
blocked_by: ["collapse_status_only_mode"]
blocks: []
---

# Test review: reconciler mode collapse (file findings as new blockers of umbrella)

## Notes (4)

### #1 by "π - mu", 2026-05-15T10:53:53.106Z

```
TASK
====
Read the test diff for the reconciler mode-collapse and file findings as new tasks (tr_<slug>) blocking the umbrella. Do NOT add tests yourself; you are a reviewer.

PRECONDITION
============
Both impl tasks closed and cherry-picked.

SCOPE
=====
- test/reconcile.test.ts diff
- Any test file that referenced status-only and was either rewritten or deleted
- Any test that exercised the placeholder-skip path
- The wholesale-tmux-crash regression test (must exist; verify against the bug's repro recipe)

CHECKLIST
=========
- Wholesale-tmux-crash regression test: does it use a mocked tmux executor that returns empty pane list AND sessionExists=false? Does it assert the FULL reap chain (agent deletion + IN_PROGRESS → OPEN + [reaper] note + task reap event)?
- Placeholder skip test: in `full` mode AND `report-only` mode (post-collapse, the only two modes left), does the placeholder agent survive a reconcile pass when not in tmux's pane list?
- Behavioral coverage vs implementation coverage: do the tests assert OBSERVABLE outcomes (DB row absence, task status, event log entries) or just internal counters?
- Are deleted status-only-specific tests really redundant, or did they encode behavior that's now untested?
- Concurrency: are tests using unique temp DBs / mocked tmux? (No real tmux required for this work.)
- Fast-tier discipline: pure unit tests in *.test.ts; no fixed sleeps > 50ms; no real tmux subprocess spawning.

FILE FINDINGS AS
================
  mu task add tr_<short_slug> -w mubugs --title "Test review: <one-liner>" --impact <50-80> --effort-days <0.1-0.3>
  mu task note tr_<short_slug> -w mubugs "FILE: <test file>:<test name>
WHAT'S MISSING/WRONG: ...
WHY IT MATTERS: <bug that could escape>
SUGGESTED FIX: ...
SEVERITY: <high/medium/low>"
  mu task block umbrella --by tr_<short_slug> -w mubugs

If ZERO findings: drop a clean-review note on this task and close.

⚠️ FINAL ACTION
==============
mu task note test_review -w mubugs "TEST FILES REVIEWED: <list>
FINDINGS: <count>, <comma-separated tr_ ids>
VERDICT: <ship-with-fixes | ship-clean | block-on-major-issue>"
mu task close test_review -w mubugs --evidence 'reviewed N test files, filed M finding tasks (tr_*)'

CONSTRAINTS
- DO NOT EDIT TEST OR PRODUCTION CODE.
- DO NOT COMMIT in this task; only create new mu tasks + notes.
- Use the test-reviewer skill if loaded.
```

### #2 by "π - mu", 2026-05-15T11:30:36.843Z

```
You are worker-2 in workstream `mubugs`. Claim is set on you for `test_review`.

YOUR TASK: test_review — review the test diff for the reconciler mode-collapse. File findings as new tasks (tr_<slug>) blocking the umbrella. Do NOT add tests yourself; you are a reviewer.

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w mubugs
  mu task notes test_review -w mubugs

STEP 2 — read the test diff. Relevant commits:
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-2
  git log --oneline 3f75a8b..HEAD
  git diff 3f75a8b..HEAD -- test/reconcile.integration.test.ts
  git diff 3f75a8b..HEAD -- test/workspace-staleness.integration.test.ts
  git diff 3f75a8b..HEAD -- test/   # any other test that was rewritten/deleted

The three relevant commits are:
  - fd181a4 reconcile: skip placeholder pane ids in prune loop (defensive, all modes)
  - eb3c6fc reconcile: collapse status-only into full; mu state now reaps lost sessions
  - e0ace82 tests: workspace-staleness uses placeholder pane id post-collapse  ← orchestrator fixup

STEP 3 — apply the test_review checklist. For each ACTIONABLE finding:

  mu task add tr_<short_slug> -w mubugs \
    --title "Test review: <one-liner>" \
    --impact <50-80> --effort-days <0.1-0.3>
  mu task note tr_<short_slug> -w mubugs "FILE: <test file>:<test name>
WHAT'S MISSING/WRONG: ...
WHY IT MATTERS: <bug that could escape>
SUGGESTED FIX: ...
SEVERITY: <high/medium/low>"
  mu task block umbrella --by tr_<short_slug> -w mubugs

THINGS WORTH SPECIFICALLY CHECKING (NOT EXHAUSTIVE):
- Wholesale-tmux-crash regression test: does it exist? Does it use a mocked tmux executor returning empty pane list? Does it assert the FULL reap chain (agent deletion + IN_PROGRESS → OPEN + [reaper] note + task reap event)? Or does it only assert one observable?
- Placeholder skip test: covers full mode AND report-only mode (the only two surviving)?
- Behavioral coverage vs implementation coverage: do tests assert OBSERVABLE outcomes (DB row absence, task status, event log entries) or just internal counters like prunedGhosts?
- Are deleted status-only-specific tests really redundant, or did they encode behavior that's now untested?
- The orchestrator's e0ace82 fixup is a classic "test was relying on the suppressed reaper". Are there OTHER tests that would have failed for the same reason but weren't caught? Use `rg -n 'insertAgent.*paneId' test/` and check whether each test ALSO exercises mu state / mu agent list — those are the tests at risk.
- Concurrency safety: tests use unique temp DBs / mocked tmux?
- Fast-tier discipline: pure unit tests in *.test.ts; no real tmux subprocess spawning; no fixed sleeps > 50ms?

If ZERO findings: drop a clean-review note + close.

STEP 4 — verify findings:
  mu task tree umbrella -w mubugs

STEP 5 — final note + close:
  mu task note test_review -w mubugs "TEST FILES REVIEWED:
- test/reconcile.integration.test.ts
- test/workspace-staleness.integration.test.ts (orchestrator fixup)
- (any others touched in 3f75a8b..HEAD)
- (any tests at risk per the rg-driven sweep above)

FINDINGS: <count>, <comma-separated tr_ ids>
VERDICT: <ship-clean | ship-with-fixes | block-on-major-issue>"
  mu task close test_review -w mubugs --evidence 'reviewed N test files, filed M finding tasks (tr_*)'

CONSTRAINTS
- DO NOT EDIT TEST OR PRODUCTION CODE.
- DO NOT COMMIT in this task; only create new mu tasks + notes.
- Use the test-reviewer skill if loaded.
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-2 (just spawned, fresh from current main).

COORDINATION WARNING
- worker-1 is in parallel on code_review. No file overlap.
```

### #3 by "worker-2", 2026-05-15T11:39:29.268Z

```
TEST FILES REVIEWED:
- test/reconcile.integration.test.ts
- test/workspace-staleness.integration.test.ts (orchestrator fixup)
- test/agent-idle.test.ts
- test/doctor-summary.integration.test.ts
- test/state-helpers.integration.test.ts
- test/tui-app-behaviour.test.ts
- test/tui-card-agents.test.ts
- test/tui-card-blocked.test.ts
- test/tui-card-commits.test.ts
- test/tui-card-doctor.test.ts
- test/tui-card-inprogress.test.ts
- test/tui-card-log.test.ts
- test/tui-card-ready.test.ts
- test/tui-card-recent.test.ts
- test/tui-card-row-budget.test.ts
- test/tui-card-tracks.test.ts
- test/tui-card-workspaces.test.ts
- test/tui-mouse-doubleclick.test.ts
- test/tui-popup-agents.test.ts
- test/tui-popup-commits.test.ts
- test/tui-popup-doctor.test.ts
- test/tui-popup-filter-drill-pinning.test.ts
- test/tui-popup-log.test.ts
- test/tui-popup-recent.test.ts
- test/tui-popup-workspaces.test.ts
- test/tui-state-hook-rerender.test.ts
- test/tui-state-slow-tick.test.ts
- test/tui-status-column-color.test.ts
- test/verbs-listlive.integration.test.ts
- rg-driven insertAgent/paneId sweep reviewed likely mu state / mu agent list / listLiveAgents risk files: test/json-output.integration.test.ts, test/state-render.integration.test.ts, test/state-dispatch.integration.test.ts, test/state-helpers.integration.test.ts, test/cli-task-wait-nextsteps.integration.test.ts, test/acceptance.integration.test.ts, test/verbs-listlive.integration.test.ts, test/agent-idle.test.ts, workspace/staleness-related fixtures.

FINDINGS: 2, tr_state_crash_entrypoint, tr_placeholder_report_only
VERDICT: ship-with-fixes
```

### #4 by "worker-2", 2026-05-15T11:39:29.593Z

```
CLOSE: reviewed 29 touched test files plus rg-driven risk sweep, filed 2 finding tasks (tr_*)
```
