---
id: "agent_spawn_liveness_check_trips_on"
workstream: "feedback"
status: CLOSED
impact: 15
effort_days: 0.2
roi: 75.00
owner: null
created_at: "2026-05-10T15:15:03.870Z"
updated_at: "2026-05-10T15:48:53.871Z"
blocked_by: []
blocks: []
---

# agent spawn liveness check trips on solo-locked CLIs (e.g. pi-meta --solo)

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T15:15:17.389Z

```
OBSERVED 2026-05-10 while orchestrating workstream infer-rs:

REPRO:
  $ mu agent spawn scout-perf-1 -w infer-rs --command pi-meta --role read-only
  -> spawn failed: agent scout-perf-1 died within 1500ms of spawn (pane %1894).
     Most common cause: the spawned CLI exited immediately (e.g. a wrapper CLI blocking on its instance lock; ...)

ROOT CAUSE: pi-meta wraps pi in a `solo` per-project lock by default. A second pi-meta in the same project root immediately exits because solo's lock is held. The error message correctly diagnoses this ("wrapper CLI blocking on its instance lock"), but two friction points remain:

1. The Next: block tells the user to set MU_<UPPER_CLI>_COMMAND globally, which is overkill for a one-off scout. The real fix here is `--command "pi-meta --no-solo"` on the scout spawn (which works), but that recipe is not in the Next: block or the skill.

2. For agents in --role read-only that demonstrably do not need write isolation (read scrollback only), mu could optionally suggest --no-solo flags or auto-pass them. But that's CLI-specific so probably not mu's job.

UX SUGGESTION:
  - Add to the spawn-fail Next: block: "If the CLI uses a per-project lock (solo, flock, etc.), pass --command 'pi-meta --no-solo' or its equivalent."
  - Possibly link to a docs page listing common single-instance CLIs and their bypass flags.

Severity: low. Tripped me once during multi-agent orchestration, recoverable in seconds once the cause is named, but tripped me at the worst time (mid-pipeline waiting for the next dispatch).
```

### #2 by "worker-1", 2026-05-10T15:48:37.246Z

```
FILES:
  - src/agents/errors.ts (AgentDiedOnSpawnError.errorNextSteps): split single override step into two; per-spawn first, global second; reordered to scrollback / per-spawn / global / liveness / doctor.
  - test/error-nextsteps.test.ts: new regression "AgentDiedOnSpawnError advertises per-spawn --command override before the global env-var" pinning per-spawn step exists, includes `--command "`, agent name interpolated, and per-spawn index < global index.
  - CHANGELOG.md ([0.3.0] § Fixed): one-paragraph entry naming the task id.

COMMANDS:
  - npm install (exit 0; node_modules was empty in this workspace)
  - npm run typecheck (exit 0)
  - npx biome check --write src test (exit 0; auto-formatted 2 files)
  - npm run lint (exit 0)
  - npm run test (exit 0; 59 files / 1065 tests pass; new regression included)
  - npm run build (exit 0)

FINDINGS: The error message body already names the wrapper-CLI/instance-lock cause correctly; the only friction was Next: only listing the global env-var, so operators reached for env-var when --command would do. Per-spawn `--command` already worked end-to-end; it just was not advertised in the error path.

DECISION: Smallest honest fix: edit only errorNextSteps(); don't touch spawn pipeline, error message, or CLI surface. No new flag/env var. Did not add a docs page of CLI bypass flags (out of scope for mu — CLI-specific knowledge). Reordered list so smallest-blast-radius (per-spawn) precedes shell-wide (env-var).

NEXT: none — single-file behaviour fix with regression test.

VERIFIED: typecheck + lint + test (1065 pass) + build all clean. New regression test asserts (a) a per-spawn step exists with `--command "`, (b) agent name interpolated, (c) per-spawn index < env-var index. Confirmed by running the suite end-to-end.
```
