---
id: "doc_stale_vocab_release_update"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-4"
created_at: "2026-05-10T13:22:27.805Z"
updated_at: "2026-05-10T13:30:25.977Z"
blocked_by: []
blocks: []
---

# docs: VOCABULARY.md `mu task update --status closed` example references nonexistent --status flag

## Notes (1)

### #1 by reviewer-3, 2026-05-10T13:22:37.815Z

```
FILES: docs/VOCABULARY.md:148, docs/VOCABULARY.md:287
FINDING: Two small drifts in the canonical-terms doc:
  (1) :148 "Verbs that move tasks through the lifecycle" table row: `mu task update <id> --status closed | Lifecycle transition`. `mu task update` does NOT accept `--status` (src/cli/tasks/wire.ts:373-391: only --title / --impact / --effort-days). The verb description is even explicit: "Use close/open/release for status/owner changes." The example is contradicted by the verbs own help text. Replace the row with `mu task close/open/reject/defer <id>`.
  (2) :287 "before destructive verbs (schema v5)" — snapshots predate v5; the parenthetical implies v5 introduced them. Either drop the version qualifier or correct to "(introduced in schema v4; carried forward)".
WHY: VOCABULARY is the source-of-truth doc per AGENTS.md ("If you use a term not defined there, fix the docs first"). A flatly wrong example here propagates downstream.
FIX-SKETCH: one-line fix per row.
```
