---
id: "audit_status_bar_hint_consistency"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.3
roi: 166.67
owner: "worker-2"
created_at: "2026-05-12T16:14:44.546Z"
updated_at: "2026-05-12T18:40:18.672Z"
blocked_by: ["feat_tui_all_tasks_popup", "fix_card_slot_layout_recents_commits_split"]
blocks: []
---

# AUDIT: status-bar bottom hint cluster — define a clear contract for what's always shown vs what lives in ? (help); apply consistently across dashboard/popup-list/popup-drill/popup-filter modes

## Notes (2)

### #1 by "π - mu", 2026-05-12T16:16:08.196Z

```
MOTIVATION (verbatim user)
--------------------------
"new task. audit the bottom hints line(s). what is always shown vs what is listed in ?. make it clear and consistent in all views."

CURRENT STATE (audited live)
----------------------------
src/cli/tui/status-bar.tsx buildHints() defines 4 modes:

  DASHBOARD: g DAG · l commits · 1-9 toggle · Shift 1-9 popup · ? help · q quit · +/- tick · r refresh
             (8 hint pairs)
  POPUP:     <name> · j/k nav · Shift 1-9 switch popup · / filter · Enter drill · y yank · Esc close · ? help · q quit
             (8 hint pairs after the popup label)
  DRILL:     <name> · drill · j/k scroll · Esc back · ? help · q back
             (4 hint pairs after labels)
  FILTER:    <name> · filter · Esc cancel · Enter commit · Bksp edit
             (3 hint pairs after labels)

src/cli/tui/help.tsx Help overlay lists ~25 keys total split across "dashboard" and "in popup" panes. Several are documented in the overlay but NOT in any status-bar hint cluster:
  - dashboard: c (clear footer), 0 (reset tick), Tab/Shift-Tab (multi-ws), F5 (refresh alias)
  - popup:     g/G (first/last), Ctrl-D/U (half-page), PgDn/PgUp (full-page), n/N (next/prev match), "any letter" pseudo-row.
  - drill:     all "in popup" keys EXCEPT j/k/Esc are silently absent from the drill cluster — but most still work.

INCONSISTENCIES TO FIX
----------------------
1. **Drill cluster is a strict subset** of what the user can press. j/k/Esc are shown; g/G/Ctrl-D/Ctrl-U/PgDn/PgUp/y/`/`/n/N are not, but most work in drill mode. User has no way to know without `?`.
2. **Filter cluster missing n/N** (next/prev match). Help overlay calls n/N "v0.next" but match cycling has already shipped in some popups.
3. **Dashboard cluster missing t** (all-tasks popup; if/when feat_tui_all_tasks_popup ships) and **Tab/Shift-Tab** for multi-ws. The `g`/`l` keys ARE shown — inconsistent treatment of top-level keybind-only popups.
4. **`q` semantics differ** mid-cluster:
   - Dashboard: `q quit` (closes the app).
   - Popup-list: `q quit` (also closes the app — confirm; user might assume "back to dashboard").
   - Drill: `q back` (one level up).
   This is reasonable per-mode behaviour, but the labels are inconsistent ("quit" vs "back") and worth confirming.
5. **`r refresh` shown only on dashboard** — popups do refresh on tick too (some have their own poll). Worth confirming whether `r` works in popups.
6. **`+/- tick` shown only on dashboard**. Popups inherit the tick rate but the user can't change it from a popup. Status quo OK.

TWO COMMITMENTS TO LOCK
-----------------------
A. **Always-shown hints** = the 100%-of-the-time keys for that mode that have NO mnemonic affordance elsewhere (no card border, no popup title, no help overlay required to discover).
B. **Help overlay (?)** = the SUPERSET — every key for the current mode plus its sub-mode peers (drill keys when popup-list is shown, filter keys when popup-list is shown).

The contract: anything shown in the hint cluster MUST work right now in this mode. Anything that works but isn't shown in the cluster MUST appear in `?` (no orphan keys).

PROPOSED HINT CLUSTERS (concrete, ready to ship)
------------------------------------------------

Each cluster is sized to fit comfortably on a 100-col terminal. Keep tokens succinct. Drop low-leverage hints (e.g. `+/- tick`) into the help overlay only.

**DASHBOARD** (currently 8 pairs; proposed 7 pairs):
  0-9 cards · Shift 0-9 popups · g DAG · t tasks · / Tab ws · ? help · q quit
                                       ^new       ^new           ^optional, shown only when N ws ≥ 2
  Drop: `l commits` (Shift+0 covers it now per fix_card_slot_layout — this audit lands AFTER that), `+/- tick` (defer to help), `r refresh` (defer to help). Keep `?` and `q` as the universal pair.
  Note the slot range becomes 0-9 (not 1-9) once fix_card_slot_layout lands.
  Note the `g DAG · t tasks` block reflects the keybind-only popup convention. If feat_tui_all_tasks_popup hasn't shipped when this lands, drop the `t tasks` token.

**POPUP-LIST** (currently 8; proposed 7):
  <name> · j/k nav · / filter · Enter drill · y yank · Shift 0-9 switch · ? help · Esc back
  Drop: redundant `q quit` (Esc is the canonical back; q is an alias).
  Same slot-range update (0-9).
  The `Esc back` label clarifies that q/Esc go BACK to dashboard from a popup (not quit-the-app — the user often confuses this; clarify it).

**POPUP-DRILL** (currently 4; proposed 6):
  <name> · drill · j/k scroll · Ctrl-D/U page · / filter · y yank · ? help · Esc back
  ADD: Ctrl-D/U (half-page; users hit it constantly in long drills) and `/`+`y` (these work in drill, just weren't advertised). g/G (top/bot) stays in help overlay only — fewer hits than Ctrl-D/U.

**POPUP-FILTER** (currently 3; proposed 4):
  <name> · filter · type to match · n/N step · Enter commit · Esc cancel
  ADD: `n/N step` if match-cycling works (verify in the popup base hook before adding). If not yet wired, leave as-is and file a separate task.
  Drop: `Bksp edit` (every text field accepts Bksp; not worth the slot).

HELP OVERLAY UPDATES
--------------------
The "?" overlay should mirror the hint clusters BUT include the always-omitted-from-bar keys:
  - Dashboard pane: explicitly add `c clear footer`, `0 reset tick`, `+/= tick faster`, `- tick slower`, `r/F5 refresh now`. Remove the stale "(slot 0 stays reserved)" comment in help.tsx since slot 0 is now Commits (post-fix_card_slot_layout).
  - In-popup pane: keep the existing list. Drop the "any letter — see popup footer" pseudo-row (the per-popup verbs are now first-class hints in the cluster).
  - NEW pane: drill keymap as its own column (or table row) so the user sees what's available WITHOUT having to enter drill first. Today drill keys are conflated under "in popup" — separate them.
  - NEW pane: filter keymap as its own column.
  - Cross-cluster: the help overlay's keys MUST be the SUPERSET of every status-bar hint cluster. Add a Test that asserts this invariant (any key in the bar is also in the overlay; mismatched keys fail the test).

⚠️ COORDINATION ⚠️
- `fix_card_slot_layout_recents_commits_split` (gated behind bug_vcs_detect_misses_git_worktrees, in flight): rewires the 1-9 → 0-9 slot range AND drops `l commits` (replaced by Shift+0). THIS AUDIT must reflect those changes — gate this task BEHIND fix_card_slot_layout_recents_commits_split.
- `feat_tui_all_tasks_popup` (gated behind fix_card_slot_layout): the new `t tasks` keybind goes in the dashboard hint cluster. Gate this audit BEHIND feat_tui_all_tasks_popup AS WELL so we don't show a token for a key that doesn't work yet.
- `feat_tui_cwd_focus_and_tab_overflow` (in flight): wires Tab/Shift-Tab for multi-ws — already exists, just not surfaced in the hint cluster. The `Tab ws` token in the proposed dashboard cluster requires this to be live. Likely already is (Tab/Shift-Tab landed in feat_tui_multi_workstream); if so, no extra gating needed.

WIRING
------
- src/cli/tui/status-bar.tsx buildHints(): rewrite the 4 mode branches per the proposed clusters above. Pure-function refactor; no React change.
- src/cli/tui/help.tsx: split the "in popup" pane into 3 (popup-list / popup-drill / popup-filter); add omitted dashboard keys; remove stale comments; add the `t` row.
- (Optional NEW) src/cli/tui/keymap-spec.ts: extract the canonical keymap (mode → keys → effect) as a single SOURCE-OF-TRUTH so both buildHints() and Help() consume it. Avoids the drift this audit fixes from reappearing. ~80 LOC pure data + helpers.
  → If the worker prefers a smaller diff, skip the centralisation; just rewrite both files in lockstep. Document the pairing in a top-of-file comment so future changes touch both sides.

TESTS (REQUIRED)
----------------
- test/tui-status-bar.test.ts (extend; grep for the existing fixtures): assert the new hint clusters PER MODE.
- test/tui-help-overlay.test.ts (extend): assert the overlay shows the new rows; assert no stale "v0.next" rows.
- test/tui-keymap-consistency.test.ts (NEW): the SUPERSET invariant. For each mode, assert `keys-shown-in-bar ⊆ keys-listed-in-help-overlay`. If a key is absent from the bar but present in help, that's allowed (help is the superset). If a key is in the bar but not the overlay, the test fails — that's the orphan-hint regression we're preventing.
- (If keymap-spec.ts is extracted): unit test the spec is structurally valid — every mode entry has at least one key, no duplicates.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke: node dist/cli.js --help && node dist/cli.js --version

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; status-bar.tsx is 237 LOC, help.tsx is 75. The optional keymap-spec.ts adds a focused module. Combined still well under cap.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: hint cluster contract — always-shown keys per mode; ? overlay is the SUPERSET (drill/filter get their own columns; orphan-hint regression test added)
- Four greens before commit + bundle smoke.

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "TUI status-bar hint clusters re-audited per mode (dashboard/popup-list/popup-drill/popup-filter); each mode now lists exactly the keys you can press in that mode. The `?` overlay is the superset. Drill and filter sub-modes get their own columns in the overlay (previously buried under 'in popup')."
- docs/USAGE_GUIDE.md TUI section: short note on the new contract.
- skills/mu/SKILL.md TUI keymap: align with the new contract.

OUT OF SCOPE
------------
- No new keybindings beyond surfacing existing ones.
- No removal of existing keybindings (this is a presentation audit, not a verb cull).
- No mouse hints (mouse_input is its own task).
- No internationalisation of the hint labels (anti-feature, no i18n).

ORDERING
--------
GATE this task behind:
  - fix_card_slot_layout_recents_commits_split  (so the 0-9 slot range is live and `l commits` is dropped)
  - feat_tui_all_tasks_popup                    (so `t tasks` is a real key when surfaced in the hint cluster)
Both already gated behind other in-flight work; this audit lands AFTER them.

FINAL ACTION
------------
After committing + four greens green + bundle smoke, close YOUR task with:
  mu task close audit_status_bar_hint_consistency -w tui-impl --evidence "<sha>: <one-line summary>"
```

### #2 by "worker-2", 2026-05-12T18:40:18.672Z

```
CLOSE: 28e6b8b: status-bar hint clusters now share keymap spec with ? overlay superset; orphan-hint regression added
```
