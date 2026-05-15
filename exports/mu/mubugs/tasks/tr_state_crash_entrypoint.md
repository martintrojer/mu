---
id: "tr_state_crash_entrypoint"
workstream: "mubugs"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: null
created_at: "2026-05-15T11:38:04.169Z"
updated_at: "2026-05-15T11:51:47.802Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: wholesale crash test bypasses mu state/no-server path

## Notes (3)

### #1 by "worker-2", 2026-05-15T11:38:05.332Z

```
FILE: test/reconcile.integration.test.ts:reconcile — wholesale tmux crash recovery > deletes all lost agents and reaps their IN_PROGRESS tasks
WHAT'S MISSING/WRONG: The regression directly calls reconcile() and mockTmux([]) returns a successful empty list-panes result. The added has-session=false branch is not exercised by reconcile(), so this does not simulate the actual wholesale tmux-server-crash stderr path (list-panes exits non-zero with 'no server running'). It also does not prove the mu state/loadWorkstreamSnapshot entry point uses full reconciliation, and the [reaper] note assertion only checks author='reaper', not that the durable note contains the [reaper] breadcrumb/previous-owner content.
WHY IT MATTERS: The user-facing bug was mu state/TUI continuing to report ghost agents after a tmux server crash. A regression where listPanesInSession stops swallowing 'no server running', or mu state accidentally routes through report-only/non-reaping reconciliation, would escape while this direct reconcile-empty-list test still passed.
SUGGESTED FIX: Add or rewrite the crash regression through loadWorkstreamSnapshot or runCli(["state", "-w", "auth", "--json"]) with a mocked tmux executor whose list-panes -s call returns exitCode=1 and stderr='no server running'. Seed agents with claimed IN_PROGRESS tasks, then assert DB agent rows are gone, tasks are OPEN with ownerName null, note content contains '[reaper]' and previous owner, and task reap events exist. Keeping the direct reconcile test is fine, but it should also exercise the non-zero no-server list-panes branch.
SEVERITY: high
```

### #2 by "π - mu", 2026-05-15T11:41:49.081Z

```
You are worker-2 in workstream `mubugs`. You have THREE claims:
  1. tr_state_crash_entrypoint   (HIGH — stronger crash regression via mu state JSON entrypoint)
  2. cr_attach_precheck          (MEDIUM — mu agent attach precheck short-circuits before reconcile)
  3. cr_doctor_ghost_wording     (LOW — doctor wording stale after mode collapse)

Bundled because they're tightly related (post-collapse polish on read surfaces). Land them as ONE commit.

STEP 1 — read context:
  mu task notes umbrella -w mubugs
  mu task notes tr_state_crash_entrypoint -w mubugs
  mu task notes cr_attach_precheck -w mubugs
  mu task notes cr_doctor_ghost_wording -w mubugs

STEP 2 — read the existing pieces:
  src/cli/agents.ts (cmdAttach around line 551 — the sessionExists() short-circuit)
  src/cli/doctor.ts (around line 139 — "pruned N during this check" wording)
  src/doctor-summary.ts (around line 189 — TUI doctor summary's "mu agent list" hint)
  src/state.ts (loadWorkstreamSnapshotSlow — the mu state entrypoint that loadWorkstreamSnapshot wraps)
  src/tmux.ts (listPanesInSession — note it swallows "no server running" stderr and returns [])
  test/reconcile.integration.test.ts (current crash regression — directly calls reconcile() with mockTmux([]))

STEP 3 — implement THREE fixes in one commit:

  FIX A — tr_state_crash_entrypoint (stronger crash regression):
    Add a new test (in test/reconcile.integration.test.ts or a new test/state-crash-recovery.integration.test.ts if it fits better) that:
    - Exercises the bug via the mu state ENTRYPOINT, not direct reconcile() call.
    - Uses a mocked tmux executor whose list-panes -s returns exitCode=1 + stderr='no server running' (the actual wholesale-crash signal that listPanesInSession swallows).
    - Seeds agents with claimed IN_PROGRESS tasks before the crash.
    - Calls runCli(["state", "-w", "auth", "--json"], dbPath) (or invokes loadWorkstreamSnapshot directly with the mocked executor — pick whichever gives the cleanest assertion surface).
    - Asserts:
      - DB agent rows are gone (queried directly via SELECT * FROM agents).
      - IN_PROGRESS tasks are now OPEN with owner_id NULL.
      - The [reaper] note content includes the literal '[reaper]' breadcrumb AND the previous owner name.
      - task reap events exist in agent_logs.
    - Keep the existing direct reconcile-empty-list test; this new one EXTENDS coverage to the entrypoint + non-zero stderr branch.

  FIX B — cr_attach_precheck (reorder cmdAttach so reconcile runs before sessionExists short-circuit):
    Current code at src/cli/agents.ts:551 throws UsageError if !sessionExists(sessionName), BEFORE listLiveAgents runs. After the collapse, mu agent attach is supposed to share the read-surface reaping behavior — but this precheck blocks that path in the wholesale-session-loss case.
    Two reasonable fixes (pick one):
      (a) Move listLiveAgents() ABOVE the sessionExists() guard. The reconcile pass observes empty pane list, reaps the agents (deleteAgent fires its FK cascade + reaper note + event chain). Then the sessionExists guard fires with the friendly "workstream X has no tmux session yet" error, and the user sees correct DB state on retry.
      (b) Drop the sessionExists guard entirely — let listLiveAgents observe empty panes, reap, then AgentNotFoundError fires naturally when the user-named agent isn't in the registry.
    My lean: (a) — preserves the friendly error message + adds the reap. The agent-not-found case (user typo) still raises AgentNotFoundError after the reap.
    Update the source comment at :554 ("mu agent attach prints scrollback...") to reflect the new ordering — the comment currently says it doesn't prune; that's now wrong.

  FIX C — cr_doctor_ghost_wording (correct wording in report-only doctor surfaces):
    src/cli/doctor.ts:139 — change "pruned N during this check" to "N ghost pane(s) would be pruned/reaped by mu state or mu agent list" (or similar; phrase it so the reader knows doctor itself didn't reap).
    src/doctor-summary.ts:189 — TUI doctor card hint currently tells the user to run `mu agent list`. After the collapse, `mu state` (and the TUI's slow-tick) also reap. Suggest both: "run `mu state` or `mu agent list` to reap" (or equivalent phrasing).
    Keep "pruned N" wording for full-mode reports that ACTUALLY deleted rows (mu agent list) — that wording is correct there.

STEP 4 — verify:
  npm run typecheck && npm run lint && npm run test:fast && npm run build
  node dist/cli.js --help
  node dist/cli.js doctor --help
  node dist/cli.js agent attach --help

STEP 5 — commit (single commit covering all three fixes):
  cd /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-2
  git add -A
  git commit -m 'reconcile/cli: extend reaper coverage to mu agent attach + crash-regression entrypoint + doctor wording (review wave B)

tr_state_crash_entrypoint: the existing crash regression directly
called reconcile() with a successful empty pane list. Add an
entrypoint-level test through mu state --json with a mocked tmux
executor that returns exitCode=1 + stderr "no server running" — the
actual wholesale-crash signal that listPanesInSession swallows.
Asserts the full reap chain including [reaper] note breadcrumb and
task reap event.

cr_attach_precheck: cmdAttach previously threw UsageError on
!sessionExists BEFORE listLiveAgents ran. After the mode collapse
attach is supposed to share the read-surface reaping behavior;
reorder so reconcile runs first, then the friendly no-session
error. Stale comment updated.

cr_doctor_ghost_wording: report-only doctor surfaces (`mu doctor`,
TUI doctor card) said "pruned N during this check" / "run mu agent
list", which is now misleading because mu state also reaps. Reword
to make clear doctor itself only counts; the reaping happens on
mu state / mu agent list.

Closes tr_state_crash_entrypoint / cr_attach_precheck /
cr_doctor_ghost_wording.'

⚠️ FINAL ACTION
==============
After commit + fast-tier verify clean, close ALL THREE tasks with the same sha:

  mu task close tr_state_crash_entrypoint -w mubugs --evidence '<sha> entrypoint-level crash regression added through mu state with non-zero list-panes stderr'
  mu task close cr_attach_precheck -w mubugs --evidence '<sha> cmdAttach reconcile order fixed; reaper now fires from attach surface too'
  mu task close cr_doctor_ghost_wording -w mubugs --evidence '<sha> doctor + doctor-summary wording corrected for post-collapse reaping reality'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/mubugs/worker-2 (recreated; HEAD = e0ace82).
- ONE commit covering all three fixes.
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 200 net (one new test + small src changes).
- No CHANGELOG (the umbrella's CHANGELOG entry from collapse_status_only_mode covers this whole feature).
- Biome auto-fix is fine; never `--write --unsafe`.
- DO NOT touch src/reconcile.ts (worker-1 territory in wave A).

COORDINATION WARNING
- worker-1 in parallel on wave A. They're modifying src/reconcile.ts + adding a report-only placeholder test in test/reconcile.integration.test.ts. NO file overlap with you. If you both ALSO touch test/reconcile.integration.test.ts (you might add the new crash regression test there), the orchestrator handles the conflict on cherry-pick. The simpler path is to put your new crash test in a new file (test/state-crash-recovery.integration.test.ts) so there's no overlap at all.
```

### #3 by "worker-2", 2026-05-15T11:51:47.802Z

```
CLOSE: 5298d59 entrypoint-level crash regression added through mu state with non-zero list-panes stderr
```
