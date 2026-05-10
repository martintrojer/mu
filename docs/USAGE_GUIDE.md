# mu — Usage Guide

A practical, copy-pasteable tour of mu (current main; v0.2-track).
Everything below works against the built CLI. Terms are canonical
— see [VOCABULARY.md](VOCABULARY.md) for definitions; the complete
current verb list is in `## CLI — complete verb list` of
[skills/mu/SKILL.md](../skills/mu/SKILL.md).

> **Status:** v0.2 wave (pre-1.0). ~60 typed verbs across 7
> namespaces, every verb accepts `--json` (one allow-listed
> exception, `mu agent attach`), per-agent VCS workspaces
> (jj/sl/git/none), activity log with `--tail` subscription,
> canonical state card (`mu state`), `mu hud` (dynamic table
> layout), human-in-the-loop approvals (`mu approve`), whole-DB
> snapshots auto-captured before destructive verbs +
> `mu undo` / `mu snapshot {list,show}`, evidence on lifecycle
> verbs, schema v5 (surrogate INTEGER PKs; per-workstream UNIQUE
> on operator-facing names). See [CHANGELOG.md](../CHANGELOG.md)
> for the release entry, and
> [§ Not in 0.2.0](#whats-not-in-020-and-how-to-work-around-it)
> at the bottom for the gaps that still need workarounds.

*If anything below disagrees with `mu --help`, trust `mu --help`.*

---

## Table of contents

1. [Setup](#1-setup)
2. [Get oriented (`mu doctor`)](#2-get-oriented)
3. [Create a workstream (`mu workstream init`)](#3-create-a-workstream)
4. [Plan some work as a DAG (`mu task add`)](#4-plan-some-work-as-a-dag)
5. [See the graph (mission control)](#5-see-the-graph-mission-control)
6. [Spawn a crew (`mu agent spawn`)](#6-spawn-a-crew)
7. [Watch the crew live (`tmux attach`)](#7-watch-the-crew-live)
8. [Send work to an agent (`mu agent send`)](#8-send-work-to-an-agent)
9. [Read what an agent did (`mu agent read`)](#9-read-what-an-agent-did)
10. [The claim protocol from inside a pane (`mu task claim`)](#10-the-claim-protocol--from-inside-an-agents-pane)
11. [Drop notes (durable context) (`mu task note`)](#11-drop-notes-durable-context)
12. [Close out a task](#12-close-out-a-task)
13. [The SQL escape hatch (`mu sql`)](#13-the-sql-escape-hatch-is-your-friend)
14. [Recovery scenarios](#14-recovery-scenarios)
15. [Cleanup](#15-cleanup)
15.5. [Archives — cross-workstream preservation](#155-archives--cross-workstream-preservation-of-task-graphs)
16. [One-shot demo script](#16-one-shot-demo-script)
17. [Mental model in three sentences](#mental-model-in-three-sentences)
18. [What's NOT in 0.2.0](#whats-not-in-020-and-how-to-work-around-it)
19. [Where to go from here](#where-to-go-from-here)

---

## 1. Setup

mu isn't published to npm yet. From inside your local checkout of
the repo:

```bash
npm install -g .         # `prepare` script auto-builds; `mu` lands on $PATH
mu --version             # → the current version (see package.json)
```

To update later: pull from upstream, then `npm install -g .` from
inside the checkout. The `prepare` script rebuilds before linking
the new dist/.

### Install the bundled skill

Mu ships a skill at `skills/mu/SKILL.md` that teaches the LLM
running inside an agent pane how to use mu (the in-pane working
loop, the approve-before-destructive pattern, the subscribe-vs-poll
pattern, the verb-list reference). Pi auto-loads skills from
`~/.agents/skills/<name>/SKILL.md` (cross-tool global location)
and `~/.pi/agent/skills/<name>/SKILL.md` (pi-specific). Either
works.

From inside the checkout:

```bash
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/mu" ~/.agents/skills/mu
# Resolves to ~/.agents/skills/mu/SKILL.md — exactly the layout
# pi expects. `git pull` keeps it in sync.
```

If you'd rather copy than symlink (e.g. you don't want the
checkout on a long-lived path), `cp -r skills/mu
~/.agents/skills/` produces the same final layout — you'll
just need to re-copy after each update.

### For mu hackers: alias to the build output

If you're hacking on mu itself and want fastest iteration, alias
directly to the build output instead:

```bash
npm install              # deps only
npm run build            # produces dist/
alias mu="node $PWD/dist/cli.js"
```

See [README.md § Install](../README.md#install) for the full set of
install patterns.

mu requires tmux ≥ 3.0. Make sure you're inside a tmux session before
proceeding:

```bash
tmux       # if you're not already in one
```

---

## 2. Get oriented

```bash
mu doctor
```

Expected output:

```
mu doctor
  tmux: ok (tmux 3.6a)
  $TMUX: set
  db: ok (/Users/you/.mu/mu.db)
  workstream: none (pass --workstream or run inside an mu-<name> tmux session)
```

The "workstream: none" line is expected — we haven't joined one yet.

Get the full command list:

```bash
mu --help
```

Every verb's `--help` is exhaustive (flags, defaults,
interactions). Every successful invocation also prints a dim
`Next:` block of suggested follow-up commands at the bottom —
you never have to leave the terminal to learn what to do next.

Every verb accepts `--json` for machine-readable output. Errors
in `--json` mode emit a `{ error, message, nextSteps, exitCode }`
record to stderr; the `nextSteps` array carries actionable
resolutions you can `eval` directly. (One verb opts out:
`mu agent attach`, which prints a `tmux attach` command for a
human to copy.)

### CLI conventions: multi-value flags

Multi-value flags accept either repeated invocations
(`--blocked-by a --blocked-by b`) or a comma-separated value
(`--blocked-by a,b`) or any mix (`--blocked-by a,b --blocked-by c`).
All three forms collapse to the same list internally. The
syntactic signal is `<value...>` in the help-text metavar (the
triple-dot); the parenthetical "repeat or comma-separate; or both"
reinforces it. Variadic positionals (e.g. `mu task wait a b c`) keep
their Unix-style space-separated shape — operands are not commas.
Single-valued flags (`-w`, `--by`, `--status`, `--title`, ...) stay
single.

---

## 3. Create a workstream

A **workstream** is mu's unit of organization. One workstream = one
tmux session = one logical project. Multiple workstreams on the same
machine are isolated (partitioned in the SQLite registry by
`session_id`); they never see each other's agents.

```bash
mu workstream init auth-refactor
```

```
Created workstream auth-refactor (tmux session mu-auth-refactor)
  Attach with: tmux a -t mu-auth-refactor
  Spawn agents with: mu agent spawn <name> -w auth-refactor
```

Behind the scenes: `tmux new-session -d -s mu-auth-refactor` plus a
placeholder window so the session is non-empty. The session sits there
detached, waiting for agents.

To see what's already on the machine before picking a name:

```bash
mu workstream list
```

```
┌──────┬───────┬────────┬───────┬───────┬───────┐
│ name │ tmux  │ agents │ tasks │ edges │ notes │
├──────┼───────┼────────┼───────┼───────┼───────┤
│ r6a  │ alive │ 0      │ 2     │ 1     │ 1     │
│ r6b  │ —     │ 0      │ 0     │ 0     │ 0     │
└──────┴───────┴────────┴───────┴───────┴───────┘
```

The list is the **union** of three sources: distinct
`agents.workstream`, distinct `tasks.workstream`, and tmux sessions
matching `mu-*`. So a freshly-`init`'d workstream with no tasks/agents
still shows up (via its tmux session), and a workstream whose tmux
session was killed externally still shows up (via its surviving DB
rows) so you can `mu workstream destroy` to clean up properly.

### How mu finds your active workstream

Every command after `init` needs to know which workstream you're in.
Resolution order, first match wins:

1. **`--workstream <name>` flag** explicitly
2. **`MU_SESSION` env var** (`export MU_SESSION=auth-refactor`)
3. **Current tmux session name** (mu reads `tmux display-message -p '#S'` and strips the `mu-` prefix)
4. Error if none of the above

The third option is the most ergonomic. Once you `tmux a -t
mu-auth-refactor`, every command "just works" without flags.

---

## 4. Plan some work as a DAG

Tasks have **mandatory** `impact` (1–100) and `effort-days` (>0).
Edges are blocks-relationships, modelled as **`--blocked-by`** on `mu
task add` (and `mu task reparent`): `--blocked-by design` means "this
task is blocked by `design`; it can't start until `design` closes."
Tasks are **scoped to a workstream** — mission control only shows
tasks for the workstream you're in.

```bash
# --workstream can be omitted if you're inside the workstream's tmux
# session or have $MU_SESSION exported.
mu task add design \
  --workstream auth-refactor \
  --title "Design auth module" \
  --impact 80 --effort-days 2

mu task add build \
  --workstream auth-refactor \
  --title "Build auth module" \
  --impact 80 --effort-days 5 \
  --blocked-by design

mu task add review \
  --workstream auth-refactor \
  --title "Review auth module" \
  --impact 60 --effort-days 1 \
  --blocked-by build
```

Each task validates its id (`/^[a-z][a-z0-9_-]{0,63}$/`) and rejects
duplicates. If you tried `mu task add x --blocked-by y` while `y`
already transitively depended on `x`, mu would refuse with a `CycleError`.

**Task ids are globally unique** (PRIMARY KEY across all workstreams)
but tasks are scoped to one workstream. Cross-workstream blocks-edges
are forbidden — if `--blocks foo` resolves to a task in a different
workstream, mu refuses with a `CrossWorkstreamEdgeError`.

---

## 5. See the graph (mission control)

```bash
mu --workstream auth-refactor
# or, if your tmux session is mu-auth-refactor:
mu
```

```
mu-auth-refactor

Agents (0)
  (no agents)

Tracks (1)
  Track 1: review (3 tasks, 1 ready, track)

Ready (1)
┌────────┬─────────────────────┬────────┬────────┬──────┬───────┐
│ id     │ title               │ impact │ effort │ ROI  │ owner │
├────────┼─────────────────────┼────────┼────────┼──────┼───────┤
│ design │ Design auth module  │ 80     │ 2      │ 40.0 │       │
└────────┴─────────────────────┴────────┴────────┴──────┴───────┘
```

This is the answer to **"what should I work on next?"** without
asking an LLM. Three sections:

- **Agents** — registry rows, status detected from each pane's
  scrollback, post-reconciliation
- **Tracks** — independent subtrees the parallel-track union-find
  found. When two goals share a prerequisite, mu collapses them into
  ONE track ("merged") so two agents are never assigned tasks that
  share a dependency
- **Ready** — actionable now, sorted by ROI (impact / effort)

### `mu hud` for a print-once status card (single OR multi-workstream)

`mu hud` is the print-once-and-compose sibling of `mu state`: a
dynamic table layout that fills the terminal (or tmux pane) height
+ width with as much useful data as fits. `watch -n 5 mu hud -w X`
for a refreshing pane; `tmux display-popup -E 'mu hud -w X'` for
an on-demand popup; `#(mu hud -w X --json) | jq ...` for tmux
status-bar interpolation.

Multi-workstream: `--workstreams a,b,c` (or `--workstreams a
--workstreams b`, or any mix — see [CLI conventions](#cli-conventions-multi-value-flags)) renders
N workstreams in one card, with one summary row per workstream and
a leading `workstream` column on every section table. `--all`
collapses to "every workstream on this machine". Single-mode
(`mu hud -w X`, or anything that resolves to one workstream — the
common case) is unchanged byte-for-byte; the JSON shape only
switches to `{ workstreams: [...] }` when N≥2 so existing tmux
status-bar pipes don't break on upgrade.

---

## 6. Spawn a crew

For a real demo with status detection, spawn pi agents:

```bash
mu agent spawn worker-1 --workstream auth-refactor          # default --cli is pi
```

To play around without needing pi installed, use `--cli sh`:

```bash
mu agent spawn worker-1 --workstream auth-refactor --cli sh
mu agent spawn worker-2   --workstream auth-refactor --cli sh
```

```
Spawned worker-1 (sh) in window worker-1 of mu-auth-refactor, pane %15
```

What just happened:

1. mu checked the agents table — no `worker-1` yet, OK to proceed
2. mu created a tmux window named `worker-1` in the `mu-auth-refactor`
   session
3. mu set the pane title to `worker-1` via `tmux select-pane -T worker-1`
   — **this is the claim protocol identity**
4. mu inserted a row in `agents` with `pane_id=%15`, `status=spawning`

If the DB insert fails after the pane was created, mu kills the pane
to avoid leaking. If the same name was already taken, mu rejects
**before** calling tmux.

### Multiple agents in one window (split panes)

Give them a shared `--tab`:

```bash
mu agent spawn reviewer-1 --workstream auth-refactor --cli sh --tab Review --role read-only
mu agent spawn audit --workstream auth-refactor --cli sh --tab Review
```

The `Review` window holds whichever agents share `--tab Review`.

### Spawn options

| Flag                         | Meaning                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `--cli <name>`               | Logical CLI family (effectively always `pi`; the flag exists as a key for `MU_<UPPER_CLI>_COMMAND` resolution) |
| `--command <cmd>`            | Executable launched in the pane. Defaults to `$MU_<UPPER_CLI>_COMMAND` (e.g. `MU_PI_COMMAND=pi-alt`) and finally to the `--cli` value |
| `--tab <name>`               | Group with other agents under this window name          |
| `--role <full-access\|read-only>` | Capability flag; stored but not yet enforced |
| `--cwd <path>`               | Initial working directory for the pane                  |
| `-w, --workstream <name>`    | Required if not auto-detectable                         |

On systems where the local `pi` binary is installed under a different
name, set `MU_PI_COMMAND=<name>` once in your shell rc and every
`mu agent spawn --cli pi` will exec the right binary; reconcile
also treats that binary's panes as agent-worthy when surfacing orphans.

`MU_PI_COMMAND` (and `--command`) accept a multi-word string — tmux
exec's it via a shell, so embedded flags survive intact. If your pi
build needs extra flags (e.g. to skip a single-instance lock), set
`MU_PI_COMMAND="pi-alt --some-flag"` and every spawn picks them up.
Same pattern for `MU_CLAUDE_COMMAND` / `MU_CODEX_COMMAND` once those
land.

### Adopt an existing tmux pane

Not every agent gets born via `mu agent spawn`. Sometimes you
launched a `pi` (or `claude`, or `codex`) by hand for a one-off
task, decided mid-flow it deserves to be in the graph, and now
want to drive it via `mu`. Or `mu` crashed mid-spawn and left an
orphan pane with no DB row. Either way:

```bash
mu agent list -w auth-refactor   # surfaces orphans at the bottom
# Orphan panes (1)
#   %15 title=worker-2 cli=pi

mu adopt %15 -w auth-refactor                    # adopt by pane id
mu adopt worker-2 -w auth-refactor               # adopt by pane title (same effect)
mu adopt %15 --name investigator -w auth-refactor  # adopt and rename the pane
```

The pane title becomes the agent name (`mu`'s claim protocol
invariant), so adopting a pane titled `worker-2` registers it as
agent `worker-2` with no further config. Use `--name` when the
pane's current title isn't a valid agent name (or when you want a
different name).

Adopt is **idempotent**: running it twice on the same pane is a
no-op. It's also **scope-aware**: the pane must be in the
`mu-<workstream>` tmux session, otherwise the adopt is rejected
(no silent cross-session moves).

---

## 7. Watch the crew live

The killer property: you can attach the workstream's tmux session and
see everything.

```bash
tmux attach -t mu-auth-refactor
```

You see one tmux window per agent (or a window with split panes if
they share a `--tab`).

| Tmux key       | What it does                                  |
| -------------- | --------------------------------------------- |
| `Ctrl+b w`     | Pick a window (interactive list)              |
| `Ctrl+b n`/`p` | Cycle next/previous window                    |
| `Ctrl+b d`     | Detach from the session (mu doesn't care)     |

mu does not require you to be attached. Detach freely.

---

## 8. Send work to an agent

From any shell with mu on `$PATH`:

```bash
mu agent send worker-1 "echo hello from outside"
```

mu uses the **canonical bracketed-paste protocol** internally:

1. `tmux copy-mode -q` (silent if not in copy mode)
2. `tmux set-buffer` (loads text into a uniquely-named buffer)
3. `tmux paste-buffer -p -d -r` (`-p` = bracketed paste, `-d` = delete
   buffer after paste, `-r` = preserve LF)
4. wait `MU_SEND_DELAY_MS` ms (default 500)
5. `tmux send-keys Enter`

This means special characters (`/`, `?`, `!`, `$`, `&&`, `|`, `*`,
…) arrive at the agent's CLI **literally** — not interpreted by tmux's
copy-mode or by the agent's TUI shortcuts. Naive `tmux send-keys`
would let the agent's TUI hijack `/` for "search forward" and similar.

The send delay is configurable per call:

```bash
MU_SEND_DELAY_MS=300 mu agent send worker-1 "..."     # faster, less safe
MU_SEND_DELAY_MS=1000 mu agent send worker-1 "..."    # slow remote
```

---

## 9. Read what an agent did

```bash
mu agent read worker-1              # full scrollback
mu agent read worker-1 -n 50        # last 50 lines
```

Both go through `tmux capture-pane`. No state change.

---

## 10. The claim protocol — from inside an agent's pane

This is where mu's design really shines. An agent (the LLM running in
a pane) can run `mu task claim foo` **with no agent name argument** — mu
figures out it's "worker-1" from the pane title.

To try this manually, attach to the workstream and switch to worker-1's
window:

```bash
tmux attach -t mu-auth-refactor       # if not attached
# Ctrl+b w, pick "worker-1" interactively
```

Then in worker-1's pane (a real shell, since `--cli sh`):

```bash
mu task claim design
```

```
Claimed design for worker-1 (OPEN → IN_PROGRESS)
```

What happened behind the scenes:

1. mu reads `$TMUX_PANE` (set by tmux for every pane in the session)
   to get the pane id (e.g. `%15`)
2. Calls `tmux display-message -t %15 -p '#{pane_title}'` → returns
   `worker-1`
3. Atomic SQLite transaction:
   ```sql
   UPDATE tasks
      SET owner = 'worker-1',
          status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
          updated_at = ?
    WHERE local_id = 'design'
      AND (owner IS NULL OR owner = 'worker-1')
   ```
4. If 0 rows changed, mu distinguishes "task doesn't exist" from
   "already owned by someone else" and throws the right typed error

Two agents trying to claim the same task → second one fails with
"already owned by worker-1." Re-claim by the same agent is idempotent.

You can also claim explicitly from outside any pane:

```bash
mu task claim build --for worker-2
```

### The orchestrator pattern: `--self`

Not every action comes from a registered worker pane. Often the
*orchestrator* (a top-level pi session, a human at a shell, a
deploy script) wants to do small work directly without spinning up
a worker pane just for a 5-minute job. Two patterns split here:

- **Worker** — a pane mu spawned (or you adopted). Has a row in the
  `agents` table. Identity = pane title. Claims with bare
  `mu task claim <id>`. `tasks.owner` is set to the worker's name.

- **Actor** — anything that *causes* a state change. Includes
  workers, but also includes the orchestrator. May or may not have
  a row in `agents`. The actor is *always* recorded in the
  auto-emitted `agent_logs` event for every state change
  (the `source` field).

If the orchestrator tries `mu task claim some-task` directly:

```
conflict: claimer 'pi-mu' (pane %6441) is not a registered mu agent.
  Working directly?           Pass --self to attribute via log instead.
  Dispatching to a worker?    Pass --for <worker> to assign.
  Want full registration?     Run: mu adopt %6441
```

Three actionable next steps. Pick one based on intent:

```bash
# Orchestrator does the work itself (most common):
mu task claim some-task --self --evidence "trivial 5-line fix"
#   -> tasks.owner stays NULL
#   -> agent_logs records 'task claim some-task by pi-mu --self (anonymous)'
#   -> mu task show surfaces it as 'owner: (self: pi-mu)'

# Orchestrator dispatches to a worker:
mu task claim some-task --for worker-1
#   -> tasks.owner = 'worker-1'

# Orchestrator wants to BE a registered worker (rare):
mu adopt %6441 -w <ws>      # only if pane is in mu-<ws> session
mu task claim some-task     # now works as a normal worker claim
```

`--self` is **only** for unregistered actors. Workers continue to
claim with bare `mu task claim` — nothing changes for them. The
`--actor <name>` flag overrides the auto-detected actor name (defaults
to pane title, or `$USER`, or `unknown`):

```bash
mu task claim deploy --self --actor deploy-bot --evidence "prod release"
```

When `tasks.owner IS NULL` because of `--self`, `mu task show` looks
up the most recent `task claim` event for that task and surfaces it:

```
owner      : (self: pi-mu)
```

So provenance is preserved — it just lives in `agent_logs` rather
than being conflated with the FK that points at registered workers.

---

## 11. Drop notes (durable context)

Notes are append-only. They survive across sessions and across agent
restarts. This is the cure for LLM context loss: when the next agent
picks up a task, they can read the full history.

```bash
mu task note design "DECISION: JWT, 24h expiry, refresh via cookie"
mu task note design "FILES: src/auth.rs:45-120"
```

Read them via the SQL escape hatch:

```bash
mu sql "SELECT author, content, created_at FROM task_notes WHERE task_id='design' ORDER BY id"
```

Convention for note content: `KEY: value` lines. Common keys are
`FILES`, `DECISION`, `VERIFIED`, `BLOCKED`, `NEXT`. Mu doesn't
enforce these — they're for the agents reading them.

---

## 12. Close out a task

```bash
mu task close design                # OPEN/IN_PROGRESS → CLOSED
mu task open design                 # CLOSED → OPEN (e.g. closed by mistake)
```

Both are idempotent (closing an already-CLOSED task prints a no-op
message and exits 0). Owner is intentionally left intact — use
`mu task release <id>` to clear ownership when an agent bails on a
task mid-flight (optionally with `--reopen` to also flip status back
to OPEN, the canonical "hand it back to the pool" workflow):

```bash
mu task release design              # clear owner; status preserved
mu task release design --reopen     # clear owner AND flip back to OPEN
```

Now run `mu` again — `build` has become ready (its only blocker
`design` is now closed):

```
Ready (1)
┌───────┬──────────────────┬────────┬────────┬──────┬───────┐
│ id    │ title            │ impact │ effort │ ROI  │ owner │
├───────┼──────────────────┼────────┼────────┼──────┼───────┤
│ build │ Build auth module│ 80     │ 5      │ 16.0 │       │
└───────┴──────────────────┴────────┴────────┴──────┴───────┘
```

---

## 13. The SQL escape hatch is your friend

Most routine operations have a typed verb — prefer those (and prefer
`--json` for scripting). `mu sql` is for the rare cases the typed
verbs don't cover: ad-hoc joins, manual recovery, exploring schema.
The schema is six tables (`workstreams`, `agents`, `tasks`,
`task_edges`, `task_notes`, `agent_logs`, `vcs_workspaces`) plus three
views (`ready`, `blocked`, `goals`):

```bash
mu sql "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name"
```

### Prefer the typed verb where one exists

| Want                                                  | Typed verb                              |
| ----------------------------------------------------- | --------------------------------------- |
| Tasks owned by an agent (current workstream)          | `mu task owned-by <agent> [--json]`     |
| Tasks owned by ANY same-named worker (all workstreams)| `mu task owned-by <agent> --all [--json]`|
| Highest-ROI ready task                                | `mu task next [-w] [-n K] [--json]`     |
| What did I touch most recently / what's stale         | `mu task list --sort recency` / `--sort age` |
| Visualise what blocks what                            | `mu task tree <id> [--json]`            |
| Show row + edges + notes                              | `mu task show <id> [--json]`            |
| Delete + cascade edges/notes                          | `mu task delete <id>`                   |
| Add / remove a single edge                            | `mu task block` / `mu task unblock`     |
| Replace all blockers atomically                       | `mu task reparent <id> --blocked-by ...`    |
| Modify scalar fields                                  | `mu task update <id> [--title ...]`     |
| Read the activity log / subscribe to events           | `mu log [--tail] [--kind event]`        |
| Block until tasks reach a status (orchestrator wait)  | `mu task wait <id> [<id>...] [--any] [--timeout S]` |

### Common ad-hoc queries

```bash
# Set task to IN_PROGRESS without claiming (claim does this automatically;
# this covers the rare manual case)
mu sql "UPDATE tasks SET status='IN_PROGRESS' WHERE local_id='build'"

# What's blocking what (open tasks only) — same data as `mu task tree`
# but as a flat join when you want a wider report
mu sql "SELECT b.local_id AS blocked, t.local_id AS by_task
        FROM tasks b
        JOIN task_edges e ON e.to_task = b.local_id
        JOIN tasks t ON t.local_id = e.from_task
        WHERE t.status != 'CLOSED' AND b.status = 'OPEN'"

# Recursive CTE: every task that transitively blocks `launch`
# (or use `mu task tree launch --json` for the same data structured)
mu sql "WITH RECURSIVE prereqs(node) AS (
          SELECT 'launch'
          UNION
          SELECT from_task FROM task_edges, prereqs WHERE to_task = prereqs.node
        )
        SELECT * FROM prereqs"
```

`mu sql` accepts both reads and writes. Reads are pretty-printed as a
table; writes report `<n> rows affected`.

---

## 14. Recovery scenarios

### An agent's pane dies externally

You killed it from another tmux client, or its CLI crashed:

```bash
mu agent list             # worker-1's row prunes itself (ghost detected)
```

Reconciliation runs on every `mu agent list` / `mu`. Three steps:

1. **Prune ghost rows** — DB row whose `pane_id` no longer exists in
   tmux gets deleted
2. **Detect status from scrollback** — for survivors, capture the
   pane and re-derive status (busy / needs_input / needs_permission /
   spawning) per the pi-status detector
3. **Surface orphan panes** — panes in the workstream's tmux session
   whose `pane.command` looks like an agent CLI (pi) but
   that aren't in the registry. **Not** auto-adopted; mu shows them
   under "Orphan panes" and tells you `mu adopt <pane-id>` to register

### You closed your terminal session

The workstream's tmux session keeps running detached. Reconnect with
`tmux a -t mu-auth-refactor`. Agents are alive; the DB has the
registry; everything resumes. mu is daemon-free — every `mu`
invocation is a short-lived process that re-reads from
`~/.local/state/mu/mu.db`.

### The mu DB seems wrong

```bash
sqlite3 ~/.local/state/mu/mu.db .schema     # inspect
sqlite3 ~/.local/state/mu/mu.db .tables     # list
mu doctor                       # quick health check
rm ~/.local/state/mu/mu.db                  # nuke (last resort; loses task graph and registry)
```

### You ran a destructive verb and want to undo it

Every destructive verb (`mu task delete`, `mu workstream destroy
--yes`, `mu task close/reject/defer/release`, `mu agent close`,
`mu workspace free`, `mu approve grant/deny`) auto-captures a
whole-DB snapshot before it mutates. Restore the latest with
`mu undo`:

```bash
mu undo                # dry-run: shows the snapshot summary, does NOT restore
mu undo --yes          # commit the restore
mu undo --to 12 --yes  # restore a specific snapshot id

mu snapshot list       # newest-first, with id / label / workstream / size
mu snapshot show 12    # full metadata for one snapshot
```

Two important caveats:

- **Tmux state is NOT rolled back.** A snapshot is a copy of
  `mu.db` only. After restore, mu reconciles every workstream and
  reports `agents pruned` (DB row → dead pane) and `orphan panes
  surfaced` (live pane the restored DB doesn't know about) so you
  can see exactly where DB and tmux disagree. On-disk workspace
  dirs that `mu workspace free` removed are NOT recreated either.
- **Each restore captures a pre-restore snapshot first.** That
  means a second `mu undo` rolls forward to the snapshot taken
  just before the previous restore — there is no separate
  `mu redo`, and there doesn't need to be.

Snapshots live next to the live DB at
`<state-dir>/snapshots/<id>.db`. They GC opportunistically:
older than 14 days OR more than 100 rows, whichever cap is hit
first, on every capture.

### Workspace orphans (dirs on disk with no DB row)

A `--workspace` spawn that aborted partway, an `mu agent close`
from an earlier mu version, or a manual `rm` of `vcs_workspaces`
rows can leave dirs in `<state-dir>/workspaces/<workstream>/<agent>/`
that have no DB row. They're invisible to `mu workspace list` but
they BLOCK subsequent `--workspace` spawns under the same name.

```bash
mu state -w <workstream>          # 'Workspace orphans' section in yellow
mu workspace orphans -w <workstream>   # focused list + cleanup recipe
```

For each orphan, the cleanup is one of:

```bash
# git-backed workspace: also prunes the worktree registry
(cd <project-root> && git worktree remove --force <orphan-path>)

# any backend (last resort)
rm -rf <orphan-path>
```

The `Next:` block from `mu workspace orphans` interpolates the
actual paths so you can copy-paste.

### You typo'd a workstream name and want to rename it

The `workstreams.name` column has `ON UPDATE CASCADE` on every
child-table foreign key, so renaming a workstream is a single SQL
statement that propagates atomically through `agents`, `tasks`,
`agent_logs`, `vcs_workspaces`, and `approvals`:

```bash
# 1. Validate the new name fits the rules (or mu will reject it on
#    next use). Lowercase alpha first, then alnum/_/-, ≤32 chars,
#    no '.' or ':' (tmux mangles them), no 'mu-' prefix.
# 2. Rename in the DB. Single statement; cascades to every child.
mu sql "UPDATE workstreams SET name='auth-refactor' WHERE name='auth-refator'"

# 3. Rename the tmux session too (only if it's currently alive).
tmux rename-session -t mu-auth-refator mu-auth-refactor
```

Mu doesn't ship a typed `mu workstream rename` verb because the
schema does the work — wrapping a single safe statement adds
surface area without buying anything (no atomicity to preserve, no
validation to add, no side effects beyond the optional `tmux
rename-session`). The recipe above is the canonical answer.

The same `ON UPDATE CASCADE` makes future `mu sql` renames safe
for `tasks.local_id` and `agents.name` too, if you ever need to
untypo those.

---

## 15. Cleanup

### Close individual agents

```bash
mu agent close worker-1          # kills pane + drops registry row
mu agent close worker-2
mu agent close reviewer-1
```

`mu agent close` is idempotent: `killPane` swallows "pane already gone"
errors; `deleteAgent` returns false (not throws) on a missing row.

### Tear down the whole workstream

`mu workstream destroy` is the symmetric counterpart of `mu workstream init`: it kills the
workstream's tmux session AND deletes every DB row tagged with the
workstream name (agents, tasks, edges, notes — edges and notes go via
FK cascade on tasks). The workstream resolves the same way as every
other verb: `--workstream <name>` flag > `$MU_SESSION` > current tmux
session (with the `mu-` prefix stripped).

The verb is two-phase by default: a bare `mu workstream destroy` prints a dry-run
summary so you can verify what's about to disappear, and exits without
touching anything. Pass `-y` / `--yes` to actually destroy.

```bash
mu workstream destroy --workstream auth-refactor          # dry-run: shows counts, exits
mu workstream destroy --workstream auth-refactor --yes    # actually does it

# Or, from inside the workstream's tmux session:
mu workstream destroy --yes                                # workstream auto-detected
```

```
Workstream auth-refactor (tmux session mu-auth-refactor)
  tmux session : alive (will be killed)
  agents       : 3
  tasks        : 10  (edges: 12, notes: 7)

Destroyed auth-refactor: killed tmux=true, agents=3, tasks=10, edges=12, notes=7
```

It's idempotent on every leg: missing tmux session is fine, zero DB
rows is fine, repeated `mu workstream destroy` against an already-gone workstream
prints "nothing to destroy" and exits 0.

A whole-DB snapshot is captured before the destroy runs. If you
regret it, `mu undo --yes` restores the DB — but the tmux session
that was killed and any per-agent workspace dirs that were freed
are NOT brought back. See
[§ 14: You ran a destructive verb and want to undo it](#you-ran-a-destructive-verb-and-want-to-undo-it).

The tmux session is killed BEFORE the DB rows so an unexpected tmux
failure leaves the registry intact (you can retry); if you only want
the DB cleared, use `mu sql` directly:

```bash
mu sql "DELETE FROM tasks  WHERE workstream='auth-refactor'"   # cascades
mu sql "DELETE FROM agents WHERE workstream='auth-refactor'"
```

Or nuke the entire DB:

```bash
rm ~/.local/state/mu/mu.db                           # next mu invocation re-creates an empty schema
```

### Preserve the conversation as markdown before destroying

A workstream's task graph + notes IS the project memory — the
durable record of what was decided and why. `mu workstream destroy`
blows that away (a snapshot is taken, but it's a binary `.db` only
readable through `mu undo`). For code review, project handoff,
git-checked-in artifacts, or just `grep`, render the workstream as
plain markdown first:

```bash
mu workstream export -w auth-refactor                         # → ./auth-refactor/
mu workstream export -w auth-refactor --out ~/notes/auth/     # explicit dir
```

The directory contains `README.md` (counts), `INDEX.md` (table of
every task), `tasks/<id>.md` (one file per task with frontmatter +
full notes), and `manifest.json` (per-file sha256 + the
`agent_logs.seq` cursor at export time). It's idempotent: re-export
against the same `--out` rewrites only files whose markdown
actually changed (mtime preserved on identical files); tasks added
since the previous export get fresh files; tasks deleted from the
DB STAY on disk with a `> **Deleted from DB on <ts>**` banner so
you never lose context that may already be git-blamed.

`mu workstream destroy --yes` auto-runs an export to
`<state-dir>/exports/<workstream>-<timestamp>/` BEFORE killing the
tmux session and dropping the rows, so the conversation survives
even if you forgot. Pass `--no-export` to opt out.

```bash
(cd auth-refactor && git init && git add . && git commit -m 'auth-refactor snapshot')
```

Markdown only by design — no HTML/PDF, no embedded VCS, no
cross-workstream merge, no re-import. Operators can pandoc /
`git init` themselves.

---

## 15.5 Archives — cross-workstream preservation of task graphs

A `mu workstream destroy` blows away the live task graph (a
snapshot is taken, but it's a binary `.db` only readable through
`mu undo`). The markdown export above keeps the conversation
human-readable on disk, but it's not queryable in-DB. The
**archive** verb is the third option: a structured, queryable
snapshot of a workstream's task graph (tasks + edges + notes +
events) that lives in the same `mu.db` indefinitely and can
accumulate snapshots from MANY workstreams under the same
operator-named label.

```bash
mu archive create v0-3-wave --description "v0.3 release wave"
mu archive add v0-3-wave -w mufeedback-v03
mu archive add v0-3-wave -w roadmap-v0-3 --destroy   # cascade: archive THEN destroy
mu archive list                                       # label | tasks | sources | created | last_added
mu archive show v0-3-wave                             # detail card + per-source-workstream summary
```

Key properties:

- **Globally-unique labels.** Archive labels live in their own
  namespace (separate from workstream names). Pick once, reuse
  across years.
- **Additive accumulation.** `mu archive add <label> -w <ws>` is
  idempotent at the (archive, source workstream) granularity.
  Re-running on the same workstream is a no-op; adding a new task
  to the source workstream and re-running picks up only the
  delta. Two different workstreams under the same label coexist
  as separate `(source_workstream, original_local_id)` rows.
- **Outlives the source.** `archived_tasks.source_workstream` is
  TEXT (not an FK), so the source workstream can be destroyed and
  the archive's snapshot of it stays queryable forever.
- **Reversible.** `mu archive delete <label> --yes` captures a
  snapshot first; `mu undo --yes` brings the whole archive back.
  `mu archive remove <label> -w <ws>` is the surgical version
  (one source workstream's contribution, without touching
  siblings).

### Three lifecycle patterns

The verb shape supports all three; pick per-call.

**Pattern A — single bucket per project family** (single growing
archive, easy cross-time queries):

```bash
mu archive create mu --description "every mu-self-development workstream"
mu archive add mu -w mufeedback --destroy           # initial v0.2 wave
mu archive add mu -w roadmap-v0-2 --destroy
# weeks later, after v0.3 ships:
mu archive add mu -w mufeedback-v03 --destroy
mu archive add mu -w roadmap-v0-3 --destroy
# months later: same single 'mu' bucket grows.
```

**Pattern B — per-release buckets** (easier to compare "what
shipped in v0.2 vs v0.3"):

```bash
mu archive create mu-v0-2 ; mu archive add mu-v0-2 -w mufeedback --destroy
mu archive create mu-v0-3 ; mu archive add mu-v0-3 -w mufeedback-v03 --destroy
```

**Pattern C — hybrid** (a workstream lives in BOTH archives;
independent rows under each label):

```bash
mu archive add mu      -w mufeedback-v03
mu archive add mu-v0-3 -w mufeedback-v03 --destroy
```

### Anti-features (intentional)

- **No "default" / auto-archive.** `mu workstream destroy` does
  NOT auto-add to a fallback bucket. Either you picked a label
  deliberately or you didn't want one.
- **No re-import.** The archive IS the workstream's afterlife.
  If you need an archived task back as live work, copy it via
  `mu sql` into a fresh workstream + `mu task add`.
- **No archive→archive merge / rename.** Operator-managed via
  `mu sql` if it ever matters.
- **Snapshots vs archives are separate concerns.** Snapshots are
  whole-DB binary backups for one-shot recovery (`mu undo`).
  Archives are first-class queryable structured data with their
  own lifecycle. Don't confuse them.

---

## 16. One-shot demo script

Copy-pasteable, end-to-end. Wipes any prior `~/.local/state/mu/mu.db`.

```bash
# Clean start
tmux kill-session -t mu-demo 2>/dev/null
rm -f ~/.local/state/mu/mu.db

# Plan
mu workstream init demo
mu task add design --title "Design"  --impact 80 --effort-days 2
mu task add build  --title "Build"   --impact 80 --effort-days 5 --blocked-by design
mu task add ship   --title "Ship"    --impact 90 --effort-days 1 --blocked-by build

# Crew
mu agent spawn worker-1 --workstream demo --cli sh
mu agent spawn worker-2   --workstream demo --cli sh

# Assign + observe
mu sql "UPDATE tasks SET owner='worker-1', status='IN_PROGRESS' WHERE local_id='design'"
mu --workstream demo

# Watch live (Ctrl+b d to detach)
tmux attach -t mu-demo

# Cleanup
mu workstream destroy --workstream demo --yes
rm -f ~/.local/state/mu/mu.db
```

---

## Mental model in three sentences

1. **One workstream is one tmux session full of agent panes.** Mu
   manages the lifecycle; tmux is the substrate. Workstreams on the
   same machine are isolated by `session_id` in the SQLite registry.

2. **The task DAG decides what's actionable; the LLM doesn't gamble.**
   Mission control + the `Ready` table + parallel-tracks union-find
   give deterministic answers to "what's next?" and "what can I
   parallelize?" Diamond patterns (two goals sharing a prerequisite)
   collapse into one merged track so two agents never collide on
   shared deps.

3. **Agents claim tasks via their pane title — zero config.**
   `mu task claim foo` from inside `worker-1`'s pane sets `tasks.owner='worker-1'`
   atomically. mu reads the pane title via
   `tmux display-message -t $TMUX_PANE -p '#{pane_title}'`, set on
   spawn. Two agents cannot claim the same task.

Everything else (`mu sql`, send/read, the bracketed-paste protocol,
ghost reconciliation) is plumbing in
service of those three.

---

## What's NOT in 0.2.0 (and how to work around it)

<a id="whats-not-in-020-and-how-to-work-around-it"></a>

The full roadmap with promotion criteria lives in
[ROADMAP.md](ROADMAP.md). The short list of gaps you might hit
in real use:

| Want                                          | Workaround                                                              | Status        |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------- |
| Multi-CLI status detection (per-CLI prompts)  | Braille spinner fallback (`f68838f`) covers pi/pi-meta + every TUI wrapper using standard spinner glyphs. Per-CLI permission-prompt patterns still pi-only. | partially shipped |
| Pi extension (typed tools, HUD, wakeups)      | `mu hud` verb covers the HUD use-case (run via `watch` / `tmux display-popup` / `status-right`). Other extension tools deferred. | partially shipped |
| Markdown agent-definition discovery           | Spawn accepts `--cli` and `--command` directly; no template registry    | dropped       |
| `mu run script.ts` (JS DSL)                   | Use `--json` + bash + jq                                                | rejected      |
| Sync to GitHub Issues / Linear / Asana        | Not in scope; explicitly rejected                                       | —             |
| ~~`mu task blocked`~~ (removed; the `blocked` SQL view is the abstraction) | `mu sql "SELECT local_id, status, title FROM blocked WHERE workstream='X'"` | removed-with-recipe |
| ~~`mu task goals`~~ (removed; same shape as `blocked` — view is the abstraction) | `mu sql "SELECT local_id, status, title FROM goals WHERE workstream='X'"` | removed-with-recipe |
| ~~`mu task search <pat>`~~ (removed; case-insensitive LIKE is one SQL line) | `mu sql "SELECT local_id, status, title FROM tasks WHERE workstream='X' AND LOWER(title) LIKE '%pat%'"` (add `LEFT JOIN task_notes` for the old `--in-notes`; drop the `WHERE workstream=` clause for the old `--all`) | removed-with-recipe |

Anything in this table that bites you in real use is a candidate
for **promotion**. Criteria: proven friction in ≥2 real workflows +
fits in <300 LOC + no major refactor of the load-bearing pillars.
The most useful feedback is "I tried to do X and had to fall back
to `mu sql`, twice in one session" — that's exactly the signal we
want. File it in [ROADMAP.md](ROADMAP.md).

---

## Where to go from here

| Doc                                          | What's in it                                            |
| -------------------------------------------- | ------------------------------------------------------- |
| [README.md](../README.md)                    | Project overview, install, comparison vs `pi-subagents` |
| [CHANGELOG.md](../CHANGELOG.md)              | Release notes                                           |
| [ROADMAP.md](ROADMAP.md)                     | What's next, with promotion criteria + rejected ideas   |
| [VOCABULARY.md](VOCABULARY.md)               | Canonical terms — source of truth for every word        |
| [VISION.md](VISION.md)                       | The eight load-bearing pillars + design principles      |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | Module map, reconciliation algorithm, layered design    |
| [skills/mu/SKILL.md](../skills/mu/SKILL.md)  | What an LLM running inside an agent pane sees           |

If you're trying mu and something doesn't work as documented, file an
issue with: the exact `mu` command, the full output (set
`MU_DB_PATH=/tmp/mu-debug.db` to isolate from your real registry),
your tmux version (`tmux -V`), and your platform.
