---
id: "output_json_keys_rename_v5"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.7
roi: 50.00
owner: null
created_at: "2026-05-09T13:22:42.038Z"
updated_at: "2026-05-09T15:58:33.183Z"
blocked_by: ["output_id_vs_name_audit"]
blocks: []
---

# BREAKING: --json key rename per OUTPUT_LABELS_AUDIT.md (TaskRow.localId→name, *.workstream→workstreamName, ApprovalRow.slug→name, drop TaskNoteRow.id/taskId, etc.)

## Notes (1)

### #1 by "worker-mf-2", 2026-05-09T13:23:15.855Z

```
PHASE 2 BREAKING REWRITE per OUTPUT_LABELS_AUDIT.md "JSON keys cleanup table". No compat layer; no --json-shape v4 flag; no dual-emit.

═══ THE FULL RENAME (single source of truth in audit doc) ═══

  TaskRow:           localId → name; workstream → workstreamName; owner → ownerName
  TaskNoteRow:       drop `id` (autoincrement), drop `taskId` (caller knows)
                     → { author, content, createdAt }
  AgentRow:          workstream → workstreamName
  WorkspaceRow:      agent → agentName; workstream → workstreamName
  ApprovalRow:       slug → name; workstream → workstreamName
  WorkstreamSummary: workstream → name; agents/tasks/notes/edges/workspaces
                     → agentCount/taskCount/noteCount/edgeCount/workspaceCount
  LogRow:            workstream → workstreamName  (seq stays — operator cursor)
  SnapshotRow:       workstream → workstreamName  (id stays — operator-facing in `mu undo --to <id>`)
  Composite verbs:   every bare top-level `workstream:"name"` → `workstreamName:"name"`

═══ FILES TO TOUCH ═══

  Type defs (the source of truth):
    src/tasks.ts       TaskRow, TaskNoteRow + RawTaskRow → row mappers
    src/agents.ts      AgentRow + RawAgentRow → row mapper
    src/workspace.ts   WorkspaceRow + RawWorkspaceRow → row mapper
    src/approvals.ts   ApprovalRow + RawApprovalRow → row mapper
    src/workstream.ts  WorkstreamSummary
    src/logs.ts        LogRow + RawLogRow → row mapper
    src/snapshots.ts   SnapshotRow + RawSnapshotRow → row mapper

  CLI emit sites: src/cli/{tasks/*,agents,workspace,approve,log,workstream,snapshot,state,hud,doctor}.ts
                  + src/cli.ts (formatters that pass rows through)

  Tests: ALL test files asserting --json shape (.localId, .workstream, .slug, .agent, .owner ...).
         Expect ~30+ test file rewrites. Use `rg --type ts "(\.localId|\.slug)\b"` and similar to find them.

═══ JQ MIGRATION RECIPES (CHANGELOG copy ready in audit doc) ═══

  jq ".localId"                  →   jq ".name"
  jq ".[] | .workstream"         →   jq ".[] | .workstreamName"
  jq "select(.owner == \"X\")"   →   jq "select(.ownerName == \"X\")"
  jq ".[] | .agent" (workspaces) →   jq ".[] | .agentName"
  jq ".slug" (approvals)         →   jq ".name"

═══ CHANGELOG REQUIREMENT ═══

[Unreleased] / Breaking. Full rename table + jq migration recipes (already drafted in OUTPUT_LABELS_AUDIT.md).

═══ ANTI-FEATURES (rejected in audit) ═══

  - No --json-shape v4 compat flag
  - No dual-emit { localId, name } both keys
  - No _meta block with rename hints
  - Surrogate INTEGER ids still NEVER appear in --json (snapshot.id and log.seq are NOT surrogate leaks — they were ALWAYS operator-facing)
```
