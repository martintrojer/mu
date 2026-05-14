---
id: "review_dead_code_glyph_for_unused"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-12T08:33:37.633Z"
updated_at: "2026-05-12T09:17:09.665Z"
blocked_by: []
blocks: []
---

# REVIEW low: glyphFor in cards/blocked + cards/inprogress + cards/recent ignores its arg (just returns a constant)

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:33:37.926Z

```
FILES + LINES:
  - src/cli/tui/cards/blocked.tsx:218-220   — `function glyphFor(_t: TaskRow): string { return "⛓"; }`
  - src/cli/tui/cards/inprogress.tsx:158-160 — `function glyphFor(_t: TaskRow): string { return STATUS_EMOJI.busy ?? "⚙"; }`
  - src/cli/tui/cards/recent.tsx:138-140    — `function glyphFor(_t: TaskRow): string { return "✓"; }`
CATEGORY: non-idiomatic
SEVERITY: low
FINDING: Three "helpers" that take a TaskRow argument and ignore it (`_t`). The argument is purely there to give the symbol a TaskRow signature for "consistency" — but the function is a constant. Tests pin the codepoint anyway. The argument's only real purpose is to make popups import it as `glyphFor(t)` so a future "depends on row" impl is plug-in compatible — exactly the "anticipatory abstraction" pattern AGENTS.md bans.
SUGGESTED FIX: drop the argument; export a `BLOCKED_GLYPH = "⛓"`, `RECENT_GLYPH = "✓"`, `INPROGRESS_GLYPH = STATUS_EMOJI.busy ?? "⚙"` constant. Or keep glyphFor but drop the arg + downstream call sites simplify (`glyphFor()` → `glyphFor`). Tests update accordingly.
NOTE: low priority — but the comment header "the colour is applied at the call site; the function returns just the glyph so tests can pin the codepoint without coupling to ink" is a smell on its own (it's a const, not a function).
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:16:41.643Z

```
FILES:
  - src/cli/tui/cards/blocked.tsx (glyphFor() now argumentless; TaskRow import dropped)
  - src/cli/tui/cards/inprogress.tsx (glyphFor() now argumentless; TaskRow import dropped)
  - src/cli/tui/cards/recent.tsx (glyphFor() now argumentless; TaskRow import dropped)
  - src/cli/tui/popups/{blocked,inprogress,recent}.tsx (call sites: glyphFor(t) -> glyphFor())
  - test/tui-card-{blocked,inprogress,recent}.test.ts (call sites + new arity guard)
COMMANDS: typecheck/lint/test/build all clean (exit 0).
FINDING: confirmed AGENTS.md anti-anticipatory-abstraction; const helpers wearing TaskRow signature.
DECISION: dropped the arg (suggested-fix path 2); helpers stay function-shaped (not const exports) so callers continue importing the same symbol; the doc comments now spell out "argumentless because the glyph never depends on the row" so the next reader doesn't re-add the arg.
NEXT: none for this finding.
VERIFIED: 1944 tests pass; new `glyphFor.length === 0` regression guard pinned per card.
ODDITIES: none.
```

### #3 by "worker-3", 2026-05-12T09:17:09.665Z

```
CLOSE: 4a848f89d3eaef31d756a40a62dc4c21639b63a8: dead-code bundle
```
