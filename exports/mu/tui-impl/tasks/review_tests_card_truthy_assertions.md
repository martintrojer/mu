---
id: "review_tests_card_truthy_assertions"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "worker-2"
created_at: "2026-05-12T08:34:57.265Z"
updated_at: "2026-05-12T09:47:43.911Z"
blocked_by: []
blocks: []
---

# REVIEW high: Card tests assert toBeTruthy() with no behaviour coverage

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:34:57.559Z

```
FILES + LINES:
  - test/tui-card-agents.test.ts:24-29 — `expect(AgentsCard({snapshot:null})).toBeTruthy()`
  - test/tui-card-tracks.test.ts:25-31 — same shape
  - test/tui-card-ready.test.ts:23-29 — same
  - test/tui-card-log.test.ts:21-27 — same
  - test/tui-card-doctor.test.ts:71-93 — `result = DoctorCard({...}); expect(result).toBeTruthy()` for null / empty / healthy / populated branches.
  - test/tui-card-inprogress.test.ts:55-77 — same shape, four "renders rows for populated list" branches all asserting `toBeTruthy()`.
  - test/tui-card-recent.test.ts:55-79 — same.
  - test/tui-card-workspaces.test.ts:48-78 — same.
  - test/tui-card-blocked.test.ts:71-83 — same.
CATEGORY: false-confidence / weak-assertions
SEVERITY: high
FINDING: Every card test that exercises the FC body is essentially:
   const result = SomeCard({snapshot: ...});
   expect(result).toBeTruthy();
A React FC always returns a truthy JSX element unless it throws. So the assertion is "the card didn't throw at construction time" — which is import-graph testing, not behaviour testing. A regression that swaps two columns, drops a row, mis-formats a status glyph, or passes the wrong colour spec ALL pass these tests.
The pure helpers (formatBehind, formatSubtitle, glyphFor, ageMs, …) are tested well — the gap is the integration: "given a populated snapshot, the card emits the rendered cells we expect."
SUGGESTED FIX: leverage the `renderToString` / element-introspection trick already used in test/tui-status-bar.test.ts and test/tui-tab-strip.test.ts:
   function walk(n) { /* recurse n.props.children, accumulate strings */ }
For each card, assert:
   - Title row contains the card name + the expected subtitle.
   - For populated rows: every task name + ROI label + glyph appears in the output exactly once (not a count, not a substring of garbage).
   - Empty-state branch contains the actual hint text ("(no agents) try `mu agent spawn ...`").
   - Truncated branch (>ROW_LIMIT) renders the ROW_LIMIT visible IDs and the bottomLabel "+N more · Shift+X".
~12-15 new behaviour assertions per card; cards/agents.tsx + cards/blocked.tsx are the highest-value targets first.
NOTE: this is the single biggest test gap in the TUI surface.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-2", 2026-05-12T09:47:40.621Z

```
FILES: test/_card-render.ts; test/tui-card-{agents,tracks,ready,log,doctor,inprogress,recent,workspaces,blocked}.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test (exit 0; 118 files / 1946 tests); npm run build (exit 0); npx vitest run test/tui-card-*.test.ts (exit 0)
FINDINGS: All prior toBeTruthy() card integration assertions were replaced with renderCardToText() element-introspection checks using the walk-recursion pattern from existing TUI tests.
DECISION: Added shared test/_card-render.ts so all nine card tests inspect returned JSX text consistently, including TitledBox title/subtitle/bottomLabel and ListRow cells without booting ink.
NEXT: None.
VERIFIED: Four-green gate passed locally: typecheck + lint + full test suite + build.
ODDITIES: Glyphs/constant status tokens can legitimately appear once per row, so tests assert exact row counts where repeated glyphs/statuses are expected and exact-once for per-row IDs/titles/unique labels.
```

### #3 by "worker-2", 2026-05-12T09:47:43.911Z

```
CLOSE: 07560e2: replaced toBeTruthy with walk() assertions
```
