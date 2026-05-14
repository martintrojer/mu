---
id: "testreview_data_system_author_gap"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: "worker-2"
created_at: "2026-05-13T12:42:04.223Z"
updated_at: "2026-05-13T13:20:44.646Z"
blocked_by: []
blocks: []
---

# REVIEW med: import round-trip test misses system author

## Notes (3)

### #1 by "worker-2", 2026-05-13T12:42:04.560Z

```
FILE(S):
  test/importing.integration.test.ts:67-101
  src/exporting.ts:188-191
  src/importing.ts:331-336

FINDING (weak assertion):
  addNote(db, "ship", "checklist done", { author: "system", workstream: "auth" });
  ...
  const designNotes = listNotes(db, "design", "auth");
  expect(designNotes.map((n) => n.content)).toEqual(["DECISION: JWT", "context follow-up"]);
  expect(designNotes.map((n) => n.author)).toEqual(["alice", "alice"]);

WHY IT'S A PROBLEM:
  The round-trip test seeds a note whose author is the literal string "system", but never asserts that note's restored author. That lets the importer collapse `author: "system"` to `author: null` without failing the suite. The test appears to cover note metadata, but only for the two `alice` notes, so a real metadata-loss bug slips through.

PROPOSED FIX:
  Extend the round-trip assertions to inspect `listNotes(db, "ship", "auth")` and assert both content and author. Also add an explicit null-author note in the fixture so the test distinguishes the two cases: literal "system" must remain "system", while omitted/null author remains null after export/import.

EFFORT NOTE:
  Test-only if filed separately. It should be landed with the exporter/importer fix in review_data_import_drops_system_author because the stronger assertion will fail against the current parser.
```

### #2 by "worker-2", 2026-05-13T13:20:43.829Z

```
FILES: test/importing.integration.test.ts
COMMANDS: npm run typecheck (0); npm run lint (0); npx vitest run test/importing.integration.test.ts test/workstream.integration.test.ts (0); npm run test:fast (0); npm run test (0; 2339 passed); npm run build (0); node dist/cli.js --help (0); git commit (d95babd)
FINDINGS: existing import round-trip fixture seeded a ship note authored by literal "system" but only asserted the design notes authored by alice, so the metadata loss was invisible.
DECISION: assert the seeded ship note returns with author "system" and add the inverse NULL-author round-trip test so those cases cannot collapse again.
VERIFIED: full suite and bundle smoke clean.
NEXT: none.
```

### #3 by "worker-2", 2026-05-13T13:20:44.646Z

```
CLOSE: d95babd: round-trip test now asserts 'system' author survives + NULL stays NULL
```
