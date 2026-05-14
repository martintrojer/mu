---
id: "bug_drill_views_dont_refresh_on_tick"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: "worker-2"
created_at: "2026-05-13T05:45:53.591Z"
updated_at: "2026-05-13T08:46:25.456Z"
blocked_by: ["bug_t_keypress_replays_stale_mouse_dblclick", "feat_git_show_drill_color_and_tuicr"]
blocks: []
---

# BUG: drill views (TaskDetailDrill notes; commits-show body; agent scrollback) capture data once on mount via useMemo and never re-fetch on tick — open the drill at T, hold for 30s, content stays frozen at T's snapshot

## Notes (3)

### #1 by "π - mu", 2026-05-13T05:47:07.492Z

```
MOTIVATION (verbatim user)
--------------------------
"bug, the periodical tick doesn update drill-down views like the task list."

ROOT CAUSE (confirmed)
----------------------
src/cli/tui/popups/task-detail.tsx lines 49-52:
  const body = useMemo<string>(
    () => renderNotes(db, task.name, workstream),
    [db, task, workstream],
  );

renderNotes runs ONCE on mount; deps `[db, task, workstream]` never change while a drill is open. The fast/slow tick refreshes the snapshot but doesn't push it through the drill's useMemo.

SAME PATTERN IN OTHER DRILLS:
- src/cli/tui/popups/ready.tsx line 103-107: same useMemo wrapping renderNotes.
- src/cli/tui/popups/all-tasks.tsx line 106: same.
- src/cli/tui/popups/blocked.tsx, inprogress.tsx, recent.tsx — likely same; grep to confirm.
- src/cli/tui/popups/commits.tsx: `git show <sha>` body via useCallback / useMemo on `loadShow` — same staleness if the user never moves the cursor.
- src/cli/tui/popups/workspaces.tsx: commits-drill body + git-show — same.
- src/cli/tui/popups/agents.tsx: agent scrollback body — same.

LOCKED DESIGN
-------------
Thread a "snapshot tick nonce" (or the snapshot itself) into every drill's useMemo deps so re-fetch fires on every fast tick.

Two implementation paths:

OPTION A — pass the snapshot down everywhere (already happens):
  Most popups already receive `snapshot: WorkstreamSnapshot | null` and pass it (or derived data) into the drill component as props. The drill's useMemo can include `snapshot` in deps. When useDashboardSnapshot returns a NEW reference (which it does on every tick where data changed — see snapshotKeyString ref-equality guard in src/cli/tui/state.ts), the drill re-fetches.
  
  Caveat: snapshotKeyString returns the SAME reference when nothing changed → drills don't re-fetch on no-op ticks. That's GOOD (no unnecessary subprocess work) but means a notes-only change (added a new note via `mu task note` from the shell) WON'T tick the snapshot key (notes aren't in the snapshot). The drill stays stale.

OPTION B — pass an explicit tick nonce that increments every fast tick:
  Add `tickNonce: number` to useDashboardSnapshot's return. Every drill component's useMemo includes tickNonce in deps. Forces re-fetch every tick regardless of snapshot equality.
  
  Cost: re-runs renderNotes (tiny SQL SELECT) on every tick. ~0.05ms per drill per tick — negligible.
  
  Benefit: drills track ANY DB change, including ones the snapshot doesn't track (notes, evidence, status changes mid-drill).

PREFER OPTION B. The cost is trivial, the correctness is complete, and it matches the user's mental model ("the tick refreshes everything visible").

⚠️ PERF GUARD ⚠️
For drills that involve subprocess work (commits-show body, agent scrollback via tmux capture-pane), DON'T re-fetch on the fast tick. Move those to the slow tick (10s) by exposing a `slowTickNonce` separately and using THAT in their useMemo deps.

So the real implementation:
  useDashboardSnapshot returns: { data, error, fastTickNonce, slowTickNonce }
  - fastTickNonce: increments every fast tick. Use for SQL-only drills (notes).
  - slowTickNonce: increments every slow tick. Use for subprocess drills (git show, agent scrollback).
  - r/F5 increments BOTH (refresh-now contract preserved).

WIRING
------
- src/cli/tui/state.ts useDashboardSnapshot:
  * Add fastTickNonce + slowTickNonce useState. Increment fastTickNonce in the fast tick handler; slowTickNonce in the slow tick handler.
  * Return them in the hook's return shape.

- src/cli/tui/app.tsx:
  * Pass fastTickNonce + slowTickNonce down to popups (as props on each <FooPopup>).
  * Popups thread them to drill components.

- src/cli/tui/popups/task-detail.tsx:
  * Add `tickNonce: number` prop.
  * Update useMemo deps to include it.
  * Callers pass fastTickNonce (notes are SQL).

- src/cli/tui/popups/{ready,all-tasks,blocked,inprogress,recent,workspaces,agents,commits}.tsx:
  * Each popup that runs a useMemo for drill body (or for filtered data displayed in the drill) gets the appropriate nonce in its deps.
  * SQL-derived bodies → fastTickNonce.
  * Subprocess bodies (commits.tsx git show, workspaces.tsx git show, agents.tsx scrollback) → slowTickNonce.

- For per-popup LIST data (e.g. all-tasks rows derived from snapshot.allTasks): no change needed. The snapshot prop ALREADY changes per tick when its content changes.

⚠️ COORDINATION ⚠️
Several in-flight tasks touch popups:
  - feat_git_show_drill_color_and_tuicr (worker-2): drill.tsx + commits.tsx + workspaces.tsx + tuicr.ts.
  - bug_t_keypress_replays_stale_mouse_dblclick (worker-3): app.tsx only.
  - feat_color_status_columns_in_task_list_popups (queued): every list popup.
  - feat_color_task_notes_drill (queued, gated behind worker-2): task-detail.tsx.

GATE this task behind:
  - bug_t_keypress_replays_stale_mouse_dblclick (so app.tsx changes don't conflict)
  - feat_git_show_drill_color_and_tuicr (so drill.tsx + commits/workspaces popups don't conflict)

This task lands AFTER both. The deeper plumbing (nonces through useDashboardSnapshot → app.tsx → every popup) is most safely done after the other in-flight popup-touching tasks finish.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/cli/tui/state.ts useDashboardSnapshot: extend test/tui-state-hook.test.ts (or test/tui-state-slow-tick.test.ts):
  * fastTickNonce increments on every fast tick.
  * slowTickNonce increments on every slow tick.
  * r/F5 (refreshNonce) increments BOTH.
  * Workstream switch increments slowTickNonce (eager fire).
- TaskDetailDrill: extend test/tui-popup-tasks.test.ts to assert renderNotes is called once on initial render AND again when tickNonce prop changes.
- A small integration test: open the all-tasks drill on a task that gets a new note via direct DB INSERT mid-test → assert the drill body now contains the new note.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Open Ready popup → Enter on a task → see notes drill.
  # In a shell: mu task note <that-task-id> 'fresh note from outside the TUI' -w tui-impl
  # EXPECTED (fixed): within 1-2s, the new note appears at the top of the drill body.
  # CURRENT BUG: drill stays frozen at the original notes; nothing updates until you Esc and re-Enter.
  
  # Same test for commits drill: navigate to commits popup → Enter on a commit → in a shell make a NEW commit in the project → wait 10s → verify the commits popup LIST shows the new commit. (The drill body itself is for one specific sha, so it shouldn't change.)

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; touches many files but each change is small (~5-10 LOC per popup to add the nonce dep).
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: drill bodies refresh on the fast/slow tick — useDashboardSnapshot exposes fastTickNonce + slowTickNonce; drill useMemos include the right nonce so notes/scrollback/show bodies don't freeze when held open

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI drill-down views (TaskDetailDrill notes, commits show body, agent scrollback) used to capture their content once on mount and stay frozen until the user closed and reopened the drill. They now refresh on the same tick the parent dashboard does — fast tick (1s) for SQL-derived content (notes); slow tick (10s) for subprocess-derived content (commits show, agent scrollback). r/F5 forces an immediate refresh."

OUT OF SCOPE
------------
- No throttling beyond fast/slow tier (already covered by perf_split_tui_snapshot_poll_into_fast_slow's split).
- No per-drill manual refresh key (r/F5 already global).
- No cache-invalidation API (the nonce-based deps are simpler).
- No memo-stable-reference optimization (re-fetch is cheap; memo equality isn't needed).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke, close YOUR task with:
  mu task close bug_drill_views_dont_refresh_on_tick -w tui-impl --evidence "<sha>: <one-line summary including 'verified mu task note from a shell appears in the open drill within 2s'>"
```

### #2 by "worker-2", 2026-05-13T08:46:24.456Z

```
FILES: src/cli/tui/state.ts, app.tsx, popups/{task-detail,ready,all-tasks,blocked,inprogress,recent,tracks,dag,agents,commits,workspaces}.tsx; tests tui-state-slow-tick, tui-popup-tasks, tui-drill-refresh.integration.
COMMANDS: npm run typecheck; npm run lint; npm run test:fast; npm run test; npm run build; node dist/cli.js --help; node dist/cli.js --version; manual tmux smoke.
FINDINGS: Drill bodies were memo/effect-stable while held open; note-only changes did not affect snapshotKey.
DECISION: Added fastTickNonce/slowTickNonce from useDashboardSnapshot and kept App snapshot ticking while popups are open. SQL drills use fast nonce; tmux/VCS subprocess drills use slow nonce.
VERIFIED: Full gates green. Manual smoke: opened All tasks -> t1 notes, ran mu task note from a shell, and saw 'fresh note from outside the TUI' appear in the open drill within 2s.
ODDITIES: Full test run shows expected agent-name hint noise from fixtures.
```

### #3 by "worker-2", 2026-05-13T08:46:25.456Z

```
CLOSE: 56d10e2: tui drill bodies refresh via fast/slow tick nonces; verified mu task note from a shell appears in the open drill within 2s
```
