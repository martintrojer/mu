---
id: "bug_workstream_init_does_not_repair_missing_mu_window"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.2
roi: 125.00
owner: null
created_at: "2026-05-08T13:05:52.760Z"
updated_at: "2026-05-08T13:32:20.013Z"
blocked_by: []
blocks: []
---

# BUG: workstream init does not repair missing _mu window

## Notes (1)

### #1 by "π - infer-rs", 2026-05-08T13:05:52.879Z

```
FILES: /Users/mtrojer/hacking/mu/src/cli.ts cmdInit; /Users/mtrojer/hacking/mu/src/agents.ts createOrReusePane.
COMMANDS: tmux list-windows -t mu-infer-rs; tmux list-windows -t mu-roadmap-v0-2; mu workstream init infer-rs --json; tmux list-windows -t mu-infer-rs after init.
FINDINGS: Healthy workstreams have a _mu window (mu-roadmap-v0-2 window 1 _mu; mu-ws window 1 _mu). mu-infer-rs has only window 1 reviewer-1 and lacks _mu. Running mu workstream init infer-rs --json returned created=false, tmuxSessionAlreadyExisted=true, dbRowAlreadyExisted=true, and did not recreate _mu. cmdInit only creates _mu when the tmux session does not already exist.
DECISION: Missing _mu is a real workstream-layout repair gap. However, code inspection suggests it is probably not the direct cause of agent spawn --workspace failures: spawnAgent/createOrReusePane checks sessionExists and then tmux new-window/split-window directly; it does not require _mu.
NEXT: Make workstream init/state detect and optionally repair a missing _mu window for existing mu-* sessions. Consider mu state warning when a managed workstream lacks _mu.
VERIFIED: Reproduced on mu-infer-rs; workstream init did not repair. Compared against mu-roadmap-v0-2 and mu-ws.
ODDITIES: mu-infer-rs likely got into this shape because the initial _mu placeholder was closed after agents were spawned or session was manually manipulated.
```
