---
id: "review_substrate_startup_err_patterns_too_broad"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.15
roi: 366.67
owner: "worker-1"
created_at: "2026-05-13T12:39:50.676Z"
updated_at: "2026-05-13T13:11:51.579Z"
blocked_by: []
blocks: []
---

# REVIEW med: startup-error regex too broad — false-positive rolls back healthy spawn

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:39:53.427Z

```
FILE(S):
  src/agents/spawn.ts:439-454 (STARTUP_ERROR_PATTERNS)
  src/agents/spawn.ts:497-518 (awaitSpawnLiveness consumer)

FINDING (non-idiomatic / coverage gap):
  STARTUP_ERROR_PATTERNS contains two patterns that are very broad
  English phrases and not anchored to any CLI banner / startup
  marker:

      /command not found/i,
      /No such file or directory/i,

  The other entries (`/No API key found for [\w-]+/i`,
  `/Authentication failed/i`, `/401 Unauthorized/i`, …) are
  reasonably specific to provider/auth startup failures.

WHY IT'S A PROBLEM:
  The two broad strings appear constantly in benign output:
    - `pi-meta`'s status bar / hint area mentions optional config
      paths that may not exist (`No such file or directory`
      from a `cat`/`ls` probe in pi's own startup);
    - any agent banner that prints a hint like "type `mu` —
      command not found? install with …" would false-positive;
    - a wrapper CLI that runs `git rev-parse` for the prompt and
      gets "fatal: not a git repository" → "No such file or
      directory" in some git locales.

  When matched, `awaitSpawnLiveness` throws AgentSpawnStartupError,
  which calls `rollbackSpawn` — killing the pane, freeing the
  workspace, and deleting the agent row from a perfectly healthy
  spawn. The cost of a false positive is total spawn loss; the
  pre-flight `checkCommandResolvable` already covers the
  high-value case (typo'd binary name) deterministically.

PROPOSED FIX:
  Either:
  (a) Drop the two broad patterns and rely on the pre-flight
      PATH check (already runs unless --command is used); OR
  (b) Anchor them to startup-shell-error markers so the pattern
      requires the line LOOKS like a shell error not prose:
      e.g. /^(?:.*: )?(?:command not found|No such file or
      directory)$/i  — i.e. the line ends with the marker, no
      trailing prose.

  Update test/agent-spawn-name-hint.integration.test.ts and the
  spawn liveness coverage to lock in the new behaviour.

EFFORT NOTE:
  Small. ~10 LOC change in spawn.ts plus 2 new test cases (one
  positive: legacy "bash: pi-meta: command not found" still
  trips; one negative: pi's banner string mentioning the phrase
  in prose does NOT trip). Risk: negligible — current PATH
  pre-flight is the actual safety net for typo'd --cli; the
  in-pane fallback regex was a belt-and-suspenders addition
  that overshot.
```

### #2 by "worker-1", 2026-05-13T13:11:51.579Z

```
CLOSE: 7f2f7ec: regex anchored to shell-error lines (single anchored regex, trailing-name allowance keeps zsh form working); prose false-positive test added in test/cli-agent-spawn-validation.integration.test.ts (4 negative cases); full test 2339 passed; bundle smoke ok
```
