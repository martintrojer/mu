---
id: "bug_no_recovery_after_tmux_server_crash"
workstream: "mubugs"
status: CLOSED
impact: 75
effort_days: 1
roi: 75.00
owner: null
created_at: "2026-05-15T10:43:49.607Z"
updated_at: "2026-05-15T11:10:30.264Z"
blocked_by: ["collapse_status_only_mode"]
blocks: ["umbrella"]
---

# BUG: mu state inconsistent after tmux server crash — agents reported alive, panes gone, no auto-detect or recovery path

## Notes (2)

### #1 by "π - gchatui", 2026-05-15T10:44:45.251Z

```
SYMPTOM (what I hit, just now):

  The host's tmux server crashed mid-session (cause unknown — most
  likely OOM or an upstream tmux bug; not a deliberate kill). Every
  tmux session was wiped, including 'mu-gchatui-node' which had three
  active workers (worker-1 in-flight on a heavy task; worker-2 doing
  the headline 'gchat unread' swap; worker-3 free).

  After tmux came back, the host had fresh tmux sessions for unrelated
  projects but NO mu-* sessions — they were all gone. mu's view of the
  world did not update:

    $ mu state -w gchatui-node
    Agents (3 active, 0 orphan)
    │ worker-1 │ pi  │ needs_input │ worker-1
    │ worker-2 │ pi  │ busy        │ worker-2
    │ worker-3 │ pi  │ free        │ worker-3
    Tracks (2)
    ...

  Three workers reported as 'active' (one even 'busy'). All three panes
  were gone. The worker-2 task was still IN_PROGRESS in the DB.

    $ tmux list-windows -t mu-gchatui-node
    can't find session: mu-gchatui-node
    no mu-gchatui-node session

  $ mu doctor reported tmux=ok. It did NOT report any orphan/dead
  agents. It did not surface that the workstream's tmux session was
  missing despite agents being registered.

  The reaper presumably never fired because the pi processes inside the
  panes died with the panes — there was no 'pane exit event' for tmux
  to relay; the whole tmux server went away.

WHAT I EXPECTED:

  1. A periodic / on-demand health probe that, for every workstream
     with registered agents, runs:
        tmux has-session -t mu-<name>
     If the session is missing, every agent in that workstream is
     marked DEAD, every IN_PROGRESS task they own is reverted to OPEN
     with a synthesized [reaper] note ('tmux session disappeared at
     <time>; agent <name> presumed dead'), and the agent's status flips
     to a new 'lost' state (distinct from 'free' which means
     'available').

  2. mu doctor should INCLUDE this probe and surface findings:
        tmux             : ok (tmux 3.7)
        sessions         : mu-gchatui-node MISSING (3 registered agents
                           orphaned — run `mu doctor --reap` to clean up)

  3. mu state -w <ws> should refuse to silently report 'busy' / 'free'
     for an agent whose pane no longer exists. Either auto-flip to
     'lost' on read OR show a clear ⚠ marker:
        │ worker-1 │ pi  │ ⚠ pane gone │ worker-1
     Today the existing reaper handles single-pane death (when pi
     exits or `mu agent close` kills it), but a wholesale tmux-server
     crash bypasses it because there are no remaining panes for the
     reaper to observe exiting — the entire detection mechanism is
     pane-event-driven.

  4. A `mu doctor --reap` (or `mu workstream reap -w <ws>`) command
     that, for a workstream whose tmux session is missing, performs
     the cleanup en masse:
        - Mark every agent in the workstream as 'lost' (or remove
          the agent rows; user choice).
        - Revert every IN_PROGRESS task they own to OPEN with reaper
          notes carrying the original claim evidence.
        - Optionally re-spawn agents under the same names if --respawn
          is passed (mu agent spawn worker-1, worker-2, worker-3).
        - Rescue uncommitted diffs from the workspace dirs into a
          named patch file so they aren't lost (similar to git stash):
            ~/.local/state/mu/rescue/<ws>/<agent>-<ts>.patch
        - Print a summary so the orchestrator can decide what to do.

  5. (Stretch) Periodic background probe: even if the user doesn't run
     `mu doctor`, any `mu` invocation should opportunistically probe
     the current workstream's tmux session and flip agent state if it
     finds it missing. Cheap (one tmux has-session call per
     command), and avoids the 'mu state lies' problem entirely.

  6. (Stretch) tmux-respawn-pane recovery: if the WORKSTREAM's tmux
     session is alive but a specific pane is gone (e.g. a single agent
     pane died), the existing reaper handles that. The new path is for
     when the WHOLE session is gone.

REPRO RECIPE:

  $ mu workstream init testcrash
  $ MU_PI_COMMAND="pi-meta --no-solo" mu agent spawn worker-1 -w testcrash --workspace
  $ mu task add t1 -w testcrash --title "demo" --impact 1 --effort-days 0.1
  $ mu task claim t1 -w testcrash --for worker-1
  $ mu agent send worker-1 "Pretend you're working" -w testcrash
  # In another terminal:
  $ tmux kill-server
  # Tmux server dies. Every session, every pane, gone.
  $ mu state -w testcrash
  # Expected: workers marked lost, t1 reverted to OPEN.
  # Actual: workers still 'busy' / 'needs_input', t1 still IN_PROGRESS.
  $ mu doctor
  # Expected: 'sessions: mu-testcrash MISSING ...' line.
  # Actual: tmux: ok, no mention of the missing session.

WORKAROUND I USED THIS TIME:

  Manually:
    mu task release <task> -w gchatui-node --evidence "tmux server crashed; redispatch"
    mu agent close worker-N --discard-workspace -w gchatui-node
    mu agent spawn worker-N -w gchatui-node --command 'pi-meta --no-solo --model meta-openai/gpt-5.5:high' --workspace
  per worker. Slow, error-prone, and required me to remember which
  agents had been alive. The workspace dirs survived (good) so any
  uncommitted diffs were rescued by hand via `cd $WS && git diff > /tmp/rescue.patch && git apply --3way` in the main repo.

  A `mu workstream reap --respawn` would have done all of this
  automatically.

ACCEPTANCE:

  - mu state, mu doctor, and any 'is this agent alive?' check internal
    to mu CONSULT 'tmux has-session' for the workstream's session before
    trusting the registered status.
  - A new 'lost' agent state distinct from 'free' / 'busy' /
    'needs_input', indicating 'pane is gone'.
  - mu workstream reap (or mu doctor --reap) cleans up en masse.
  - --respawn re-creates the panes under the same agent names.
  - --rescue-diffs writes uncommitted workspace diffs to a known
    location before any cleanup that would touch the workspace dir.
  - Tests cover: simulated 'tmux session missing' state via mocked
    tmux helper. (Not real tmux-kill-server in CI — too gnarly.)

OUT OF SCOPE:

  - Preventing tmux server crashes (not mu's job).
  - Reattaching to the same Claude/pi conversation context after a
    crash (impossible — agent process state is in memory of the dead
    pi).
```

### #2 by "worker-1", 2026-05-15T11:10:30.264Z

```
CLOSE: 65ec5d9 mu state now reaps lost sessions via the collapse; original bug repro recipe verified — agents are now deleted + tasks reverted + [reaper] notes emitted within one reconcile interval after a wholesale tmux server crash.
```
