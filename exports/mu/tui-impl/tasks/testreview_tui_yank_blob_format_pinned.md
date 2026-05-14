---
id: "testreview_tui_yank_blob_format_pinned"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: "worker-3"
created_at: "2026-05-13T12:54:30.594Z"
updated_at: "2026-05-13T15:50:58.226Z"
blocked_by: []
blocks: []
---

# REVIEW low: 3 popup tests pin filter-blob template-literal format byte-for-byte

## Notes (3)

### #1 by "worker-4", 2026-05-13T12:54:31.563Z

```
FILE(S):
  test/tui-popup-recent.test.ts:80-89
  test/tui-popup-blocked.test.ts:90-100
  test/tui-popup-inprogress.test.ts:91-101

FINDING (test smell — fragile regex + tautological coverage):
  Three popup test files all have the SAME shape of test:

    it("filter blob covers id + title + owner (matching rules)", () => {
      expect(SRC).toMatch(/\$\{t\.name\} \$\{t\.title\} \$\{t\.ownerName \?\? ""\}/);
    });

  This regex matches one specific template-literal source layout
  byte-for-byte. Any reformatting (a longer line broken across
  multiple lines, swapping ` for ', adding parentheses around
  the expression, switching `${t.name}` to a variable) silently
  fails — but the test name says "covers id + title + owner",
  which is the actual requirement.

WHY IT'S A PROBLEM:
  - The test asserts SOURCE FORMAT, not BEHAVIOUR. A different
    blob expression with identical semantics fails. A blob that
    accidentally drops `t.title` but keeps the literal substring
    `${t.name} ${t.title}` somewhere unrelated passes.
  - Three near-identical regex pinnings (one per popup) — if
    the convention changes (e.g. a new "status" field is added
    to the blob across the board), all three regex tests fail
    simultaneously without distinguishing which popup is wrong.
  - Documents the SHAPE of the implementation, not the SEARCH
    BEHAVIOUR. A test reader can't tell from the assertion what
    the blob is supposed to do, only what bytes it should
    contain.

PROPOSED FIX:
  Replace with a single shared behaviour test (test/_popup-fixture.ts):

      function testFilterMatches(makePopup, sourceTasks, query, expectedNames) {
        // Mount with sourceTasks; type '/' + query + Enter;
        // capture rendered output; assert only expectedNames are
        // visible.
      }

  Then per popup:

      it("filter matches by name", () => {
        testFilterMatches(InProgressPopup, [task("design_x"), task("review_y")], "design", ["design_x"]);
      });
      it("filter matches by title", () => {
        testFilterMatches(InProgressPopup, [task("a", { title: "design something" }), task("b")], "design", ["a"]);
      });
      it("filter matches by owner", () => {
        testFilterMatches(InProgressPopup, [task("a", { ownerName: "alice" }), task("b")], "alice", ["a"]);
      });

  Replaces 1 fragile regex × 3 popups with a 3-case behaviour
  test × 3 popups, that actually pins the search semantics.

EFFORT NOTE:
  ~0.3d. Depends on (or motivates) the input-driving harness
  proposed in testreview_tui_app_no_behaviour_coverage. Without
  a harness, the smaller fix is: replace the regex with an
  assertion on a pure-function `filterBlob(t)` extracted from
  each popup. That moves the contract into a real function with
  a real signature that TS can enforce.
```

### #2 by "worker-3", 2026-05-13T15:50:57.905Z

```
FILES: test/tui-popup-inprogress.test.ts; test/tui-popup-blocked.test.ts; test/tui-popup-recent.test.ts
COMMANDS: rg blobOf/filter patterns; npm run test:fast -- test/tui-popup-inprogress.test.ts test/tui-popup-blocked.test.ts test/tui-popup-recent.test.ts; npx biome check test/tui-popup-inprogress.test.ts test/tui-popup-blocked.test.ts test/tui-popup-recent.test.ts; npm run typecheck && npm run lint && npm run test:fast && npm run build; git commit
FINDINGS: Source regex tests pinned applyFilter blob template-literal shape in in-progress/blocked, and recent had only id-substring filtering. Replaced with Ink mount+simulateInput tests that filter by title/owner or title/blocker and assert the matching row remains while noise rows disappear.
DECISION: No CHANGELOG change; test-only cleanup is covered by commit message and task evidence.
VERIFIED: npm run typecheck, npm run lint, npm run test:fast, npm run build all pass.
ODDITIES: rg found two literal blob-regex tests, not three; recent was already behaviour-style but only covered id filtering, so expanded it to cover title+owner semantics.
```

### #3 by "worker-3", 2026-05-13T15:50:58.226Z

```
CLOSE: b0b9360: 3 popup blob-format regexes replaced with behaviour tests
```
