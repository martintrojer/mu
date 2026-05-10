---
id: "nextsteps_audit_workspace_orphans_phantom_verb"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-4"
created_at: "2026-05-10T13:34:34.779Z"
updated_at: "2026-05-10T13:41:22.458Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: mu workspace orphans hint suggests `mu workspace adopt` which does not exist

## Notes (1)

### #1 by worker-5, 2026-05-10T13:34:44.903Z

```
FILES: src/cli/workspace.ts:142-147
FINDING: cmdWorkspaceOrphans nextSteps offers a verb (`mu workspace adopt`) that does not exist; the inline gloss admits "deferred; see roadmap" but ROADMAP.md has no entry either (grep "workspace adopt" docs/ROADMAP.md returns nothing).
CURRENT-HINT:
  intent: "Adopt the dir as a managed workspace"
  command: mu workspace adopt  (deferred; see roadmap)
STALE-BECAUSE: Pointing operators at a non-existent verb violates the "Bad nextSteps point operators at non-existent verbs" framing. The roadmap reference is also dangling. Either drop the hint, or add a real ROADMAP.md entry behind it.
FIX-SKETCH: Two options:
  (a) Drop the hint outright. Operators currently have one workable path — the rm -rf hint above it — and adoption is theoretical.
  (b) Add a real ROADMAP.md entry under "Workspace" with a promotion criterion ("≥2 operators ask to recover an orphan dir without losing its contents"), then keep the hint pointing AT the roadmap entry by ID.
  Recommend (a) for the small fix.
```
