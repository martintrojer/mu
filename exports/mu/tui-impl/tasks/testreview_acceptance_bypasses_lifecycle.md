---
id: "testreview_acceptance_bypasses_lifecycle"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.4
roi: 150.00
owner: "worker-2"
created_at: "2026-05-12T11:16:55.601Z"
updated_at: "2026-05-12T13:14:09.333Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# TEST REVIEW: acceptance and graph tests bypass lifecycle verbs with raw task status SQL

## Notes (2)

### #1 by "worker-3", 2026-05-12T11:17:01.935Z

```
FILES: test/acceptance.test.ts:186-187; test/tasks-views.test.ts:138-145 and 326-333; test/tracks.test.ts:42-47, 362-370, 391-397, 410-418; also scattered raw task status setup in agents/tasks/logs JSON tests.
FINDING: Several behavior/acceptance tests mutate tasks.status directly with db.prepare(UPDATE tasks SET status=...) instead of exercising closeTask/openTask/setTaskStatus or the CLI. The most serious instance is the canonical acceptance test: it claims specs, adds a note, then closes via raw SQL. That means the end-to-end gate can stay green if lifecycle code stops recording evidence/events, snapshots, owner semantics, updated_at changes, or close guards regress; the ready-list assertion only proves the DB view reacts to a manually stamped CLOSED row.
RECOMMENDED FIX: In acceptance and graph-level tests, use closeTask/setTaskStatus (or runCli(['task','close',...]) where CLI coverage is intended) for status transitions, then assert the side effects that raw SQL currently skips: task status, relevant agent_logs event/evidence/note, and any snapshot/no-op behavior where applicable. Keep raw SQL only for impossible/corrupt-state fixtures and mark those setup-only cases with a short comment explaining why the typed verb is intentionally bypassed.
VERIFIED: audit only; no code changed.
```

### #2 by "worker-2", 2026-05-12T13:14:09.333Z

```
CLOSE: 9ff9ba9: acceptance/graph tests use closeTask/setTaskStatus and assert lifecycle side effects; four greens passed
```
