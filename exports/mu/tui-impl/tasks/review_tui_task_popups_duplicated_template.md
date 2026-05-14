---
id: "review_tui_task_popups_duplicated_template"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: "worker-4"
created_at: "2026-05-13T12:52:55.436Z"
updated_at: "2026-05-13T13:14:18.215Z"
blocked_by: []
blocks: []
---

# REVIEW high: 5 task-popup files share copy-pasted ~150 LOC scaffold (notes drill, useInput, filter)

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:52:58.274Z

```
FILE(S):
  src/cli/tui/popups/ready.tsx
  src/cli/tui/popups/inprogress.tsx
  src/cli/tui/popups/recent.tsx
  src/cli/tui/popups/blocked.tsx
  src/cli/tui/popups/all-tasks.tsx
  (also similar shape: src/cli/tui/popups/doctor.tsx, agents.tsx)

FINDING (duplication):
  Five "rows-are-tasks" popups (ready / inprogress / recent / blocked /
  all-tasks) share an essentially identical scaffold:

    1. const contentWidth = contentWidthFromCols(termColsForLayout());
    2. const viewport = usePopupViewport();
    3. const [cursor, setCursor] = useState(0);
    4. const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
    5. const sourceTasks = snapshot?.<slice> ?? [];
    6. const tasks = mode === "drill" ? sourceTasks : applyFilter(sourceTasks, flt.query, blob);
    7. const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
    8. const focused = tasks[safeCursor];
    9. const notesText = useMemo<string>(() => { void fastTickNonce; if (mode !== "drill" || !focused) return ""; return renderNotes(db, focused.name, workstream); }, [...]);
   10. const drill = useDrillKeymap({ body: notesText, viewport, onClose: () => onModeChange("list"), onYank: () => yank(`mu task notes ${focused.name} -w ...`) });
   11. useInput((input, key) => { if (mode !== "drill" && flt.onKey(input, key) === "consumed") return; const action = dispatchPopupKeyFromInk(input, key); if (mode === "drill") { drill.dispatch(action); return; } if (isNavAction(action)) { setCursor((c) => applyCursor(c, action, tasks.length, viewport)); return; } switch (action.kind) { case "close": onClose(); return; case "filter": flt.startEdit(); return; case "drill": if (focused) onModeChange("drill"); return; case "yank": ... } });
   12. The same loading / no-source / no-matches / drill-render / list-render branches.

  Per-popup deltas are small and structured: the source slice
  (snapshot.ready vs blocked vs inProgress vs recentClosed), the
  filter blob, the column specs, the per-row colour map, the yank
  command, and a handful of cells in the row map.

WHY IT'S A PROBLEM:
  - The template was copy-pasted (each file says so in its header
    comment: "Sibling of popups/ready.tsx", "Carbon-copy of
    popups/ready.tsx", "Mirrors popups/inprogress.tsx" etc.).
  - Drift is inevitable and has already happened: blocked.tsx
    yields `mu task tree` on yank (not the OPEN-branch matrix);
    inprogress.tsx adds `--evidence "..."`; recent.tsx adds extra
    impact / effort columns. Today these are deliberate
    differences, but a future bug fix in one popup (e.g. a missing
    cursor clamp on filter-resize, a new `Esc to clear filter
    first` UX) has to be repeated across 5+ files. The
    `feat_track_drill_chains_to_task_drill` headers explicitly
    call out the recursion contract — but each consumer still
    re-implements it line-for-line.
  - The `void fastTickNonce; if (mode !== "drill" || !focused)
    return ""; return renderNotes(...)` block exists THREE times
    (popups/ready.tsx:99-103, popups/recent.tsx:109-113,
    popups/inprogress.tsx:107-111, popups/blocked.tsx:136-140,
    popups/all-tasks.tsx:101-105). Each header explicitly says
    "we duplicate the call here only because useDrillKeymap needs
    the rendered body to clamp scroll." — that's a smell: the
    keymap helper is forcing duplication elsewhere.
  - One missing finding becomes 5 missing findings.

PROPOSED FIX:
  Extract a `useTaskListPopup({snapshot, source, db, workstream,
  fastTickNonce, mode, onModeChange, onFilterEditingChange, blob})`
  hook that returns
    { tasks, focused, safeCursor, viewport, contentWidth, flt,
      drill, useInputHandler(extraVerbsBag) }
  Each popup then writes ~30 LOC: source slice + column specs +
  row map + colour map + yank-command callbacks + custom verbs.
  The notes-fetch + drill keymap + filter + nav + close all
  collapse into the hook.

  Smaller subset (separately shippable, fits the <300 LOC pledge):
  Extract just the `notesText` useMemo (steps 9 + 10) into a
  `useNotesDrill(focused, mode, db, workstream, fastTickNonce,
  yank, onModeChange, viewport)` hook returning `{ drill,
  notesText }`. Removes 5 byte-identical useMemo blocks. Then
  iterate later if the other ~30 LOC of overlap proves expensive.

EFFORT NOTE:
  Touches 5 popups + adds 1 hook. Each popup test file is mostly
  static-source-greps that will need to be updated to match the
  new shape (the `void fastTickNonce` / `notesText` literals will
  move). Estimate 0.4d for the small subset; 1d for the full
  hook. No behaviour change at the user surface — pure refactor.
```

### #2 by "worker-4", 2026-05-13T13:14:18.215Z

```
CLOSE: 50b4143: useNotesDrill hook extracted from 5 popups (ready/inprogress/blocked/recent/all-tasks); per-popup useMemo+renderNotes block deduped into src/cli/tui/use-notes-drill.ts (33 LOC); net -4 LOC; new test/tui-use-notes-drill.test.ts pins the contract; updated 5 source-grep tests; CHANGELOG + ARCHITECTURE updated; four greens (typecheck/lint/test:fast/test 2339/build) + bundle smoke clean. Did NOT extract the larger useTaskListPopup hook — diverging filter blobs/column specs/yank matrices would push it LOC-positive; defer per task description.
```
