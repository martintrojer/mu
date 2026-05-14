---
id: "externally_blocked_tasks_show_as_ready"
workstream: "feedback"
status: REJECTED
impact: 12
effort_days: 0.3
roi: 40.00
owner: null
created_at: "2026-05-11T09:02:24.606Z"
updated_at: "2026-05-11T09:18:06.270Z"
blocked_by: []
blocks: []
---

# externally-blocked tasks show as ready; no waiting-on-condition state

## Notes (2)

### #1 by "π - infer-rs", 2026-05-11T09:02:24.717Z

```
FILES: mu task statuses / ready view.
COMMANDS: In infer-rs, perf_remeasure_quiescent_host is actionable only when host load <1.5 and security daemons <5% CPU; current load sample 5.91/8.60/10.65. Attempting 'mu task defer perf_remeasure_quiescent_host' correctly refused because open dependents would be stranded; leaving it OPEN makes it appear in ready set even though dispatching now would produce contaminated benchmark data.
FINDINGS: There is no first-class 'waiting on external condition' / sleeping-until-manual state that keeps dependents blocked but removes task from ready. DEFERRED would be semantically close but terminal/non-satisfying and guarded by dependents.
DECISION: file feedback.
NEXT: consider WAITING/PAUSED status, a ready-suppression flag, or deferred-with-dependents ergonomics for externally blocked tasks.
```

### #2 by "π - mu", 2026-05-11T09:18:06.163Z

```
TRIAGE (orchestrator, 2026-05-11): rejected as wont-fix per AGENTS.md promotion criteria.

PROMOTION CHECK:
- N=1 dogfood occurrence (perf_remeasure_quiescent_host in infer-rs).
- Threshold per docs/ROADMAP.md: real user hits the missing feature ≥2 times.

WORKAROUND USING EXISTING PRIMITIVES (zero LOC, composes with existing semantics):
  Sentinel-blocker pattern. Create a "host quiescent" task with low impact/effort, block the perf task on it, manually close the sentinel when the external condition is met:

    mu task add -w infer-rs --title "Host quiescent (load <1.5; sec daemons <5%)" --impact 1 --effort-days 0.1
    mu task block perf_remeasure_quiescent_host --by host_quiescent_load_15_sec_daemons_5 -w infer-rs
    # later:
    mu task close host_quiescent_load_15_sec_daemons_5 -w infer-rs --evidence "load 0.8 0.6 0.5"

  Side benefit: the threshold conditions live in task notes with full audit trail of why we resumed; better than a flag.

REVISIT IF:
  - This pattern recurs ≥2x more in real workflows, OR
  - The sentinel workaround proves clumsy in practice (e.g. operators forget to close the sentinel, or the threshold conditions are non-trivially expressed).

Then promote with one of two implementations (smaller first):
  - tasks.suppress_from_ready boolean column + mu task pause/unpause (~80 LOC)
  - 6th TaskStatus WAITING (~300+ LOC; substrate change)
```
