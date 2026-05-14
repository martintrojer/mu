---
id: "workers_commonly_attempt_unbounded_find"
workstream: "feedback"
status: CLOSED
impact: 25
effort_days: 0.3
roi: 83.33
owner: null
created_at: "2026-05-10T23:14:28.431Z"
updated_at: "2026-05-11T08:35:17.461Z"
blocked_by: []
blocks: []
---

# workers commonly attempt unbounded find / scans, costing >1h wall

## Notes (3)

### #1 by "π - infer-rs", 2026-05-10T23:14:41.755Z

```
NOTE: re-attaching content because slugify truncated the id (typed without -find suffix originally; tail -1 hid the warning). Content as before.

OBSERVED 2026-05-10 over multiple workers in workstream infer-rs.

PATTERN: pi workers, when asked to find a file or directory whose path is not in their immediate context, default to running `find / -maxdepth 6 -name foo` or `find /Users/mtrojer -maxdepth 5 ...`. These take 30-60+ minutes on a populated home directory and effectively block the worker until the find completes. The orchestrator's `mu agent send` steering messages queue but go unread until the find returns.

OCCURRENCES THIS SESSION:
  - worker-leak-1: 36+ minute `find / -maxdepth 6 -name infer -type f`
  - worker-walltime-1: ~28 minute `find ~ -maxdepth 6 -name perf-remeasure-off-*`
  - worker-perf-4: 49 minute `while true; do load=...; if (( $(echo "$load < 1.5" | bc -l) )); then break; fi; sleep 30; done` busy wait with bc parse error
  - worker-perf-5 successfully avoided after explicit "DO NOT run find" prompt

ORCHESTRATOR ESCAPE: had to drop out of mu, `pgrep -af "find /"` / `pgrep -af "while.*load"`, kill the PID directly. tmux Ctrl-C through `mu agent send` does NOT propagate to wrapped subprocesses.

UX SUGGESTIONS (mu side):
  1. `mu agent kick <name> [--signal SIGINT|SIGTERM|SIGKILL]` that signals the agent's pane TTY foreground process group, so a runaway shell command can be interrupted from outside the pane. Currently no built-in escape.
  2. Optional: a watchdog flag `mu agent spawn ... --max-tool-secs N` that auto-kills any single tool-invocation taking longer than N seconds. Would need pi-side cooperation but mu could implement crude version via agent_logs heartbeat polling.
  3. Document the failure mode prominently in the skill DON'Ts: "Do NOT prompt workers to run filesystem-wide `find` commands or unbounded busy-wait loops; pass them paths explicitly or scope to $WORKSPACE."

Severity: medium-high. Cost ~2h of orchestrator+worker time across the session. Fully avoidable with prompt hygiene but the recovery story is bad.
```

### #2 by "worker-kick-1", 2026-05-11T08:34:40.574Z

```
FILES:
  src/tmux.ts (+38 LOC) — paneTTY(paneId) helper: tmux display-message
    -p '#{pane_tty}' wrapped with PaneNotFoundError on can't-find / empty stdout.
  src/agents/kick.ts (NEW, 318 LOC) — KickSignal type, KickProcessExecutor
    swappable executor (mirrors setTmuxExecutor), parsePsTtyOutput
    (whitespace-split of `ps -o pid=,pgid=,stat=,comm=`), foregroundPgid
    (strips /dev/ prefix; finds row whose stat contains '+'; refuses when
    fg comm matches WRAPPER_COMM_PREFIXES = pi/claude/codex/bash/zsh/sh/
    fish/dash incl `<prefix>-suffix` like pi-meta), kickAgent verb
    (kill -<signal> -<pgid>; emits 'agent kick <name> (signal=..., pgid=...,
    comm=...)' event), NoForegroundProcessError typed class with
    errorNextSteps (mu agent show / mu agent close).
  src/agents.ts — re-exports kick cluster.
  src/index.ts — adds kick + paneTTY to SDK surface.
  src/logs.ts — 'agent kick' added to EVENT_VERB_PREFIXES (HUD colourer
    regression test would fail otherwise).
  src/cli/agents.ts — wireAgentCommands gains 'agent kick <name>'
    (--signal SIGINT|SIGTERM|SIGKILL, --workstream, --json). cmdKick
    validates the signal via isKickSignal (UsageError on bad value).
  test/cli-agent-kick.test.ts (NEW, 20 tests) — parsePsTtyOutput unit tests,
    isKickSignal, foregroundPgid (mocked KickProcessExecutor: ok / no-fg /
    shell-only branches incl pi-meta / claude / codex / bash / zsh / sh
    matrix, /dev/ prefix-stripping for procps, race-condition kill ESRCH
    swallow), kickAgent unit (mocked tmux + mocked proc exec: SIGINT default,
    SIGTERM honoured, AgentNotFound, no-fg, shell-only, no event on refusal,
    happy-path event payload format), and TWO real-tmux integration tests
    (skipped when $TMUX unset): SIGINT actually kills a `bash -c 'exec sleep
    600'` pane (foreground IS sleep, not bash, so shell-only guard doesn't
    fire), and the wrapping-bash refusal (NoForegroundProcessError shell-only).
  test/tmux.test.ts — 5 new paneTTY tests (happy / PaneNotFoundError on
    can't-find / PaneNotFoundError on empty stdout / TmuxError on other
    failures / invalid pane id rejected before tmux call).
  skills/mu/SKILL.md — DON'T entry: 'Don't prompt workers to run filesystem-
    wide find, broad grep -r /, or unbounded busy-wait loops; pass paths
    explicitly or scope to $WORKSPACE; if a worker wedges on one, use mu
    agent kick <name>'. Hard-earned dispatch lessons gain a 'wedged on
    unbounded tool subprocess' para covering kick + escalation. CLI overview
    line updated to include 'kick'.
  CHANGELOG.md — Unreleased ### Added entry for mu agent kick.
  docs/USAGE_GUIDE.md — Recovery scenarios gains 'A worker is wedged on an
    unbounded tool subprocess' section.
  docs/VOCABULARY.md — kick row added to the four 'stop talking to this
    agent' verbs table (now five).
  docs/ARCHITECTURE.md — module table mentions kick.ts in the agents cluster.

COMMANDS:
  npm run typecheck     exit 0
  npm run lint          exit 0 (after one biome --write pass for format)
  npm run test          exit 0 — 1194 tests / 67 files all pass; new test
                        file contributes 20 tests (incl 2 real-tmux integration)
  npm run build         exit 0 — dist/cli.js + dist/index.js
  node dist/cli.js agent kick --help     verified output

FINDINGS:
  - tmux send-keys C-c to a pane running pi/claude/codex DOES NOT propagate
    to wrapped subprocesses; the wrapping CLI catches SIGINT as TUI input.
    This is exactly why the operator's existing escape (mu agent send /
    tmux send-keys) didn't work in the original feedback report.
  - The portable foreground-pgid trick: ps -t <tty> -o pid=,pgid=,stat=,comm=
    works on both Darwin (BSD ps) and Linux (procps) when the tty is given
    as the short form (ttysNNN, not /dev/ttysNNN). procps is strict; BSD
    accepts both. Strip /dev/ everywhere for portability.
  - The `+` flag in ps's stat field is the canonical foreground-of-its-
    controlling-tty marker; portable across BSD + Linux. Picking the row
    whose stat contains '+' is more robust than `tcgetpgrp` shell-out
    (no extra binary, works under macOS sandbox).
  - kill -SIG -<pgid> (negative pid form) targets the whole process group;
    a single `find` may have spawned helpers and we want them all gone with
    one signal. Tests verify the negative-pgid form is what hits the
    executor.

DECISION:
  - SDK function lives in src/agents/kick.ts (cluster file, mirrors
    spawn.ts / adopt.ts pattern). Re-exported from src/agents.ts and
    src/index.ts. Errors live in src/agents/kick.ts itself
    (NoForegroundProcessError) rather than src/agents/errors.ts because
    it's exclusively used by kick — keeps the errors file focused on the
    cross-cutting agent errors.
  - Refusing on shell-only (foreground IS the wrapping CLI) is a hard
    refusal that throws NoForegroundProcessError; alternative would have
    been to silently no-op or to prompt for confirmation. Hard refusal
    matches the WorkspacePreservedError precedent (refuse + nextSteps
    pointing at the right verb — `mu agent close <name>`).
  - WRAPPER_COMM_PREFIXES intentionally includes shells (bash/zsh/sh/...)
    so an idle pi pane (pi may have exited and the bash shell is the
    foreground) still refuses. The match is loose (basename === prefix OR
    starts with `<prefix>-`) so pi-meta, bash-3.2, etc. are all caught.
  - Process executor abstraction (setKickProcessExecutor) mirrors
    setTmuxExecutor — the unit tests need to mock both ps and kill, and
    the existing TmuxExecutor only covers tmux args.
  - 'agent kick' event added to EVENT_VERB_PREFIXES (the HUD's verb-
    colourer reads this; a regression test in test/hud.test.ts would
    have failed otherwise per the maintenance contract in src/logs.ts).

NEXT:
  - Optional follow-up (NOT in scope here, would be a separate task):
    mu agent kick --self for an in-pane self-kick when the agent itself
    is in a wedged-tool situation; today the agent has no recourse from
    inside its own pane.
  - Optional: a watchdog flag mu agent spawn ... --max-tool-secs N from
    the original feedback report's UX suggestion #2 — would need pi-side
    cooperation; deferred until promotion criteria met (real friction
    reported ≥2x).

VERIFIED:
  - npm run typecheck && npm run lint && npm run test && npm run build all
    exit 0.
  - 20/20 new tests pass (test/cli-agent-kick.test.ts).
  - Real-tmux integration test: spawn 'exec sleep 600' in a tmux pane,
    run kickAgent (default SIGINT), poll: pane closes within 1s, sleep
    is gone from `ps -axo comm,args`. Confirmed.
  - mu agent kick --help renders the documented options + description.

ODDITIES:
  - foregroundPgid returns three discriminated kinds (ok / no-foreground /
    shell-only). The defensive 'should be unreachable' branch in kickAgent
    that re-throws NoForegroundProcessError when the discriminator says
    'ok' but pgid/fgRow are undefined exists only to satisfy
    noUncheckedIndexedAccess + future-refactor safety; unreachable today.
  - The benign 'No such process' kill response is swallowed (race: the
    pgid completed between our ps and our kill). Test covers it.
```

### #3 by "worker-kick-1", 2026-05-11T08:35:17.461Z

```
CLOSE: all 4 green; new verb mu agent kick + SKILL DON'T entry; commit 7c250ff
```
