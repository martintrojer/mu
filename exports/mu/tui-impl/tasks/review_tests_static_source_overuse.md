---
id: "review_tests_static_source_overuse"
workstream: "tui-impl"
status: DEFERRED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-12T08:35:23.109Z"
updated_at: "2026-05-12T08:50:39.789Z"
blocked_by: []
blocks: []
---

# REVIEW high: Many popup tests assert on source-text regex (typeof === function + grep)

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:35:23.420Z

```
FILES + LINES:
  - test/tui-popup-tasks.test.ts (entire file) — `expect(src).toContain("mu task claim")` etc.
  - test/tui-popup-agents.test.ts — same shape
  - test/tui-popup-tracks.test.ts — same
  - test/tui-popup-log.test.ts — same
  - test/tui-popup-blocked.test.ts — same (heavy use of regex on source)
  - test/tui-popup-inprogress.test.ts:74-141 — long static-source assertion list
  - test/tui-popup-recent.test.ts — same
  - test/tui-popup-workspaces.test.ts — same plus "no TaskDetailDrill import" anti-import
  - test/tui-popup-doctor.test.ts — same
  - test/tui-acceptance.test.ts:113-119 — even the "acceptance" test asserts `expect(src).toMatch(/mu task claim \${t.name}/)`
  - test/tui-app.test.ts:30+ — App tests are entirely structural source scans.
CATEGORY: false-confidence / fake-testing
SEVERITY: high
FINDING: A large fraction of the TUI test suite is regex-on-source. Tests pass when:
   - the literal string "mu task claim" appears anywhere in the file (including a comment, a typo'd variant `mu task claimx`, or a deleted-but-string-leftover);
   - the source contains `onModeChange("drill")` (even if it's wired to the wrong action — e.g. on yank instead of Enter).
Tests fail spuriously when a maintainer renames a helper or extracts a constant. Comment from the test files themselves: "We can't snapshot ink output without ink-testing-library (network-blocked)."
The acceptance test is the worst offender — it claims to be the "TUI end-to-end acceptance" but the third assertion is `expect(src).toMatch(/mu task claim \${t.name} -w \${ws}/)` against popups/ready.tsx source. That's not acceptance, that's `grep`.
SUGGESTED FIX:
  1. Install `ink-testing-library` as a devDependency (per docs/ROADMAP.md if it's been resisted; otherwise just add to package.json + npm i). This is the single highest-leverage change.
  2. Rewrite the popup tests to:
       a. Mount the popup with a fixture snapshot.
       b. Send the `y` keystroke.
       c. Assert that the YANK CALLBACK was called with the expected command string (real behaviour: the user's clipboard would receive that exact string).
       d. Same for Enter (drill), filter mode (typing), Esc (close).
  3. Delete every regex-on-source assertion EXCEPT the architectural anti-pattern guards (e.g. tui-popup-viewport-no-hardcode.test.ts, tui-card-render-width.test.ts) — those genuinely catch a code-shape regression class.
ROUGH CARVE-OUT: keep the static guards that target an EXPLICIT anti-pattern; delete the static guards that just paraphrase the source. The suite's signal-to-noise jumps materially.
NOTE: orchestrator should plan this as a separate fix wave — large surface but very high value.
CROSS-REF: review_tui_code_and_tests
```
