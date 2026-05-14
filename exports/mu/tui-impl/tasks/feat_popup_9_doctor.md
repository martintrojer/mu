---
id: "feat_popup_9_doctor"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.3
roi: 133.33
owner: null
created_at: "2026-05-11T16:40:15.899Z"
updated_at: "2026-05-11T19:33:16.284Z"
blocked_by: ["feat_card_9_doctor", "feat_popup_search_filter"]
blocks: ["feat_more_cards_umbrella"]
---

# FEAT: Popup 9 — Doctor (Shift+9 / (); list ALL doctor checks + filter; NO TaskDetailDrill chain (rows aren't tasks)

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:40:59.229Z

```
GOAL
----
Add the matching popup for Card 9 — Doctor. Shift+9 (glyph `(`)
opens a fullscreen drill-down of EVERY doctor check (not just the
non-OK subset Card 9 surfaces) with j/k nav, '/' filter, and a
read-only Enter that drills into the check's full detail.

This popup is DIFFERENT from popups 6/7/8 — rows are NOT tasks, so
do NOT chain into TaskDetailDrill. Drill is a small ad-hoc detail
view of a single doctor check.

DATA
----
src/doctor-summary.ts already exposes loadDoctorSummary(db, snapshot)
which Card 9 consumes — that returns NON-OK checks only. The popup
needs ALL checks, including OK ones. Either:
  (a) Add a second SDK function loadDoctorChecks(db, snapshot) that
      returns the full check array (not filtered), OR
  (b) Run the underlying checks SDK directly from the popup (same
      cheap pragmas/COUNT-shape SELECTs).

Pick (a) for cleanliness — keeps the SDK seam.

POPUP LAYOUT
------------
  glyph   check          STATUS  detail
  PROTECT PROTECT        PROTECT CLIP

  ⚠       agents         warn    2 ghost panes…
  ✓       schema         ok      v7 (current)
  ✓       db-locked      ok      WAL mode
  ✗       workspaces     fail    1 orphan dir blocking spawns

Glyph: ⚠ yellow / ✗ red / ✓ green (mirror Card 9).

KEY MAP
-------
- y → yank a remediation suggestion if the check fails/warns:
    agents → 'mu agent list'
    workspaces → 'mu workspace orphans'
    schema → '# schema is ok' (yank a no-op note)
  This is informational — no actual mutating verbs.
- Enter → DRILL into a small detail view of the focused check.
  The detail view renders the check name, status, and a multi-line
  "detail" / "remediation hint" body (longer than the card's
  one-line summary). Use DrillScrollView.
  This is NOT a TaskDetailDrill chain (rows aren't tasks).

KEYS WIRING
-----------
- src/cli/tui/keys.ts: dispatchGlobalKey '(' → openPopup(9).
  Add '(': 9 to the glyphMap; widen the openPopup union to include 9.
- app.tsx: extend popup union to include 9; renderPopup case 9;
  popupNameForId(9) → "Doctor".

FILTER CONTRACT
---------------
- Wire usePopupFilter() with blob `${name} ${status} ${detail}`.
- Mode union "list" | "drill" → standard recursion (drill = check-
  detail view, NOT TaskDetailDrill).

CONSTRAINTS / DOCS / TESTS
--------------------------
- New popups/doctor.tsx (~150 LOC).
- New test/tui-popup-doctor.test.ts (mirror Popup 5/6/7 pattern).
- ARCHITECTURE.md popups list: extend + note that Doctor popup
  drill is its own detail view (NOT TaskDetailDrill).
- AGENTS.md repo-layout block: extend popups/{...}.
- CHANGELOG.md (under v0.4.0): bullet under TUI.
- status-bar.tsx popupNameForId case for "Doctor".

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Read-only TUI: yank remediation hints; never execute.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.

OUT OF SCOPE
------------
- Auto-remediation actions (read-only pledge — yank only).
- Historical doctor trend / sparkline (single-tick latest only).
- A "run-doctor-fresh" verb from inside the popup.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_popup_9_doctor -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T19:33:16.284Z

```
CLOSE: 830a6ad — Doctor popup Shift+9: loadDoctorChecks SDK seam + popups/doctor.tsx (DrillScrollView ad-hoc detail, NOT TaskDetailDrill — rows arent tasks) + keys/app/test wiring; 1735 tests pass (was 1718); typecheck + lint + build all green
```
