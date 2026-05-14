---
id: "fb_agent_spawn_no_validation"
workstream: "feedback"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: null
created_at: "2026-05-11T08:18:43.205Z"
updated_at: "2026-05-11T08:52:41.682Z"
blocked_by: []
blocks: []
---

# agent spawn silently succeeds when --cli is broken/unavailable

## Notes (3)

### #1 by "π - gchatui", 2026-05-11T08:19:06.464Z

```
SEEN: 2026-05-11 in workstream gchatui.

I ran `mu agent spawn worker-1 -w gchatui --workspace` (default --cli
pi). On this system the correct CLI is `pi-meta`. `mu agent spawn`
returned success and a "Spawned worker-1 (pi)" line. The pane was
created; the CLI either failed to start or started an unusable session.
There was no error surfaced, no early failure.

Discovery only happened when the user told me. Without that, I would
have sent dispatch prompts to a dead pane and `mu task wait` would have
hung until --timeout fired.

REPRO:
  mu agent spawn test-bad -w <ws> --workspace --cli does-not-exist
  # exits 0; pane spawned with "command not found".

DESIRED:
  - `mu agent spawn` should validate that --cli (a) resolves to a
    binary on PATH and (b) ideally that the pane process doesn't exit
    in the first ~2s. Fail loudly if either check fails.
  - If --cli was resolved via $MU_<KEY>_COMMAND, mention which env var
    in the success line so config issues are obvious.

PRIORITY: high. This is a silent footgun that costs an entire wave +
human intervention to recover from.

WORKAROUND: always pass --cli explicitly the first time on a new
machine and verify with `mu agent read <name>` before sending work.
```

### #2 by "worker-spawnpath-1", 2026-05-11T08:52:30.240Z

```
FILES:
  - src/agents/errors.ts (added AgentSpawnCliNotFoundError; updated header comment)
  - src/agents/spawn.ts (added envVarNameForCli, resolveCliCommandWithSource, CommandResolver/CommandResolutionResult types, defaultCommandResolver via `command -v`, set/resetCommandResolverForTests, checkCommandResolvable, pre-flight in spawnAgent before prestageWorkspace, extended STARTUP_ERROR_PATTERNS with /command not found/ + /No such file or directory/)
  - src/agents.ts (re-exported new symbols)
  - src/index.ts (re-exported new symbols + types from SDK)
  - src/cli/handle.ts (mapped AgentSpawnCliNotFoundError → label "spawn cli not found", exit 1)
  - src/cli/agents.ts (cmdSpawn surfaces "(via $MU_<KEY>_COMMAND)" in human success line; --json envelope adds resolvedFromEnvVar; precedence: --command > env-var > bare cli)
  - test/cli-agent-spawn-validation.test.ts (NEW — 20 tests covering envVarNameForCli, the resolver seam, Part A pre-flight (typed error, no orphan workspace, nextSteps content, --command opt-out, env-var override paths), Part B extended scrollback patterns, Part C env-var attribution in stdout + --json + bare-cli case + e2e CLI refusal)
  - test/verbs-spawn.test.ts (added permissive default resolver in beforeEach so existing tests using synthetic --cli/MU_PI_COMMAND values keep passing)
  - CHANGELOG.md (Unreleased § Fixed entry covering all three parts + SDK additions)
  - docs/VOCABULARY.md (extended MU_<UPPER_CLI>_COMMAND row to mention env-var attribution + spec hyphen→underscore convention; extended MU_SPAWN_LIVENESS_MS row to mention shell-error patterns + the new pre-flight error class)

COMMANDS:
  npm run typecheck   exit 0
  npm run lint        exit 0
  npm run test        exit 0 (68/68 files, 1210/1210 tests)
  npm run build       exit 0

FINDINGS:
  - The dogfood report nailed the failure mode: `mu agent spawn worker-1 --cli pi-meta` on a host where pi-meta wasn't on PATH printed "Spawned worker-1 (pi-meta)" and the pane died on "command not found"; the existing 1.5s liveness check missed it because the shell stayed alive past the failed exec.
  - resolveCliCommand was already a clean seam — the env-var convention is `MU_<UPPER_CLI>_COMMAND`. Hyphens in cli keys (e.g. pi-meta) had to be rewritten to underscores for env var validity; codified in the new envVarNameForCli helper and tested.
  - The pre-flight had to skip when --command is explicit: that path is the operator's signed-off literal command (often a shell snippet whose first token wouldn't survive a naive `command -v` parse). The post-spawn scrollback scanner is the safety net there.
  - The dedicated test harness (setCommandResolverForTests / resetCommandResolverForTests) keeps the test suite independent of what's installed on the test box.

DECISION:
  - Three coordinated fixes (Part A pre-flight, Part B extended scrollback patterns, Part C env-var attribution) shipped together — the user-visible failure mode involves all three loops, and any one fix without the others leaves a hole.
  - Pre-flight uses `/bin/sh -c "command -v <bin>"` rather than scanning $PATH manually: portable POSIX, honours operator's PATH semantics including PATH=. weirdness, doesn't reimplement shell semantics in JS.
  - AgentSpawnCliNotFoundError carries the THREE spec-listed nextSteps (default --cli pi, set MU_<KEY>_COMMAND, `which pi pi-meta claude codex`) verbatim — operators paste them.
  - Env-var attribution in success line uses `(via $MU_PI_META_COMMAND)` to make it greppable; --command override still wins display via the existing `(cmd: ...)` suffix because the explicit value is what the operator typed.
  - resetCommandResolverForTests added to verbs-spawn.test.ts beforeEach defensively: synthetic test --cli values like 'pi-alt' would otherwise trip the new pre-flight check on systems without pi-alt installed.

NEXT:
  - None planned. ROADMAP doesn't yet mention this — submit this work as the closure for fb_agent_spawn_no_validation.
  - Possible follow-up if real-world friction emerges: surface the env-var attribution in `mu agent show` too (currently only spawn-success line + --json envelope). Not done now — promotion criteria not met.

VERIFIED:
  - All 4 gates green: typecheck, lint, 1210/1210 tests pass, build clean.
  - Dedicated test file covers: pre-flight typed error class, no orphan workspace on pre-flight refusal, error nextSteps content, --command opt-out, env-var override paths (present + missing-binary), all extended scrollback patterns, env-var attribution in human stdout + --json envelope (presence + absence), e2e CLI refusal exits non-zero.
  - Manual smoke in repo not run — covered by the integration-test variants of spawn that exercise the real tmux server (existing test/verbs.integration.test.ts) plus the new in-process tests.

ODDITIES:
  - The "sh: 1: pi-meta: not found" pattern (dash-shell variant lacking the literal "command not found") would not trip the curated patterns. Spec only listed the four /command not found/ + /No such file or directory/ variants; left it as-is to keep the false-positive surface tight. If dogfood reports surface dash-shell installs, expand the curated list.
```

### #3 by "worker-spawnpath-1", 2026-05-11T08:52:41.682Z

```
CLOSE: all 4 green; pre-flight PATH check + scrollback patterns + env-var attribution; commit d6ef436
```
