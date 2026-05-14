---
id: "feat_card_9_doctor"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.3
roi: 133.33
owner: null
created_at: "2026-05-11T13:16:00.189Z"
updated_at: "2026-05-11T16:21:25.872Z"
blocked_by: ["feat_card_header_digit_prefix", "feat_column_aligned_lists"]
blocks: ["feat_more_cards_umbrella", "feat_popup_9_doctor"]
---

# FEAT: Card 9 — Doctor (health checks summary; reuses runDoctor SDK)

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:05:43.938Z

```
GOAL
----
Card 9 — Doctor diagnostics. Slot 9 was the last reserved slot per
design_global_keymap. Mirror Card 5/6/7 (commits 264585f95, 760fc6c,
4c50fc0) — same template.

WHY
---
Health surface for a polled dashboard. `mu doctor` is a separate
verb that runs a battery of checks; surfacing the FAILING ones
directly on the dashboard means the operator notices a broken
state without having to remember to run doctor. Most popular UX
in btop/k9s/lazygit is a tiny health badge.

DATA
----
src/cli/doctor.ts (or src/doctor.ts if it exists) drives `mu doctor`.
Look at how it's structured. Each check returns
{name, status: ok/warn/fail, detail}. The card should pull only
non-OK checks for the dashboard; the popup (later) would show all.

If extending the snapshot with doctor data feels too coupled, use
the lighter pattern: the card runs its own poll-on-tick fetch
(mirroring useDashboardSnapshot) — it's read-only and cheap; doctor
already runs in <50ms typically. But don't add a SECOND tick loop;
piggyback on the existing snapshot tick by extending
loadWorkstreamSnapshot with an opt-in `withDoctor: true` flag (mirror
the `withDirty` flag added by Card 5).

The dirty/withDirty flag pattern (commit 264585f95) is the canonical
example to copy.

CARD LAYOUT
-----------
Columns:

  glyph   check        STATUS   detail
  PROTECT PROTECT      PROTECT  CLIP

  ⚠       agents       warn     2 ghost panes; run `mu agent reconcile`
  ✗       workspaces   fail     1 orphan dir blocking spawns
  ✓       schema       ok       (rendered ONLY if no warn/fail rows)

Glyph: ⚠ yellow for warn, ✗ red for fail, ✓ green for ok.
Subtitle: "<N>" (count of warn+fail) — when 0, render the
all-good case as: subtitle "all healthy" + dim "✓ <K> checks" body.
Empty (impossible since doctor always runs at least one check) →
treat as "all healthy".

KEY WIRING
----------
- keys.ts: digit '9' was reserved → toggleCard(9). This is the LAST
  reserved digit; after this all 1-9 slots are filled. Slot 0 stays
  reserved (by convention; doesn't promote here).
- app.tsx: render <DoctorCard ... /> after Recent; widen
  cardKeyFromId(9) → "doctor".
- src/cli/tui/state.ts: CardVisibility.doctor = true default.
- src/cli/tui/help.tsx: extend digit prefix to ⁹; legend updated.

POPUP / FUTURE OBLIGATIONS (when slot-9 popup ships)
-----------------------------------------------------
Out of scope NOW. The umbrella feat_more_cards_umbrella tracks the
matching popup. The popup MAY consume feat_popup_search_filter
(filtering check names is useful) but does NOT need
feat_track_drill_chains_to_task_drill (rows aren't tasks; Enter
might drill into the check's failure detail or a one-line
remediation hint).

CONSTRAINTS / DOCS / TESTS
--------------------------
Same as Card 6/7. CHANGELOG, ARCHITECTURE.md, AGENTS.md updated.
New test/tui-card-doctor.test.ts.

OUT OF SCOPE
------------
- Shift+9 popup (umbrella tracks it).
- Auto-remediation actions (read-only TUI pledge).
- Historical doctor trend / sparkline (single-tick latest only).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_card_9_doctor -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-2", 2026-05-11T16:21:25.872Z

```
CLOSE: dfadaa2 — Card 9 Doctor: loadDoctorSummary SDK seam (withDoctor opt-in mirrors withDirty) + cards/doctor.tsx + keys/help/state/app wiring (digit 9 → toggleCard); 1542 tests pass (was 1517); typecheck + lint + build all green
```
