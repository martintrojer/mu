---
id: "fix_card_slot_layout_recents_commits_split"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: "worker-2"
created_at: "2026-05-12T16:00:17.731Z"
updated_at: "2026-05-12T16:52:53.936Z"
blocked_by: ["bug_vcs_detect_misses_git_worktrees"]
blocks: ["audit_status_bar_hint_consistency", "feat_dag_popup_status_filters", "feat_tui_all_tasks_popup"]
---

# FIX: restore Recent to card slot 8; promote Commits to slot 0 (DAG/all-tasks stay as keybind-only popups, no cards)

## Notes (2)

### #1 by "π - mu", 2026-05-12T16:01:23.184Z

```
MOTIVATION (verbatim user)
--------------------------
"questioln. what happened to the mu task to show the last VCS commits and the '0' pane one the tui main screen?"
"oh we have it aleready?"
"what did it replace?"
"put recents back to 8 and move 0 to vcs. the dag and full task list are not cards on the tui. they are key binds taking you straight to those views."

WHAT HAPPENED
-------------
Commit 4838b36 (feat_tui_commits_card) demoted Recent from a dashboard card to popup-only and put Commits in card slot 8. Slot 0 stayed reserved-by-convention.

DIRECTIVE (locked)
------------------
- Card slot 8 = Recent (restore the v0.4 layout).
- Card slot 0 = Commits (NEW promotion of the previously-reserved slot).
- 'g' DAG popup stays a keybind-only popup. NO card.
- 't' all-tasks popup (feat_tui_all_tasks_popup) stays a keybind-only popup. NO card.

WHY
---
The DAG and all-tasks views are richer than what fits in a card; pinning them to card slots wastes a glance row. Commits IS a natural glance card (small, dense, lazygit pattern); slot 0 was sitting unused. Recent had been a glance card since the Recent feature shipped — losing it as a card was a regression even though Shift+8 still opened the popup.

EXACT KEY MAPPING (after this change)
-------------------------------------
Dashboard cards 0..9 (toggle visible):
  0  Commits  (NEW; previously reserved)
  1  Agents
  2  Tracks
  3  Ready
  4  Log
  5  Workspaces
  6  InProgress
  7  Blocked
  8  Recent   (RESTORED — was demoted in 4838b36)
  9  Doctor

Popups Shift+0..Shift+9 = US-keyboard `)!@#$%^&*(`:
  Shift+0 ')'  Commits popup  (NEW)
  Shift+1 '!'  Agents
  Shift+2 '@'  Tracks
  Shift+3 '#'  Ready
  Shift+4 '$'  Log
  Shift+5 '%'  Workspaces
  Shift+6 '^'  InProgress
  Shift+7 '&'  Blocked
  Shift+8 '*'  Recent   (semantics restored — same popup as before, just no longer "popup-only")
  Shift+9 '('  Doctor

Keybind-only popups (no card, no digit):
  g          DAG popup
  t          All-tasks popup (feat_tui_all_tasks_popup; in flight separately)
  l / L      Commits popup → DROP this alias. Shift+0 is the canonical popup key now. Keeping `l` is "two ways to open the same popup", which costs keymap surface. Drop l/L. (If user pushes back later, easy to re-add.)

WIRING
------
- src/cli/tui/cards/commits.tsx: stays; just rendered in slot 0 instead of 8.
- src/cli/tui/cards/recent.tsx: stays; rendered in slot 8 again.
- src/cli/tui/popups/recent.tsx: stays; opened by Shift+8 = '*' (no semantic change to the popup).
- src/cli/tui/popups/commits.tsx: stays; opened by Shift+0 = ')'.
- src/cli/tui/keys.ts dispatchGlobalKey:
    - Add slot 0 = Commits. Today the file says "Slot 0 is reserved by convention" — promote it.
    - Slot 8 = Recent (revert the 4838b36 wiring that bound 8 to Commits).
    - DROP `l` / `L` → openPopup(commits). The Shift+0 binding (which goes through the existing 1-9/Shift+1-9 dispatcher) is sufficient. Update the comment header in keys.ts to reflect the new layout.
    - Cardid type widens to include 0 (already done by feat_tui_dag_popup as "0 | 1 | … | 9", because g→openPopup(0)). VERIFY this — the DAG popup currently uses cardId=0; that needs to MOVE to a string-tagged variant ("dag") so slot 0 numeric is freed up for Commits. Same idea for `t` → "allTasks" string variant.

⚠️ COORDINATION WITH IN-FLIGHT TASKS ⚠️
- feat_dag_popup_status_filters: doesn't touch cardId numbering (status toggles only). Safe to ship in parallel.
- feat_tui_all_tasks_popup: also wires a new popup; that PR should use a STRING-tagged cardId variant ("allTasks"), NOT a numeric slot. The spec already says "Top-level dashboard key: 't'" — keep it keybind-only, no card, no digit slot.
- Existing DAG popup uses cardId=0. THIS task migrates DAG to cardId="dag" (string variant) AND promotes numeric 0 = Commits. Update src/cli/tui/keys.ts dispatchGlobalKey accordingly:
    if (input === "g") return { kind: "openPopup", cardId: "dag" };  // was 0
    // numeric 0 / Shift+0 ')' now route to Commits via the existing 1-9 dispatcher.

- src/cli/tui/app.tsx: PopupId already includes "commits" string AND 0..9 numeric. Add "dag" string variant (already done if dag.tsx uses it; otherwise add). Update the renderPopup branch + popupNameForId switch.

- src/cli/tui/layout.ts (added in feat_responsive_layout): the layout function consumes `visibleCardIds[]`. Verify it handles slot 0 + slot 8 correctly. Likely fine since it's already generic over 1..9; just extend to 0..9. Check the per-card config (smallpair / task-list / stream tags) — Commits already lives in 'stream' from feat_responsive_layout's design (Log + Commits = stream column).

UPDATES (centralized)
---------------------
- src/cli/tui/keys.ts: comments + dispatchGlobalKey body.
- src/cli/tui/app.tsx: dashboard slot rendering; renderPopup branch.
- src/cli/tui/help.tsx: row "0  toggle Commits card" replaces / supplements the slot rows; drop "l/L → commits" row; row "g  DAG popup", "t  all-tasks popup" as keybind-only entries (separate section "Keybind-only popups" or similar).
- src/cli/tui/status-bar.tsx: dashboard hint cluster — replace any explicit `l commits` / `8 recent` mismatch with the new layout. The 1-9 hint string should become 0-9.
- src/cli/state.ts: any visibleCardIds default that excludes 0 needs updating.
- src/state.ts loadWorkstreamSnapshot: recentCommits opt-in stays (it's the data source for the Commits card; no change to data loading).

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js` in any tui/ file. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version
If silent → cycle.

TESTS
-----
- test/tui-keys.test.ts: assert
  * 0 toggles Commits card (was: slot 0 reserved → unbound).
  * 8 toggles Recent card (was: 8 toggled Commits).
  * Shift+0 ')' opens Commits popup.
  * Shift+8 '*' opens Recent popup (unchanged semantics).
  * 'g' opens DAG popup (cardId="dag", not 0).
  * 't' opens all-tasks popup IF that task lands first; otherwise SKIP this assertion (cross-PR coordination).
  * 'l' / 'L' do NOT open Commits popup (alias dropped).
- test/tui-card-commits.test.ts: still passes; just rendered in slot 0 now (introspection of slot index may need an update).
- test/tui-card-recent.test.ts: restored to slot 8.
- test/tui-popup-recent.test.ts: still works (popup unchanged).
- test/tui-help-overlay.test.ts: row updates.
- test/tui-status-bar.test.ts: hint cluster updates (0..9 vs 1..9).
- test/tui-dashboard-layout.test.ts (added in responsive_layout): cards 0 + 1..9 placed correctly; pair-aware packer respects new tags.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO: node dist/cli.js --help; node dist/cli.js --version (bundle smoke)

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; this is a NET-WASH change (no new components).
- Conventional commit prefix: tui:
- Suggested commit:
    tui: Recent back to card slot 8; Commits promoted to slot 0; DAG/all-tasks stay keybind-only popups (no card)
- Four greens before commit + bundle smoke.

DOCS
----
- CHANGELOG.md [Unreleased] — under "Changed" (this is a UX revert + repromotion):
  * "Recent restored to dashboard card slot 8 (was demoted to popup-only in v0.5 alpha when Commits took the slot)."
  * "Commits promoted to dashboard card slot 0 (was reserved-by-convention)."
  * "Dropped `l`/`L` alias for the Commits popup; Shift+0 ')' is the canonical key."
- docs/USAGE_GUIDE.md TUI keymap: 0..9 instead of 1..9 (with the new commits / recent assignments).
- skills/mu/SKILL.md TUI keymap: same.
- docs/ARCHITECTURE.md src/cli/tui/cards/ row: extend to mention slot 0 promotion + the dag/all-tasks keybind-only convention.

OUT OF SCOPE
------------
- Don't redesign the popup contents. Just slot mapping + key binding rewiring.
- Don't add a config to remap slots (anti-feature).
- Don't change the in-popup behaviour of any popup.

ORDERING
--------
This should land BEFORE feat_tui_all_tasks_popup so the all-tasks PR doesn't accidentally rewire slot 0 (the all-tasks popup spec is already keybind-only via 't'; this gating just makes the convention explicit). It should also land BEFORE feat_dag_popup_status_filters to avoid stomping on the DAG popup's renderPopup branch wiring (low risk; just sequencing nicety).

FINAL ACTION
------------
After committing + four greens green + bundle smoke, close YOUR task with:
  mu task close fix_card_slot_layout_recents_commits_split -w tui-impl --evidence "<sha>: <one-line summary>"
```

### #2 by "worker-2", 2026-05-12T16:52:53.936Z

```
CLOSE: a9a3b04: Recent restored to slot 8, Commits promoted to slot 0, DAG keybind-only, l/L dropped
```
