---
id: "selfdoc_verbs_round2"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 50
effort_days: 0.6
roi: 83.33
owner: null
created_at: "2026-05-08T06:19:51.221Z"
updated_at: "2026-05-08T06:51:23.996Z"
blocked_by: ["selfdoc_infra"]
blocks: ["selfdoc_skill_cleanup"]
---

# Impl: nextSteps hints for the rest of the verbs (per audit table)

## Notes (1)

### #1 by null, 2026-05-08T06:41:25.616Z

```
SCOPE EXPANDED: this task now also covers selfdoc_json_universal (which is closed as a duplicate). Doing both as one commit since each remaining verb needs both --json plumbing AND nextSteps hints in the same handler. Splitting them would mean touching every cmd handler twice. See selfdoc_json_universal note #110 for the full --json verb audit.
```
