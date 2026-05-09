---
id: "review_test_hud_default_mid_tautology"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: null
created_at: "2026-05-08T11:25:43.832Z"
updated_at: "2026-05-08T12:57:12.565Z"
blocked_by: []
blocks: []
---

# REVIEW: hud --mid default test compares output to itself (tautological)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:26:00.510Z

```
FILES: test/hud.test.ts:107-111 ; src/cli.ts:3367-3380 (resolveHudMode default branch).
WHAT THE TEST CLAIMS: it("--mid is the default when no mode flag is passed")
WHAT IT ACTUALLY VERIFIES: Runs `mu hud -w ws` and `mu hud -w ws --mid`, asserts stdout strings are equal.
GAP: The two invocations are nearly time-adjacent and should produce identical output IF the impl is consistent — but they're inherently equal in any impl where '--mid is the default'. Conversely, if the default became e.g. --small (clearly wrong), `a !== b` and the test fails — so far so good. BUT: if the default became --line (one-liner), the test still fails on inequality. If the default became --json, fails on JSON-vs-prose mismatch. So mechanically the test does signal something. The deeper issue: when `mu hud -w ws` and `mu hud -w ws --mid` produce DIFFERENT output (e.g. due to time-relative `+12s` strings rendered between the two runs), the test would flake because both runs use `relTime(now - createdAt)`. There's no flake yet because the two seeded events are old enough that `relTime` rounds to the same `Ns`. But on a slow CI or with a poorly-timed clock tick, the assertion `a === b` could spuriously fail.
WHY IT MATTERS: Low-impact but real. A sleep of 1+ seconds between the two invocations during a slow test run could shift `+0s -> +1s` for one event and produce false failures. The behavioural assertion ('default is mid') would be more robustly expressed as: parse `mu hud -w ws --json` from both invocations and assert their `mode` field (or just assert the --json shape that mid mode would produce — agents table present, no tracks list).
SUGGESTED FIX: Either (a) freeze time during the test (vi.useFakeTimers around both runCli calls), or (b) drop the equality check and assert the structural marker that distinguishes mid from other modes (e.g. `expect(stdout).toContain("agents (")` AND `expect(stdout).not.toContain("tracks (")` — already done in the --mid test above, so this whole test is redundant rather than tautological).
```
