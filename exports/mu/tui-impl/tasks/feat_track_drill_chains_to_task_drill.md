---
id: "feat_track_drill_chains_to_task_drill"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: null
created_at: "2026-05-11T15:10:04.529Z"
updated_at: "2026-05-11T15:31:37.131Z"
blocked_by: ["feat_popup_enter_drill"]
blocks: ["feat_popup_6_inprogress", "feat_popup_7_blocked", "feat_popup_8_recent", "tui_impl_complete"]
---

# FEAT: Tracks-popup drill rows are tasks — Enter chains into the task drill (notes/details), per popup-drill recursion contract

## Notes (2)

### #1 by "π - mu", 2026-05-11T15:11:24.172Z

```
GOAL
----
After feat_popup_enter_drill landed (commit 37e02aa), each list popup
gained an "Enter → drill" sub-view. The Tracks popup's drill is a
LIST OF TASKS (id + status + title) for the focused track's
prerequisite subgraph. When the user presses Enter on a row inside
THAT drill, today nothing happens (or yank/back-only behaviour).

What the user wants: pressing Enter on a task row inside the
Tracks-drill should "chain" — render the SAME read-only task-detail
view the Tasks popup (Shift+3) drill renders for a single task
(notes timeline + edges + grounding). One Esc/q backs out to the
Tracks-drill list-of-tasks; a second Esc/q backs to the Tracks
list-of-tracks; a third Esc/q closes the popup.

This is the "popup-drill recursion" the user named. Same pattern
should apply to any future popup whose drill is itself a list of
tasks (e.g. Card 7 Blocked popup, Card 6 In-progress popup, Card 8
Recent popup — see feat_more_cards_umbrella). Make it a SHARED
PRIMITIVE so future authors get the chain for free.

ORDERING
--------
Blocked by feat_popup_enter_drill (already CLOSED — commit 37e02aa
introduced popups/drill.tsx with DrillScrollView + clampScrollTop).
This task EXTENDS that primitive.

CURRENT STATE (post 37e02aa)
----------------------------
- src/cli/tui/popups/drill.tsx exports DrillScrollView and clampScrollTop.
- popups/ready.tsx (Tasks popup) has an Enter-drill that loads a
  task's notes via listNotes() and renders them via DrillScrollView.
  This is the "task-detail view" we want to RE-USE.
- popups/tracks.tsx Enter-drill loads a list of TaskRow for the
  track's taskIds. Inside that drill, current Enter handling needs
  to be widened to "drill into the focused task".
- popups/agents.tsx Enter-drill loads pane scrollback (irrelevant
  here; agent rows aren't tasks).
- popups/log.tsx Enter-drill is a no-op (events aren't tasks; if a
  log row has a task id, "yank" already produces the show-task cmd).

DESIGN
------
1) FACTOR the task-detail view out of popups/ready.tsx into a
   reusable component:

     src/cli/tui/popups/task-detail.tsx
     export function TaskDetailDrill({
       task: TaskRow,
       db: Db,
       workstream: string,
       scrollTop: number,
       onScrollTopChange: (t: number) => void,
     }): JSX.Element

   It renders the task's listNotes() output via DrillScrollView,
   identical to today's ready.tsx drill body. Pure presentation —
   parent owns scroll cursor (so each level of recursion has its
   own scroll state).

   This is the shared primitive. Both popups/ready.tsx and
   popups/tracks.tsx (and future popups) consume it.

2) EXTEND tracks.tsx mode state machine from `"list" | "drill"` to
   `"list" | "drill" | "task-detail"`:

     mode === "list"        → list of tracks (existing)
     mode === "drill"       → list of tasks for focused track (existing)
     mode === "task-detail" → notes/details for focused task (NEW)

   Esc/q transitions:
     "task-detail"  → "drill"
     "drill"        → "list"
     "list"         → close popup

   The mode field is ALREADY parent-owned (passed in via prop +
   onModeChange) per the existing contract. Widen the union in:
     - app.tsx (the popup mode state slot)
     - the PopupProps types of every popup that consumes this prop
   Default to "list" on popup open.

3) WIRE Enter inside the tracks-drill:

   In popups/tracks.tsx, in the `if (mode === "drill")` branch of
   useInput, add a case for the "drill" action returned by
   dispatchPopupKey (Enter):

     case "drill":
       const t = drillTasks[drillCursor];
       if (t !== undefined) {
         // Cache focused task id so the task-detail view knows
         // which task to render. Either:
         //  - hoist a `drillTaskId` state, OR
         //  - read drillTasks[drillCursor] inside the task-detail
         //    render branch (cheaper; current cursor already drives it).
         onModeChange("task-detail");
       }
       return;

4) RENDER branch:

   Today tracks.tsx renders one of two sub-views (list vs drill).
   Add a third branch:

     if (mode === "task-detail" && focusedTrack) {
       const t = drillTasks[drillCursor];
       if (t === undefined) {
         // Defensive: drilltasks shape changed under us; back to drill.
         onModeChange("drill");
         return null;
       }
       return (
         <Shell ...>
           <TaskDetailDrill task={t} db={db} workstream={workstream}
             scrollTop={taskDetailScrollTop}
             onScrollTopChange={setTaskDetailScrollTop} />
         </Shell>
       );
     }

   New local state:
     const [taskDetailScrollTop, setTaskDetailScrollTop] = useState(0);

   Reset taskDetailScrollTop to 0 on mode→"task-detail" transition
   (useEffect on mode).

5) SHELL TITLE per recursion depth:

   Update the Shell title prop so the user always knows where they
   are in the recursion:

     mode === "list"        : "Tracks · popup (i/N)"
     mode === "drill"       : "Tracks · drill: <track-head-id> (j/M)"
     mode === "task-detail" : "Tracks · task: <task-id> (k/P notes)"

6) STATUSBAR mode indicator:

   status-bar.tsx today has `popup` mode hint. The hint cluster
   should reflect drill depth:

     popup-list mode      : "j/k nav · Enter drill · y yank · Esc close"
     popup-drill mode     : "j/k nav · Enter drill · Esc back · y yank"
     popup-task-detail    : "j/k scroll · Esc back" (no Enter chain
                            beyond task-detail; it's the leaf)

   Add a `popup-detail` (or `popup-task-detail`) status mode if
   needed. Existing `popup` mode can stay generic for popups that
   don't recurse.

   Be conservative — reuse existing modes where the hint set is
   identical; add new ones only when the cluster genuinely differs.

7) OUT OF SCOPE FOR THE LEAF:

   - The task-detail view is the LEAF. Pressing Enter on a notes line
     does NOT chain further. (Notes aren't entities; there's nothing
     to drill into. A future "yank this note line" feature is a
     separate task.)
   - No edit/claim/release in the chain — read-only end-to-end. Yank
     stays at the existing Tracks-popup yank target (mu task tree
     <head>); future work can widen yank-while-drilled per popup.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge enforces this).
- Read-only TUI: never executes mutations.
- 1500 LOC hard cap per file; popups/tracks.tsx will grow but should
  stay well under (it's currently ~210 lines).
- Conventional commit prefix: tui:
- Four greens before commit: typecheck + lint + test + build.
- Suggested commit:
    tui: Tracks drill → Enter chains into task-detail (shared
         TaskDetailDrill primitive)

DOCS
----
- skills/mu/SKILL.md TUI keymap line: clarify Enter recurses where
  rows ARE entities.
- docs/USAGE_GUIDE.md TUI section: extend the popup-drill blurb
  with the recursion example.
- CHANGELOG.md (under v0.4.0): bullet under TUI.
- docs/ARCHITECTURE.md src/cli/tui/ table: add a row for
  popups/task-detail.tsx (shared task-detail leaf consumed by
  Tracks drill + Tasks drill + future card popups).

TESTS
-----
- test/tui-popup-task-detail.test.ts (NEW): pure assertions on the
  TaskDetailDrill component shape (props bag, snapshot-null safety,
  empty-notes case, populated-notes case). Mirror the pattern of
  existing tui-popup-tasks.test.ts.
- test/tui-popup-tracks.test.ts: add coverage for the new mode
  union value "task-detail" and the Enter→chain transition. The
  test pattern is "import the popup, assert the source contains the
  expected mode literal + transition" since ink-testing-library is
  not available.
- test/tui-status-bar.test.ts: if you add a new status mode, add
  the corresponding case.
- test/tui-keys.test.ts: dispatchPopupKey should already emit
  {kind: "drill"} on Enter; no change needed unless the recursion
  introduces a different action.

OUT OF SCOPE
------------
- Don't chain from popups/agents.tsx drill (scrollback isn't a
  list of tasks).
- Don't chain from popups/log.tsx (events aren't tasks; the existing
  yank target is the right answer).
- Don't promote popups/task-detail.tsx into a "universal entity
  drill" abstraction. One concrete consumer at a time per the
  no-anticipatory-abstractions pledge — Tracks and Tasks already
  count as 2 (the refactor itself unifies them).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_track_drill_chains_to_task_drill -w tui-impl \
    --evidence "<sha + 1-line summary>"
```

### #2 by "worker-2", 2026-05-11T15:31:37.131Z

```
CLOSE: 62b5f72 tui: Tracks drill→Enter chains into shared TaskDetailDrill leaf (4 greens; 1429/1429 tests; ready.tsx + tracks.tsx both consume new popups/task-detail.tsx)
```
