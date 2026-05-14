---
id: "review_tests_drill_chain_navigation"
workstream: "tui-impl"
status: DEFERRED
impact: 50
effort_days: 0.3
roi: 166.67
owner: null
created_at: "2026-05-12T08:36:32.472Z"
updated_at: "2026-05-12T08:50:39.198Z"
blocked_by: []
blocks: []
---

# REVIEW med: Drill-chain navigation (Enter → Enter → Esc → Esc) has no behaviour test

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:36:32.805Z

```
FILES + LINES (no test exists; gap evidence):
  - src/cli/tui/popups/tracks.tsx:107-112 (DrillSubMode "task-list" | "task-detail") — multi-level drill is tested only by `expect(src).toContain('"task-list"')` and `setDrillSubMode("task-detail")` substring matches in test/tui-popup-tracks.test.ts.
  - src/cli/tui/popups/workspaces.tsx:198-209 (showSha sub-state) — multi-level drill tested only by static-source matches in test/tui-popup-workspaces.test.ts (e.g. `case "drill":\s*\{[^}]*setShowSha`).
CATEGORY: weak-coverage
SEVERITY: med
FINDING: The Tracks popup has a 3-level recursion (tracks list → task list → task notes); Workspaces has a 3-level recursion (workspace list → commits-since-fork → git show diff). Neither has a behaviour test that:
   - opens the popup,
   - presses Enter to drill,
   - presses Enter again to chain into the leaf,
   - presses Esc twice to back out one level at a time,
   - confirms the popup closes cleanly to the dashboard.
A regression that mis-routes Esc (e.g. closes the whole popup instead of backing one level) wouldn't be caught.
SUGGESTED FIX (depends on review_tests_static_source_overuse for ink-testing-library):
   1. Mount the popup with a fixture snapshot that includes ≥1 track with ≥2 tasks AND a fixture workspace with ≥1 commit.
   2. Drive the keystroke sequence (Enter → Enter → Esc → Esc → Esc).
   3. After each Esc assert the rendered title (e.g. "Track 1 · task: ..." → "Track 1 · ... drill" → "Tracks · popup (1/N)" → onClose called).
Stop-gap (no ink-testing-library): the DrillSubMode state machine is pure on (mode, drillSubMode, showSha). Extract a reducer and unit-test the transitions.
CROSS-REF: review_tui_code_and_tests
```
