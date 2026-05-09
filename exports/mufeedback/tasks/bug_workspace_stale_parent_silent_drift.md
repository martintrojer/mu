---
id: "bug_workspace_stale_parent_silent_drift"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "worker-mf-1"
created_at: "2026-05-09T05:42:10.974Z"
updated_at: "2026-05-09T06:05:15.831Z"
blocked_by: []
blocks: []
---

# BUG: --workspace can be N commits behind main; worker silently does work against stale base

## Notes (2)

### #1 by π - mu, 2026-05-09T05:42:57.992Z

```
SURFACED LIVE while orchestrating worker-1 (roadmap-v0-2 workstream) on cross_workstream_claim_for.

═══ REPRO ═══
1. Long-running workstream (roadmap-v0-2 created 2026-05-08T11:08, parent ref 503a576ae93e captured at workspace-create time).
2. Main has moved 9 commits since then — including the refactor_split_large_src_files series that broke src/cli.ts → src/cli/{...}.ts and src/tasks.ts → src/tasks/{claim,errors,...}.ts.
3. Worker-1 dispatched on cross_workstream_claim_for; cwd = its workspace at parent ref 503a576ae93e.
4. Worker correctly implements the fix in src/tasks.ts (the file that exists in its workspace) — adds the AgentNotInWorkstreamError pre-check.
5. Worker reports task closed with "713/711 gate green" — INSIDE the workspace, against the stale parent, this is true.
6. From main: `git diff main` against worker's workspace shows ~6500 insertions / 7700 deletions because the worker is "re-creating" the monolithic files that main has split. The semantic change (~30 LOC) is buried inside a 1037-line tasks.ts diff.

═══ WHAT BROKE ═══
- mu workspace create captures parent_ref at create time and never refreshes. There is no `mu workspace rebase` / `mu workspace fetch` / `mu workspace pull` verb.
- Worker-1's tests passed because they ran against the stale tree's tests. The stale tree ran 713 tests; main runs 713 tests; the TWO tree's tests cover different file layouts. Identical pass count is coincidental.
- The orchestrator (this conversation) had no signal that the workspace was stale. mu state, mu agent show, mu workspace list ALL show parent_ref but the operator has to mentally diff it against `git rev-parse main`.
- The workspace diff is so large that even applying the patch back to main is not mechanical. The recovery is: extract the semantic delta by reading the worker's diff manually, apply onto main, re-test. That's exactly what the workspace was supposed to AVOID.

═══ SEVERITY ═══
HIGH for any workstream that lives >1 day across active main churn. Today: roadmap-v0-2 + infer-rs are both at risk. Without a rebase verb, every dispatched task on a long-lived workstream silently gets harder to land as main moves.

The worker did NOTHING wrong. The framework lost the operator's invariant ("workspaces stay close to main").

═══ OPTIONS ═══

Option 1: ADD `mu workspace rebase <agent>` typed verb.
  Calls `git fetch + git rebase main` (or jj/sl equivalent) in the workspace dir. Updates parent_ref in vcs_workspaces. Surfaces conflicts via the normal jj/git conflict path. Operator opts in per workspace.
  Pros: explicit, undoable via vcs op log, no surprise mutation.
  Cons: another verb. Operator might forget to run it (same problem we have today, just with a verb to forget).

Option 2: WARN on staleness in mu state / mu workspace list.
  Add a "stale" column: count of commits between workspace's parent_ref and current main HEAD. Color-code (yellow ≥10, red ≥50). No mutation; pure observation.
  Pros: cheap; the operator decides.
  Cons: requires git call per workspace per state-render. Could be slow on large repos. Need a graceful "main not found" / "wrong default branch" fallback.

Option 3: AUTO-REBASE on workspace activity.
  When mu agent send is invoked, fetch+rebase the workspace if it's >N commits behind. Silent or with a one-line nudge.
  Pros: zero operator burden.
  Cons: silent mutations of the workspace are exactly the wrong direction for VISION.md. Conflict-on-rebase mid-send is a footgun.

Option 4: REJECT spawning new agents into a workspace whose parent is >N commits behind.
  At spawn time, fail with WorkspaceStaleError pointing at `mu workspace rebase` (option 1) or `mu workspace free + recreate`. No mutation; explicit gate.
  Pros: catches the problem before any work is dispatched.
  Cons: requires Option 1 to exist OR forces free+recreate (lossy).

═══ RECOMMENDATION ═══
Ship Option 2 first (warn-only, ~30 LOC, no mutation, cheapest signal). If that surfaces but operators still get bitten, layer Option 1 on top (~50 LOC + jj/sl/git backend impls). Option 4 only if Option 1 + 2 leaves real friction. Option 3 never (silent mutation = anti-feature).

═══ INTERIM WORKAROUND (no code change) ═══
After spawning a worker into an existing workspace OR before dispatching a new task to a worker on a long-lived workspace, the orchestrator should manually:
  cd $(mu workspace path <agent>) && git fetch origin && git log --oneline ..origin/main | wc -l
If >5, free + recreate the workspace OR (when jj/git supports it) `jj rebase -d main` / `git rebase main` in the workspace before dispatching.
SKILL.md should mention this until the typed verb lands.

═══ EVIDENCE ═══
worker-1 workspace at /Users/mtrojer/.local/state/mu/workspaces/roadmap-v0-2/worker-1
  parent_ref: 503a576ae93e (2026-05-08T11:08)
  git diff main --stat: 35 files changed, 6503 insertions(+), 7702 deletions(-)
  semantic delta (extracted manually): src/tasks.ts +~30 LOC + test/tasks.test.ts +~50 LOC + CHANGELOG +1 line.
This task surfaced the bug live; the dispatch is being recovered by extracting the semantic delta by hand.

═══ NEXT ═══
- Recover cross_workstream_claim_for by transplanting worker-1's semantic delta onto main directly (in progress).
- File a SKILL.md update once the workaround above is verified.
- Decide on Option 1+2 promotion (this task) vs DEFERRED if the orchestrator decides "free+recreate is fine for now".

═══ ODDITIES ═══
- workspace_create_partial_dir_on_failure (also from snap_dogfood) is a related but DISTINCT bug: that one is "create-time partial state"; this one is "lifetime drift". They share the same recovery muscle (mu workspace free + recreate is the operator-side answer to both today).
- The reaper note saying worker-1 was on "claude-opus-4-7 • high" is in the pane footer, not the workspace. So even if the substrate moves, the model+effort context is separately observable.
```

### #2 by worker-mf-1, 2026-05-09T06:05:12.762Z

```
FILES
  src/vcs.ts                — VcsBackend.commitsBehind (~120 LOC: interface clause + git/jj/sl/none impls + resolveGitMainRef helper). Pure observation; NO automatic fetch.
  src/workspace.ts          — WorkspaceRow.commitsBehindMain optional field + decorateWithStaleness(rows) SDK helper.
  src/cli.ts                — formatWorkspacesTable gains 'behind' column + formatBehind(n) color-coder (green <=2, yellow 3-9, red >=10).
  src/cli/workspace.ts      — `mu workspace list` calls decorateWithStaleness before render/JSON emit.
  src/cli/state.ts          — `mu state` decorates workspaces, computes staleWorkspaces (>=10), prefixes Workspaces header with ⚠ count when non-empty, prints Tip line below table.
  src/index.ts              — re-export decorateWithStaleness.
  test/workspace.test.ts    — per-backend commitsBehind tests (git fetches OK; jj/sl smoke; none always null) + decorateWithStaleness shape.
  test/workspace-staleness.test.ts (new, ~200 LOC) — drives CLI in-process; asserts behind column renders + mu state warn line fires at the threshold boundary.
  CHANGELOG.md              — new Unreleased > Added entry.
  docs/VOCABULARY.md        — new 'stale workspace' row in canonical table.
  docs/ARCHITECTURE.md      — VcsBackend.commitsBehind in src/vcs.ts seam row + extension-point row.
  skills/mu/SKILL.md        — one-line behind-column hint on mu workspace list.

COMMANDS
  npm install && npm run typecheck && npm run lint && npm run build      # all green
  env -u TMUX_PANE -u MU_AGENT_NAME -u MU_SESSION_ID npm run test         # 736/736 pass in a clean env
  # Live demo (verified end-to-end):
  CLI=$(mu workspace path worker-mf-1 -w mufeedback)/dist/cli.js
  export MU_DB_PATH=/tmp/demo-db/mu.db MU_STATE_DIR=/tmp/demo-state
  # set up project + bare origin + worker-1 git workspace; advance origin 12 commits; fetch once
  node $CLI workspace list -w demo                      # behind=12 in RED
  node $CLI state -w demo                               # ⚠ warn line + Tip with correct recovery commands
  # then reset to behind=5 -> YELLOW + no warn line. All three color zones (green/yellow/red) work.

FINDINGS
  - Each backend can resolve "main" without phoning home: git via origin/HEAD with origin/main / origin/master fallbacks; jj/sl via trunk(). All four return null cleanly when their notion of main can't be resolved.
  - decorateWithStaleness is a separate function (not folded into listWorkspaces) so callers that don't need staleness (acceptance, internal SDK uses) don't pay the per-row VCS roundtrip cost.
  - Color budget honored: only picocolors via the project's pc helper; no new render-layer deps. Three colors: green/yellow/red + dim em-dash for null.

DECISION
  Implemented OPTION 2 ONLY (warn-only in mu state + behind column in mu workspace list). Out of scope per the task (and per anti-feature pledges in ROADMAP):
    - Option 1 (mu workspace rebase) — file as follow-up if Option 2 leaves friction.
    - Option 3 (auto-rebase) — silent mutation, anti-feature.
    - Option 4 (reject stale spawn) — layers on Option 1 only.
  Threshold = 10 (matches the task spec exactly). NO automatic fetch (matches the task spec exactly: "show the count as of the last fetched state. The user can `git fetch` themselves if they want fresher").

NEXT
  - Watch dogfooding for "Option 1 still needed" signal (orchestrators forgetting to fetch + free+recreate). If it surfaces, file `feature_workspace_rebase_verb` and extend VcsBackend with `rebaseToMain(workspacePath)`.
  - Cosmetic follow-up if anyone hits it: jj/sl trunk() heuristics on fresh repos with no remote may return null; that's deliberately silent today (no warn) but `mu state` could emit a one-time `info: workspace staleness unknown` hint per render. Out of scope.

VERIFIED
  - typecheck + lint + build green.
  - 736/736 tests pass in a clean env (env -u TMUX_PANE -u MU_AGENT_NAME -u MU_SESSION_ID npm run test). The 2 "failures" when run inside this very pane are pre-existing in test/tasks.test.ts ("--self resolves actor from $USER") and caused by the test inheriting our TMUX_PANE — confirmed identical 2-fail pattern with my changes git-stashed out.
  - Live demo across all three color zones:
      behind=0 -> green '0' in workspace list table; mu state shows no warn line.
      behind=5 -> yellow '5'; still no warn line.
      behind=12 -> red '12' + Workspaces header reads "⚠ (1 stale ≥10 commits behind):" + Tip line reads "⚠ Tip: Free + recreate stale workspaces to land patches against current main: mu workspace free worker-1 + mu workspace create worker-1".
  - none-backend workspaces render '—' and never trigger the warn (covered by test).

ODDITIES
  - jj's commitsBehind impl uses --template '\"x\n\"' (escaped quotes around x\n) because jj templates require string literals; the simpler {commit_id} would work too but counting lines is robust to formatting.
  - The git impl uses `origin/HEAD` first because it tracks whatever symbolic ref the remote actually publishes. On a freshly-cloned repo this is set to point at refs/remotes/origin/main automatically; on older clones, fallback to origin/main / origin/master. No need to parse `git remote show`.
  - Source budget was ~120 LOC (close to the ~80 estimate; the typed result + 4 backend impls + helper added ~40); test budget was higher (~370 LOC across two files) but it's all real coverage including the CLI-render warn-line assertion the task explicitly asked for.
```
