---
id: "review_complexity_status_bar_hint_dual_render"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.15
roi: 300.00
owner: null
created_at: "2026-05-12T08:33:50.458Z"
updated_at: "2026-05-12T09:43:09.133Z"
blocked_by: []
blocks: []
---

# REVIEW med: status-bar.tsx maintains hintsPlain() + renderHints() in lockstep (drift risk)

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:33:50.799Z

```
FILE + LINES:
  - src/cli/tui/status-bar.tsx:90-110 (hintsPlain) and :112-176 (renderHints)
CATEGORY: complexity / duplication
SEVERITY: med
FINDING: Two parallel switches over (mode, popupMode, popupName). hintsPlain returns a plain string used purely to size the LEFT zone's truncation budget; renderHints returns the JSX with coloured `<Key>` tokens. The header comment honestly says "Keep in lockstep with renderHints()" — that's a maintenance burden that will silently rot on the next edit (e.g. someone adds a new hint to renderHints but forgets hintsPlain → narrow-terminal LEFT zone is a few cols too generous and overlaps the keys cluster).
SUGGESTED FIX: build the hint as a single declarative array of `{plain, jsx}` pairs (one entry per token), then derive both the plain string (`.map(p=>p.plain).join("")`) and the JSX (`.map(p=>p.jsx)`) from it. Single switch per (mode, popupMode); zero drift surface. Tests in tui-status-bar.test.ts already assert on the rendered string + on the absence of "F1" / "!@#$"; they continue to pass.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:43:09.133Z

```
CLOSE: fcd5b81: status-bar hint cluster collapsed to single declarative HintToken[] list; hintsPlain() and renderHints() both derive from buildHints(), no second source of truth. 20-test tui-status-bar suite passes unchanged. 4 greens.
```
