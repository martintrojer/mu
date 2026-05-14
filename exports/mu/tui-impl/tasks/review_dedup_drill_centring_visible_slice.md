---
id: "review_dedup_drill_centring_visible_slice"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-12T08:34:19.369Z"
updated_at: "2026-05-12T09:28:28.942Z"
blocked_by: []
blocks: []
---

# REVIEW low: tracks/log/workspaces drills repeat the 'centre cursor in viewport' formula

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:34:19.801Z

```
FILES + LINES (the same `Math.max(0, Math.min(items.length - viewport, cursor - Math.floor(viewport/2)))` pattern):
  - src/cli/tui/popups/log.tsx:226-229 — events list cursor-centring
  - src/cli/tui/popups/tracks.tsx:328-331 — drillTasks cursor-centring
  - src/cli/tui/popups/workspaces.tsx:560-563 (in renderDrillBody) — filteredCommits cursor-centring
CATEGORY: duplication
SEVERITY: low
FINDING: Three popups compute a `start` offset for "scroll the viewport so the cursor is centred", with the same boundary clamps. Sibling helpers (scroll.ts:applyCursor / applyScroll) own the cursor-update math but NOT the visible-slice math. Drift surface: `Math.floor(viewport/2)` vs `Math.ceil(viewport/2)` vs explicit half-window — easy to get subtly different scroll behaviour across popups.
SUGGESTED FIX: add `centredVisibleSlice(items, cursor, viewport): {start, visible}` to src/cli/tui/popups/scroll.ts (sits next to applyCursor — same domain). Three call sites collapse to one line each. Tests in tui-scroll.test.ts add 4-5 cases for the new helper.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:28:28.942Z

```
CLOSE: 651cde3: added centredVisibleSlice(items, cursor, viewport) to src/cli/tui/popups/scroll.ts; log/tracks/workspaces drill views collapse to one line each; tui-scroll.test.ts +7 cases incl. sweep-test pinning legacy formula. typecheck+lint+test(1954)+build all green.
```
