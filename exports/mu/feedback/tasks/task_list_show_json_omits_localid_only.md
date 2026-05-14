---
id: "task_list_show_json_omits_localid_only"
workstream: "feedback"
status: CLOSED
impact: 25
effort_days: 0.3
roi: 83.33
owner: null
created_at: "2026-05-10T14:31:33.847Z"
updated_at: "2026-05-10T14:54:24.168Z"
blocked_by: []
blocks: []
---

# task list/show JSON omits localId; only top-level 'name' is exposed

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T14:31:48.024Z

```
OBSERVED 2026-05-10: during a state-audit pass on workstream infer-rs.

REPRO:
  mu task list -w infer-rs --status OPEN --json | jq '.[0] | keys'
  -> [createdAt, effortDays, impact, name, ownerName, roi, status, title, updatedAt, workstreamName]
  No localId field. Same for `mu task next --json` and `mu task show ... --json | .task | keys`.

UNDERLYING SCHEMA: mu sql confirms tasks.local_id exists (the user-facing per-workstream unique name) and tasks.id is the integer PK. The CLI table uses "name" as the column header but the canonical identifier is local_id. JSON exposes it as `name`.

WHY IT'S A NIT:
  1. A script doing `jq '.[].localId'` (the natural inference from agents/workstreams JSON, where localId-equivalents do exist) yields null. I tripped on this myself in this session.
  2. Cross-workstream qualified ref reconstruction wants `workstreamName + "/" + localId`. JSON forces the consumer to know that "name" plays the localId role for tasks specifically.
  3. Skill examples like `NEXT=$(mu task next --json | jq -r '.[0].localId')` are advertised in the SKILL.md "Pick the highest-ROI" recipe but they DO NOT WORK as-shown.

FIX OPTIONS:
  A. Add `localId` alongside `name` in task JSON (compat-safe).
  B. Rename `name` -> `localId` in task JSON (breaking).

VERIFIED: also breaks the SKILL.md "Pick the highest-ROI" recipe verbatim.
```

### #2 by "worker-1", 2026-05-10T14:53:58.683Z

```
FILES:
  - src/tasks.ts (TaskRow interface +localId; rowFromDb sets localId: row.local_id)
  - src/exporting.ts (TaskRow constructed for archive export: +localId mirror of name)
  - test/json-output.test.ts (new regression: pins localId === name across task list/next/show --json)
  - test/output-labels-human-rename.test.ts (relaxed compat-belt assertion that asserted localId NOT present; now asserts both keys present and equal)
  - CHANGELOG.md (entry under [0.3.0] § Fixed)
COMMANDS:
  npm run typecheck        # exit 0
  npm run lint             # exit 0
  npm run test             # 1043/1043 pass
  npm run build            # exit 0
FINDINGS:
  TaskRow.name was the sole per-workstream identifier in JSON. exporting.ts also constructs TaskRow shapes for archive bucket rendering and needed the same field. No other src/ file constructs TaskRow literals. Other domain shapes (AgentRow, WorkspaceRow, WorkstreamSummary) intentionally untouched -- their `name` IS globally unique within their kind.
DECISION:
  Option A (additive). Added `localId: string` to TaskRow alongside `name: string`; both fields hold the same value. Compat-safe: existing scripts using `.name` still work, and the SKILL.md "Pick the highest-ROI" recipe (.localId) now works as advertised.
NEXT:
  None required. A future cleanup could similarly mirror localId on ArchivedTaskRow and NoteRow if `jq -r '.[].localId'` ergonomics are expected there too -- not in scope here.
VERIFIED:
  - typecheck/lint/test/build all green
  - new regression test exercises `mu task list --json`, `mu task next --json`, `mu task show --json` end-to-end via runCli; asserts t.localId === t.name and that .task.localId is "a"
  - relaxed but still-meaningful assertion in output-labels-human-rename.test.ts confirms `name` stays present (no breaking rename)
```
