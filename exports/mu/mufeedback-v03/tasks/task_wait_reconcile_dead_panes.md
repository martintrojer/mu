---
id: "task_wait_reconcile_dead_panes"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-10T07:48:53.215Z"
updated_at: "2026-05-10T08:51:15.519Z"
blocked_by: []
blocks: ["idle_assigned_agent_detection", "task_wait_cross_workstream"]
---

# fix: mu task wait should run reconcile each poll (so dead panes get reaped → IN_PROGRESS flips to OPEN → wait fails fast)

## Notes (1)

### #1 by "π - mu", 2026-05-10T07:49:47.803Z

```
mu task wait — should reconcile each poll so dead-pane workers get reaped → fail fast instead of timing out.

═══ THE BUG (just hit twice in this session) ═══

WHAT HAPPENS:
  1. Operator dispatches worker-X via `mu agent send`; worker claims a task → status IN_PROGRESS.
  2. Tmux server gets restarted out-of-band (this happened twice today during the v0.3 wave).
  3. Worker pane is GONE; the agent row is stale; the task row still says IN_PROGRESS owner=worker-X.
  4. Operator runs `mu task wait <id> --timeout 1800`.
  5. Wait POLLS the task row every N seconds. Task is still IN_PROGRESS. Wait blocks indefinitely until the timeout fires (5 → 30 minutes lost), then exits 5.

ROOT CAUSE:
The reaper in mu's reconciler flips IN_PROGRESS → OPEN when an agent's pane is gone. But the reconciler only runs when something CALLS it — typically `mu state` / `mu agent list` / `mu hud`. `mu task wait` does NOT trigger reconcile; it only polls task status.

So the row stays IN_PROGRESS forever (in the wait's view) even though the worker is dead. Operator must side-channel a `mu agent list` to trigger the reaper, then notice the OPEN flip in another shell.

OBSERVED twice today:
  - tmux restart at 07:30: 3 panes died; my polling loop kept saying IN_PROGRESS for ~25 minutes; you noticed and prompted me to look.
  - Same again at 08:35: pane death; same silent stall.

═══ THE FIX (preferred: reconcile each poll) ═══

Each iteration of the poll loop in cmdTaskWait, BEFORE reading the task row(s):
  1. Run the reconcile pass for the affected workstream(s). This is what `mu state` / `mu agent list` already do; the call is `await reconcileWorkstreamAgents(db, workstream)` (or whatever the canonical reconciler entry is in src/reconcile.ts).
  2. If the reaper flipped any IN_PROGRESS → OPEN for an owned task that the wait is monitoring, the next read sees the new status.

Side effect: a dead pane now causes the wait to FAIL FAST. Either:
  - the task is now OPEN (reaper-flipped) AND the wait's target is CLOSED ⇒ wait keeps polling, will eventually timeout HONESTLY (showing "task X: was IN_PROGRESS, now OPEN due to reaper", so the operator sees what happened).
  - OR (better — see UX section): when reaper flips a wait-target task to OPEN mid-wait, abort with an early non-zero exit + a clear stderr message. Treat reaper-flip as a wait-incompatible state change. (Compare: today's --stuck-after just warns; this is a stronger signal.)

═══ UX OPTIONS ═══

OPTION A (minimal): reconcile each poll; let the wait keep waiting. Operator sees the task row update via parallel `mu state`. Lowest risk; preserves today's "wait until status reached" semantics.

OPTION B (loud): reconcile each poll; if a wait-target task got reaper-flipped (i.e., its IN_PROGRESS owner died) AND the wait's target is CLOSED, exit immediately with a non-zero code (suggest exit 6 = REAPER_DETECTED) and a stderr message:
  "task X was IN_PROGRESS owner=worker-Y until 2 sec ago; reaper detected dead pane and flipped to OPEN. wait abandoned."
This makes the silent stall impossible. The operator dispatches a fresh worker and re-runs.

OPTION C (loud + observation-only): same as B but log the warning (yellow stderr) and keep waiting. Operator decides whether to ctrl-c. Mirrors --stuck-after's "observation-only" philosophy.

  RECOMMEND OPTION B. The operator's intent in `mu task wait` is "I'm waiting for work that's actually progressing". A dead-pane worker isn't progressing — silent timeout violates the principle of least surprise. Exit 6 is unambiguous; a fresh re-dispatch is the right next action.

  Document the new exit code in the help text + USAGE_GUIDE.

═══ EDGE CASES ═══

  - Reaper-flip on a NON-target task (--all wait on tasks A,B,C; reaper hits an unrelated D): no-op. Only watched tasks matter.
  - Reaper-flip happens BEFORE the wait starts (operator's worker died before they ran wait): first poll iteration sees OPEN, fails fast — same exit 6, same message.
  - Task gets re-claimed by a fresh agent after reaper-flip (race): the next poll sees IN_PROGRESS again. The wait STAYED in the failed-fast exit-6 path, so this doesn't matter; the new worker is its own operator's problem.
  - Many wait targets, one dies: today the wait blocks on all-of-N (default) or any-of-N (--any); option B exit-6 fires on the FIRST dead-pane detection, regardless of N. Mention in the message which task died.

═══ IS THIS A REAL FIX OR A WORKAROUND? ═══

It's a real fix — the reaper was always intended to be the safety net for dead workers. The bug is purely "reaper isn't triggered during wait". Adding the trigger:
  - costs one reconcile call per poll iteration (~few ms; reconcile is dominated by tmux's `list-panes`, which is local and fast).
  - cures the silent stall in every case (not just the cases that happened today).
  - aligns with mu's "everything reconciles when read" pattern (mu state, mu agent list, mu hud all reconcile too).

═══ SCOPE ═══

  src/cli/tasks/wait.ts (or wherever cmdTaskWait lives): ~30 LOC for the per-poll reconcile + the option-B detection branch + the exit-6 path.
  src/cli.ts: declare exit code 6 = REAPER_DETECTED in the exit-code map.
  test/cli-task-wait.test.ts (extend): kill a worker pane mid-wait via the test tmux helpers; assert wait returns exit 6 within ~poll-interval seconds.
  docs/USAGE_GUIDE.md: extend the wait section.
  CHANGELOG.md (v0.3 unreleased): one line.
  skills/mu/SKILL.md: update the wait bullet to mention the reaper-detection.

Total ~80 LOC code + ~80 LOC tests.

═══ ANTI-FEATURES ═══

  - DON'T add a --no-reconcile escape hatch. The reconcile cost is trivial; an operator who wants pure passive observation can use `mu log --tail` instead.
  - DON'T extend reconcile beyond the workstream(s) of the wait targets. Reconcile is per-workstream; cross-workstream waits should reconcile each affected workstream.
  - DON'T exit 6 when --status is anything other than CLOSED (the operator might wait for a task to reach OPEN as part of a state-machine dance; reaper-flip TO open is the SUCCESS condition there). The exit-6 trigger is "task was IN_PROGRESS, owner died, flipped to OPEN, but I was waiting for CLOSED" specifically.

═══ PROMOTION ═══

  - Real-user friction: hit ≥2 times in a single session today (the v0.3 dispatch wave).
  - Substrate ready: reconciler exists and is well-trodden; cmdTaskWait already polls.
  - Fits in <300 LOC: yes (~150 incl. tests).

PROMOTE for v0.3. HIGH ROI given the timeout-magnitude friction (5–30 min stalls vs ~5 sec fail-fast).

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_wait_reconcile_dead_panes -w mufeedback-v03 --evidence 'reconcile each poll; option B exit-6 on reaper-flip; tests'
```
