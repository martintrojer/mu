---
id: "review_code_decorate_with_staleness_n_plus_one"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-mf-3"
created_at: "2026-05-09T08:33:52.059Z"
updated_at: "2026-05-09T09:52:30.203Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "review_test_workspace_staleness_behind_value_unanchored"]
---

# REVIEW: decorateWithStaleness fans out N concurrent VCS shellouts; bounded by Promise.all

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:34:24.677Z

```
FILES: src/workspace.ts:419-432 (decorateWithStaleness), src/vcs.ts:227-237 + :318-336 + :412-432 (per-backend commitsBehind impls)

FINDINGS: decorateWithStaleness uses Promise.all over the input array, calling backend.commitsBehind(path, ref) for each row in parallel. Each call shells out to git/jj/sl ≥1 time:
  - git: resolveGitMainRef tries up to 3 `git rev-parse --verify` invocations + 1 `git rev-list --count` (vcs.ts:268-282). 1-4 child processes per workspace.
  - jj: 1 `jj log` invocation. 1 child process.
  - sl: 1 `sl log` invocation. 1 child process.

Called by:
  - cli/workspace.ts:cmdWorkspaceList (every `mu workspace list` invocation)
  - cli/state.ts:cmdState (every `mu state` invocation)

Two issues:

1. N×4 unbounded fork bomb on a workstream with many workspaces. A user with 20 workspaces calling `mu workspace list --all` could fork-burst 80 git children at once. node's libuv child-process pool is large but not infinite; OS-level fork-rate-limits surface as ETXTBSY / ENOMEM / EAGAIN under load. Recovery is an opaque error that the user reads as "mu broken".

2. No caching, no opt-out. mu state is the canonical "every operator runs this often" verb; a 50ms-per-workspace × 10-workspace operator pays 500ms+ per state read. The HUD docstring at hud.ts:7-13 is explicit: "print-once-and-compose by design (`watch -n 5 mu hud -w X`)". A 5-second watch loop with 10 workspaces means 100 child processes/minute just for staleness. That's substrate-level expensive for a decorative column.

Recovery / mitigation options exist:
  - Bound concurrency (e.g. 4 parallel) — easy; makes the fork-burst manageable.
  - Cache the result with a short TTL (e.g. 60s) — protects watch loops without staleness becoming actually stale on the user-perception scale.
  - Make staleness opt-in via a flag (default off; --stale to compute). The cleanest answer; the docstring already labels staleness as "pure observation" — making the decoration itself opt-in matches that framing.

WHY IT MATTERS: 50. Real-user pain on multi-workspace setups + a substrate-blast-radius hazard. Not a crash today (vcs.ts wraps each call in try/catch returning null), so symptomatic only when the operator notices `mu state` taking longer or watch loops thrashing the disk.

SUGGESTED FIX (~30 LOC):
Recommend Option C (opt-in flag). Smallest correct fix:
1. Add `--stale` flag to `mu state` and `mu workspace list` (default off).
2. cli/state.ts and cli/workspace.ts call decorateWithStaleness only when --stale is set. Otherwise rows render with commitsBehindMain undefined → formatBehind → dim em-dash. This is what the table already does for "not yet computed" so no UI surface change.
3. mu workspace list keeps decoration as a behaviour-preserving default for now (it's the verb that looks most like "I'm asking about workspaces specifically"); state.ts opts out of decoration unless --stale. Or: both opt out; user runs `mu workspace list --stale` when they care.

If staleness is judged load-bearing in the default mu state output, instead bound concurrency (~10 LOC):
  - Wrap the rows.map in a chunked Promise.all (4 at a time).

ALTERNATIVES CONSIDERED:
- Cache: keep decoration on by default; cache results in agent_logs or a new ephemeral table for 60s. ~50 LOC + invalidation policy. Probably overkill.
- Time-bound: decorateWithStaleness has a per-call timeout; results that don't return in 250ms get null. Simple; doesn't solve the fork burst.
- Move to a one-shot helper that opens a single git/jj/sl process and queries multiple workspace paths from it. Heavyweight, not portable across backends.

EVIDENCE:
- src/workspace.ts:421-432: Promise.all unbounded.
- src/vcs.ts:268-282: resolveGitMainRef serial-tries 3 candidates, each its own exec.
- cli/state.ts:181 + cli/workspace.ts:75: both call decorateWithStaleness on every invocation, no flag.
- HUD docstring at cli/hud.ts:7-13 (NOT a caller — hud doesn't call decorateWithStaleness — but the watch-loop usage pattern is what makes the cost a concern; mu state is the verb users put into watch).
```
