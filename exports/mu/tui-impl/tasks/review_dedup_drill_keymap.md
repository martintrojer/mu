---
id: "review_dedup_drill_keymap"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-2"
created_at: "2026-05-12T08:32:41.597Z"
updated_at: "2026-05-12T09:27:17.542Z"
blocked_by: []
blocks: []
---

# REVIEW med: Drill-mode keymap (close + yank + applyScroll) duplicated across 5 popups

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:32:41.889Z

```
FILES + LINES (drill-mode useInput branch — `if (mode === "drill")`):
  - src/cli/tui/popups/agents.tsx:153-167   — body=scrollback, close→onModeChange("list"), no yank in drill
  - src/cli/tui/popups/ready.tsx:127-145    — body=notesText (renderNotes), yank→`mu task notes`, close→list
  - src/cli/tui/popups/inprogress.tsx:122-140 — same as ready, different yank verb (still notes)
  - src/cli/tui/popups/recent.tsx:135-153    — same again
  - src/cli/tui/popups/blocked.tsx:156-176   — same again
  - src/cli/tui/popups/doctor.tsx:118-137    — body=ad-hoc, yank=remediation hint; otherwise same shape
  - src/cli/tui/popups/log.tsx:114-141      — body=focused.payload, yank=`mu log --since N -n 1`, same shape
  - src/cli/tui/popups/workspaces.tsx:296-318 (commits drill) and :281-294 (show drill) — both follow the same shape
CATEGORY: duplication
SEVERITY: med
FINDING: Every drill-mode keymap is the same six-line skeleton:
   1. compute totalLines from body
   2. if (isNavAction(action)) setScrollTop(s => applyScroll(s, action, totalLines, viewport))
   3. switch action.kind: case "close" → exit drill (+ reset scrollTop); case "yank" → drill-specific verb; default return.
9-10 instances. The shared scroll.ts + viewport.ts already factored the "what does Ctrl-D mean" question; this would factor "what does drill mode mean".
SUGGESTED FIX: build `useDrillKeymap({body, viewport, onClose, onYank})` in src/cli/tui/popups/drill.tsx (sibling of DrillScrollView). Returns the (scrollTop, dispatch) pair. Each popup wires `if (mode === "drill") { drill.dispatch(action); return; }` instead of the open-coded switch. Estimated diff: -120 LOC, +30 LOC. Same anti-drift argument as scroll.ts — Ctrl-D started landing in some drills and not others before centralisation.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-2", 2026-05-12T09:27:17.542Z

```
CLOSE: 3393252: extracted useDrillKeymap; 10 callsites collapsed
```
