---
id: "feat_more_cards_umbrella"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.1
roi: 700.00
owner: null
created_at: "2026-05-11T13:16:00.453Z"
updated_at: "2026-05-11T19:41:19.316Z"
blocked_by: ["bug_tui_render_ghosting", "feat_card_5_workspaces", "feat_card_6_inprogress", "feat_card_7_blocked", "feat_card_8_recent", "feat_card_9_doctor", "feat_popup_5_workspaces", "feat_popup_6_inprogress", "feat_popup_7_blocked", "feat_popup_8_recent", "feat_popup_9_doctor", "feat_resurrect_state_card"]
blocks: ["feat_responsive_layout", "tui_impl_complete"]
---

# UMBRELLA: ship cards 5-9 (Workspaces / In-progress / Blocked / Recent / Doctor) + matching popups

## Notes (5)

### #1 by "π - mu", 2026-05-11T13:16:02.094Z

```
The brainstorm reserved slots 5-9 for additional cards
(design_global_keymap "Slots 5-9 are reserved so we can add cards
WITHOUT churning the muscle memory of the four canonical cards"). v0
shipped only cards 1-4. These are the obvious candidates from the
existing audit_state_ts + design_card_iface + design_locked notes.

Recommended order (by ROI, decreasing):
1. card 5 Workspaces — high signal for cherry-pick / refresh-between-
   waves loops; only place that exposes commits-behind + dirty.
2. card 6 In-progress — currently you have to glance at Agents card
   then mentally cross-ref; one card that just shows IN_PROGRESS
   tasks + owners would help.
3. card 7 Blocked — useful for "what's blocking the umbrella" diag.
4. card 8 Recent closed — short-term memory of "what just shipped".
5. card 9 Doctor — least urgent; a polled doctor is unusual.

EACH card needs a matching POPUP (Shift+5..Shift+9 = % ^ & * (). The
glyph mapping already exists in design_global_keymap; dispatchGlobalKey
in src/cli/tui/keys.ts will need 5 new lines.

Per the digit-prefix feat (feat_card_header_digit_prefix), each new
card's header should also use the matching superscript: ⁵ ⁶ ⁷ ⁸ ⁹.
```

### #2 by "π - mu", 2026-05-11T14:56:03.527Z

```
SHARED-PRIMITIVE OBLIGATION FOR POPUPS 5-9
------------------------------------------
A sibling task feat_popup_search_filter introduces:
  - usePopupFilter() hook
  - applyFilter<T>(items, query, blobOf)
  - <FilterPrompt state={flt} /> component

EVERY new list popup added by feat_card_5_workspaces /
feat_card_6_inprogress / feat_card_7_blocked / feat_card_8_recent /
feat_card_9_doctor MUST consume these — '/' filter is now part of
the popup contract, not optional.

The wiring is ~5 lines per popup; see feat_popup_search_filter notes
for the exact recipe. Don't ship a list popup without it.

This obligation should be reiterated in the per-card task spec when
each is dispatched (orchestrator: copy the recipe block into the
dispatch prompt, and into each card-task's notes).
```

### #3 by "π - mu", 2026-05-11T15:11:38.078Z

```
DRILL-RECURSION OBLIGATION FOR POPUPS 6/7/8 (LIST-OF-TASKS POPUPS)
------------------------------------------------------------------
A sibling task feat_track_drill_chains_to_task_drill factors out a
shared TaskDetailDrill component from popups/ready.tsx and chains
the Tracks-drill into it on Enter.

EVERY new card popup whose drill is itself a list of tasks MUST
chain into TaskDetailDrill on Enter the same way:

  Card 6 In-progress popup → drill = list of IN_PROGRESS tasks → Enter chains
  Card 7 Blocked popup     → drill = list of blocked tasks      → Enter chains
  Card 8 Recent popup      → drill = list of recent CLOSED tasks → Enter chains

Card 5 Workspaces popup → drill = list of workspaces (NOT tasks) →
  Enter is either a no-op or chains into a "show workspace commits"
  view; not into TaskDetailDrill. Decide at popup-implementation
  time.

Card 9 Doctor popup → drill = list of diagnostics (NOT tasks) →
  no chain.

The wiring is: import { TaskDetailDrill } from "./task-detail.js";
add "task-detail" to the popup's mode union; add the Enter-while-
drill case; add the render branch. ~25 LOC per popup.

This obligation should be reiterated in the per-card task spec when
each is dispatched (orchestrator: copy the recipe block into the
dispatch prompt, and into each card-task's notes).
```

### #4 by "worker-2", 2026-05-11T16:00:01.566Z

```
CROSS-REF (worker-2 / feat_popup_search_filter)

The shared '/'-filter primitive is shipped at:
  src/cli/tui/use-popup-filter.tsx

Exports:
  - usePopupFilter()              React hook (state machine)
  - popupFilterReducer + classifyFilterKey   pure (test friendly)
  - applyFilter<T>(items, query, blobOf)     pure
  - <FilterPrompt state={flt}/>   bottom-of-popup prompt component

Wiring per popup is ~5 LOC:

  const flt = usePopupFilter();
  useInput((input, key) => {
    if (flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKey(input, key);
    if (action.kind === "filter") { flt.startEdit(); return; }
    ...own j/k/y/q switch...
  });
  useEffect(() => onFilterEditingChange?.(flt.editing), [flt.editing]);
  const filtered = applyFilter(source, flt.query, (e) => `${e.name} ${e.label}`);
  ...render rows from filtered...
  <FilterPrompt state={flt} />

OBLIGATION for cards 5-9 popups (Workspaces / In-progress /
Blocked / Recent / Doctor): MUST consume usePopupFilter rather
than re-implement. The popup-props contract now includes
onFilterEditingChange?: (editing: boolean) => void which <App>
plumbs through to the StatusBar so the hint cluster flips to
mode="popup-filter" while the user is typing.

See AgentsPopup / ReadyPopup / LogPopup / TracksPopup for the
canonical wiring.
```

### #5 by "π - mu", 2026-05-11T19:41:19.316Z

```
CLOSE: all slot-5..9 cards + popups shipped (commits b5e8811 / 760fc6c / 4c50fc0 / 5cccd34 / 1b5c36a + e30df47 / a47259f / 4a25508 / e4efd66 / 7cb06cf); plus filter primitive (a96312c) + drill chain (29e3ba9) consumed by every list popup
```
