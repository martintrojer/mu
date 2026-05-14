---
id: "feat_tui_multi_workstream"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.4
roi: 150.00
owner: null
created_at: "2026-05-11T13:23:29.526Z"
updated_at: "2026-05-11T19:57:54.504Z"
blocked_by: ["bug_tui_render_ghosting", "bug_tui_top_align", "feat_resurrect_state_card", "feat_status_bar"]
blocks: ["tui_impl_complete"]
---

# FEAT: TUI supports multi-workstream like the static card (mu state --tui -w A,B); static card already does, TUI doesn't

## Notes (3)

### #1 by "π - mu", 2026-05-11T13:23:29.832Z

```
Today's dispatch (src/cli/state.ts cmdState) explicitly bails out of
the TUI when multi-workstream is requested:

    if (process.stdout.isTTY && process.stdin.isTTY &&
        opts.mission !== true && !multi) {
        // ... TUI
    }

So `mu state -w A,B` falls through to the STATIC card (which stacks
per-ws cards correctly). After feat_resurrect_state_card lands,
`mu state -w A,B` will continue to render the static stacked card
(unchanged). But `mu state --tui -w A,B` will throw the "TUI is
single-ws today" error from feat_resurrect_state_card's mutual-
exclusion test.

GOAL: --tui multi-ws should work too. Both surfaces (static + TUI)
should accept N workstreams and render coherently.

DESIGN OPTIONS for the TUI's multi-ws view:

A. Stacked dashboards (mirror the static card's stacking):
   Render each workstream as its own labelled section, top-to-bottom.
   Cards within each dashboard reflow per the responsive layout
   task. Pro: visually obvious; matches the static card. Con:
   limited screen real estate; popups become awkward (which ws
   does Shift+1 open against?).

B. Tabbed TUI (one ws at a time, Tab/Shift-Tab cycles):
   Top of dashboard shows a tab strip:
     ╭─ tui-impl  | tui  | gchatui ─╮
   Visible cards/popups always pertain to the active tab. The tab
   strip is the multi-ws affordance; cards/popups themselves stay
   single-ws.
   Pro: all the existing keys keep their meaning per-ws; popups
   work without disambiguation; matches k9s/lazygit's "namespace
   switcher" pattern. Con: only one ws visible at a time (but
   cycling is one keystroke).

C. Side-by-side workstreams:
   Render each ws as a column. Pro: glance-at-everything. Con:
   doesn't scale beyond 2-3 ws; cards are tiny; popups are deeply
   ambiguous.

RECOMMEND OPTION B (tabbed):
- Cleanest interaction model.
- Tab/Shift-Tab cycles through the resolved workstream set.
- Footer / status bar shows the active workstream name.
- Popups always operate on the active tab.
- Single tab = no tab strip (degenerate to today's behaviour).
- Aligns with the design_locked workstream picker (`w` key)
  reservation; the picker becomes "set the active tab" effectively.

IMPLEMENTATION SKETCH:
1. <App> takes `workstreams: string[]` instead of `workstream:
   string`. RunTuiOptions grows `workstreams: string[]` (the resolved
   set from cmdState's resolveWorkstreamSet).
2. <App> tracks `activeWs: number` (index into the array). Tab/
   Shift-Tab adjust it.
3. useDashboardSnapshot is called with `workstreams[activeWs]`.
4. New <TabStrip> component at the top of the dashboard, only
   rendered when workstreams.length > 1. Shows each ws with the
   active one highlighted (inverse / coloured).
5. cmdState's TUI branch: drop the `!multi` guard. Pass the full
   resolvedWorkstreams set to runTui.
6. The mutual-exclusion test added by feat_resurrect_state_card for
   `--tui` + multi-ws gets removed (or inverted into "asserts both
   work in tandem").

EFFORT GROWTH:
- App state machine: +1 piece (activeWs).
- 1 new component (TabStrip).
- Wave 4-style state-restore: tab state is preserved across popup
  open/close (already lives in App, so trivially).

INTERACTION:
- Lands AFTER feat_resurrect_state_card (which establishes --tui as
  the entry point and ships the multi-ws guard).
- Lands AFTER feat_status_bar (the active-ws label belongs in the
  status bar's right zone, next to the tick rate).
- Lands AFTER bug_tui_top_align (alt-screen gives the tab strip a
  reliable top anchor).
- Independent of card/popup work.
```

### #2 by "π - mu", 2026-05-11T16:48:49.465Z

```
CROSS-REF — NO PER-ROW WORKSTREAM COLUMN
-----------------------------------------
The user asked whether the trailing '—' on each Agents-card row
would become a workstream-name column once multi-ws lands. NO.

Per the design recommendation above (option B, tabs):
  - One workstream visible at a time.
  - Tab/Shift-Tab switches the active workstream.
  - The active workstream label lives in the StatusBar (or the new
    TabStrip at the top of the dashboard).

Per-row ws identity is therefore implicit in the active tab — every
visible row belongs to the same ws. A per-row ws column would be
100% redundant within a tab view AND would steal column real estate
from the actual signal columns (agent name, task summary, idle).

If we ever want a true cross-workstream "all agents flat" view (the
rejected option A), THAT view would need a ws column — but option
A was explicitly rejected because of popup-ambiguity / keymap-clarity
problems, so don't reserve a column for an unbuilt rejected option.

WIRE-IN REMINDER
----------------
The sibling task nit_tui_agents_card_drop_idle_placeholder removes
the '—' placeholder NOW (independent of multi-ws). When multi-ws
lands, the cards/* files don't need any per-row schema change — only
the App / TabStrip / StatusBar gain workstream-aware affordances.
```

### #3 by "worker-3", 2026-05-11T19:57:54.504Z

```
CLOSE: d0266a3 — TUI gains multi-workstream tab support via new <TabStrip>; <App> takes workstreams[]; Tab/Shift-Tab cycle; status bar shows active ws; cmdState's --tui multi-ws guard removed. 1746 tests + typecheck + lint + build all green.
```
