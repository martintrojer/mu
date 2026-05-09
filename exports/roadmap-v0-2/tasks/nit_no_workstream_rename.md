---
id: "nit_no_workstream_rename"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 45
effort_days: 0.4
roi: 112.50
owner: null
created_at: "2026-05-07T17:58:43.774Z"
updated_at: "2026-05-08T05:20:53.120Z"
blocked_by: []
blocks: []
---

# NIT: no `mu workstream rename <old> <new>` verb; forces hand-written SQL migration

## Notes (1)

### #1 by system, 2026-05-07T17:58:43.867Z

```
Surfaced when fixing bug_workstream_name_dot_mangle: the existing 'roadmap-v0.2' workstream had to be renamed and there's no typed verb. The migration touched 4 statements (insert new workstreams row, update tasks.workstream, update agent_logs.workstream, delete old workstreams row) plus a tmux session kill. A typed verb would: validate the new name, do all of those in one transaction, kill+recreate the tmux session if alive, emit a 'workstream rename' event. Maybe 60 LOC.
```
