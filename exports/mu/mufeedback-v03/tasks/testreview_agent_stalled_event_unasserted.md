---
id: "testreview_agent_stalled_event_unasserted"
workstream: "mufeedback-v03"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-10T11:33:13.635Z"
updated_at: "2026-05-10T12:11:10.968Z"
blocked_by: []
blocks: []
---

# test-review: `agent stalled` event-log row from task wait --stuck-after has zero test coverage

## Notes (1)

### #1 by "reviewer-2", 2026-05-10T11:33:17.809Z

```
FILES: src/tasks/wait.ts:294 (the emitEvent call); src/logs.ts:339 (the EVENT_VERB_PREFIXES entry); test/tasks.test.ts:1980-2078 (the existing stuck-warn tests — assert ONLY on stderr warnings)
FINDING: CHANGELOG [Unreleased] § Added — idle_assigned_agent_detection: "mu task wait --stuck-after also persists a kind='event' row payload `agent stalled <name> owns <task-id> for <secs>s` as corroborating signal." A grep for `agent stalled` across test/ returns ZERO hits. The two existing stuck-warn tests in test/tasks.test.ts use setWaitStuckWarnForTests to capture stderr warnings — the agent_logs INSERT side-effect is never queried.

WHY: The event-log row IS the durable corroborating signal mu state and downstream tools surface; the stderr warning is one-shot and dies with the wait process. A regression where the stuck-warn fires but emitEvent silently fails (FK breakage, wrong workstream id, prefix typo) would be invisible: tests pass, operators see a warn line but no event-log entry, mu state's recent-events tail stays empty, idle correlation breaks.

FIX-SKETCH: Inside the existing "emits exactly one STUCK warning" test (or as a sibling):
  const events = db.prepare(`SELECT payload FROM agent_logs WHERE kind='event' AND payload LIKE 'agent stalled%'`).all();
  expect(events).toHaveLength(1);
  expect((events[0] as {payload: string}).payload).toMatch(/agent stalled worker-stuck owns a for \d+s/);
Plus the dedup property: re-run wait, assert event count is 2 (one per call), not N (one per poll cycle).
```
