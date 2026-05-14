---
id: "fb_close_require_clean"
workstream: "feedback"
status: DEFERRED
impact: 35
effort_days: 0.3
roi: 116.67
owner: null
created_at: "2026-05-12T11:13:26.163Z"
updated_at: "2026-05-12T11:14:22.292Z"
blocked_by: []
blocks: []
---

# FEAT: mu task close --require-clean opt-in flag — refuse to close when workspace has uncommitted changes (orchestrator safety net for the 'agent closed without committing' failure)

## Notes (1)

### #1 by "π - mu", 2026-05-12T11:13:59.249Z

```
TRIAGED FROM agents_close_tasks_without_committing (proposal 1).

REJECT proposal 1a's auto-commit variant: agents shouldn't make commits silently (anti-feature pledge — every commit is an LLM authorship decision).

ACCEPT proposal 1b as opt-in flag: mu task close --require-clean refuses (TaskCloseDirtyWorkspaceError exit code) when the actor's workspace has uncommitted changes. Default behaviour unchanged for back-compat.

Implementation sketch:
  - mu task close gains --require-clean flag (commander)
  - cli/tasks/lifecycle.ts: if flag set, call workspace.dirty(actor) before the close transaction. If dirty, throw a typed error mapped to a new exit code in handle().
  - Test: integration test with a worker that has uncommitted changes; assert the close fails with the new exit code; without the flag, close succeeds.
  - Docs: USAGE_GUIDE.md mu task close section, CHANGELOG.md.

LOW PRIORITY — opt-in safety net, not a behaviour fix. Defer until a real user repeatedly hits the FINAL ACTION discipline gap.

Promotion criterion (per ROADMAP.md): hit ≥2 times by real users.
```
