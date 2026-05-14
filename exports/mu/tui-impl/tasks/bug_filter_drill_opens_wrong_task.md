---
id: "bug_filter_drill_opens_wrong_task"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.1
roi: 800.00
owner: "worker-1"
created_at: "2026-05-13T15:11:09.053Z"
updated_at: "2026-05-13T15:36:44.844Z"
blocked_by: []
blocks: []
---

# BUG: filter on + Enter drills wrong task — visibleTasks drops filter on mode='drill', cursor index stale

## Notes (2)

### #1 by "π - mu", 2026-05-13T15:11:47.052Z

```
TASK: bug_filter_drill_opens_wrong_task — search filter on, press
Enter, drills into wrong task.

VERBATIM USER MOTIVATION
> "in task list, when / search filter is on. there are some offset
>  problem with tasks selected so you end up going into the wrong
>  task on enter."

ROOT CAUSE

src/cli/tui/popups/all-tasks.tsx (and the same pattern in any
sibling popup that drops the text filter when mode === "drill"):

    const visibleTasks = useMemo(() => {
      const filteredByStatus = sourceTasks.filter((t) =>
        statusFilter.statuses.has(t.status));
      const filteredByText =
        mode === "drill"
          ? filteredByStatus            // <-- DROPS text filter
          : applyFilter(filteredByStatus, flt.query, ...);
      return sortTasks(filteredByText, sortKey);
    }, [sourceTasks, statusFilter.statuses, mode, flt.query, sortKey]);
    const safeCursor = visibleTasks.length === 0 ? 0
      : Math.min(cursor, visibleTasks.length - 1);
    const focused = visibleTasks[safeCursor];

Sequence that triggers the bug:
1. User has filter "abc", visibleTasks = [t12, t37, t99] (3 matches
   from a 50-task source).
2. User has cursor at row 1 (focused = t37).
3. User presses Enter → onModeChange("drill").
4. mode flips to "drill". useMemo dep change triggers recompute.
5. visibleTasks now = [t01, t02, t03, ..., t50] (status-filter only;
   text filter dropped).
6. safeCursor = min(1, 49) = 1. focused = visibleTasks[1] = t02.
7. TaskDetailDrill renders task={t02}, NOT t37 (the visually-
   selected task before Enter).

The drop-filter-on-drill behaviour is intentional? Probably not —
it's a stale design from when drill-mode filter UX was different.
The text filter SHOULD stay applied so the focused row identity is
preserved across the mode flip.

FIX

Just remove the mode-conditional in visibleTasks. The text filter
should be applied uniformly:

    const visibleTasks = useMemo(() => {
      const filteredByStatus = sourceTasks.filter((t) =>
        statusFilter.statuses.has(t.status));
      const filteredByText = applyFilter(
        filteredByStatus,
        flt.query,
        (t) => `${t.name} ${t.title} ${t.status} ${t.ownerName ?? ""}`,
      );
      return sortTasks(filteredByText, sortKey);
    }, [sourceTasks, statusFilter.statuses, flt.query, sortKey]);
    // mode dep dropped; visibleTasks no longer changes when entering
    // drill mode, so cursor index stays pointing at the same task.

The mode dependency was the entire bug surface.

DEFENSIVE FIX (also worth doing in the same commit): the safest
contract is to capture the focused task at the moment Enter is
pressed, not re-resolve from cursor on the next render. Pattern:

    const [drilledTask, setDrilledTask] = useState<TaskRow | null>(null);

    case "drill":
      if (focused) {
        setDrilledTask(focused);   // capture identity NOW
        onModeChange("drill");
      }
      return;

    // In drill render branch:
    if (mode === "drill" && drilledTask !== null) {
      return <TaskDetailDrill task={drilledTask} ... />;
    }

    // Reset on close:
    case "close":
      setDrilledTask(null);
      onModeChange("list");
      return;

This belt-and-suspenders pattern means even if a future refactor
re-introduces a visibleTasks shift, the drill stays pinned to the
task the user actually selected.

PICK ONE OR BOTH:
- The minimal one-line fix (drop the mode dep) is enough for this
  bug.
- The drilledTask-capture defensive fix is worth adding too — same
  bug class is latent in any popup that resolves focused from
  cursor across mode flips.

Recommend BOTH, in one commit, in this order: (1) drop mode dep,
(2) capture drilledTask. Mention both in the commit body.

AUDIT THE OTHER POPUPS

Same bug class may exist in:
- src/cli/tui/popups/ready.tsx
- src/cli/tui/popups/inprogress.tsx
- src/cli/tui/popups/blocked.tsx
- src/cli/tui/popups/recent.tsx
- src/cli/tui/popups/workspaces.tsx
- src/cli/tui/popups/agents.tsx
- src/cli/tui/popups/commits.tsx

`rg "mode === \"drill\"\? .*: applyFilter|mode.*\?.*filtered.*: " src/cli/tui/popups/`
should find the offending pattern. Apply the same one-line fix
(drop the mode conditional) to each popup that has it.

For the drilledTask capture, only apply it to popups that have a
mode-conditional drill (most do). One pattern, applied uniformly.

TESTS
- test/tui-popup-all-tasks.test.ts already has behaviour tests
  (worker-1 just shipped a conversion). Add:
    "with text filter 'abc', cursor at row 1 of [t12, t37, t99],
     pressing Enter drills into t37 — NOT a different task from
     the unfiltered set"
- Same shape test for any other popup we patched.
- Manually verify in TTY: open `mu`, drill into Tasks (or any list
  popup), type `/abc<Enter>`, j once, Enter. The drill should
  show the second matching task, not whatever index 1 of the
  full set is.

CONSTRAINTS
- Touch:
    src/cli/tui/popups/all-tasks.tsx (the bug source)
    src/cli/tui/popups/{ready,inprogress,blocked,recent,workspaces,agents,commits}.tsx
      (any with the same pattern; audit + patch)
    test/tui-popup-all-tasks.test.ts (regression test)
    test/tui-popup-{ready,inprogress,...}.test.ts as relevant
    CHANGELOG.md
- TUI cluster only.
- Bundle smoke MANDATORY.
- Four greens: typecheck (broader) + lint + full test + build.
- Commit prefix: `tui:`. ONE commit. Suggested:
    tui: text filter no longer drops on drill mode; capture drilled task identity

DOCS
- CHANGELOG.md under [Unreleased] / Fixed.

PARALLEL WORK NOTE
- worker-1: bug_drill_ansi_state_leaks_into_border (wrap-ansi.ts;
  unrelated, but a sibling drill-class bug; CHANGELOG.md is shared).
- worker-2: src/agents.ts (lastClaimEvent helper; unrelated)
- worker-3: tests_tui_convert_workspaces_commits_doctor (test
  files for those popups; YOUR audit MAY touch
  src/cli/tui/popups/{workspaces,commits,doctor}.tsx — coordinate
  by NOT changing prop signatures or filter call sites worker-3's
  tests assert against. The minimal fix (drop mode dep) doesn't
  change interfaces. The drilledTask capture is per-popup local
  state — also doesn't change interfaces).
- worker-4: tests_tui_convert_ready_inprogress_blocked (test
  files for those popups). Same caution as worker-3 above.
- CHANGELOG.md is shared.

⚠️ FINAL ACTION
After four greens AND manual TTY verification:

  mu task close bug_filter_drill_opens_wrong_task -w tui-impl \
    --evidence "<sha>: dropped mode dep from visibleTasks (root cause); captured drilledTask identity (defensive); all-tasks + N other popups audited; regression test added"
```

### #2 by "worker-1", 2026-05-13T15:36:44.844Z

```
CLOSE: d855c5c: dropped mode dep from visibleTasks/tasks/agents/checks/workspaces (root cause) AND captured drilledTask/Agent/Check/Workspace identity at Enter (defensive); audit + patch across 8 popups (all-tasks, ready, blocked, inprogress, recent, agents, doctor, workspaces); log/commits already correct, tracks N/A; new test/tui-popup-filter-drill-pinning.test.ts cross-popup regression (5 popups exercised through real ink mount + simulateInput) + mirrored case in tui-popup-all-tasks.test.ts; manual tmux TTY repro shows drill title = 'All tasks · abc_second (notes)'; four greens (typecheck + lint + test:fast 1400 + test 2460 + build) clean
```
