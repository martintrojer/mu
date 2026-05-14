---
id: "review_test_hud_full_n_loose"
workstream: "mufeedback"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-08T11:23:05.084Z"
updated_at: "2026-05-08T12:57:12.664Z"
blocked_by: []
blocks: []
---

# REVIEW: hud --full -n 1 test only checks header, not the actual cap

## Notes (1)

### #1 by "test-reviewer-1", 2026-05-08T11:23:21.715Z

```
FILES: test/hud.test.ts:130-133 ; src/cli.ts:3408-3412 (eventLimit/listLogs path in cmdHud)
WHAT THE TEST CLAIMS: it("--full -n 1 caps the recent-events tail")
WHAT IT ACTUALLY VERIFIES: After running 4-5 seed verbs (workstream init + 2 task adds in beforeEach), `mu hud -w ws --full -n 1` is invoked and stdout is asserted to contain the literal string "recent (1)". That's the count printed in the section header — which always equals `recentEvents.length` regardless of whether the cap was actually applied.
GAP: If the implementation forgot to pass `limit: opts.lines` to `listLogs` (e.g. `listLogs(db, { workstream, kind: "event" })` with no limit), the section header would be `recent (5)` and the test would catch it. BUT if a future refactor accidentally hard-codes `limit: 5` while still computing `recentEvents.length` from the limited array, the test would still pass — the assertion is on the rendered length, not on a contract that "-n 1 means at most 1 event row is shown". Worse: there is NO test that `-n 5` (default) shows up to 5, no test that `-n 0` is treated sanely, no test that `-n` larger than the available events doesn't error. The test pretends to cover "the cap" but only catches one specific bug class.
WHY IT MATTERS: User-facing tail-length flag with a single weak assertion. A real bug would be: someone refactors `eventLimit = opts.lines ?? 5` to `eventLimit = 5` (dropping the user override) — the test would still pass since `--full -n 1` would yield 5 events and "recent (1)" would never appear; THIS would be caught. But the inverse — where `-n` is honored but the rendered list ignores the slice — slips through. The test is fragile and oversells coverage.
SUGGESTED FIX: After seeding N>1 events (e.g. 4 task-status flips after the workstream init), run `mu hud -w ws --full -n 1` AND `--full -n 3`, parse `--json` form to count entries in `recent: [...]` (existing `--json` path), assert lengths are 1 and 3 respectively. Catches off-by-one, missing limit propagation, and any future drift in either path.
```
