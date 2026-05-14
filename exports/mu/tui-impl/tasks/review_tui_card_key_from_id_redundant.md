---
id: "review_tui_card_key_from_id_redundant"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.4
roi: 112.50
owner: "worker-1"
created_at: "2026-05-13T12:53:13.678Z"
updated_at: "2026-05-13T14:13:58.839Z"
blocked_by: []
blocks: []
---

# REVIEW med: cardKeyFromId+popupNameForId are dual switches; CardVisibility keyed by name not id

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:13.959Z

```
FILE(S):
  src/cli/tui/app.tsx:529-552 (cardKeyFromId)
  src/cli/tui/app.tsx:454-477 (visibleCardIds → uses cardKeyFromId)
  src/cli/tui/app.tsx:296-300 (toggleCard handler → uses cardKeyFromId twice)
  src/cli/tui/state.ts:51-78 (CardVisibility type)
  src/cli/tui/layout.ts:18-46 (CARD_CONFIGS keyed by CardId 0..9)

FINDING (duplication / non-idiomatic):
  CardVisibility is keyed by string ("agents", "tracks", "ready",
  "log", "workspaces", "inProgress", "blocked", "commits",
  "recent", "doctor"); every other card-system data structure
  (CARD_CONFIGS in layout.ts, CARD_CULL_PRIORITY, dataCountForCard,
  popupNameForId) is keyed by the numeric CardId 0..9. The bridging
  function `cardKeyFromId(id)` is a 24-line switch that exists ONLY
  to translate between the two representations:

      function cardKeyFromId(id: CardId): keyof CardVisibility {
        switch (id) {
          case 0: return "commits";
          case 1: return "agents";
          ...
          case 9: return "doctor";
        }
      }

  And it's hot — called on every key dispatch (`toggleCard`
  handler), plus once per visible card in `visibleCardIds()` on
  every render.

WHY IT'S A PROBLEM:
  - Two parallel ID systems (numeric + named) for the same 10-item
    enum is a smell. If a developer ever swaps slot 0 (Commits) and
    slot 8 (Recent) again — which has happened TWICE in this
    cluster's history per the `cards/commits.tsx` and
    `cards/recent.tsx` headers — they have to remember to update
    keys.ts AND popupNameForId AND cardKeyFromId AND
    DEFAULT_CARD_VISIBILITY plus the tests.
  - `popupNameForId` (in app.tsx 555-580) is a SECOND 24-line
    switch over the same enum, also repeating the same name list.
  - Both switches are pure data tables — they belong in
    layout.ts as a property of CARD_CONFIGS or as one shared
    const lookup.

PROPOSED FIX:
  Add a `name` field to CardRowConfig (layout.ts):

      0: { name: "commits", chrome: 4, ... }
      1: { name: "agents",  chrome: 4, ... }
      ...

  Re-derive CardVisibility as `Record<CardId, boolean>` (or a
  brand-new keyed object built from CARD_CONFIGS). Then:

      function cardKeyFromId(id: CardId) { return CARD_CONFIGS[id].name; }
      function popupNameForId(id) { return capitalised CARD_CONFIGS[id].name; }

  Or even simpler: collapse both switches into a single
  `CARD_INFO[id] = { key, label }` table.

  Removes ~40 LOC across two switch statements; centralises the
  card name list to one place.

EFFORT NOTE:
  Touches state.ts (CardVisibility shape) + app.tsx (two switches)
  + tests that hardcode the visibility key strings (search
  test/tui-state-hook.test.ts and tui-app.test.ts for
  DEFAULT_CARD_VISIBILITY usage). 0.3-0.5d. Pure refactor; no
  user-visible change.
```

### #2 by "worker-1", 2026-05-13T14:13:58.839Z

```
CLOSE: 6de50b5: cardKeyFromId/popupNameForId folded into CARD_CONFIGS.name lookup
```
