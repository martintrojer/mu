---
id: "agent_close_discipline_gap"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-09T08:55:44.936Z"
updated_at: "2026-05-09T09:11:17.986Z"
blocked_by: []
blocks: ["audit_verbs_typed_vs_sql", "docs_staleness_review_capstone"]
---

# BUG: agents do work + commit + report done in pane, but skip mu task close — orchestrator's mu task wait hangs indefinitely

## Notes (2)

### #1 by π - mu, 2026-05-09T08:56:29.718Z

```
SURFACED LIVE wave 3 (this very session). 4 dispatches, 2 closed cleanly (worker-mf-2 state_hud, worker-mf-3 evidence_suffix), 2 stuck IN_PROGRESS (worker-mf-1 should_overwrite, worker-mf-4 destroy_count) — both workers committed their patches AND printed "done / committed as <sha>" in their pane, but neither ran `mu task close <id>`. Orchestrator's `mu task wait` correctly kept polling because the DB row was still IN_PROGRESS. Looked like a hang; was actually agent-side discipline drift.

═══ ROOT CAUSE ═══

The contract today is: "agent does work → agent calls `mu task close <id> --evidence '...'` → typed verb writes status=CLOSED → wait sees the transition → orchestrator continues."

That contract has THREE failure modes the agent can hit:

  A. Agent forgets the close call entirely. Reports done in chat-style ("committed as <sha>") and goes idle. Tries to short-circuit the contract.
  B. Agent calls close but the call errors silently (exit non-zero) and the agent doesn't notice. Pane shows the error but the agent's next "Working..." spinner moves on without re-trying.
  C. Agent's pane CLI (pi/pi-meta) loses queue: my prompt said "when done, close with mu task close ..." but it sat in the agent's queue alongside the work, and the close instruction ran AT QUEUE START, before the work was actually finished — and CLOSED the task prematurely. (Hypothetical; haven't seen this in the wild yet but it's a shape of failure.)

═══ THREE LAYERS WHERE THE FIX COULD LIVE ═══

LAYER 1 — agent-side prompt discipline (no code change to mu)
  The orchestrator's prompt already says "close with mu task close ...". The skill (skills/mu/SKILL.md) DOs section says "Pass --evidence on claim AND close." Both agents in this session knew. They still skipped it. Doc-only is necessary but insufficient.

LAYER 2 — orchestrator-side defensive wait (LOC inside mu task wait)
  Today: mu task wait polls task status. Could ALSO poll: "if owner is set AND owner's agent is in 'needs_input' for >N seconds AND owner's scrollback contains the close command pattern but task is still IN_PROGRESS → emit a STUCK warning to stderr". Let the operator (or, in scripted use, a wrapping policy) decide whether to force-close, re-prompt, or escalate.
  
  The wait verb's --json output gains a `stuck: boolean` per task. Backwards-compatible (opt-in inspection).

LAYER 3 — agent-runtime hook (the deepest fix; coupled to inner CLI)
  Mu deliberately doesn't introspect the inner CLI's lifecycle (anti-pattern; mu is CLI-agnostic). But we COULD add a thin convention: on `mu agent send <name> "<prompt>"`, if the prompt mentions a task id, mu auto-appends a "after this work, run: mu task close <id> --evidence '<your-summary>'" footer. (Footer-injection is dangerous — same shape as anything that mutates the user's prompt — but it might be the right call for a specific --task <id> opt-in flag like the one filed in nit_orchestrator_dispatched_without_task's note #321.)
  
  RECOMMEND: don't ship layer 3. Doc + layer 2 should be enough.

═══ RELATIONSHIP TO audit_verbs_typed_vs_sql ═══

This bug IS a data point for the verb audit. mu task wait is one of the load-bearing typed verbs (high atomicity, real value: deadline-aware polling, multi-task all/any, exit codes, --json), but its REAL VALUE depends on the close discipline being maintained at the other end.

The audit should ask: for every verb that has a "discipline contract" with the agent (claim with evidence, close with evidence, note with the contract format), what's the failure mode when the agent skips the discipline? Today most verbs degrade gracefully (skip `--evidence`: no audit trail) but mu task close being skipped is uniquely orchestrator-blocking because mu task wait depends on it.

═══ RELATED EXISTING TASKS ═══

  - nit_orchestrator_dispatched_without_task (CLOSED) was the FIRST hit of the pattern: dispatched reviewers without task at all → no wait possible. We fixed it with SKILL.md discipline.
  - This task is the SECOND hit: discipline existed, agent skipped it. SKILL alone is insufficient.
  - audit_verbs_typed_vs_sql (OPEN, blocked) should reference this bug as a calibration point for "how do we score a verb whose value is contract-dependent?"

═══ DELIVERABLE ═══

Two PHASES (file the second as follow-up if budget cracks):

PHASE 1 (~0.2d) — Layer 2: orchestrator-side defensive wait
  - mu task wait gains `--stuck-after <seconds>` (default 300). When IN_PROGRESS task's owner is `needs_input` longer than --stuck-after, emit a single-line yellow STUCK warning to stderr per-stuck-task PER POLL CYCLE (rate-limited, not spammy). Continue waiting (don't fail).
  - --json output gains `stuck: boolean` on each task.
  - Test: simulate a stuck-but-IN_PROGRESS scenario (set owner via SQL, leave status IN_PROGRESS, advance fake time, poll twice, assert warning fired exactly once — not twice).

PHASE 2 (~0.2d) — Layer 1: SKILL.md tightening
  - The "Working loop (worker path)" already says "close with --evidence". Add a single-line counter-pattern bullet: "If you committed/finished but skipped `mu task close <id>`, the orchestrator's `mu task wait` will hang. Always close as the LAST action of a dispatched task."
  - (Per the SKILL.md "must stay terse" addendum on docs_staleness_review_capstone — one bullet, no paragraph.)

Phase 3 (deferred unless ≥2 more hits) — agent-runtime hook
  - Skip until the bug recurs after both phase 1 and phase 2 land.

═══ NOT DOING (anti-features) ═══

  - Auto-closing the task on agent's behalf based on heuristics (string-match scrollback for "committed", etc.). False positives terrify; agent's "I'm about to" looks the same as "I did".
  - Taking ownership of the agent's CLI lifecycle (anti-pattern; mu is CLI-runtime-agnostic).
  - Adding `mu agent send --close-task-on-success <id>` magic (Layer 3; defer).

═══ NEXT ═══

After phase 1 + 2 land, this bug closes; audit_verbs_typed_vs_sql gains the calibration data point.
```

### #2 by worker-mf-1, 2026-05-09T09:11:11.322Z

```
FILES: src/tasks/wait.ts (TaskWaitOptions.stuckAfterMs default 300_000; TaskWaitTaskState.stuck; per-task dedupe via Set<localId>; setWaitStuckWarnForTests test seam emitting yellow ANSI single line to stderr); src/cli/tasks.ts (cmdTaskWait wires stuckAfter seconds → stuckAfterMs; --stuck-after <seconds> CLI flag with parseLines); src/tasks.ts + src/index.ts (re-export setWaitStuckWarnForTests); skills/mu/SKILL.md (one bullet under Working loop: skipped-close → hang); test/tasks.test.ts (2 new cases in waitForTasks describe — stuck-warn fires exactly once across ~8 polls; stuckAfterMs:0 disables — plus updated existing equality assertion for new stuck:false field); CHANGELOG.md (Added + Changed under [Unreleased]).
DECISION: did NOT ship Phase 3 / Layer-3 agent-runtime hook; did NOT add auto-close magic. Both anti-features per the original diagnosis note (#438). Warning is observation-only — wait keeps polling, operator decides force-close vs re-prompt vs escalate. Used dedupe-per-wait-call (not per-poll-cycle as the original spec ambiguously read) because per-poll-cycle would still spam stderr every second; one nudge is enough to get the operator's attention. Yellow ANSI escapes inlined in src/tasks/wait.ts (no picocolors import — the SDK module stays dep-free; CLI layer pulls picocolors). Detection queries agents table directly via SQL (not via getAgent) to avoid an import cycle (src/agents.ts already imports from src/tasks.ts).
GATE: typecheck + lint + build all clean. Tests 770/770 with clean env (the 2 failures shown when running inside this worker pane are environmental — MU_AGENT_NAME=worker-mf-1 exported in the pane interferes with two pre-existing claimTask --self actor-resolution tests; unrelated to this change, confirmed by re-running with env unset).
COMMIT: 3c1041d (HEAD was 46e91f2).
```
