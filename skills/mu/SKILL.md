---
name: mu
description: Manage a persistent crew of pi agents in tmux panes coordinated through a built-in task graph. Use when the user asks to spawn, send work to, observe, or coordinate multiple sub-agents — especially long-lived ones, or work that benefits from a dependency graph and parallel-track detection.
---

# mu — Multi-agent orchestration

You have access to `mu`, a CLI for managing a persistent crew of AI
agents in tmux panes coordinated through a task graph. State lives at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db` (SQLite) and mu is
driveable from any shell.

This skill describes the **complete current surface**. Any verb not
listed below does not exist; check `mu --help` if in doubt.

## Vocabulary

- **workstream** — mu's unit of organization; one tmux session.
- **agent** — a named worker in a tmux pane (you may be one).
- **task** — a node in the DAG; mandatory `impact` (1–100) and
  `effort_days`; status `OPEN → IN_PROGRESS → CLOSED`.
- **claim** / **release** — atomic CAS take/clear of `tasks.owner`.
- **free** — mark the *agent* available (`mu agent free`). Pane
  untouched. Different from release: free is about the agent,
  release is about the task.
- **note** — append-only context attached to a task; survives
  across sessions.
- **track** — an independent subtree of the DAG (parallel-track
  detection; visible in mission control).
- **workspace** — per-agent isolated VCS working copy
  (`<state-dir>/workspaces/<workstream>/<agent>/`).

## When to reach for mu

**Use mu for:**
- Multi-phase investigations where context loss across the
  session would hurt (benchmark + profile + fix + review + parity).
- Tasks worth gating with review (DAG enforces the
  `implement → review → address → ship` chain).
- Parallel read-only/audit work alongside a heavier task (one
  worker profiling, one scout auditing retention, etc).
- Implementation + reviewer/tester splits with isolated workspaces.
- Work likely to survive context compaction — the durable task
  notes are the project memory the next agent inherits.
- Anything where "what was decided and why" needs to outlive a
  single agent's scrollback.

**Do NOT use mu for:**
- Tiny direct edits (5-minute one-file changes).
- Quick local inspection / one-off commands.
- Single-context work where no durable coordination is needed.

The overhead (task creation → claim → send → monitor → notes →
close) is worth it when the work has multiple phases or
uncertainty; it's pure ceremony when the work is one shell
command. **The orchestrator's first decision is whether to
reach for mu at all.**

Mu is a pi orchestrator; status detection is pi-only. Pairs well
with `tmux attach` for live observation.

## Mental model

### One workstream = one tmux session

Named `mu-<workstream>`. Every agent in the workstream is a pane;
`tmux a -t mu-<workstream>` shows the whole crew. Multiple
workstreams = multiple tmux sessions, partitioned in the DB by
`workstream` columns.

### The task DAG drives coordination

- One edge type: `blocks`. `A → B` = A must close before B starts.
- Built-in views: `ready` (no unresolved blockers), `blocked`,
  `goals` (no dependents).
- Bare `mu` shows **parallel tracks** with **automatic diamond-merge**:
  goals sharing a prerequisite collapse into one track. Don't spawn
  more agents than there are tracks.
- Notes are append-only per task. Conventions: `FILES:`, `DECISION:`,
  `VERIFIED:` — they cure LLM context loss.

### Per-agent workspaces stop trampling

For two agents editing the same project, use `--workspace` on spawn.
Each gets an isolated working copy under
`<state-dir>/workspaces/<workstream>/<agent>/`. Auto-detects jj/sl/git;
`cp -a` for non-VCS. Workspaces are NOT freed when you close an
agent (`agent close` is intentionally separate from disk cleanup,
so uncommitted artifacts — benchmark output, profiles, scratch
logs — don't get auto-deleted). Run `mu workspace free <agent>`
explicitly when you want the dir gone.

### Name agents by role, not by person

Use `worker-1`, `worker-2`, `reviewer-1`, `scout-1`, `auditor-1`,
`planner-1`. Pick the smallest unused suffix. Avoid human names
(`alice`/`bob`) and pejoratives (`peon`/`minion`). mu accepts any
`[a-z][a-z0-9_-]{0,31}` but stick to the convention — names show up
in `mu agent list`, in tmux's window list, and as the pane title.

## Orchestrator loop (the canonical operational discipline)

This is what the orchestrator pi (or human operator) does, every
turn. Internalise it before you start delegating; skipping steps
is how fire-and-forget creeps in.

**Before assigning work:**

1. Run `mu state -w <ws>` (or bare `mu -w <ws>` for the lighter
   table). Read the card.
2. Check four things:
   - **current agents** — who's alive, who's `busy / needs_input /
     idle / done`?
   - **`IN_PROGRESS` tasks** — what's already claimed?
   - **ready tasks** — what could be picked up now?
   - **parallel tracks** — how many independent threads exist?
3. **Do not spawn more agents than independent ready tracks.**
   The track count is the upper bound; more agents than tracks
   means agents fighting over the same prerequisite chain.
4. Claim before sending instructions:
   ```bash
   mu task claim <id> -w <ws> --for <agent> --evidence "why this task, why this agent"
   ```
5. Send task-specific instructions that include:
   - the task ID (so the agent can `mu task show <id>`)
   - which files / notes to read first
   - what NOT to do (scope guards)
   - expected note + close behaviour (the task note contract —
     see below)
6. Monitor (don't walk away — see "After spawning, observe" below):
   - `mu state -w <ws>` between turns
   - `mu agent show <agent> -n N` for a focused look
   - task notes and status as they accumulate
7. When a task closes, re-run `mu state` and repeat from step 1.

The loop is short on purpose. Every step exists because skipping
it was a real friction point in early use.

### Parallelisation decision table

| Situation | Action |
|-----------|--------|
| One ready task / one track | Reuse one existing agent |
| Multiple independent ready tasks | Spawn one agent per ready track |
| CPU-heavy benchmark in progress | Only parallelise read-only / audit tasks |
| Two agents editing/building/testing same repo | Use `--workspace` |
| Agent only reading docs/source | `--cli pi` (or any operator-defined alias) without `--workspace` is OK |
| Agent making code changes | `--workspace` strongly preferred |
| Agent reviewing/testing another agent's patch | Separate `--workspace` (or wait for the patch to merge) |

### Default workspace rule

**If an agent may edit files, build, run tests, or generate
artifacts while another agent is active in the same repo, spawn
with `--workspace`.** The main checkout should be reserved for
orchestration or single-agent work.

```bash
mu agent spawn worker-1   -w infer-rs --workspace
mu agent spawn reviewer-1 -w infer-rs --workspace --role read-only
```

Why: jj/git workspaces share the repo root, but each gets its own
working copy. Two builds in the same checkout will corrupt each
other's `target/` (Rust), `node_modules/.cache/` (JS), or any
generated artifact. Read-only agents (no build, no edit) can skip
`--workspace` if you're sure they'll stay read-only — but the
cost of `--workspace` is small enough that "always on" is a fine
default.

### Task note contract

Every delegated task should end with a note containing six fields
(omit only the ones genuinely N/A):

```
FILES:    paths inspected/changed (with line ranges if precise)
COMMANDS: shell commands run + exit codes
FINDINGS: what you observed
DECISION: what you chose, and why (when applicable)
NEXT:     follow-on tasks the next agent should know about
VERIFIED: how you confirmed it works (test names, command output)
ODDITIES: anything weird you saw but didn't act on
```

Then close with grounding:

```bash
mu task close <id> -w <ws> --evidence "tests pass: cargo test exit 0"
```

This turns the DAG from a coordination tool into a durable
project log. Future agents (and humans) can `mu task notes <id>`
to reconstruct the why without reading the diff.

## CLI — complete verb list

```bash
# Workstream (3)
mu workstream init <name>             # create the tmux session (mu-<name>)
mu workstream list [--json]           # every workstream on this machine
mu workstream destroy [-w] [--yes]    # nuke tmux session + all DB rows;
                                      # default is dry-run, --yes to commit

# Agents (8)
mu agent spawn <name> [-w] [--cli pi] [--command CMD] [--tab T]
                      [--role full-access|read-only] [--cwd P]
                      [--workspace] [--workspace-backend jj|sl|git|none]
                      [--workspace-from REF] [--workspace-project-root PATH]
mu agent send <name> "text" [-w]      # bracketed-paste send (handles /, ?, !, $)
mu agent read <name> [-n N] [-w]      # tmux capture-pane; default = full scrollback
mu agent show <name> [-n N] [-w] [--json]  # registry row + last N lines (default 20)
mu agent list [-w] [--json]           # this workstream's agents (reconciled with tmux)
mu agent close <name> [-w]            # kill pane + drop registry row
                                      # NOTE: does not touch the workspace; run
                                      # `mu workspace free <name>` separately.
mu agent free <name> [-w]             # set agents.status='free' (idempotent; pane untouched)
mu agent attach <name> [-w]           # print scrollback + tmux command to attach
                                      # Note: -w on send/read/show/close/free is a SCOPE check
                                      # (errors with AgentNotInWorkstreamError if mismatch);
                                      # -w on attach picks WHICH agent (different role).

# Tasks (22)
mu task add [id] [-w] --title T --impact N --effort-days N [--blocks A,B,C]
                                      # id optional — derived from title via slugify when omitted
mu task list [-w] [--json]            # every task in the workstream
mu task next [-w] [-n K] [--json]     # top-K ready tasks by ROI (default K=1)
mu task ready [-w] [--json]           # all ready tasks, sorted by ROI
mu task blocked [-w] [--json]         # OPEN tasks with at least one non-CLOSED blocker
mu task goals [-w] [--json]           # tasks with no dependents (graph endpoints; excludes CLOSED)
mu task owned-by <agent> [--include-closed] [--json]
                                      # what is <agent> currently working on? (cross-workstream)
                                      # excludes CLOSED by default (closeTask preserves owner
                                      # as historical record); --include-closed to surface that
mu task search <pattern> [-w] [--all] [--in-notes] [--json]
                                      # case-insensitive substring on title + id
mu task show <id> [-w] [--json]            # row + edges + notes
mu task tree <id> [-w] [--down] [--json]   # ASCII tree of blockers (default) or dependents (--down);
                                           # diamonds collapse with an arrow marker
mu task notes <id> [-w] [--json]           # just the notes (oldest first)
mu task note <id> "text" [-w]              # append a note (\n / \t / \\ escapes interpreted)
mu task claim <id> [-w] [--for <agent>]    # CAS on tasks.owner; reads pane title via $TMUX_PANE
mu task release <id> [-w] [--reopen]       # clear tasks.owner; --reopen flips status back to OPEN
mu task close <id> [-w]                    # OPEN/IN_PROGRESS → CLOSED (idempotent)
mu task open <id> [-w]                     # CLOSED → OPEN (e.g. reopen mistakenly closed)
mu task block <blocked> [-w] --by <blocker>    # add a blocking edge (cycle + workstream check)
mu task unblock <blocked> [-w] --by <blocker>  # remove a blocking edge (idempotent)
mu task update <id> [-w] [--title T] [--impact N] [--effort-days N]
                                           # modify scalar fields; one or more required
mu task reparent <id> [-w] --blocks <a,b,c>    # atomically replace incoming edges; '' clears all
mu task delete <id> [-w]                   # delete; FK CASCADE cleans edges + notes (idempotent)
                                           # On all task verbs: -w is a scope check — if the task
                                           # exists in a different workstream, errors with
                                           # TaskNotInWorkstreamError (exit 4).

# Self-identification (3) — only useful inside a managed pane
mu whoami [--include-closed] [--json] # name + workstream + cli + owned tasks (via $TMUX_PANE);
                                      # owned-tasks excludes CLOSED by default
mu my-tasks [--include-closed] [--json]    # alias for `task owned-by <self>`
mu my-next [-n K] [--json]            # alias for `task next -w <self.workstream>`

# Workspace (4) — per-agent isolated VCS working copies
mu workspace create <agent> [-w] [--backend jj|sl|git|none] [--from <ref>]
mu workspace list [-w] [--all] [--json]
mu workspace free <agent> [-w] [--commit]  # tear down on-disk dir; --commit auto-commits first
mu workspace path <agent> [-w]        # print the path; usable as `cd $(mu workspace path X)`
                                      # -w on workspace free/path is a scope check on the agent.

# Activity log (1, overloaded) — async coordination channel
mu log "text" [--as N] [--kind K]     # write; source defaults to your agent or 'user'
mu log [-w] [--since SEQ] [-n N] [--source X] [--kind X] [--all] [--json]
                                      # read latest 50 (or since cursor); filters apply
mu log --tail [-w] [--since SEQ] [--json]
                                      # blocking subscription; new entries print every ~1s

# Approvals (5) — human-in-the-loop gate for risky actions
mu approve add --reason "..." [-w] [--slug X] [--requested-by N] [--json]
                                      # request approval; returns slug
mu approve list [-w] [--all] [--status pending|granted|denied|timeout] [--json]
mu approve grant <slug> [-w] [--by N]    # human grants
mu approve deny  <slug> [-w] [--by N]    # human denies
mu approve wait  <slug> [-w] [--timeout SECONDS]
                                      # block; exit 0 granted, 4 denied, 5 timeout
                                      # -w on grant/deny/wait is a scope check on the approval.

# SQL escape hatch (1)
mu sql "<query>"                      # SELECT / UPDATE / DELETE / WITH RECURSIVE

# State / mission control (2)
mu [-w] [--json]                      # bare = quick mission control (agents + tracks + ready);
                                      # if no workstream resolves, falls back to listing all workstreams
mu state [--events N] [--json]        # canonical state card: agents + tracks + tasks (ready/
                                      # in_progress/blocked/recent_closed) + workspaces + recent_events
                                      # — the "what does an LLM look at first?" verb

# Health
mu doctor                             # tmux/db/schema/workstream + per-workstream stats
```

### Evidence on lifecycle verbs

`task close / open / claim / release` accept `--evidence "<text>"`.
The string is recorded verbatim in the auto-emitted event row,
suffixed `evidence="..."`. mu doesn't verify it — the audit trail
just records what the caller said it relied on. Use it for grounding
("tests pass: npm test exit 0", "reviewed spec"). Empty is fine; the
verb still works.

Workstream resolution for `--workstream / -w`:
explicit flag > `$MU_SESSION` > current tmux session minus `mu-` prefix > error.

### Machine-readable output: `--json`

Every read verb accepts `--json`. Output is one JSON document per line.
Conventions:

- Collections → JSON arrays; `[]` on empty (NOT "(no rows)").
- Single entities → JSON objects.
- Composite verbs (`task show`, `task tree`, `whoami`, mission control)
  emit a top-level object with documented keys.
- `task tree --json` carries diamond-collapse semantics: a re-visited
  node renders as `{ task, recurrence: true, children: [] }` instead
  of expanding twice.

```bash
mu task next -w auth --json | jq '.[0].localId'
mu task ready -w auth --json | jq '[.[] | select(.impact > 80)]'
mu task tree launch --json | jq '.. | .task? | .localId'
mu agent list -w auth --json | jq '.agents | length'
mu --json | jq '.ready | length'
mu whoami --json | jq .agent.name
```

bash + jq + `--json` covers every scriptable orchestration use case.

### Picking the spawned executable

mu is a pi orchestrator. The `--cli` flag exists primarily to swap
the pi binary itself. Resolution chain:

`--command <cmd>` flag > `$MU_<UPPER_CLI>_COMMAND` env var > the cli value itself.

If pi is installed under a different binary name, set
`MU_PI_COMMAND=<name>` once in your shell rc and every spawn
picks it up. Multi-word values work too (e.g.
`MU_PI_COMMAND="pi-alt --some-flag"`).

**Spawn liveness check.** After spawn, mu waits
`MU_SPAWN_LIVENESS_MS` (default 1500ms) and verifies the pane is
still alive. If the CLI died, the DB row rolls back. Set
`MU_SPAWN_LIVENESS_MS=0` to disable (CI / fast spawn).

### Picking model + thinking effort per agent

The zen of mu: **mu doesn't reason about models.** Pi already speaks
`--model sonnet:high` and `--thinking off|minimal|low|medium|high|xhigh`.
Mu has no tier abstraction, no provider matrix, no vendor mapping
on purpose — see [VISION.md § 10](../../docs/VISION.md#10-get-out-of-the-models-way).

Discover what model strings are valid via pi: `pi --list-models`
(takes an optional fuzzy-search arg, e.g. `pi --list-models opus`).

Three controls, smallest first:

```bash
# Per-spawn (one-off):
mu agent spawn reviewer-1 --command "pi --model opus:high"

# Shell default (short sessions):
export MU_PI_COMMAND="pi --model sonnet:medium"

# Operator-defined aliases (the underlying mechanism: --cli <key>
# uppercases the key and looks up $MU_<KEY>_COMMAND; the names
# below are convention, not built-in tiers):
export MU_PI_COMMAND="pi --model sonnet:medium"      # default for --cli pi
export MU_PI_MINI_COMMAND="pi --model haiku:off"     # → --cli pi_mini
export MU_PI_BIG_COMMAND="pi --model opus:high"      # → --cli pi_big
mu agent spawn worker-1   --cli pi_mini
mu agent spawn reviewer-1 --cli pi_big
```

Use underscores (`pi_big`, not `pi-big`) — env-var names need
valid shell identifiers.

**Suggested rubric** (just convention; mu doesn't enforce it):
mini for probing / fan-out; modest for build/edit/refactor; big
for design / review / incident / gnarly debugging. When ambiguous,
default to `MU_PI_COMMAND`.

### The reaper

When an agent's pane dies (or you `mu agent close` mid-task), any
IN_PROGRESS task it owned auto-reverts to OPEN with a `[reaper]` note
explaining what happened, plus a `task reap` event in `agent_logs`.
You don't have to manually `task release --reopen` after a crash.

### Known limitations

- **Status detection lags with custom `--command` wrappers.**
  Agents may show `needs_input` while actively running commands.
  Workaround: trust scrollback (`mu agent read`), task notes,
  and event log (`mu log --tail`) more than the status emoji for
  monitoring decisions. The 4-state heuristic is best-effort.
- **Workspace patch flow needs explicit apply.** Worker writes in
  isolated workspace → review → parity tests in workspace →
  manual apply to main → sanity test in main. Safer but more
  steps than "agent edits the live tree." Worth it for any patch
  that benefits from review; overkill for a one-line typo fix.
- **Orchestration overhead is real for tiny tasks.** Task create
  + claim + send + monitor + notes + close is ~6 verbs of
  ceremony. For a 5-minute one-file edit, direct work in main
  context is faster. See ["When to reach for mu"](#when-to-reach-for-mu)
  above.

## SQL escape hatch

`mu sql "<query>"` for anything not yet typed. Schema: 8 tables
(`workstreams`, `agents`, `tasks`, `task_edges`, `task_notes`,
`agent_logs`, `vcs_workspaces`, `approvals`) + 3 views (`ready`,
`blocked`, `goals`). Inspect with
`mu sql "SELECT name FROM sqlite_master WHERE type IN ('table','view')"`.

```bash
# Cross-agent join
mu sql "SELECT a.name, t.local_id, t.title
          FROM agents a JOIN tasks t ON t.owner = a.name
         WHERE a.status IN ('busy','needs_input')"

# Recursive CTE: every task that transitively blocks `launch`
mu sql "WITH RECURSIVE prereqs(node) AS (
          SELECT 'launch'
          UNION
          SELECT from_task FROM task_edges, prereqs WHERE to_task = prereqs.node
        ) SELECT * FROM prereqs"
```

## Common patterns

### Plan + spawn a crew (canonical example)

IDs auto-derive from titles via slugify; `--blocks` takes a comma
list of task IDs.

```bash
mu workstream init payments
mu task add -w payments --title "Design payments" --impact 70 --effort-days 1
mu task add -w payments --title "Build payments"  --impact 70 --effort-days 5 --blocks design_payments
mu task add -w payments --title "Review payments" --impact 60 --effort-days 1 --blocks build_payments

mu agent spawn worker-1   -w payments --workspace
mu agent spawn reviewer-1 -w payments --workspace --role read-only
mu -w payments                                    # mission control
```

### Pick the highest-ROI ready task for the next agent

```bash
NEXT=$(mu task next -w payments --json | jq -r '.[0].localId')
mu task claim "$NEXT" --for worker-1 \
  --evidence "selected as highest ROI from ready set"
mu agent send worker-1 "Working on $NEXT."
```

### Parallel heavy-task + read-only audit (canonical worked example)

Maps directly to the most common parallelisation shape: one agent
doing CPU-heavy work, a sibling doing safe read-only auditing.

```bash
# Heavy task: gets its own workspace because it'll build + benchmark.
mu agent spawn worker-1 -w perf --workspace
mu task claim profile_hotspot -w perf --for worker-1 \
  --evidence "only ready CPU-bound task"
mu agent send worker-1 'Run cargo bench --bench hotspot; capture flame graph.'

# Parallel read-only audit. No workspace needed (read-only role,
# no build/edit), but explicit instruction not to mutate.
mu agent spawn scout-1 -w perf --role read-only
mu task claim audit_retention -w perf --for scout-1 \
  --evidence "safe to parallelise; read-only audit task"
mu agent send scout-1 'Read-only audit. Do NOT build, test, or benchmark; just inspect docs/src and report findings via task notes.'
```

The role flag is the safety belt; the prompt repeats it for the
LLM's benefit. Together they prevent the read-only agent from
accidentally kicking off a parallel `cargo build` and trashing
`worker-1`'s timing.

### Quote command-rich prompts (avoid `$VAR` expanding in YOUR shell)

`$VAR`, `$(...)`, backticks, and `!history` in a double-quoted
prompt expand in YOUR shell before mu sees them. Single-quote (or
use a quoted heredoc) to defer expansion to the agent.

```bash
# Bad: $HOME and $(date) expand in YOUR shell.
mu agent send worker-1 "OUT=\"$HOME/foo-$(date)\" run_me"

# Good: single quotes — expansion deferred.
mu agent send worker-1 'OUT="$HOME/foo-$(date)" run_me'

# Good: quoted heredoc for multi-line + literal.
mu agent send worker-1 "$(cat <<'EOF'
for f in src/*.rs; do cargo check --manifest-path "$f"; done
EOF
)"
```

When in doubt, single-quote.

### Status is approximate; scrollback + log are authoritative

All status-reading verbs (`mu state`, `mu agent list`,
`mu agent show`) reconcile fresh from scrollback. But status is
a 4-state heuristic (`busy / needs_input / idle / done`) derived
from prompt shape — it can't tell you WHAT the agent is doing.
For the rich picture, combine three reads:

```bash
mu agent read worker-1 -n 100             # pane scrollback
mu log -w infer-rs --kind event --tail    # state-change stream
mu task notes <id>                        # decisions + grounding
```

With custom `--command` wrappers, heuristics may misclassify edge
cases. Trust scrollback + notes + log over
the status emoji for high-stakes calls.

### After spawning, observe — don't fire-and-forget

Orchestrator loop step 6 in operational form. Pick one of two
patterns; never bare `mu agent send` with no follow-up.

**Subscribe (react when state changes; zero polling cost):**

```bash
mu log -w infer-rs --kind event --tail | \
  awk '/task status .*CLOSED/ { print; system("...") }'
```

Every state-changing verb auto-emits a `kind='event'` row. Best
for "start the next worker when this blocker closes" or "escalate
when a task gets reaped."

**Poll (heartbeat narrative; transitions over time):**

```bash
last=""
while true; do
  cur=$(mu agent show worker-1 -w infer-rs --json | jq -r .agent.status)
  if [[ "$cur" != "$last" ]]; then
    echo "[$(date -Iseconds)] worker-1: $last → $cur"
    last="$cur"
  fi
  [[ "$cur" == "needs_input" || "$cur" == "done" ]] && break
  sleep 5
done
```

5–10s intervals are fine; faster adds tmux capture-pane load
without real-time benefit. Best for a running per-worker
narrative.

Anti-pattern: bare `mu agent send` with no follow-up. The worker
stalls in `needs_input` for hours; the operator finds out later.
The activity log is why mu doesn't need a daemon — it IS the
coordination channel; use it.

### Tear down a workstream

`mu workstream destroy` is two-phase by default. **Always run the
dry-run first** — there is no `mu undo`; recovery is restoring
`~/.local/state/mu/mu.db` from backup.

```bash
mu workstream destroy -w payments        # dry-run: counts
mu workstream destroy -w payments --yes  # commit
```

FK CASCADE handles the cleanup (agents, tasks, edges, notes,
workspaces, logs).

### Drop durable context on a task

Follow the [Task note contract](#task-note-contract). `\n` / `\t`
/ `\\` escapes are interpreted, so multi-field notes can land in
one call:

```bash
mu task note design_payments "FILES: src/auth.rs:45-120\nDECISION: JWT, 24h expiry\nVERIFIED: cargo test pass"
```

`task_notes.author` is auto-filled from `$TMUX_PANE` inside a pane,
NULL (treat as orchestrator) elsewhere.

## If you ARE the agent (in-pane patterns)

Verbs auto-resolve via `$TMUX_PANE` — `mu whoami`, `mu my-next`,
`mu task claim` all work without a name argument. Working loop:

```bash
# 1. Orient yourself
mu whoami                              # who am I, what workstream, what do I own?
mu state                               # what's the canonical picture right now?

# 2. Find work
mu my-next                             # top ready task by ROI in my workstream
mu task show <id>                      # row + edges + existing notes
mu task notes <id>                     # what previous agents recorded

# 3. Claim with grounding
mu task claim <id> --evidence "reviewed task + notes; have implementation plan"

# 4. Work; drop durable context as you go
mu task note <id> "FILES: src/auth.rs:45-120"
mu task note <id> "DECISION: chose JWT, 24h expiry, refresh via cookie"

# 5. Close with grounding
mu task close <id> --evidence "tests pass: npm test exit 0; diff posted as D12345"

# 6. Repeat from step 2
```

### When you need to do something irreversible

Gate it on a human approval. Don't `mu workstream destroy` or
`mu task delete` autonomously.

```bash
slug=$(mu approve add --reason "delete the abandoned 'design_v1' task" --json | jq -r .slug)
if mu approve wait "$slug" --timeout 600; then
  mu task delete design_v1
else
  echo "denied or timed out"; exit 1
fi
```

The `wait` exits 0 (granted) / 4 (denied) / 5 (timeout) for clean
shell control flow.

### When you need to wait for another agent to finish

Subscribe to events instead of polling `mu task ready` every 5s.

```bash
# Wait until 'design' closes, then start the next thing
mu log -w "$(mu whoami --json | jq -r .agent.workstream)" --kind event --tail | \
  awk '/task status design.*CLOSED/ { exit 0 }'
mu task claim build_auth --evidence "design closed at $(date -Iseconds)"
```

## DOs

- **Run `mu state -w <ws>` before every action** (claim, send,
  spawn). The state card is the single source of truth.
- **Add a task before assigning work.** "What is worker-1 doing?"
  is a graph query if there's a task, "I forget" otherwise.
- **Claim BEFORE sending.** Audit trail attributes the work
  cleanly; ownership is murky if you `send` first and the agent
  later closes a task it never claimed.
- **Read existing notes before claiming.** Previous agents may
  have left context that changes your approach.
- **Always pass `--evidence` on claim AND close.** "Tests pass:
  npm test exit 0" beats silence. Even on claim: "selected from
  ready set; reviewed task + notes."
- **Drop notes per the task note contract** (FILES / COMMANDS /
  FINDINGS / DECISION / NEXT / VERIFIED / ODDITIES). The DAG is
  only as useful as the notes attached to it.
- **Set `impact` and `effort_days` honestly.** They drive ROI
  ordering in the `ready` view.
- **Check parallel tracks before spawning.** Don't spawn more
  agents than independent ready tracks.
- **Use `--workspace` whenever the agent might edit, build, test,
  or generate artifacts** while another agent is active in the
  same repo. Default-on, not exception.
- **Single-quote prompts containing `$VAR`, `$(...)`, backticks.**
  Otherwise your shell expands them before mu sees them.
- **Subscribe via `mu log --tail` instead of polling.**
- **Use `--json` for scripting; `mu sql` for what the typed verbs
  don't cover.**
- **Prefer narrow, correct changes over broad rewrites.**
- **Run `mu doctor` if anything looks off.**

## DON'Ts

- **Don't fire-and-forget** after `mu agent send`. Use `mu log
  --tail` (subscribe) or poll `mu agent show` (heartbeat).
  Walking away is how workers stall in `needs_input` for hours
  unnoticed.
- **Don't trust the status emoji alone for high-stakes calls.**
  Especially with custom `--command` wrappers, heuristics can
  misclassify. Cross-check
  scrollback + task notes + event log.
- **Don't double-quote a `$VAR`-laden prompt.** Your shell expands
  it; the agent receives the empty string. Single-quote or use a
  quoted heredoc.
- **Don't bypass mu and edit the DB with `sqlite3` directly.**
  Use `mu sql` so the invocation goes through the same code path.
- **Don't spawn an agent without a workstream.** Pass `-w` or run
  inside the workstream's tmux session.
- **Don't anthropomorphize agent names.** `worker-1`, not `alice`.
- **Don't poll `mu agent read` in tight loops.** Each call is a
  tmux capture-pane; for state changes use `mu log --tail`
  instead.
- **Don't add tasks across workstreams.** Cross-workstream edges
  are rejected (`CrossWorkstreamEdgeError`). If B depends on A,
  model them as one workstream.
- **Don't `mu workstream destroy --yes` without the dry-run
  first.** No `mu undo`.
- **Don't name tasks with the `mu_` prefix.** Reserved for
  system-generated IDs.
- **Don't try to message agents directly.** Coordinate via task
  notes and the activity log; agents are peers, not chat partners.

## What mu is NOT

- Not a build tool. mu doesn't compile, test, or deploy code.
- Not a chat protocol — agent-to-agent comms is via task notes
  (durable, per-task) and the `mu log` activity channel (timeline).
- Not a replacement for `pi-subagents` — for one-shot focused
  delegation with synthesis, use `pi-subagents`. mu is for long-lived
  crews you keep talking to.

## See also

- `mu --help` and `mu <verb> --help` — canonical CLI reference (always
  trust `--help` over this skill if they disagree).
- `docs/USAGE_GUIDE.md` — worked examples for every verb.
- `CHANGELOG.md` — release notes.
- `docs/VOCABULARY.md` — canonical terms.
