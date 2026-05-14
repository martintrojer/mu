---
id: "workstream_destroy_empty_sweep"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-10T07:10:34.014Z"
updated_at: "2026-05-10T07:29:02.739Z"
blocked_by: []
blocks: []
---

# feat: mu workstream destroy --empty — sweep every empty workstream (zero tasks, zero agents, zero workspaces); useful for test cleanups

## Notes (1)

### #1 by "π - mu", 2026-05-10T07:11:14.975Z

```
mu workstream destroy --empty — sweep every empty workstream.

═══ THE FRICTION ═══

Test runs (and exploratory operator usage) leave behind workstreams that have nothing in them: zero tasks, zero agents, zero workspaces. Today the cleanup is per-name:

  for ws in $(mu workstream list --json | jq -r '.[] | select(.tasks==0 and .agents==0) | .name'); do
    mu workstream destroy -w "$ws" --yes
  done

The shape is right (every destroy still snapshots first; FK CASCADE handles the empty case cleanly), but the operator has to know the jq incantation and the destroy call has nothing to destroy in the live DB.

Add a flag to the destroy verb that does the sweep in one command.

═══ THE TARGET SHAPE ═══

  mu workstream destroy --empty                 # dry-run: list workstreams that WOULD be destroyed
  mu workstream destroy --empty --yes           # actually destroy each one
  mu workstream destroy --empty --json          # list as JSON (dry-run)
  mu workstream destroy --empty --yes --json    # destroy + emit per-workstream result array

KEY semantics:
  - "Empty" means: zero tasks, zero agents, zero vcs_workspaces, zero approvals (any user-meaningful state).
  - Tmux session presence is NOT a disqualifier: an empty workstream with a live tmux session is still empty (the session itself was created at init time and contains no agent panes; killing it is correct).
  - agent_logs presence is also NOT a disqualifier: a workstream with no live entities but a few `workstream init` events from its creation is still empty (the events are audit, not state).
  - --empty is MUTUALLY EXCLUSIVE with -w (the existing single-target flag) and with --archive (no archive sweep; that would be silently risky).

═══ PER-CALL FLOW ═══

  1. Resolve the empty set: SELECT every workstream where (tasks=0 AND agents=0 AND vcs_workspaces=0 AND approvals=0).
  2. Dry-run (default): print a table of names + summary counts; print Next-steps including the --yes incantation.
  3. --yes: capture ONE snapshot covering the whole sweep (label: "workstream destroy --empty sweep (N workstreams)"), then for each, call destroyWorkstream(db, { workstream }) sequentially. Per-workstream tmux kill + DB row delete, just like the single case.
  4. Atomicity: if one destroy throws, the others STILL run (best-effort sweep; the snapshot at step 3 is the recovery anchor for the whole batch). Print a summary at the end with successes + failures.
  5. JSON shape: array of { workstreamName, killedTmux, deletedAgents, deletedTasks, ... } per destroy result, plus an envelope { destroyed: N, failed: [{ workstreamName, error }] }.

═══ EDGES / DEDUP ═══

  - Empty set might include the orchestrator's own workstream (if -w is unset and the orchestrator is running in an empty tmux session). The sweep DOES kill it; the operator's mu invocation survives because mu reads from the DB once and short-lived. This matches the existing destroy semantics (you can mu workstream destroy -w <your-own-session> --yes today).
  - Doesn't touch archives. Even if every source-ws of an archive is empty + destroyed by --empty, the archive is preserved.
  - Doesn't auto-archive. Anti-feature: silent archive-on-destroy is a footgun.
  - Doesn't touch on-disk workspace dirs that have NO DB row (orphan-workspace cleanup is `mu workspace orphans` + `mu workspace free`; not in scope).

═══ DELIVERABLE ═══

1. src/cli/workstream.ts:
   - Extend cmdWorkstreamDestroy to accept --empty.
   - When --empty is set: ignore -w (or error if explicitly given); resolve the empty set via a single SQL query (joined LEFT JOIN counts, or one query per workstream — pick the cleaner shape).
   - Dry-run: render a small table (workstream | tmux session present? | created_at) + count summary.
   - --yes path: snapshot once, then loop destroyWorkstream over each.

2. src/workstream.ts (SDK):
   - listEmptyWorkstreams(db): WorkstreamSummary[] with the predicate above. Reuse summarizeWorkstream's counts where reasonable.

3. Tests in test/workstream-destroy-empty.test.ts (NEW, ~120 LOC):
   - Two empty + two non-empty workstreams; --empty (dry-run) reports the two empties only.
   - --empty --yes destroys both; non-empty untouched.
   - One empty has a live tmux session; --empty --yes kills the session.
   - --empty + -w mutually exclusive; --empty + --archive mutually exclusive.
   - Mid-sweep failure (e.g., tmux error mocked on one) doesn't stop the others; failure surfaced in the summary.
   - --json shape verified for both dry-run and --yes.

4. Docs:
   - docs/USAGE_GUIDE.md: extend the workstream destroy bullet with --empty.
   - skills/mu/SKILL.md: extend the destroy line.
   - CHANGELOG.md (v0.3 unreleased): one line.

═══ ANTI-FEATURES ═══

  - DON'T add a "destroy all" without the --empty filter. The friction is "I have litter from tests"; adding "blow up everything" is a different (high-risk) feature — operator's recourse is the today's per-name destroy.
  - DON'T add --since/--older-than time filters. KEEP IT SIMPLE: the predicate is "is there any user-state in this row?" and that's enough for the test-cleanup case.
  - DON'T silently archive empty-but-soon-to-be-destroyed workstreams. Archive integration stays explicit per-call.

═══ PROMOTION ═══

  - Real-user friction: hit during v0.3 wave (operator filed). ≥1 hit; the per-name jq workaround is permanent.
  - Substrate: existing destroyWorkstream + listWorkstreams; ~50 LOC of new SDK + ~30 LOC of CLI wiring.
  - Fits in <300 LOC: yes (~150 incl. tests).

PROMOTE for v0.3. Lives in mufeedback-v03 (CLI surface).

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close workstream_destroy_empty_sweep -w mufeedback-v03 --evidence 'sweep + tests + docs'
```
