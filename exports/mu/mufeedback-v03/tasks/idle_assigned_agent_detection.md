---
id: "idle_assigned_agent_detection"
workstream: "mufeedback-v03"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: null
created_at: "2026-05-10T08:24:13.906Z"
updated_at: "2026-05-10T09:05:45.849Z"
blocked_by: ["task_wait_reconcile_dead_panes"]
blocks: ["task_wait_stall_action_flag"]
---

# feat: detect 'idle but assigned' agents — alive pane, owns IN_PROGRESS task, no progress; surface in mu state + mu task wait

## Notes (1)

### #1 by "π - mu", 2026-05-10T08:25:07.141Z

```
Detect 'idle but assigned' agents (third lifecycle state).

═══ THE GAP (just hit; worker-6 example) ═══

Today mu's agent lifecycle assumes two kinds of un-progress:
  - DEAD PANE: pane gone → reaper flips IN_PROGRESS task → OPEN, reaps.
  - ACTIVELY WORKING: pane alive, status=busy, task progressing.

Missing third state:
  - IDLE BUT ASSIGNED: pane alive, status=needs_input, owns an IN_PROGRESS task, no progress evidence in scrollback for >N seconds. The pi process inside the pane hit an error ('Operation aborted', model timeout, rate-limit, transient connection drop) and stopped working WITHOUT crashing. Reaper doesn't fire (pane alive). mu task wait stalls (status doesn't change). Operator only notices via side-channel scrollback inspection.

Today's --stuck-after on mu task wait warns when an agent is in needs_input AND owns an IN_PROGRESS task for ≥N seconds, BUT it's observation-only and only fires from inside the wait verb. mu state doesn't surface it. The signal isn't propagated.

═══ THE TARGET BEHAVIOR ═══

A new derived AGENT STATE: 'idle' (or 'stalled'; pick the clearer name).

  Predicate: pane alive AND status=needs_input AND owns ≥1 IN_PROGRESS task AND last status-change was ≥N seconds ago (configurable, default 300s — matches today's --stuck-after default).

Surfaced in:
  1. mu agent list / mu state agents table — color/glyph for 'idle' (orange/⚠️) so operator sees at a glance.
  2. mu hud — same.
  3. mu task wait — already does this via --stuck-after; promote the warning to a structured event (kind='event' payload starting 'agent stalled') so wait can also exit fast (option B from task_wait_reconcile_dead_panes — extend the same exit-6 mechanism to cover stalled-not-just-dead).
  4. mu state --json — agents array gets a derived 'idle' boolean field per agent.

ACTION SURFACE (operator's recourse):
  mu agent send <name> '<retry-prompt>'           # poke the pi context to retry
  mu task release <id> --evidence 'agent stalled' # clear ownership; re-dispatch
  mu agent close <name>                           # nuke pane; reaper handles the task
  
Document the recovery flow in SKILL.md.

═══ HOW TO DETECT THE 'NO PROGRESS' SIGNAL ═══

Several candidates; pick the cheapest reliable one:

A. agents.updated_at vs now — if the pane's status hasn't transitioned in ≥N sec WHILE owning IN_PROGRESS. Today's --stuck-after uses this. Cheap; per-row read.

B. agent_logs entries from this agent in the last N sec — if zero events from source=<agent-name>, that's a signal of no recent SDK activity (no claim/release/note/close). Slightly noisier but more robust to status-detector flakes.

C. tmux pane scrollback content match — look for known error strings ('Operation aborted', 'Error: Connection error', 'Retry failed', 'Rate limit'). Fragile to upstream pi changes; AVOID.

  RECOMMEND A as primary signal (matches today's --stuck-after; consistent UX). B as a secondary corroborator if A's threshold is exceeded.

═══ DELIVERABLE ═══

1. src/detect.ts (or wherever agent status detection lives): add a derived 'idle' bool to AgentRow / agent state; computed at read time (NOT stored — agents.status enum stays as-is).
   - idle = (status=='needs_input' AND ownsInProgress AND now - updated_at ≥ MU_IDLE_THRESHOLD_MS).
   - MU_IDLE_THRESHOLD_MS env var; default 300000 (5 min).

2. src/agents.ts listLiveAgents: enrich the returned AgentRow with the idle flag; consumers (state, hud, task wait) read it.

3. src/cli/state.ts + src/cli/hud.ts: render 'idle' agents with the warning glyph (⚠️ or similar) and orange color. Update the legend if there's one.

4. mu task wait: extend the existing --stuck-after path. When the predicate fires, ALSO emit a kind='event' log row payload 'agent stalled <name> owns <task-id> for <secs>s' and (per the in-flight task_wait_reconcile_dead_panes design) optionally exit fast. Add a new flag --exit-on-stall (boolean; default true if reconcile-on-wait is on, false otherwise — match exit-6 semantics).

5. JSON shape: agents array gains 'idle: true|false'; mu hud / mu state JSON consumers can detect.

6. SKILL.md addition (Hard-earned dispatch lessons):
   - 'agent showed up as idle (alive but assigned, no recent progress) — see scrollback via mu agent show <name> -n N; recover via mu agent send <name> '<retry>' OR mu task release <id> --reopen.'

7. Tests in test/agent-idle.test.ts (NEW):
   - Pane alive + needs_input + owns IN_PROGRESS + updated_at older than threshold → idle=true.
   - Same but updated_at recent → idle=false.
   - Same but doesn't own a task → idle=false.
   - Pane alive + busy + owns task → idle=false (busy is the right state).
   - Threshold honors MU_IDLE_THRESHOLD_MS env var.

═══ INTERACTION WITH task_wait_reconcile_dead_panes (in flight) ═══

That worker (currently re-dispatched after its own model error) is adding reconcile-on-wait + exit-6 on reaper-flip. The natural extension is: exit-6 ALSO fires on idle-detection (alive but stalled). Same UX, same recovery story.

Coordinate: idle_assigned_agent_detection lands AFTER task_wait_reconcile_dead_panes (sequential); idle is a third condition added to the existing exit-6 branch. ~30 LOC delta on top of the reconcile-on-wait code.

═══ ANTI-FEATURES ═══

  - DON'T auto-restart pi inside a stalled pane. Idle isn't always a recoverable error; the operator decides. (Auto-restart would make a 'transient model timeout' invisible.)
  - DON'T auto-release the task when idle is detected. Reaper-on-dead-pane is one thing (clear graceful: pane gone = work won't continue); idle is ambiguous (pane might recover on next message). Surface, don't act.
  - DON'T match on scrollback content (fragile; upstream pi changes break it).
  - DON'T add idle as a new status enum value (would force a schema change + tests across the surface). Keep status as 4 values; idle is a derived flag.

═══ PROMOTION ═══

  - Real-user friction: hit ≥1x today (worker-6 'Operation aborted'); the v0.2 wave's --stuck-after addition came from the same shape of friction (worker_close_discipline_gap pattern) so this is the second similar hit.
  - Substrate ready: agents.updated_at + listLiveAgents pipeline already present; --stuck-after is the CLI prior-art.
  - Fits in <300 LOC: yes (~150 incl. tests).

PROMOTE for v0.3.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close idle_assigned_agent_detection -w mufeedback-v03 --evidence 'idle derived flag; surface in state/hud/wait; tests; SKILL note'
```
