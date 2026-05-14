---
id: "nit_no_mu_task_wait"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 75
effort_days: 0.4
roi: 187.50
owner: null
created_at: "2026-05-08T07:39:50.715Z"
updated_at: "2026-05-08T08:40:13.925Z"
blocked_by: []
blocks: []
---

# NIT: orchestrator hand-rolls polling loops because mu has no 'wait for tasks to reach status X' primitive

## Notes (1)

### #1 by null, 2026-05-08T07:39:50.832Z

```
SURFACED LIVE during the multi-agent dogfood. After dispatching 3 workers via mu task claim --for, I needed to wait for all three to close their tasks before reviewing/merging. mu has no primitive for this; I hand-rolled a polling loop:

  LAST_SEQ=$(mu sql "SELECT MAX(seq) FROM agent_logs" --json | python3 -c ...)
  for i in $(seq 1 12); do
    sleep 30
    mu sql "SELECT ... WHERE seq > $LAST_SEQ ..." --json | python3 -c "..."
    STILL_OPEN=$(mu sql "SELECT COUNT(*) FROM tasks WHERE local_id IN (...) AND status != 'CLOSED'" --json ...)
    if [[ "$STILL_OPEN" == "0" ]]; then break; fi
  done

That's 30+ lines of bash+python+sql for what should be one verb. And it duplicates state-tracking logic the activity-log subscriber does anyway.

The missing primitive: mu task wait

  mu task wait <id> [<id> ...] [--status CLOSED] [--timeout SECONDS] [--json] [-w <ws>]

  Block until ALL listed tasks reach --status (default CLOSED).
  Exit 0: all reached. Exit 5: timeout (mirrors mu approve wait).
  --json: { tasks: [{id, status, reachedTarget, elapsedMs}], allReached: bool, elapsedMs: N }

Implementation sketch (~50 LOC + tests):
  - assertTaskInWorkstream for each id.
  - Open the activity-log tail starting at the current MAX(seq).
  - Initial state: query the current status of each task; if all already at --status, exit 0 immediately.
  - On each kind=event row whose payload starts with "task status <id>", check if id is in our target set and the new status matches --status; remove from pending set.
  - When pending set is empty, exit 0.
  - On timeout, exit 5 with a JSON record listing which tasks did/didn't reach.

Companion ergonomics:
  - --any (not --all): exit as soon as ONE reaches the target. Useful for "first worker to finish gets the next task" patterns. Defer unless dogfood proves it.
  - --status filter accepts: OPEN | IN_PROGRESS | CLOSED (mirror existing TaskStatus). Default CLOSED.
  - In stderr/JSON timeout case: per-task nextSteps suggesting "mu task show <id>" so the orchestrator can see what blocked the laggard.

Why this matters specifically:
  1. Multi-agent orchestration (the canonical mu use case) NEEDS this. Spawning 3 workers and not having a "wait for all" verb is glaring.
  2. SKILL.md's "Subscribe (react when state changes; zero polling cost)" pattern only handles ONE event well via awk:
       mu log --tail | awk '/task status design.*CLOSED/ { exit 0 }'
     For N tasks the awk script becomes stateful, which is a BAD shape for SKILL examples.
  3. The polling loop I wrote was 30+ lines including JSON parsing, seq tracking, sleep, status query. Each line is a place to bug. mu task wait collapses all of it to one verb.
  4. mu approve wait already proves the pattern: same exit semantics (0/5), same blocking-with-timeout shape. Symmetrically, mu task wait belongs.

Promotion criterion: 1st occurrence (this session). But the polling loop is a category of friction (every multi-agent orchestrator I've spawned this session hit it implicitly — single-worker tasks just don't need it). Promotion-by-occurrence might say "wait for 2nd", but the LOC math (30 LOC of boilerplate vs 1 verb) is overwhelming. The 'category-promotion' clause in ROADMAP applies.

Pairs naturally with bug_status_detector_pi_solo_misclassifies (just filed): the status-emoji misclassification means mu agent show/list is unreliable for "is this worker done?", but agent_logs events ARE reliable. mu task wait reads from the reliable source.

Estimated 50-80 LOC + 4-6 tests. ~0.4 effort-days.
```
