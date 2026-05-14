---
id: "task_wait_stall_action_flag"
workstream: "mufeedback-v03"
status: CLOSED
impact: 40
effort_days: 0.2
roi: 200.00
owner: null
created_at: "2026-05-10T09:13:02.894Z"
updated_at: "2026-05-10T11:37:47.845Z"
blocked_by: ["idle_assigned_agent_detection", "task_wait_cross_workstream"]
blocks: []
---

# feat: mu task wait --on-stall warn|exit — expose the stall action (today: warn-only); exit 7 = STALL_DETECTED

## Notes (1)

### #1 by "π - mu", 2026-05-10T09:13:49.319Z

```
mu task wait --on-stall warn|exit — expose the stall action.

═══ THE FRAMING ═══

`--stuck-after <N>` (today, default 300s) defines the TRIGGER for stall detection: an IN_PROGRESS task whose owner has been in needs_input for ≥N seconds. The ACTION is currently hardcoded to 'warn' (yellow STUCK message to stderr; wait keeps polling).

This task EXPOSES the action as a flag. Two separable concerns:
  - --stuck-after <N>     when (trigger; today's flag, semantics unchanged)
  - --on-stall <action>   what (NEW; values: warn (default) | exit)

So `--stuck-after` and `--on-stall` are NOT redundant — one is the trigger, the other is the response. They compose.

═══ THE TARGET SHAPE ═══

  mu task wait X                                    # default: warn at 300s; today's behavior byte-for-byte
  mu task wait X --stuck-after 60                   # warn at 60s; today's tuning
  mu task wait X --on-stall exit                    # warn THEN exit at 300s with code 7
  mu task wait X --stuck-after 60 --on-stall exit   # exit at 60s
  mu task wait X --stuck-after 0                    # disable BOTH the warn and the exit (today's --stuck-after 0 semantics preserved)
  mu task wait X --on-stall warn                    # explicit default; equivalent to omitting

═══ EXIT CODE 7 = STALL_DETECTED ═══

Mirrors exit 6 (REAPER_DETECTED) from task_wait_reconcile_dead_panes. Consumers can branch:
  6 → dead pane (reaper-flipped IN_PROGRESS to OPEN; re-dispatch is the recovery)
  7 → idle agent (alive but no progress; operator decides if it's transient)

stderr message format: 'task <id> owned by <agent> has been needs_input for <secs>s; exiting per --on-stall exit. Re-dispatch a worker or send a poke (mu agent send <agent> "...") and re-run wait.'

═══ INTERACTION WITH EXISTING --any / --first AND CROSS-WS ═══

- Multi-task wait: --on-stall exit fires on the FIRST watched task that hits the stall threshold (regardless of --any vs default --all). Mention which task in the stderr message.
- Cross-workstream wait: per-poll reconcile already loops over the watched workstreams (post task_wait_cross_workstream); --on-stall exit reads the union of watched task statuses + the new agent-idle flag (post idle_assigned_agent_detection).

═══ COMPOSABILITY WITH EXIT 6 (DEAD PANE) ═══

Both exit conditions can fire in the same poll iteration. Precedence: exit 6 (dead pane / reaper-flip) wins over exit 7 (stall). Reasoning: dead pane is unambiguous (work won't continue); stall is ambiguous (might recover). On the same task, dead-pane is the dominant signal.

═══ ANTI-FEATURES ═══

- DON'T add --on-stall release (auto-release the task ownership). Operator may want to inspect first.
- DON'T add --on-stall send '<text>' (auto-poke pi). Out of scope; operator can `mu agent send` after exit 7.
- DON'T let --on-stall exit fire when --status target is OPEN (mirror exit-6's carve-out: stall while waiting for OPEN is meaningless because we're not waiting for work to complete; the worker reaching needs_input might BE the success path).

═══ DELIVERABLE ═══

  src/cli/tasks/wait.ts (or src/tasks/wait.ts; find the existing cmdTaskWait): 
    - Add --on-stall <action> option; values 'warn' | 'exit'; default 'warn'.
    - In the existing --stuck-after detection branch, gate behavior by opts.onStall:
      * 'warn' → today's stderr write; keep polling.
      * 'exit' → emit kind='event' agent_logs row 'agent stalled <name> ... (wait exit)' (per the in-flight idle work pattern); throw a new typed StallDetectedDuringWaitError; cli.ts handle() maps to exit 7.
    - --on-stall exit suppressed when --status is not CLOSED.

  src/cli.ts: declare exit code 7 = STALL_DETECTED. New StallDetectedDuringWaitError extends Error implements HasNextSteps; classifyError() maps to 7.

  Tests in test/cli-task-wait.integration.test.ts (extend; ~60 LOC):
    - Stall-and-warn (default): worker idle; --stuck-after 1; wait keeps polling; stderr emits warning; eventually times out (exit 5).
    - Stall-and-exit: same setup + --on-stall exit; wait exits 7 within poll-interval after the stall threshold; stderr names the task + agent.
    - --on-stall exit suppressed when --status OPEN.
    - Mixed: dead pane AND idle simultaneously (mock both); exit 6 wins.
    - --stuck-after 0 disables both warn and exit.
    - --on-stall exit fires on the FIRST stalled task in a multi-ref wait.

  Docs:
    - docs/USAGE_GUIDE.md: extend the wait section with the --on-stall flag.
    - skills/mu/SKILL.md: update the dispatch lesson; mention --on-stall exit as the unattended-orchestrator escape.
    - CHANGELOG.md (v0.3 unreleased): one line.

═══ SCOPE ═══

  ~50 LOC code + ~80 LOC tests. Trivial since --stuck-after's predicate is reused entirely.

═══ DEPENDENCY ═══

  Blocked-by idle_assigned_agent_detection (just landed; provides the idle-event signal in agent_logs that --on-stall exit can ALSO trigger on, not just the --stuck-after counter).

═══ PROMOTION ═══

  - Real-user friction: filed during dogfood after operator hit the question 'will mu task wait catch idle?'. The framing question itself surfaces the gap.
  - Substrate ready: --stuck-after detection logic + the new idle event + exit-6 precedent (REAPER_DETECTED) all on main.
  - Fits in <300 LOC: yes (~130).

PROMOTE for v0.3.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_wait_stall_action_flag -w mufeedback-v03 --evidence '--on-stall warn|exit; exit 7; tests; docs'
```
