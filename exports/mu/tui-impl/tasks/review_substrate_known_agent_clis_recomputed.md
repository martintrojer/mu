---
id: "review_substrate_known_agent_clis_recomputed"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: "worker-1"
created_at: "2026-05-13T12:40:15.415Z"
updated_at: "2026-05-13T14:24:02.160Z"
blocked_by: []
blocks: []
---

# REVIEW low: knownAgentCommands recomputed per orphan pane in hot reconcile path

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:40:15.690Z

```
FILE(S):
  src/reconcile.ts:113-120 (BASE_AGENT_CLIS, knownAgentCommands)
  src/reconcile.ts:200 (looksLikeAgentPane consumer)

FINDING (non-idiomatic / minor inefficiency, more importantly env-time-of-check):
  knownAgentCommands() is rebuilt on every pane visited
  (`looksLikeAgentPane` calls it once per pane in the orphan
  surface loop). Inside it, resolveCliCommand reads
  process.env.MU_<CLI>_COMMAND for each of the three base CLIs.

      const BASE_AGENT_CLIS: readonly string[] = ["pi", "claude", "codex"];
      function knownAgentCommands(): ReadonlySet<string> {
        const names = new Set<string>(BASE_AGENT_CLIS);
        for (const cli of BASE_AGENT_CLIS) {
          names.add(resolveCliCommand(cli));
        }
        return names;
      }

WHY IT'S A PROBLEM:
  - Recomputing the Set per pane (and re-reading 3 env vars per
    call) is wasteful in a hot path. tmux sessions in the wild
    can have dozens of panes; reconcile is called by `mu state`
    on every poll tick.
  - More importantly, recomputing per pane means the env-var
    snapshot can change mid-loop in test suites that twiddle
    MU_<X>_COMMAND in afterEach. That's not a real production
    issue but it makes the orphan-detection contract harder to
    reason about ("which env-var snapshot wins?"). Hoisting it
    to a per-call-of-`reconcile()` value is the natural fix —
    one snapshot per reconcile pass, applied uniformly.

PROPOSED FIX:
  In `reconcile()`, compute `const knownCommands = knownAgentCommands()`
  once before the orphan loop and inline it into a closure:
  `const looksLikeAgentPane = (p) => knownCommands.has(p.command);`
  Or move the closure-capturing approach into a helper:

      function buildAgentPaneRecogniser(): (pane: TmuxPane) => boolean {
        const known = knownAgentCommands();
        return (pane) => known.has(pane.command);
      }

  Drop the standalone `looksLikeAgentPane` function and stop
  exporting BASE_AGENT_CLIS recomputation per call.

EFFORT NOTE:
  ~5 LOC change. Zero behavioural change in production (env vars
  don't change mid-call). One unit test that asserts MU_PI_COMMAND
  set BEFORE reconcile is honoured in the orphan list (already
  exists in tmux-related tests; verify it stays green).
```

### #2 by "worker-1", 2026-05-13T14:24:02.160Z

```
CLOSE: ee95e98: knownAgentCommands hoisted via buildAgentPaneRecogniser() closure; orphan loop now O(1) env-reads per reconcile pass (was 3N); reconcile.integration.test.ts 33/33 green; full npm run test = same baseline (one pre-existing unrelated tui-app-emitter-shape failure)
```
