---
id: "review_tests_acceptance_isnt_acceptance"
workstream: "tui-impl"
status: DEFERRED
impact: 55
effort_days: 0.3
roi: 183.33
owner: null
created_at: "2026-05-12T08:35:39.674Z"
updated_at: "2026-05-12T08:50:38.584Z"
blocked_by: []
blocks: []
---

# REVIEW high: tui-acceptance.test.ts is mostly static-source assertions, not E2E

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:35:40.004Z

```
FILE + LINES:
  - test/tui-acceptance.test.ts (entire file, but specifically lines 113-119, 121-130, 132-150)
CATEGORY: false-confidence / weak-coverage
SEVERITY: high
FINDING: The "TUI end-to-end acceptance" test:
   1. Builds a real DB with 4 tasks + edges. ✓ good.
   2. Calls loadWorkstreamSnapshot. ✓ good.
   3. Asserts the snapshot shape (track count, ready/blocked counts, recent length). ✓ good.
   4. Then drops to: `expect(src).toMatch(/mu task claim \${t.name}/)` ← NOT acceptance.
   5. `expect(src).toMatch(/opts\.tui === true/)` ← grep on cli/state.ts.
   6. `expect(src).toMatch(/await import\("\.\/tui\/index\.js"\)/)` ← grep again.
   7. The alt-screen escape test asserts source bytes appear in escapes.ts.
None of this exercises the TUI's actual behaviour: render → keystroke → state change → rendered frame. The first two grep assertions could pass with `process.exit()` wired in the middle of cmdState; nothing would catch it.
SUGGESTED FIX:
  - Acceptance should mount the TUI (via ink-testing-library — see review_tests_static_source_overuse), feed it a sequence of keystrokes ("3" toggle, "#" open popup, "j" move cursor, "y" yank, "Esc" close), and assert the FINAL FRAME plus the yank callback's last argument.
  - Failing that (no ink-testing-library), narrow the file to ONLY the SDK seam check (the snapshot shape gate is genuinely valuable) and drop the source-grep assertions — they're redundant with the per-popup grep tests anyway.
NOTE: depends on review_tests_static_source_overuse for the ink-testing-library install.
CROSS-REF: review_tui_code_and_tests
```
