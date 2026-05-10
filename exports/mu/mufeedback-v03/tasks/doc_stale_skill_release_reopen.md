---
id: "doc_stale_skill_release_reopen"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-3"
created_at: "2026-05-10T13:22:58.113Z"
updated_at: "2026-05-10T13:29:49.633Z"
blocked_by: []
blocks: []
---

# docs: SKILL.md --reopen description for `mu task release` is wrong — reopen is now CLOSED/REJECTED/DEFERRED un-close, not the IN_PROGRESS auto-flip

## Notes (1)

### #1 by reviewer-3, 2026-05-10T13:23:13.449Z

```
FILES: skills/mu/SKILL.md:183, :287-289, :408
FINDING: Per CHANGELOG [Unreleased] Changed (review_release_open_in_progress_inconsistency), bare `mu task release` now auto-flips IN_PROGRESS → OPEN; `--reopen` is the un-close escape hatch (CLOSED/REJECTED/DEFERRED → OPEN). On IN_PROGRESS, `--reopen` is a no-op vs bare release. SKILL.md:
  (1) :183 "recover via `mu agent send <name> <retry>` OR `mu task release <id> --reopen`." For an IN_PROGRESS-but-stuck task, `--reopen` is unnecessary now (bare release does the right thing). The recovery hint should say `mu task release <id>` (or specifically call out --reopen only for un-closing a CLOSED task).
  (2) :287-289 inline help block has it half-right: "mu task release <id> [--reopen]   # clear owner; IN_PROGRESS → OPEN | auto-flips so task re-enters ready; --reopen forces OPEN from CLOSED/REJECTED/DEFERRED". The bracketed-paste makes it ambiguous — the [--reopen] flag is shown on the same line as "IN_PROGRESS → OPEN" which reads as if --reopen is what triggers the IN_PROGRESS flip. Move [--reopen] to the second line beside the CLOSED/REJECTED/DEFERRED clause.
  (3) :408 "You dont have to manually `task release --reopen` after a crash." — should be `task release` (no --reopen) since the reaper already flips status. The --reopen here is a v0.2 carryover (back when bare release left status=IN_PROGRESS).
  VOCABULARY.md:151 already has the correct semantics — SKILL.md is the lagging doc.
WHY: SKILL.md is the in-pane LLMs manual; sending an unnecessary --reopen flag is harmless but conveys the wrong mental model and triggers a release that may not fail-fast on locked rows.
FIX-SKETCH: 3 single-word edits in SKILL.md as above.
```
