---
id: "nextsteps_audit_read_verbs_emit_no_nextsteps"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.4
roi: 87.50
owner: "worker-4"
created_at: "2026-05-10T13:35:16.657Z"
updated_at: "2026-05-10T13:55:39.511Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: many read-only verbs (task list/next/owned-by/tree/show/notes, state, doctor, log read, workspace list/path, agent show/list/read/attach, me) emit no nextSteps

## Notes (1)

### #1 by worker-5, 2026-05-10T13:35:33.415Z

```
FILES: src/cli/tasks/queries.ts (cmdMyTasks, cmdMyNext, cmdTaskList, cmdTaskNext, cmdTaskOwnedBy), src/cli/tasks/tree.ts, src/cli/tasks/edit.ts (cmdTaskShow, cmdTaskNotes), src/cli/state.ts (cmdState all 3 modes), src/cli/doctor.ts (cmdDoctor), src/cli/log.ts (cmdLog read mode), src/cli/workspace.ts (cmdWorkspaceList, cmdWorkspacePath), src/cli/agents.ts (cmdRead, cmdAgentShow, cmdList, cmdAttach, cmdMe), src/cli/archive.ts (cmdArchiveShow happy path on populated archive)
FINDING: SKILL.md says "Every successful verb also prints a `Next:` block of suggested follow-up commands; agents read it, humans skim past it." The docstring contract was set in selfdoc_design (v0.2). In current main, ~17 read-only verbs emit no nextSteps on success. This is a coverage gap, not a correctness gap.
CURRENT-HINT: (none)
STALE-BECAUSE: SKILL.md & VOCABULARY.md describe an invariant that the read verbs silently violate. Either:
  - SKILL.md/VOCABULARY.md should clarify that nextSteps are emitted on MUTATING verbs (the current empirical truth), OR
  - the read verbs should each gain ≥1 cheap hint (e.g. `mu task list` → `mu task next`/`mu task tree <id>`; `mu agent show` → `mu agent send` / `mu task owned-by`; `mu state` → `mu task next`).
FIX-SKETCH: Doc-side fix is one-line in SKILL.md (cap of effort: 0.05). Code-side adds ~3 lines per verb × 17 = ~50 LOC. Recommend doc fix unless an LLM-running-as-worker telemetry shows it consults missing nextSteps blocks.
PRIORITY: low — read verbs are by definition idempotent and the operator chose to look. The mutating-verb nextSteps are higher-leverage.
```
