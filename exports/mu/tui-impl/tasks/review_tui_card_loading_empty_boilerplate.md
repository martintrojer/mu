---
id: "review_tui_card_loading_empty_boilerplate"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.25
roi: 200.00
owner: "worker-4"
created_at: "2026-05-13T12:53:02.778Z"
updated_at: "2026-05-13T13:53:00.482Z"
blocked_by: []
blocks: []
---

# REVIEW med: 10 cards repeat loading/empty TitledBox+PaddedRows scaffolding (~20 blocks)

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:03.073Z

```
FILE(S):
  src/cli/tui/cards/agents.tsx (loading 53-66, empty 73-89)
  src/cli/tui/cards/blocked.tsx (loading 122-135, empty 138-152)
  src/cli/tui/cards/commits.tsx (loading 47-60, empty 62-76)
  src/cli/tui/cards/doctor.tsx (loading 86-99)
  src/cli/tui/cards/inprogress.tsx (loading 102-115, empty 119-133)
  src/cli/tui/cards/log.tsx (loading 49-62, empty 67-79)
  src/cli/tui/cards/ready.tsx (loading 51-64, empty 66-83)
  src/cli/tui/cards/recent.tsx (loading 87-100, empty 103-117)
  src/cli/tui/cards/tracks.tsx (loading 47-60, empty 65-83)
  src/cli/tui/cards/workspaces.tsx (loading 73-86, empty 100-114)

FINDING (duplication):
  Each of the 10 cards repeats the same loading/empty TitledBox
  scaffolding. The "loading…" branch is byte-identical across all
  cards modulo the title and cardId props:

      if (snapshot === null) {
        return (
          <TitledBox
            height={cardRenderHeight(cardConfig, rowBudget)}
            width={cols}
            title="<Card>"
            cardId={N}
          >
            <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
              <Text dimColor>loading…</Text>
            </PaddedRows>
          </TitledBox>
        );
      }

  The "empty" branch repeats the same shell with a card-specific
  hint string. That's 20+ near-identical 13-line blocks.

WHY IT'S A PROBLEM:
  - Adding a new card-level chrome attribute (e.g. `borderColor`,
    a per-card subtitle override, a new bottom-label rule for
    empty-state) requires editing 20+ blocks. The recent
    `bottomLabel` / `cardRenderHeight` plumbing was added — and
    every card had to be touched.
  - The `PaddedRows rows={rowBudget ?? cardConfig.minRows}`
    formula is repeated 20 times; if it ever needs adjustment
    (e.g. honour a `chrome` floor differently) every card carries
    the change.
  - The pattern violates DRY for a clearly homogeneous concept
    ("show the loading/empty placeholder for THIS card") that has
    a single behaviour.

PROPOSED FIX:
  Add a small helper component to src/cli/tui/cards/ (or
  alongside titled-box.tsx):

      <CardPlaceholder
        title="Agents" cardId={1}
        rowBudget={rowBudget} cols={cols}
        config={cardConfig}
        subtitle={subtitle}     // optional; threaded through
        text="loading…"         // or "(none in progress)" etc.
      />

  Each card collapses its loading/empty branch to one line. The
  variant for cards that need richer JSX (e.g. AgentsCard's
  empty state with a code-style hint) keeps PaddedRows + a
  ReactNode child accepted by CardPlaceholder.

EFFORT NOTE:
  Touches all 10 card files + adds 1 helper. Pure refactor; the
  rendered output stays byte-identical. Card unit tests already
  check title + body text via renderCardToText, so the test deltas
  are minor.
```

### #2 by "worker-4", 2026-05-13T13:53:00.482Z

```
CLOSE: 83d9d9e: CardPlaceholder helper extracted at src/cli/tui/cards/_placeholder.tsx; 10 cards (agents/blocked/commits/doctor/inprogress/log/ready/recent/tracks/workspaces) collapsed loading/empty branches from ~10-line TitledBox/PaddedRows blocks to one CardPlaceholder({...}) call; net -77 LOC across cards; called as a function (not JSX) so test/_card-render.ts walker contract is preserved unchanged; 4 greens (typecheck, lint, test:fast 1351/1351, test 2408/2408, build) + bundle smoke clean
```
