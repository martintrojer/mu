---
id: "agent_spawn_model_auth_failure_counts_as_live"
workstream: "feedback"
status: CLOSED
impact: 16
effort_days: 0.3
roi: 53.33
owner: null
created_at: "2026-05-11T07:42:13.912Z"
updated_at: "2026-05-11T08:23:57.155Z"
blocked_by: []
blocks: []
---

# agent spawn with unavailable model/provider counts as live worker until task wait stalls

## Notes (4)

### #1 by "π - infer-rs", 2026-05-11T07:42:14.025Z

```
FILES: mu agent spawn/liveness status; pi-meta model selection.
COMMANDS: mu agent spawn worker-profile-1 -w infer-rs --cli pi-meta --command 'pi-meta --no-solo --model sonnet:high' --workspace ... succeeded with pane %2376; later mu task wait on assigned task stalled after 300s; mu agent show displayed 'Error: No API key found for amazon-bedrock' from pi startup and status needs_input.
FINDINGS: invalid/unavailable provider auth can look like a live spawned agent to mu; orchestrator only discovers it after assigning work and waiting for stall.
DECISION: file feedback.
NEXT: spawn/liveness could detect provider-auth startup errors and fail the spawn/reap assigned tasks, or pi-meta could validate model/provider auth before handing control to pi.
VERIFIED: worker-profile-1 scrollback showed the startup auth error and no prompt work was executed.
```

### #2 by "π - infer-rs", 2026-05-11T07:47:45.984Z

```
UPDATE: same failure with 'pi-meta --no-solo --model opus:high': spawn succeeded, but pane showed 'Error: No API key found for amazon-bedrock' and mu task wait later stalled. In this environment the safe pi-meta worker command appears to be default 'pi-meta --no-solo' without explicit model, which selects an Anthropic-backed default; explicit sonnet:high/opus:high routed to unavailable amazon-bedrock.
```

### #3 by "worker-spawnauth-1", 2026-05-11T08:23:48.478Z

```
FILES: src/agents/spawn.ts (awaitSpawnLiveness, detectSpawnStartupError, STARTUP_ERROR_PATTERNS, STARTUP_ERROR_TAIL_LINES); src/agents/errors.ts (new AgentSpawnStartupError); src/agents.ts + src/index.ts re-export; src/cli/handle.ts (exit-code 1 lane); test/verbs-spawn.test.ts; test/error-nextsteps.test.ts; CHANGELOG.md; docs/VOCABULARY.md.
COMMANDS: npm run typecheck && npm run lint && npm run test && npm run build (all green; 1184/1184 tests).
FINDINGS: awaitSpawnLiveness now scans the LAST 30 lines of the post-liveness scrollback for 5 curated patterns (No API key found for X, invalid API key, Authentication failed, 401 Unauthorized, Could not authenticate). Tail-only mitigates false positives from harmless prior-session text on a brand-new pane. On match: existing rollbackSpawn seam runs, then throw new AgentSpawnStartupError carrying matched line + scrollback + nextSteps pointing at pi-meta --no-solo and ANTHROPIC_API_KEY recipes.
DECISION: picked a NEW typed error AgentSpawnStartupError (vs extending AgentDiedOnSpawnError with a startupError flag). Distinct remediation (CLI override vs API key) and pane-alive-but-parked vs pane-dead is a meaningful semantic split. Both map to exit code 1 (substrate-level).
NEXT: feature complete and tested.
VERIFIED: 8 new tests added — pure-scanner unit tests (each pattern, case-insensitive, clean-buffer, tail-window-100-lines), it.each over all 5 patterns through spawnAgent, healthy-spawn pass-through, MU_SPAWN_LIVENESS_MS=0 disables the scan, --workspace rollback path produces orphan-cleanup nextSteps. AgentSpawnStartupError added to error-nextsteps audit.
```

### #4 by "worker-spawnauth-1", 2026-05-11T08:23:57.155Z

```
CLOSE: all 4 green; liveness check now scans scrollback for known auth-error patterns; commit b9b64e11467e94ac91ec6fa547da5a3fd4d2c381
```
