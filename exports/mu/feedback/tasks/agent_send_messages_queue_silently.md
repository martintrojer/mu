---
id: "agent_send_messages_queue_silently"
workstream: "feedback"
status: REJECTED
impact: 15
effort_days: 0.3
roi: 50.00
owner: null
created_at: "2026-05-10T16:29:52.716Z"
updated_at: "2026-05-11T08:14:52.358Z"
blocked_by: []
blocks: []
---

# agent send messages queue silently behind unresponsive shell tools

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T16:29:52.848Z

```
OBSERVED 2026-05-10 while orchestrating workstream infer-rs:

A worker (worker-leak-1) ran a `find / -maxdepth 6 -name infer -type f` shell command via its pi tool wrapper. The command ran for 36+ minutes (filesystem scan). I noticed via `mu agent show worker-leak-1` and sent a steering message via `mu agent send`. The steering message was visibly queued in pi's UI (showed up as "Steering: Cancel the find / search ...  ↳ Alt+Up to edit all queued messages") but the running shell command blocked the entire pi event loop, so the steering went unread for ~10 more minutes.

Eventually I had to:
  1. SSH to the host
  2. pgrep -af "find /" to find the runaway PID
  3. kill the wrapped subprocess directly
  4. only THEN did pi consume the steering message

NIT: from `mu agent show worker-leak-1` (and `mu state`) there's no surfaced indicator of "this worker has queued steering messages waiting on a long-running tool". The worker `status` was "busy" the whole time, which is correct but not actionable.

UX SUGGESTIONS:
  1. In `mu agent show`, surface "queued steering messages: 1 (oldest 10 min ago)" if the agent has unread `agent send` traffic that has NOT been turn-acknowledged. This signals "your steering is stuck, the worker can't read you yet."
  2. Add a `mu agent kick <name>` that sends Ctrl-C through tmux at the shell-command level (not just at the pi prompt level), as an escape hatch when steering is stuck. Currently `tmux send-keys C-c` hits pi but not pi's wrapped subprocess.

Severity: medium. Tripped me once mid-pipeline; cost ~10min orchestrator time + ~36min worker time. The right operator behavior turned out to be "exit out of mu, hunt PIDs, kill from outside" — that's pretty awkward.

CROSS-REF: not really an issue with `mu agent send` itself (pi accepted the queued message correctly). The visible gap is in mu's introspection.
```

### #2 by "π - mu", 2026-05-11T08:14:52.250Z

```
TRIAGE: merging into workers_commonly_attempt_unbounded_find. Both have the same root cause (wedged worker; no escape hatch from outside the pane). The proposed `mu agent kick <name> [--signal SIGINT|SIGTERM|SIGKILL]` verb will close both:

- THIS task (#2): operator can SIGINT a wrapped subprocess that has the steering-message queue blocked behind it.
- workers_commonly_attempt_unbounded_find: operator can SIGINT a runaway find / busy-wait loop without dropping out of mu and pgrep-killing.

The OTHER suggestion in this task — surface "queued steering messages: N (oldest M min ago)" on `mu agent show` — requires pi-side cooperation (mu cannot read pi internal queue). Out of scope for the v0.3 substrate. Filed mentally as a future improvement; no separate task.

Closing as superseded.
```
