---
id: "pass_mu_env_to_panes"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-08T08:11:08.698Z"
updated_at: "2026-05-08T08:20:00.797Z"
blocked_by: []
blocks: []
---

# Pass MU_MANAGED_AGENT / MU_AGENT_NAME / MU_WORKSTREAM env vars to mu-spawned tmux panes

## Notes (1)

### #1 by null, 2026-05-08T08:11:08.818Z

```
USER-PROVIDED TASK (pasted into the orchestrator).

Motivation: pi extensions can't tell 'mu-managed worker' from 'normal interactive pi'. The motivating case: a desktop-notification extension that fires on agent_end should suppress for mu workers. The pi-side change is out of scope; this task is just to inject the env vars at pane creation.

Implementation outline (verbatim from the user prompt):

1. src/tmux.ts — thread an `env?: Record<string,string>` option through:
   - NewSessionOptions (newSession)
   - NewSessionWithPaneOptions (newSessionWithPane)
   - NewWindowOptions (newWindow)
   - SplitWindowOptions (splitWindow)
   tmux supports `-e KEY=VALUE` (repeatable) on new-session/new-window/split-window since 3.0. Emit one `-e` flag per entry, after the existing flag pushes and before the `-P -F .../command` args. Validate keys: non-empty + no `=`; throw TypeError otherwise.

2. src/agents.ts — in createOrReusePane (private helper), accept and forward env. In spawnAgent, build:
     paneEnv = { MU_MANAGED_AGENT: "1", MU_AGENT_NAME: opts.name, MU_WORKSTREAM: opts.workstream }
   and pass via env: paneEnv. Don't expose env on SpawnAgentOptions — mu identity vars are not user-tunable.

3. Tests:
   - Unit: newWindow({env:{FOO:'bar',BAZ:'qux'}}) → args contain `-e FOO=bar` and `-e BAZ=qux`. Same for splitWindow + newSessionWithPane.
   - Validation: bad keys throw TypeError.
   - Integration: spawnAgent's tmux call includes the three MU_* envs; verify all three spawn paths (fresh session, new window in existing session, split into existing window).

Constraints:
- Keep diff small; no refactors beyond what's described.
- Don't add deps.
- The -e flag MUST be emitted before the command arg in tmux invocations.
- Preserve assertValidPaneId + existing error semantics.

Validation gate: typecheck + lint + test + build + (optional) live tmux smoke.
```
