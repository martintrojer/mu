---
id: "code_review"
workstream: "mubugs"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-15T10:51:18.630Z"
updated_at: "2026-05-15T11:38:23.074Z"
blocked_by: ["collapse_status_only_mode"]
blocks: []
---

# Code review: reconciler mode collapse (file findings as new blockers of umbrella)

## Notes (4)

### #1 by "π - mu", 2026-05-15T10:53:52.771Z

```
TASK
====
Read the diff for the reconciler mode-collapse feature and file findings as new tasks (cr_<slug>) blocking the umbrella. Do NOT fix anything yourself; you are a reviewer.

PRECONDITION
============
Both impl tasks (reconcile_pending_skip + collapse_status_only_mode) are closed and cherry-picked onto main.

SCOPE
=====
- src/reconcile.ts diff (placeholder skip + mode collapse)
- src/agents.ts diff (listLiveAgents jsdoc + any callsite changes)
- Every callsite that previously passed mode: "status-only" — verify they're all migrated cleanly (no orphans)
- src/cli/state.ts (likely the biggest caller of mu state behavior)
- Anywhere else that imported ReconcileMode

CHECKLIST
=========
- Are typed errors mapped to distinct exit codes? (No new errors expected here.)
- Is the placeholder skip isolated to step 1's prune loop, or did it accidentally affect step 2 (status detection) or step 3 (orphan surface)? It MUST be only step 1.
- The wholesale-tmux-crash case: when listPanesInSession returns [] AND there are agents, do they ALL get reaped (correct) or does some defensive guard prevent reaping when 100% would die (wrong; that would be a bandaid that defeats the bug fix)?
- Is the deleteAgent transaction unchanged? (We rely on its all-in-one-tx semantics for the reap audit trail.)
- Does the collapse remove dead code paths cleanly (no leftover `if (mode === "status-only")` branches anywhere in the codebase)?
- LOC budget: the change should be net NEGATIVE. If it grew, why?
- CHANGELOG: does the entry call out the BEHAVIORAL change (TUI slow-tick now reaps)? Does it explicitly close the bug?
- Any commit author drift / off-spec work in the diff? (The notes were precise; reviewers should flag scope creep.)

FILE FINDINGS AS
================
  mu task add cr_<short_slug> -w mubugs --title "Code review: <one-liner>" --impact <50-80> --effort-days <0.1-0.3>
  mu task note cr_<short_slug> -w mubugs "FILE/LINE: ...
WHAT'S WRONG: ...
WHY IT MATTERS: ...
SUGGESTED FIX: ...
SEVERITY: <high/medium/low>"
  mu task block umbrella --by cr_<short_slug> -w mubugs

If ZERO findings: drop a clean-review note on this task and close.

⚠️ FINAL ACTION
==============
mu task note code_review -w mubugs "FILES REVIEWED: <list>
FINDINGS: <count>, <comma-separated cr_ ids>
VERDICT: <ship-with-fixes | ship-clean | block-on-major-issue>"
mu task close code_review -w mubugs --evidence 'reviewed N files, filed M finding tasks (cr_*)'

CONSTRAINTS
- DO NOT EDIT PRODUCTION CODE.
- DO NOT COMMIT in this task; only create new mu tasks + notes.
- Use the code-reviewer skill if loaded.
```

### #2 by "π - mu", 2026-05-15T11:30:36.528Z

```
You are worker-1 in workstream `mubugs`. Claim is set on you for `code_review`.

YOUR TASK: code_review — review the diff for the reconciler mode-collapse feature. File findings as new tasks (cr_<slug>) blocking the umbrella. Do NOT fix anything yourself; you are a reviewer.

STEP 1 — read the design context end-to-end:
  mu task notes umbrella -w mubugs
  mu task notes code_review -w mubugs

The code_review task note has the full review checklist; the umbrella has the design rationale.

STEP 2 — read the diff. The relevant commits are:
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1
  git log --oneline 3f75a8b..HEAD       # everything since the start of mubugs work
  git diff 3f75a8b..HEAD --stat
  git diff 3f75a8b..HEAD -- src/reconcile.ts
  git diff 3f75a8b..HEAD -- src/agents.ts
  git diff 3f75a8b..HEAD -- src/state.ts
  git diff 3f75a8b..HEAD -- src/cli/

The three relevant commits are:
  - fd181a4 reconcile: skip placeholder pane ids in prune loop (defensive, all modes)
  - eb3c6fc reconcile: collapse status-only into full; mu state now reaps lost sessions
  - e0ace82 tests: workspace-staleness uses placeholder pane id post-collapse  ← orchestrator fixup

STEP 3 — apply the code_review checklist. For each ACTIONABLE finding:

  mu task add cr_<short_slug> -w mubugs \
    --title "Code review: <one-liner>" \
    --impact <50-80> --effort-days <0.1-0.3>
  mu task note cr_<short_slug> -w mubugs "FILE/LINE: <path>:<line>
WHAT'S WRONG: ...
WHY IT MATTERS: ...
SUGGESTED FIX: ...
SEVERITY: <high/medium/low>"
  mu task block umbrella --by cr_<short_slug> -w mubugs

THINGS WORTH SPECIFICALLY CHECKING (NOT EXHAUSTIVE):
- Is the placeholder skip isolated to step 1's prune loop, or did it leak into step 2 (status detection) or step 3 (orphan surface)? It MUST be only step 1.
- The wholesale-tmux-crash case: when listPanesInSession returns [] and there are agents, do they ALL get reaped (correct) or did anyone add a defensive guard "skip if 100% would die" that defeats the bug fix?
- Is the deleteAgent transaction unchanged?
- Does the collapse remove dead code paths cleanly (no leftover `if (mode === "status-only")` anywhere; verify with `rg -n 'status-only' src/`)?
- LOC budget: should be net negative; is it?
- CHANGELOG entry: does it call out the BEHAVIORAL change (TUI slow-tick now reaps)? Does it explicitly close bug_no_recovery_after_tmux_server_crash?
- The orchestrator's e0ace82 fixup: is the choice (synthetic test agent uses placeholder pane id) the right pattern, or should it have mocked tmux instead? (Either is defensible; flag if you think mocking tmux would be cleaner long-term.)
- Other tests in the suite that might be affected by the same pattern but weren't caught by the full-tier run (i.e. tests that insertAgent with a non-placeholder paneId AND then call mu state OR mu agent list). Use `rg -n 'insertAgent.*paneId.*"%[^p]' test/` to find candidates.

If ZERO findings: drop a clean-review note + close.

STEP 4 — verify findings:
  mu task tree umbrella -w mubugs

STEP 5 — final note + close:
  mu task note code_review -w mubugs "FILES REVIEWED:
- src/reconcile.ts
- src/agents.ts
- src/state.ts
- src/cli/* (any callsites)
- test/reconcile.integration.test.ts
- test/workspace-staleness.integration.test.ts (orchestrator fixup)
- CHANGELOG.md

FINDINGS: <count>, <comma-separated cr_ ids>
VERDICT: <ship-clean | ship-with-fixes | block-on-major-issue>"
  mu task close code_review -w mubugs --evidence 'reviewed N files, filed M finding tasks (cr_*)'

CONSTRAINTS
- DO NOT EDIT PRODUCTION CODE.
- DO NOT COMMIT in this task; only create new mu tasks + notes.
- Use the code-reviewer skill if loaded.
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-1 (recreated).

COORDINATION WARNING
- worker-2 is in parallel on test_review. No file overlap (you don't write code; they don't write code).
```

### #3 by "worker-1", 2026-05-15T11:38:22.455Z

```
FILES REVIEWED:
- src/reconcile.ts
- src/agents.ts
- src/agents/spawn.ts
- src/state.ts
- src/cli/agents.ts
- src/cli/state.ts
- src/cli/snapshot.ts
- src/cli/tasks/claim.ts
- src/doctor-summary.ts
- src/cli/doctor.ts
- test/reconcile.integration.test.ts
- test/workspace-staleness.integration.test.ts (orchestrator fixup)
- test/agent-idle.test.ts
- test/verbs-listlive.integration.test.ts
- CHANGELOG.md

CHECKS:
- rg -n 'status-only' src/ shows no source callsites/branches remain.
- deleteAgent transaction unchanged in src/agents.ts.
- wholesale-crash prune loop has no 100%-death guard; listPanesInSession=[] reaps normal pane ids.
- source diff is net negative; full diff is positive due to added tests + CHANGELOG.
- CHANGELOG calls out TUI/mu state behavioral reaping change and closes bug_no_recovery_after_tmux_server_crash.
- e0ace82 placeholder test fixture is defensible for workspace-staleness isolation, though cr_pending_leak asks to tighten reconcile internals.

FINDINGS: 3, cr_attach_precheck, cr_pending_leak, cr_doctor_ghost_wording
VERDICT: ship-with-fixes
```

### #4 by "worker-1", 2026-05-15T11:38:23.074Z

```
CLOSE: reviewed 15 files, filed 3 finding tasks (cr_attach_precheck, cr_pending_leak, cr_doctor_ghost_wording)
```
