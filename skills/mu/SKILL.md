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

One-liners only. Run `mu <verb> --help` for every flag, defaults,
and interactions — the CLI is the canonical reference. Every verb
below accepts `--json` for machine-readable output (one exception:
`mu agent attach`, which prints a tmux command for a human).
Every successful verb also prints a `Next:` block of suggested
follow-up commands; agents read it, humans skim past it.

```bash
# Workstream (3)
mu workstream init <name>            # create tmux session mu-<name> + DB row
mu workstream list                   # every workstream on this machine
mu workstream destroy [--yes]        # tear down (dry-run unless --yes)

# Agents (8)
mu agent spawn <name> [--workspace]  # spawn into mu-<workstream>
mu agent send <name> "text"          # bracketed-paste safe
mu agent read <name> [-n N]          # capture-pane scrollback
mu agent show <name> [-n N]          # registry row + last N lines
mu agent list                        # reconciled with tmux; surfaces orphans
mu agent close <name>                # kill pane + drop row (workspace untouched)
mu agent free <name>                 # status='free'; pane untouched
mu agent attach <name>               # print scrollback + tmux attach hint

# Registration (1) — the inverse of spawn
mu adopt <pane-id|pane-title>        # register an orphan pane as a managed agent

# Tasks (22)
mu task add [id] --title T --impact N --effort-days N [--blocked-by A,B]
mu task list [--status S]            # every task; --status filters
mu task next [-n K]                  # top-K ready tasks by ROI
mu task ready                        # all ready, sorted by ROI
mu task blocked                      # OPEN with non-CLOSED blockers
mu task goals                        # graph endpoints (no dependents)
mu task owned-by <agent>             # what is <agent> working on?
mu task search <pattern> [--all] [--in-notes]
mu task show <id>                    # row + edges + notes
mu task tree <id> [--down]           # ASCII blockers (or dependents)
mu task notes <id>                   # notes only, oldest first
mu task note <id> "text"             # append (\n / \t / \\ escapes work)
mu task claim <id> [--for <worker> | --self [--actor <name>]]
mu task release <id> [--reopen]      # clear owner; optionally flip OPEN
mu task close <id>                   # → CLOSED (idempotent)
mu task open <id>                    # → OPEN (idempotent)
mu task block <blocked> --by <blocker>     # cycle + workstream checked
mu task unblock <blocked> --by <blocker>
mu task update <id> [--title|--impact|--effort-days]
mu task reparent <id> --blocked-by A,B   # atomic edge replacement
mu task delete <id>                  # cascades to edges+notes; no undo

# Self-identification (3) — in-pane only
mu whoami                            # name + workstream + cli + owned tasks
mu my-tasks                          # alias for task owned-by <self>
mu my-next [-n K]                    # alias for task next -w <self.ws>

# Workspace (4) — per-agent VCS working copies
mu workspace create <agent> [--backend jj|sl|git|none] [--from REF]
mu workspace list [--all]
mu workspace free <agent> [--commit]
mu workspace path <agent>            # cd $(mu workspace path X)

# Activity log (1, overloaded)
mu log "text" [--as N] [--kind K]    # write
mu log [-n N] [--source X] [--kind X] [--since SEQ] [--all]
mu log --tail [--since SEQ]          # subscribe

# Approvals (5) — human-in-the-loop
mu approve add --reason "..." [--slug X]   # returns slug
mu approve list [--status S]
mu approve grant <slug>
mu approve deny  <slug>
mu approve wait  <slug> [--timeout SECONDS]   # exit 0 / 4 / 5

# Escape hatch + state + health
mu sql "<query>"                     # SELECT / UPDATE / DELETE / WITH
mu                                   # bare: quick mission control
mu state                             # canonical state card
mu doctor                            # tmux + db + schema + workstream stats
```

Universal flags worth knowing without `--help`:

- **`-w, --workstream <name>`** — explicit > `$MU_SESSION` > current
  tmux session minus `mu-` prefix > error. On verbs that take an
  entity by id, `-w` is a SCOPE check (errors with
  `*NotInWorkstreamError`); on verbs that pick which entity
  (`mu task next`, `mu agent list`), it picks WHICH.
- **`--evidence "<text>"`** — on `task close / open / claim /
  release`. Recorded verbatim in the auto-emitted event payload.
  Not validated; just preserved. Use for grounding ("tests pass:
  npm test exit 0").
- **`--json`** — on every verb. Success path emits one JSON object
  (or array for collection reads); errors emit
  `{ error, message, nextSteps, exitCode }` to stderr. No prose
  parsing required.

### Picking model + thinking effort per agent

The zen of mu: **mu doesn't reason about models.** Pi speaks
`--model sonnet:high` and `--thinking off|minimal|low|medium|high|xhigh`.
Mu has no tier abstraction, no provider matrix, no vendor mapping on
purpose (see [VISION.md § 10](../../docs/VISION.md#10-get-out-of-the-models-way)).

Three controls, smallest first:

- **Per-spawn**: `mu agent spawn r --command "pi --model opus:high"`
- **Shell default**: `export MU_PI_COMMAND="pi --model sonnet:medium"`
- **Operator aliases**: any `--cli <key>` uppercases to
  `$MU_<KEY>_COMMAND` (use underscores; env-var names). Convention
  for tiers: `pi_mini` / `pi` / `pi_big`. Mu doesn't enforce these.

**Rubric (convention)**: mini for probing/fan-out; modest for
build/edit/refactor; big for design/review/incident/gnarly
debugging. When ambiguous, default to `MU_PI_COMMAND`. Discover
valid model strings: `pi --list-models [fuzzy-search]`.

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

`mu sql "<query>"` for anything not yet typed. Schema: 9 tables
(`workstreams`, `agents`, `tasks`, `task_edges`, `task_notes`,
`agent_logs`, `vcs_workspaces`, `approvals`, `schema_version`) +
3 views (`ready`, `blocked`, `goals`). Inspect with
`mu sql "SELECT name FROM sqlite_master WHERE type IN ('table','view')"`
or `mu doctor --json | jq .db.schema`.

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

# Rename a workstream (typo recovery). Every FK has ON UPDATE CASCADE
# so children (agents, tasks, agent_logs, vcs_workspaces, approvals)
# follow the rename atomically. Run `tmux rename-session -t mu-<old>
# mu-<new>` afterwards if the tmux session is alive.
mu sql "UPDATE workstreams SET name='auth-refactor' WHERE name='auth-refator'"
```

## Common patterns

For each pattern below, the verbs themselves emit a `Next:` block
on success that lists the natural follow-ups. The patterns here are
the **multi-verb composites** that no single verb's hint can show.

### Plan + spawn a crew

IDs auto-derive from titles via slugify; `--blocked-by` takes a
comma list of task IDs that block the new one.

```bash
mu workstream init payments
mu task add -w payments --title "Design payments" --impact 70 --effort-days 1
mu task add -w payments --title "Build payments"  --impact 70 --effort-days 5 --blocked-by design_payments
mu task add -w payments --title "Review payments" --impact 60 --effort-days 1 --blocked-by build_payments
mu agent spawn worker-1   -w payments --workspace
mu agent spawn reviewer-1 -w payments --workspace --role read-only
mu -w payments    # mission control
```

### Pick the highest-ROI ready task for the next agent

```bash
NEXT=$(mu task next -w payments --json | jq -r '.[0].localId')
mu task claim "$NEXT" --for worker-1 --evidence "highest ROI from ready set"
mu agent send worker-1 "Working on $NEXT."
```

### Parallel heavy-task + read-only audit

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

### Tear down a workstream (no undo)

`mu workstream destroy` is two-phase: dry-run by default, `--yes`
to commit. There is no `mu undo`; back up `~/.local/state/mu/mu.db`
before high-stakes destructions. FK CASCADE handles cleanup
(agents, tasks, edges, notes, workspaces, logs).

## If you ARE the agent (in-pane patterns)

Verbs auto-resolve via `$TMUX_PANE` — `mu whoami`, `mu my-next`,
`mu task claim` all work without a name argument. The pane title
(set at spawn) IS the agent identity.

There are two patterns:

- **Worker** — your pane was created by `mu agent spawn` (or
  promoted via `mu adopt`). Has a row in `agents`. Bare
  `mu task claim <id>` Just Works.
- **Orchestrator** — a top-level pi session NOT in `agents`
  (e.g. running mu from a host shell to coordinate workers). Bare
  `mu task claim` errors with `ClaimerNotRegisteredError` whose
  `errorNextSteps()` lists three options: `--self` (work directly,
  owner=NULL, actor in log), `--for <worker>` (dispatch), or
  `mu adopt <pane>` (promote pane to worker; pane must be in
  `mu-<ws>` tmux session).

Working loop (worker path):

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
