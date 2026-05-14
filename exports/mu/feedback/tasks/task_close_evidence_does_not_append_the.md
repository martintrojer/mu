---
id: "task_close_evidence_does_not_append_the"
workstream: "feedback"
status: CLOSED
impact: 10
effort_days: 0.2
roi: 50.00
owner: null
created_at: "2026-05-10T23:14:57.312Z"
updated_at: "2026-05-11T08:11:01.963Z"
blocked_by: []
blocks: []
---

# task close --evidence does not append the evidence as a final note

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T23:15:04.613Z

```
re-attaching: slug truncated.

OBSERVED 2026-05-10 in workstream infer-rs.

When a worker calls `mu task close <id> --evidence "..."`, the evidence string is recorded in the agent_logs event payload but does NOT show up in the `mu task notes <id>` list. As an orchestrator I have to look at both `mu task notes` AND query agent_logs (or check the worker's pane scrollback) to see what they verified.

REPRO: worker-clippy-2 closed clippy_fix_remaining_all_targets_lints with --evidence "clippy --all-targets clean; tests green"; mu task notes only showed the pre-existing spec note. Several other workers (worker-perf-3, worker-canonical-2) closed without leaving a final note, relying on --evidence — and the evidence was invisible in `mu task notes`.

UX SUGGESTIONS:
  1. On `task close` with --evidence, automatically insert a synthetic note `CLOSE: <evidence>` so the evidence is part of the note timeline.
  2. Or: extend `mu task notes` to interleave close/claim events with --evidence chronologically.
  3. Or: extend `mu task show --json` to surface the most recent close --evidence as a top-level field.

Severity: low. Workaround (always drop a final note before close) is documented in the skill's task note contract, but workers skip it when --evidence feels sufficient.
```

### #2 by "worker-evidence-1", 2026-05-11T08:10:52.909Z

```
Implemented OPTION 1 in src/tasks/lifecycle.ts: closeTask now auto-inserts a synthetic note "CLOSE: <evidence>" via addNote when opts.evidence is non-empty AND the close actually changed status (idempotent re-close skipped to avoid spam). Author resolved in the CLI (src/cli/tasks/lifecycle.ts) via resolveActorIdentity() → MU_AGENT_NAME > pane title > $USER > orchestrator. Empty-string evidence treated as none. Tests added in test/tasks-lifecycle.test.ts: with --evidence inserts CLOSE: note, without omits, empty omits, idempotent re-close stays at 1 note. Existing evidence-event tests adjusted (lastEventPayload now takes optional match because closeTask emits TWO events: status + note). 4/4 green; smoke verified mu task notes shows the new CLOSE: row.
```
