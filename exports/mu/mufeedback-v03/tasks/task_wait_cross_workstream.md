---
id: "task_wait_cross_workstream"
workstream: "mufeedback-v03"
status: CLOSED
impact: 65
effort_days: 0.4
roi: 162.50
owner: null
created_at: "2026-05-10T07:54:39.139Z"
updated_at: "2026-05-10T09:23:53.675Z"
blocked_by: ["task_wait_reconcile_dead_panes"]
blocks: ["task_claim_for_cross_workstream", "task_wait_stall_action_flag"]
---

# feat: mu task wait — cross-workstream qualified refs + --any returns WHICH (one verb covers both gaps)

## Notes (3)

### #1 by π - mu, 2026-05-10T07:55:19.420Z

```
mu task wait — accept cross-workstream qualified refs.

═══ THE FRICTION ═══

Today (verified at 07:55 today during the v0.3 wave):

  $ mu task wait roadmap-v0-3/archive_phase2_cli_verbs mufeedback-v03/cli_audit_plurality_uniformity --timeout 2400
  error: qualified ref "mufeedback-v03/cli_audit_plurality_uniformity" (workstream=mufeedback-v03) conflicts with --workstream roadmap-v0-3

  $ mu task wait archive_phase2_cli_verbs cli_audit_plurality_uniformity --timeout 2400
  error: task cli_audit_plurality_uniformity is in workstream mufeedback-v03, not roadmap-v0-3

So cross-workstream wait is impossible. The orchestrator's workaround is N parallel polling loops in shell — exactly what we've been hand-rolling all day.

═══ THE GAP ═══

`mu task wait` resolves -w (single workstream) and asserts every <id> belongs to that workstream. The fix is to allow each <id> to be a qualified ref `<ws>/<name>`; when ALL ids are qualified, -w is dropped from the resolution chain entirely.

═══ THE TARGET SHAPE ═══

  # all qualified — no -w needed; each id resolves independently
  mu task wait roadmap-v0-3/archive_phase2 mufeedback-v03/cli_audit --timeout 1800

  # mixed: some qualified, some bare — bare ids fall back to -w resolution; qualified ones independent
  mu task wait roadmap-v0-3/archive_phase2 cli_audit -w mufeedback-v03

  # all bare with -w — today's behavior, unchanged
  mu task wait archive_phase2 cli_audit -w mufeedback-v03

═══ MECHANICS ═══

Each <id> arg goes through the existing resolveEntityRef() helper (the one mu task show etc. use; src/cli.ts) which already understands qualified-ref form. cmdTaskWait collects { workstream, name } pairs; the polling loop reads each task by its (ws, name) pair.

The "task is in workstream X, not Y" error path goes away when ALL ids are explicit. Only fires for bare ids without -w resolution.

═══ INTERACTION WITH RECONCILE-ON-WAIT (task_wait_reconcile_dead_panes, in flight) ═══

The reconcile pass currently being added to cmdTaskWait by worker-6 today is per-workstream (reconcileWorkstreamAgents). For cross-workstream waits, the loop must reconcile EACH UNIQUE workstream in the wait set, NOT just the resolved -w. Add a Set<workstream> built from the qualified refs and reconcile each per poll iteration.

This is a constructive interaction: the in-flight reaper-detection feature naturally extends to cross-workstream waits.

═══ INTERACTION WITH --any AND --all (task_wait_any_returns_which) ═══

Today's --all (default) and --any flags work over the wait set; cross-workstream just changes the membership. No new flag semantics needed.

═══ TESTS ═══

test/cli-task-wait.test.ts (extend; ~80 LOC):
  1. All-qualified: 2 workstreams, 2 tasks; close one in workstream A and one in B; --all wait succeeds.
  2. Mixed: 1 qualified + 1 bare with -w; both resolve correctly.
  3. Qualified ref to non-existent workstream: TaskNotFoundError listing the missing ref.
  4. Qualified ref where the task name doesn't exist in that workstream: same.
  5. Cross-ws + --any: returns when ANY task closes (any workstream).
  6. Cross-ws + reaper-flip in workstream B while waiting on A's task: only A's task is watched; B's reaper-flip doesn't trigger exit 6.

═══ FILES ═══

  src/cli/tasks/wait.ts (or wherever cmdTaskWait is): ~50 LOC.
  src/tasks.ts: any SDK helper that the wait calls (e.g. getTaskStatus) might need to take an explicit (workstream, name) pair instead of inferring -w. Verify; extend if needed.
  test/cli-task-wait.test.ts: ~80 LOC of new cases.
  docs/USAGE_GUIDE.md: extend the wait section with cross-ws example.
  skills/mu/SKILL.md: update the wait line to mention qualified refs.
  CHANGELOG.md (v0.3 unreleased): one line.

═══ ANTI-FEATURES ═══

  - Don't auto-resolve a bare id to "the only workstream that has a task with this name". That's NameAmbiguousError today; keep its honesty.
  - Don't add a --all-workstreams flag. The qualified-ref form is the expressive one; --all-workstreams would be a less precise shortcut.

═══ PROMOTION ═══

  - Real-user friction: hit ≥2x today (the v0.3 wave). Each hit cost ~5 min of hand-rolled polling.
  - Substrate ready: resolveEntityRef helper already exists and understands qualified refs.
  - Fits in <300 LOC: yes (~130 incl. tests).

PROMOTE for v0.3.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_wait_cross_workstream -w mufeedback-v03 --evidence 'qualified-ref support; reconcile per affected ws; tests'
```

### #2 by π - mu, 2026-05-10T07:57:11.287Z

```
REJECTED: skill update (SKILL.md cross-ws wait carve-out, commit 17186ef) documents the hand-roll workaround. Smart-orchestrator guidance is preferred over a code change here. Re-promote if friction surfaces ≥1 more time AND the hand-roll proves insufficient.
```

### #3 by π - mu, 2026-05-10T08:00:43.376Z

```
RE-OPENED + EXPANDED scope per operator (commit 17186ef SKILL note didn't survive contact with the loop; orchestrator kept barriering).

Combine the two previously-rejected features into ONE wait verb that covers the dispatch-pipeline use case end-to-end. The merged design:

═══ THE COMBINED FEATURE ═══

  mu task wait <ref>... [--any] [--first] [--timeout SECONDS] [--json]

Each <ref> is either:
  - bare name (resolves via -w / $MU_SESSION / tmux session, today's behavior)
  - qualified ref `<workstream>/<name>` (resolves independently of -w)

When ALL refs are qualified, -w is dropped from resolution. When SOME are qualified and some bare, qualified ones resolve via their prefix and bare ones via -w.

Two return shapes for the "what just closed?" question:

  --any      (existing today): exit 0 when ANY ref reaches the target; exit 5 on timeout. Already supported.
  --first    (NEW; alias for --any): exit 0 when first ref closes; STDOUT prints the firing ref's qualified id (e.g. `mufeedback-v03/foo`); --json emits { firing: { workstreamName, name, status }, all: [...] }.

  Also extend the default --all path: --json result includes which refs reached target and which timed out, with their per-task statuses, so a polling-style orchestrator gets WHICH info on partial success.

═══ WHY THIS MATTERS (the operator-observed pain) ═══

Today's parallel-fan-out polling loop has to:
  1. Hand-roll across workstreams (mu task wait can't span ws).
  2. Hand-roll WHICH closed first (mu task wait --any only returns exit code).
  3. Cherry-pick + verify after each WHICH detection.

Adding the verb means the orchestrator can:
  while in_flight:
    closed_ref=$(mu task wait <ref1> <ref2> ... --first --timeout 90 --json | jq -r .firing.qualifiedId)
    if [[ -n "$closed_ref" ]]; then
      git cherry-pick <worker-of-$closed_ref's HEAD>
      npm run typecheck && npm run lint && npm run test && npm run build
      mu workspace free <worker> ; mu workspace create <worker>
      ... dispatch next ...
      remove $closed_ref from in_flight
    fi

Actually — the loop is now fundamentally simpler: ONE wait per cycle, ONE pick per cycle, ONE verify per cycle. No polling-loop bookkeeping. The skill update tried to teach this; the implementation makes it the path of least resistance instead.

═══ INTERACTION WITH THE OTHER IN-FLIGHT WAIT FIX (task_wait_reconcile_dead_panes) ═══

Worker-6 is shipping per-poll reconcile + exit-6 on dead-pane reaper-flip. Cross-ws + --first slot in cleanly:
  - Per-poll reconcile loops over Set<workstream> built from refs (already in the task_wait_reconcile_dead_panes design).
  - exit-6 fires on the FIRST reaper-flip for any watched task (pluggable into the same per-iteration check).

Both features should land before either is considered "done"; coordinate cherry-picks to avoid the wait file being edited by two parallel branches. Recommend: land task_wait_reconcile_dead_panes first (already in flight), then this one.

═══ NEXT-STEP HINTS (operator-stated must-have) ═══

The verb's --json output AND its plain-text output should print actionable next-steps. For --first / --any:
  - "Cherry-pick worker's HEAD: `git cherry-pick $(mu workspace path <worker> | xargs -I{} sh -c 'cd {} && git log -1 --format=%H')`"
  - "Verify: `npm run typecheck && npm run lint && npm run test && npm run build`"
  - "Free + recreate workspace: `mu workspace free <worker> && mu workspace create <worker>`"

For --all (default): on success, list the closed refs + suggest the verify step. On timeout/partial: list which closed and which didn't, suggest `mu task show <unfinished-ref>` for each.

═══ DELIVERABLE ═══

  src/cli/tasks/wait.ts: ~80 LOC for the combined logic.
  src/cli.ts: no new exit code (--first reuses 0/5; --json emits the WHICH).
  Output: extend the --first / --any path to print the qualified id; --json schema { firing, all, timedOut } where firing is the closing ref + workstream, all is per-ref status array, timedOut is the unmet refs.
  Tests: ~120 LOC. Cross-ws --any returns first; cross-ws --all reports per-ref; bare + qualified mix; reaper-flip mid-wait surfaces correctly.
  docs/USAGE_GUIDE.md: rewrite the wait section with the dispatch-pipeline recipe.
  skills/mu/SKILL.md: REWRITE the cross-ws carve-out and the pipeline-cherry-picks lesson — the new verb makes the skill note even more direct ("mu task wait --first --json | jq .firing.qualifiedId; cherry-pick; verify; free; loop").
  CHANGELOG.md: one line.

═══ ANTI-FEATURES ═══

  - DON'T auto-cherry-pick or auto-verify. The verb returns WHICH; the orchestrator runs the next steps. Composability is the win.
  - DON'T add a --watch loop mode. The verb is one-shot per call; the loop is operator-side.
  - DON'T change today's --all default semantics.

═══ PROMOTION ═══

  - Real-user friction: hit ≥3x today + the SKILL note didn't fix the structural issue.
  - Substrate ready: today's wait + the in-flight reconcile work; --json infrastructure already exists.
  - Fits in <300 LOC: yes (~250 incl. tests).

PROMOTE for v0.3. Land AFTER task_wait_reconcile_dead_panes (sequential to avoid wait.ts conflicts).

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_wait_cross_workstream -w mufeedback-v03 --evidence 'cross-ws + --first WHICH + tests + docs + SKILL rewrite'
```
