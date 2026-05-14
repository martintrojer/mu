---
id: "task_wait_any_returns_which"
workstream: "mufeedback-v03"
status: REJECTED
impact: 35
effort_days: 0.15
roi: 233.33
owner: null
created_at: "2026-05-10T07:55:19.521Z"
updated_at: "2026-05-10T07:57:02.808Z"
blocked_by: []
blocks: []
---

# feat: mu task wait --any prints WHICH task fired (not just exit 0); --json includes the firing task's id

## Notes (1)

### #1 by "π - mu", 2026-05-10T07:57:11.394Z

```
REJECTED: skill update (commit 17186ef "pipeline cherry-picks; don't barrier") teaches the orchestrator to poll per-iteration with mu task show --json, which gives WHICH task fired for free. mu task wait --any not extended. Re-promote if friction recurs.
```
