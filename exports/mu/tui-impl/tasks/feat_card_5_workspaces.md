---
id: "feat_card_5_workspaces"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: null
created_at: "2026-05-11T13:15:59.026Z"
updated_at: "2026-05-11T14:55:25.198Z"
blocked_by: ["feat_card_header_digit_prefix", "feat_column_aligned_lists"]
blocks: ["feat_more_cards_umbrella", "feat_popup_5_workspaces"]
---

# FEAT: Card 5 — Workspaces (per-agent worktree, behind, dirty); reserved slot 5 from design_global_keymap

## Notes (2)

### #1 by "worker-2", 2026-05-11T14:55:21.126Z

```
FILES:    src/cli/tui/cards/workspaces.tsx (new), src/cli/tui/{app.tsx,keys.ts,state.ts,help.tsx}, src/{state.ts,workspace.ts,index.ts}, test/{tui-card-workspaces.test.ts (new),tui-app.test.ts,tui-keys.test.ts}, CHANGELOG.md, docs/ARCHITECTURE.md, AGENTS.md
COMMANDS: npm run typecheck (clean), npm run lint (clean), npm run test (1404 pass, 90 files), npm run build (clean). git commit 264585f.
FINDINGS: snapshot.workspaces was already populated via decorateWithStaleness so commits-behind + parent_ref were on hand; only the dirty marker required new plumbing. Mirrored decorateWithStaleness's concurrency-cap + jj/none short-circuit conventions in the new decorateWithDirty.
DECISION: kept the matching popup OUT (per task brief). Glyph priority dirty>stale>clean; subtitle suppresses zero counts to avoid '3 · 0 stale · 0 dirty' chatter. Every cell PROTECTED in the column layout because the values are identity-bearing yank targets — no clippable column here.
NEXT:     feat_more_cards_umbrella tracks the slot-5 popup (Shift+5/'%'); a sibling task can wire WorkspacesPopup with per-row yank intents (refresh / commits / free / path).
VERIFIED: 1404 vitest pass; new test file exercises pure helpers + FC smoke; existing tui-keys.test.ts updated for '5' promotion; tui-app.test.ts imports the new card.
ODDITIES: dirty=null (backend command failure) is treated like clean for glyph purposes — we never paint a row red on uncertainty, only on a confirmed positive listDirtyFiles result.
```

### #2 by "worker-2", 2026-05-11T14:55:25.198Z

```
CLOSE: 264585f — Card 5 Workspaces card shipped (per-agent dirty/behind/parent_ref); typecheck+lint+test(1404)+build all green
```
