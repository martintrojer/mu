---
id: "review_dedup_filter_editing_effect"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-12T08:32:54.620Z"
updated_at: "2026-05-12T09:28:27.941Z"
blocked_by: []
blocks: []
---

# REVIEW low: 9 popups have identical onFilterEditingChange useEffect

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:32:54.933Z

```
FILES + LINES:
  - src/cli/tui/popups/agents.tsx:97-99
  - src/cli/tui/popups/blocked.tsx:120-122
  - src/cli/tui/popups/doctor.tsx:107-109
  - src/cli/tui/popups/inprogress.tsx:91-93
  - src/cli/tui/popups/recent.tsx:108-110
  - src/cli/tui/popups/ready.tsx:90-92
  - src/cli/tui/popups/log.tsx:98-100
  - src/cli/tui/popups/tracks.tsx:117-119
  - src/cli/tui/popups/workspaces.tsx:191-193 (slightly different — picks list vs drill flt)
CATEGORY: duplication
SEVERITY: low
FINDING: Eight popups have the literal:
    useEffect(() => { onFilterEditingChange?.(flt.editing); }, [flt.editing, onFilterEditingChange]);
The 9th (workspaces) varies the flag source but the wiring is the same. Trivial centralisation; benefit is "new popup author can't forget to wire the StatusBar mode flip".
SUGGESTED FIX: bake the bubble-up into `usePopupFilter` itself: accept an optional `onEditingChange` callback in the hook signature (or expose a sibling `usePopupFilterWithBubble(onEditingChange)`). All 8 popup useEffects collapse. workspaces.tsx still hand-rolls because it needs to choose between two filter instances; that's fine.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:28:27.941Z

```
CLOSE: 651cde3: baked onEditingChange option into usePopupFilter; 8 popups collapsed (3-line useEffect each), 6 drop useEffect import; workspaces.tsx keeps hand-roll (two filter instances) — documented + baseline-tested. typecheck+lint+test(1954)+build all green.
```
