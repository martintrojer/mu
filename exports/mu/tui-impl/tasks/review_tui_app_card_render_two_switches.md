---
id: "review_tui_app_card_render_two_switches"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.3
roi: 150.00
owner: "worker-2"
created_at: "2026-05-13T12:53:28.250Z"
updated_at: "2026-05-13T13:42:48.169Z"
blocked_by: []
blocks: []
---

# REVIEW med: app.tsx has two parallel switch(id) blocks (renderCard + renderPopup) — table candidate

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:53:28.572Z

```
FILE(S):
  src/cli/tui/app.tsx:404-450 (renderCard)
  src/cli/tui/app.tsx:480-525 (renderPopup)

FINDING (duplication):
  Two large `switch (id)` statements live side-by-side in app.tsx,
  each mapping a 0..9 (+ string "dag" / "allTasks") id to a
  card/popup component. Each case is a single-line return of
  `<XCard ...>` / `<XPopup ...>`. The cases all pass the same
  prop bag (snapshot/db/workstream/rowBudget/cols for cards;
  yank/onClose/snapshot/fastTick/slowTick/mode/onModeChange/...
  for popups).

WHY IT'S A PROBLEM:
  - Adding a new card means adding a row to BOTH switches plus
    `cardKeyFromId` (see review_tui_card_key_from_id_redundant)
    plus `popupNameForId` plus `dataCountForCard` (in layout.ts)
    plus the import list at the top of app.tsx. That's 5+ touch
    points for a single card.
  - Each render walks the switch O(N) for every visible card; the
    switch is a constant-time lookup conceptually.
  - Readability: the meaningful information (which component
    answers to which slot) is buried in two boilerplate switches
    instead of being one obvious table.

PROPOSED FIX:
  Replace both switches with a single registry table at the
  module top of app.tsx:

      const CARD_REGISTRY: Record<CardId, FC<CardProps>> = {
        0: CommitsCard, 1: AgentsCard, ..., 9: DoctorCard,
      };
      const POPUP_REGISTRY: Record<NonNullable<PopupId>, FC<PopupProps>> = {
        0: CommitsPopup, ..., 9: DoctorPopup,
        dag: DagPopup, allTasks: AllTasksPopup,
      };

  Then renderCard / renderPopup both shrink to:

      const Component = CARD_REGISTRY[id];
      return <Component {...commonProps} />;

  Combine with the `name` field proposal in
  review_tui_card_key_from_id_redundant and the registry can hold
  `{ name, key, Card, Popup, popupName, defaultVisible, group, ...}`
  so adding a card is one row.

  Smaller subset (separately shippable): just collapse the two
  switches into the two registry maps without unifying with the
  other tables. ~50 LOC delta.

EFFORT NOTE:
  Component prop signatures already converge (cards take
  snapshot/db/workstream/rowBudget/cols; popups take the
  popup-props bag). Two open questions:
  - BlockedCard takes `db` + `workstream` while other cards don't.
    A registry can pass them all unconditionally; cards ignore
    unused props (TS would complain unless prop types widen).
    Easy to handle with a wider per-card prop interface, or by
    making the registry value `{ Component, needsDb }`.
  - Acceptance: 0.3d, low risk. The tests in
    test/tui-app.test.ts that grep for case statements would need
    updating (probably to grep for the registry entries instead).
```

### #2 by "worker-2", 2026-05-13T13:42:47.847Z

```
FILES: src/cli/tui/app.tsx; test/tui-app.test.ts; test/tui-dashboard-layout.test.ts; test/tui-popup-{blocked,commits,doctor,inprogress,recent,workspaces}.test.ts; CHANGELOG.md; docs/ARCHITECTURE.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test:fast (exit 0); npm run test (exit 0); npm run build (exit 0); node dist/cli.js --help (exit 0)
FINDINGS: app.tsx renderCard/renderPopup switch blocks collapsed to CARD_REGISTRY and POPUP_REGISTRY. Common prop bags pass row budgets/width/db/workstream/ticks/footer uniformly; untouched popup files did not need prop-signature edits.
DECISION: kept registries in app.tsx as the smallest TUI-local refactor; did not merge with cardKeyFromId/popupNameForId follow-up.
NEXT: follow-up review_tui_card_key_from_id_redundant can decide whether names/keys join the registry.
VERIFIED: committed b75f38c; four greens plus mandatory dist help smoke passed.
ODDITIES: git checkout is detached HEAD in worker workspace.
```

### #3 by "worker-2", 2026-05-13T13:42:48.169Z

```
CLOSE: b75f38c: switches collapsed to CARD_REGISTRY + POPUP_REGISTRY; tests updated
```
