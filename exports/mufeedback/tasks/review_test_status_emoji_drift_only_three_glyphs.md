---
id: "review_test_status_emoji_drift_only_three_glyphs"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.1
roi: 350.00
owner: "worker-mf-3"
created_at: "2026-05-09T08:35:20.460Z"
updated_at: "2026-05-09T09:36:15.350Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: STATUS_EMOJI drift-cleanup audit only covers 3 of 7 statuses in parseAgentNameFromTitle tests

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:35:46.558Z

```
FILES: test/tmux.test.ts:843-863 (parseAgentNameFromTitle); test/agents.test.ts:329-417 (composeAgentTitle); src/agents.ts:225-233 (STATUS_EMOJI: 7 entries — spawning, busy, needs_input, needs_permission, free, unreachable, terminated).

WHAT THE TESTS CLAIM: The tests "interpolate STATUS_EMOJI.* (good!)" so any drift between composeAgentTitle and parseAgentNameFromTitle breaks loud. Per the test comment at tmux.test.ts:851-854: "Use the actual STATUS_EMOJI codepoints production emits, so this test breaks loud if STATUS_EMOJI changes shape (any drift between composeAgentTitle and parseAgentNameFromTitle is the bug we're guarding against)."

WHAT THEY ACTUALLY VERIFY: parseAgentNameFromTitle is tested with three STATUS_EMOJI codepoints: `needs_input`, `busy`, `busy` (twice). composeAgentTitle is tested with `busy` (3x), `needs_input` (1x), `free` (1x). Together: busy, needs_input, free — 3 of 7 statuses. Specifically NOT covered:
  - spawning (intentional — composeAgentTitle SKIPS the emoji for spawning, see src/agents.ts:243-245; but parseAgentNameFromTitle should still handle it gracefully if an external pane title contained it; untested)
  - needs_permission (lock glyph; visually distinct, but never appears in any test fixture)
  - unreachable (question_circle; this status fires when reconciliation can't ping a pane — important corner case)
  - terminated (times_circle; rare but real)

Why this matters for "drift": if someone adds a new status (e.g. AgentStatus is extended to include "stale" or "queued") and forgets to add the glyph to STATUS_EMOJI, TS catches it (Record<AgentStatus,string> is exhaustive). But if someone CHANGES the codepoint for, say, STATUS_EMOJI.unreachable from `\uf059` to `\uf128` (question-mark variants), no test fires. The drift-clean comment promises ALL glyphs are pinned by tests; in practice 4 of 7 are not.

GAP: A regression that swaps unreachable's glyph or terminated's glyph silently passes the suite. The visual surface (mu state, mu hud) renders the wrong icon. Production HUD legend (test at hud.test.ts probably exists?) might or might not cover it; check.

WHY IT MATTERS: 35. Cosmetic-glyph regressions are visible to users but not destructive. The drift-cleanup commit (d1d43e0) made a virtue of glyph-source-of-truth — it's reasonable to expect ALL glyphs to be pinned. Easy fix; not pursuing it would itself be a small false-confidence signal.

SUGGESTED FIX: One it() in test/tmux.test.ts that loops over `Object.entries(STATUS_EMOJI)` and asserts `parseAgentNameFromTitle(\`worker · ${glyph}\`) === "worker"` for every status. Equivalent in test/agents.test.ts for composeAgentTitle. ~10 LOC across both files; no new fixtures.

EVIDENCE: test/tmux.test.ts:855-857 — three calls, two distinct emoji (needs_input + busy used twice). test/agents.test.ts:354-417 — busy (3x as the dominant fixture status), needs_input, free. src/agents.ts:225-233 — STATUS_EMOJI has 7 keys. Counterexample: change `unreachable: "\uf059"` to `unreachable: "\uf128"` (different glyph, same status) in src/agents.ts. Run the suite. All tests pass. The HUD now shows a question mark instead of a question_circle for unreachable agents — a visible regression no test catches.
```
