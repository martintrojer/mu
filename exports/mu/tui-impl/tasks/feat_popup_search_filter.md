---
id: "feat_popup_search_filter"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: null
created_at: "2026-05-11T14:54:16.770Z"
updated_at: "2026-05-11T16:01:52.904Z"
blocked_by: ["bug_tui_popups_fill_pane"]
blocks: ["feat_popup_5_workspaces", "feat_popup_6_inprogress", "feat_popup_7_blocked", "feat_popup_8_recent", "feat_popup_9_doctor", "tui_impl_complete"]
---

# FEAT: '/' search/filter in list popups (Agents/Tracks/Tasks/Log) — incremental, case-insensitive, fuzzy substring

## Notes (3)

### #1 by "π - mu", 2026-05-11T14:55:28.866Z

```
GOAL
----
Press '/' inside any list popup (Agents · Shift+1, Tracks · Shift+2,
Tasks · Shift+3, Log · Shift+4) to enter an incremental
case-insensitive substring filter. Matches narrow the visible row set
in real time. Esc cancels the filter (restores full list); Enter
"commits" the filter (stays applied; cursor jumps to first match);
Backspace edits the query.

This is the lazygit / k9s / fzf convention. Every comparable TUI has
it; mu's popups are unusable past ~30 rows without it (acceptance
test currently exercises lists in the single-digit row range; a real
production workstream has dozens of agents / tracks / tasks).

ORDERING
--------
Blocked by bug_tui_popups_fill_pane (popups must be edge-to-edge
before the filter line has a sensible place to live — the filter
prompt sits at the bottom of the popup body, just above the
StatusBar).

UX SPEC
-------
- Trigger key: '/' inside a popup. Outside a popup '/' is a no-op
  (or reserved for future "global search" feature; do NOT wire it).
- Prompt position: a single line at the BOTTOM of the popup's body
  region (between the row list and the popup-specific yank-hint
  if any). Render as:
      /<query>_         while editing
      [filter] <query>  after Enter (committed)
  The trailing _ is a literal underscore as a "cursor" character;
  ink doesn't expose a real text-input cursor without ink-text-input
  which we are NOT adding (anti-feature pledge — no new render layer
  beyond cli-table3 + picocolors at runtime, and ink itself is the
  only TUI dep).
- Keymap while filter mode is active:
    Esc       cancel — clear query, return to popup list mode
    Enter     commit — keep query active, return to list mode with
              filter applied; cursor jumps to first visible row
    Backspace pop one char from query
    printable append to query (case preserved in display, lower-cased
              for matching)
    j/k/y/q/Shift-* etc. should NOT navigate while filter mode is
    active — they get appended as literal chars to the query. The
    only exception is Esc (cancel) and Enter (commit).
- After commit: '/' re-enters edit mode with the existing query
  pre-filled (so the user can refine).
- StatusBar mode: add a new `mode="popup-filter"` to status-bar.tsx
  showing `Esc cancel · Enter commit · Backspace edit`. The
  existing `mode="popup"` should ALSO show `/` in its hint cluster
  ("/ filter") so users discover the keybinding.

MATCHING RULES
--------------
- Case-insensitive substring on a per-popup "search blob" string:
    Agents popup : `${name} ${status} ${cli} ${role}`
    Tracks popup : `${head_id} ${head_title}` (concat all task titles
                   later if too coarse — out of scope for v0)
    Tasks popup  : `${name} ${title} ${status} ${owner ?? ""}`
    Log popup    : `${verb} ${rest} ${source}` (the existing
                   classifyEventVerb output)
- Empty query → all rows visible (same as no filter).
- No fuzzy / regex / glob in v0. Plain substring. Add a follow-up
  task if a real user asks for fuzzy.

STATE LOCATION
--------------
Filter state belongs in each popup component (per-popup independent;
opening Agents with `dog` shouldn't pre-filter Log with `dog`):

  const [filter, setFilter] = useState({ query: "", editing: false });

The single-popup invariant in app.tsx already discards popup state on
close — filter naturally resets when the popup unmounts. ✓

IMPLEMENTATION SHAPE
--------------------
Step 1 — extract a tiny shared hook:
    src/cli/tui/use-popup-filter.ts
    export function usePopupFilter(): {
      query: string; editing: boolean;
      onKey(input: string, key: InkKey): "consumed" | "passthrough";
      reset(): void; startEdit(): void;
    }
This hook owns the editing state machine. Returns "consumed" when
the keypress is a filter-mode keystroke, "passthrough" when the
host should run its normal dispatchPopupKey handler (e.g. j/k while
NOT editing).

Step 2 — each popup wires the hook:
    const flt = usePopupFilter();
    useInput((input, key) => {
      if (flt.onKey(input, key) === "consumed") return;
      // existing dispatchPopupKey logic
      const action = dispatchPopupKey(...);
      if (action.kind === "filter") { flt.startEdit(); return; }
      ...existing switch...
    });
And add a case to dispatchPopupKey in src/cli/tui/keys.ts:
    if (input === "/") return { kind: "filter" };

Step 3 — each popup applies the filter to its source array BEFORE
slicing for the viewport:
    const blob = (e) => `${e.name} ${e.status} ${...}`.toLowerCase();
    const q = flt.query.toLowerCase();
    const filtered = q === ""
      ? source
      : source.filter((e) => blob(e).includes(q));
    // then existing cursor / VIEWPORT logic over `filtered`.

Step 4 — render the prompt at the bottom of each popup body:
    {flt.query.length > 0 || flt.editing ? (
      <Box marginTop={1}>
        <Text color={flt.editing ? "yellow" : "gray"}>
          {flt.editing ? "/" : "[filter] "}
          {flt.query}
          {flt.editing ? "_" : ""}
        </Text>
      </Box>
    ) : null}

Step 5 — status-bar.tsx gets a third popup mode:
    type Mode = "dashboard" | "popup" | "popup-filter" | "help";
    case "popup-filter": hint = "Esc cancel · Enter commit · Bksp edit";
The existing tests in test/tui-status-bar.test.ts get one new case.

Step 6 — when filter mode is active, the global useInput in app.tsx
must NOT eat keys before the popup sees them. Today app.tsx's
useInput suppresses "1..9" and "!@#$%^&*()" while a popup is open;
that's already correct. But it also lets q/Q/Esc through to its
"safety net" close-popup branch — the filter prompt's Esc handler
needs to win over the safety net. Easiest fix: in app.tsx, when
the popup is rendering, do NOT register the q/Esc safety net at all
(trust each popup to handle its own close). Or: thread a "popupHasFilterEditing"
boolean from popup → app via context (heavier; avoid).
The clean fix is: drop the safety net in app.tsx and assert each popup
handles close in dispatchPopupKey. Today they do (case "close").

EDGE CASES
----------
- Filter query that hides the cursor's current row → snap cursor to 0
  (or the row at index Math.min(cursor, filtered.length-1)). The
  visible-window centring helper already clamps.
- Filter query that matches zero rows → render the row area as
  `<Text dimColor>(no matches for "<query>")</Text>` and disable
  j/k navigation (they're already no-ops on empty arrays).
- Log popup auto-tail (deferred per existing comments) — for now
  filter is a pure pre-tail filter on the snapshot.recent array.
- Backspace on empty query → no-op.
- Printable chars: limit to ASCII 32..126 + space; ignore tab,
  control characters. Use ink's existing `key.tab` etc. to skip.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge enforces this).
  use-popup-filter.ts is a pure hook → still ink-adjacent (uses
  React's useState) → goes in src/cli/tui/. ✓
- Read-only TUI: filter just narrows visible rows; no DB writes.
- 1500 LOC hard cap per file. usePopupFilter goes in its own file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit message:
    tui: '/' incremental substring filter in all four list popups
- Update help.tsx legend with one row:
    /         filter (in popup)

DOCS
----
- docs/USAGE_GUIDE.md TUI section: add a one-liner under popup
  keymaps.
- skills/mu/SKILL.md TUI keymap line: add / filter.
- CHANGELOG.md draft v0.4.0 entry: bullet under TUI.
- VOCABULARY.md: no new term needed ("filter" is plain English).

TESTS
-----
- test/tui-use-popup-filter.test.ts (NEW): exhaustive state-machine
  coverage of usePopupFilter via React's act() OR via extracting a
  pure-function reducer if the hook is too tangled to test directly
  (recommended: pull the reducer out as `popupFilterReducer(state,
  action)` and test that; keep the hook a thin wrapper).
- test/tui-keys.test.ts: extend dispatchPopupKey tests with the
  new "/" → {kind:"filter"} case, plus assert all other keys are
  unchanged.
- test/tui-status-bar.test.ts: one case for mode="popup-filter".

OUT OF SCOPE
------------
- No regex / glob / fuzzy / scoring. Plain substring v0.
- No persistent / cross-session filter (filter state dies with
  popup close).
- No global "/" search (TUI-wide filter across cards). That's a
  different beast — file as a follow-up FEAT if asked.
- No "filter highlight" (bold the matched substring in each row).
  Tasteful but adds renderRow complexity. Follow-up.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_popup_search_filter -w tui-impl --evidence "<sha + summary>"
```

### #2 by "π - mu", 2026-05-11T14:55:53.083Z

```
ADDENDUM — APPLIES TO FUTURE LIST POPUPS TOO
--------------------------------------------
The four v0 list popups (Agents/Tracks/Tasks/Log) are NOT the only
popups this feature should cover. Cards 5-9 are tracked under
feat_more_cards_umbrella with these planned popups:

  Shift+5 (%) — Workspaces popup     (per-agent workspace rows)
  Shift+6 (^) — In-progress popup    (IN_PROGRESS task rows)
  Shift+7 (&) — Blocked popup        (blocked task rows)
  Shift+8 (*) — Recent closed popup  (recently CLOSED task rows)
  Shift+9 (() — Doctor popup         (diagnostic rows)

Every one of these is a list popup; every one MUST get '/'-filter
out of the box at implementation time. To make that the path of
least resistance, structure THIS task to land a SHARED PRIMITIVE that
new popups consume in ~3 lines, not a per-popup re-implementation.

THIS IS WHY usePopupFilter() (or its pure reducer popupFilterReducer)
IS THE CENTRE OF THE FIX. The wiring per popup should look like:

    const flt = usePopupFilter();
    const filtered = applyFilter(source, flt.query, blobOf);

  where blobOf(item) → string is the per-popup search blob. That
  composition is what new card popups should re-use.

Export from src/cli/tui/use-popup-filter.ts:
  - usePopupFilter (the hook)
  - applyFilter<T>(items: T[], query: string, blobOf: (t:T)=>string): T[]
  - FilterPrompt component (the bottom-of-popup `/<query>_` prompt)

So a future popup author writes:

    const flt = usePopupFilter();
    useInput((input, key) => {
      if (flt.onKey(input, key) === "consumed") return;
      const action = dispatchPopupKey(input, key);
      if (action.kind === "filter") { flt.startEdit(); return; }
      ...own j/k/y/q switch...
    });
    const filtered = applyFilter(source, flt.query,
      (e) => `${e.name} ${e.label}`);
    ...render rows from `filtered`...
    <FilterPrompt state={flt} />

…and gets the full UX (incremental edit, Enter commit, Esc cancel,
status-bar mode flip, no-matches fallback) for free.

UMBRELLA-LEVEL OBLIGATION
-------------------------
Cross-link in this task's commit message:
    tui: '/' incremental substring filter — primitive + 4 popups
         (cards 5-9 popups must consume usePopupFilter when shipped)

And drop a note on feat_more_cards_umbrella reminding the author
that new card popups consume usePopupFilter (so the next worker
can't miss it). The orchestrator should also add this cross-ref
to each of feat_card_5_workspaces / 6_inprogress / 7_blocked /
8_recent / 9_doctor when those tasks are dispatched.

DOCS UPDATE
-----------
docs/ARCHITECTURE.md — the src/cli/tui/ module table should get a
row for use-popup-filter.ts:
    use-popup-filter.ts   shared '/' filter state-machine + applyFilter
                          + FilterPrompt; every list popup consumes it.

That single ARCHITECTURE.md line is the canonical "the next dev sees
this exists" surface.
```

### #3 by "worker-2", 2026-05-11T16:01:52.904Z

```
CLOSE: 417067f '/' filter primitive (usePopupFilter + reducer + applyFilter + FilterPrompt) wired into Agents/Tracks/Tasks/Log popups; status-bar gains popup-filter mode; 1482/1482 tests pass
```
