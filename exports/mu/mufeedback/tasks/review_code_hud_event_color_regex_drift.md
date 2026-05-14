---
id: "review_code_hud_event_color_regex_drift"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.15
roi: 400.00
owner: null
created_at: "2026-05-09T08:30:05.331Z"
updated_at: "2026-05-09T09:28:42.352Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: cmdHud's colorEventPayload regex doesn't match emitted event verbs

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:30:32.306Z

```
FILES: src/cli/hud.ts:255-262 (colorEventPayload regex)

FINDINGS: The colorEventPayload regex enumerates verbs that DON'T match the actual event payload formats currently emitted by the rest of the codebase:

- `task edge add` / `task edge remove` are listed in the regex but no caller emits them. The actual edge verbs emit `task block ${blocked} by ${blocker}` (src/tasks.ts:617) and `task unblock ${blocked} by ${blocker}` (src/tasks.ts:642). Neither matches.
- `task reparent` is emitted (src/tasks.ts:818) but is NOT in the regex.
- `approve (add|grant|deny)` is in the regex, but src/approvals.ts emits `approval add ...` (src/approvals.ts:165) and `approval ${newStatus} ${slug}` (src/approvals.ts:244) where newStatus is one of granted|denied|timeout. The regex hits zero approval events today.
- `snapshot (capture|restore|prune)` is in the regex, but src/snapshots.ts emits no events at all (`grep -n emitEvent src/snapshots.ts` returns empty).

Net: the regex is a "hint words" that are actively wrong. block/unblock/reparent (the most common day-to-day event verbs after task add/close/note/claim/release) silently fall through the colour path and render dim, even though the bottom-of-HUD "recent events" table is one of the highest-density UI surfaces.

WHY IT MATTERS: 60. This is a maintenance hazard, not a crash bug, but it's exactly the kind of "silent false confidence" pattern the test-reviewer skill flags: the regex looks complete; you trust it. Operators who skim the HUD's recent-events column see e.g. `task block foo by bar` rendered uniformly dim alongside `task close foo` (cyan-cyan), and don't get the visual grouping the function promises in its docstring ("the eye can group events at a glance"). The fix is one line; there's no test coverage demanding the regex stay aligned with emitter sites, so this WILL drift again.

SUGGESTED FIX (~10 LOC):
1. Update the regex in src/cli/hud.ts:256-258 to match real verbs:
   - Replace `task (...edge add|edge remove)` with `task (...|block|unblock|reparent)`.
   - Replace `approve (...)` with `approval (...)`.
   - Drop `snapshot (...)` entirely until snapshots.ts starts emitting events (or move that to a tracked TODO in the same comment block).
2. Cheaper longer-term: extract a single source-of-truth `EVENT_VERB_PREFIXES` array in src/logs.ts that the regex builds from, and that emitter sites can reference. (Probably not worth doing today; the file-comment fix is enough until pattern promotion criteria are met.)

ALTERNATIVES CONSIDERED:
- Test-driven: a unit test that calls colorEventPayload on every emitter-site payload string and asserts the verb token is highlighted. Earns its keep but exceeds the 0.15-day budget; file as a follow-up if drift recurs.
- Drop the colour entirely. No: hud.ts comment says the verb-grouping is load-bearing for visual scanning, and operators have already absorbed the green/cyan/yellow language.

EVIDENCE:
- grep -n colorEventPayload src/cli/hud.ts → 255: regex declared at 256-258
- grep -rn emitEvent src/ | grep -v import → 18 callers; payloads start with: workstream init, agent free, task block, task unblock, task update, agent close, agent spawn, agent adopt, task close (via setTaskStatus → "task status"), task reap, task release, task claim, task add, task note, task delete, task reparent, approval add, approval ${status}, workspace create, workspace free, workstream destroy.
- grep -n emitEvent src/snapshots.ts → empty (no snapshot events emitted).
- src/tasks.ts:617,642,818 confirm task block / task unblock / task reparent payloads.
- src/approvals.ts:162,241 confirm `approval` (not `approve`) prefix.
```
