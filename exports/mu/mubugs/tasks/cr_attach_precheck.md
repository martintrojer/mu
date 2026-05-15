---
id: "cr_attach_precheck"
workstream: "mubugs"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: null
created_at: "2026-05-15T11:37:09.692Z"
updated_at: "2026-05-15T11:51:48.157Z"
blocked_by: []
blocks: ["umbrella"]
---

# Code review: agent attach skips reaping when session is gone

## Notes (2)

### #1 by "worker-1", 2026-05-15T11:37:14.375Z

```
FILE/LINE: src/cli/agents.ts:551
WHAT'S WRONG: cmdAttach checks sessionExists() and throws before calling listLiveAgents(). After the mode collapse, attach is supposed to run full reconciliation, but in the wholesale tmux-server/session-loss case this precheck exits early, so ghost agent rows and their IN_PROGRESS tasks are not reaped from this status-only callsite.
WHY IT MATTERS: The feature's rationale is that former status-only read surfaces should let the canonical deleteAgent reaper observe missing panes. mu state does that, but mu agent attach still preserves the old blind spot whenever the whole session is gone; the new comment at :554 also claims attach reaps a disappeared pane, which is false for the full-session-loss case.
SUGGESTED FIX: Move reconciliation before the sessionExists() guard, or remove the guard and let listLiveAgents() see listPanesInSession() == [] so deleteAgent() reaps the row before cmdAttach raises AgentNotFoundError / captures scrollback. If a friendlier no-session error is still desired, emit it only after the reconcile pass has had a chance to reap registered agents.
SEVERITY: medium
```

### #2 by "worker-2", 2026-05-15T11:51:48.157Z

```
CLOSE: 5298d59 cmdAttach reconcile order fixed; reaper now fires from attach surface too
```
