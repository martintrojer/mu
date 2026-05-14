---
id: "review_tests_yank_matrix_per_state"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.3
roi: 166.67
owner: "worker-2"
created_at: "2026-05-12T08:36:15.410Z"
updated_at: "2026-05-12T10:00:37.486Z"
blocked_by: []
blocks: []
---

# REVIEW med: yank-matrix tests grep for substrings, never simulate the yank per row state

## Notes (3)

### #1 by "worker-3", 2026-05-12T08:36:15.742Z

```
FILES + LINES:
  - test/tui-popup-tasks.test.ts:14-22 — `expect(src).toContain("mu task claim")` etc. Doesn't verify which row state yields which command.
  - test/tui-popup-blocked.test.ts:35-58 (yank intents) — only asserts the strings APPEAR in source.
  - test/tui-popup-recent.test.ts (yankCommandForTask) — DOES test the helper directly. Better than tasks.test.ts but doesn't gate "list mode yields open, drill mode yields notes".
  - test/tui-popup-inprogress.test.ts (yankCommandForTask) — same as recent.
  - test/tui-popup-doctor.test.ts:121-155 — directly tests yankCommandForCheck with 4-5 sample rows. Best of the bunch.
CATEGORY: weak-coverage
SEVERITY: med
FINDING: The yank-matrix is the load-bearing user-visible feature of the TUI ("press y → get the right command for THIS row's state"). It should be tested by simulating the keystroke and asserting the yank callback's last argument is the right command for the focused row. Today, the matrix in popups/ready.tsx (the canonical Tasks popup) is gated only by `expect(src).toContain("mu task claim")` — meaning if a regression maps OPEN→`mu task close` (the wrong verb), the test passes.
The recent + inprogress popups DO export `yankCommandForTask` for direct testing — that's the right shape for a stop-gap. ready.tsx should follow suit (export its `yankCommandForTask`). Better: install ink-testing-library and test the rendered behaviour end-to-end.
SUGGESTED FIX:
  Stop-gap: export `yankCommandForTask` from popups/ready.tsx (currently a private helper). Test:
    - OPEN no owner → claim
    - OPEN owned → release
    - IN_PROGRESS owned → close --evidence
    - CLOSED → open
    - REJECTED → open
    - DEFERRED → open
    - unknown → null
  Long-term: same as review_tests_static_source_overuse — render + simulate.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-2", 2026-05-12T10:00:37.201Z

```
FILES: src/cli/tui/popups/ready.tsx; test/tui-yank-matrix.test.ts; test/tui-popup-tasks.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test (0); npm run build (0); git commit (0)
FINDINGS: Tasks popup yank matrix was only indirectly covered by static source assertions.
DECISION: Exported the pure yankCommandForTask helper and added table-driven state-to-command coverage for OPEN unowned/owned, IN_PROGRESS, CLOSED, REJECTED, DEFERRED, and unknown.
NEXT: None.
VERIFIED: Four greens passed locally; committed as 54526ea.
ODDITIES: None.
```

### #3 by "worker-2", 2026-05-12T10:00:37.486Z

```
CLOSE: 54526ea: yank matrix table-driven tests
```
