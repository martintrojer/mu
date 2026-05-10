---
id: "review_release_open_in_progress_inconsistency"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-10T11:39:39.934Z"
updated_at: "2026-05-10T12:16:34.441Z"
blocked_by: []
blocks: []
---

# review: releaseTask preserves IN_PROGRESS while clearing owner — yields owner=NULL/IN_PROGRESS

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:39:40.546Z

```
FILES: src/tasks/claim.ts:40-95 (releaseTask)

FINDING: `releaseTask` sets `owner_id = NULL` but only changes status when `--reopen` is passed. Default behaviour: a task in IN_PROGRESS owned by worker-1 becomes owner=NULL, status=IN_PROGRESS. That state is structurally weird: `mu task wait <id>` (default --status CLOSED) has nothing to drive the task forward (no owner; not OPEN so won't be picked up by `mu task next`); the reaper's OPEN-flip path (which DOES clear owner AND flip to OPEN) is the inverse.

WHY: This combination — owner=NULL + status=IN_PROGRESS — is reachable in real usage: an operator runs `mu task release foo` to take the worker off the task without cancelling the task. The skill docs mention `mu task release <id> --reopen` for "give it back to the pool"; bare `mu task release` is doc'd as "the agent gave up mid-flight, hand it back" which suggests OPEN. Two callers that exercise this path: (a) `mu task wait` will block forever; (b) `mu state`'s in-progress section will show the task as IN_PROGRESS but with no owner column populated. The `mu task show` output via lastClaimActor() does cover the "who was working on this" question for owner=NULL/IN_PROGRESS tasks (so this state is observed), but the workflow is unclear.

FIX-SKETCH: Either (a) make `releaseTask` flip IN_PROGRESS back to OPEN by default (rename `--reopen` to `--no-reopen` for the rare preserve-IN_PROGRESS use case), OR (b) refuse `release` against IN_PROGRESS without --reopen and tell the operator to pass --reopen explicitly. Option (a) is the right default per how operators describe the verb; this is breaking but pre-1.0.

DONT-FIX: Don't silently change status without a CHANGELOG entry. Don't conflate release with closeTask.
```
