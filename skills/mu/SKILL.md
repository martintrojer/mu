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
  `effort_days`; status one of `OPEN` (ready), `IN_PROGRESS`
  (claimed), `CLOSED` (shipped — the only state that satisfies
  a `--blocked-by` edge), `REJECTED` (terminal won't-do; still
  blocks downstream), or `DEFERRED` (parked, may revisit; still
  blocks downstream).
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

### Pane border carries mu's interpreted state

In `mu-<ws>` sessions every pane shows a one-row top border with
`[mu] <name> · <emoji> · <task-id>` (e.g. `[mu] worker-a · ⚙️ · build_x`).
Updated on every state-touching verb and on every `mu state` /
`mu agent list` reconcile. Glance at the pane to see what mu thinks.
Opt-out: `MU_BANNER_QUIET=1`.

## Orchestrator loop

Every turn:

1. `mu state -w <ws>` — read the card. Check agents, IN_PROGRESS
   tasks, ready tasks, parallel tracks.
2. **Don't spawn more agents than independent ready tracks.**
3. **Claim before sending — even for one-shot reviewers / scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   No task = nothing to `mu task wait` on; agent status alone is
   too noisy (idles flip back to `needs_input`). If the dispatch
   has no task, `mu task add` one first.
4. Send task-specific instructions: task ID, files/notes to read,
   scope guards, the task note contract. Tell the agent to
   `mu task close <id> --evidence "..."` on done.
5. Monitor via `mu state` / `mu agent show` / task notes — don't
   walk away (see "After spawning, observe" below).
6. On close, repeat from 1.

### Hard-earned dispatch lessons

- **Refresh workspaces between waves.** `/new` → `mu workspace free`
  → `mu workspace create`. Without it the worker ships clean code
  against a stale parent; you find out at cherry-pick time. The
  `behind` column in `mu state` shows the cost.
- **Cherry-pick worker commits onto main, don't merge.** Stale-parent
  worker branches drag in re-reverts of everything they missed.
- **End every dispatch prompt with a loud `⚠️ FINAL ACTION: git commit
  -am '...' THEN mu task close <id> --evidence '...'`.** Without the
  literal reminder, agents commit + report success in chat without
  running the typed close, and `mu task wait` hangs until
  `--stuck-after` fires.

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

**If an agent may edit, build, test, or generate artifacts while
another agent is active in the same repo, spawn with
`--workspace`.** Reserve the main checkout for orchestration.

```bash
mu agent spawn worker-1   -w <ws> --workspace
mu agent spawn reviewer-1 -w <ws> --workspace --role read-only
```

Two builds in the same checkout corrupt each other's build
artifacts. `--workspace` is cheap; default-on.

**Prompt workspace agents with repo-relative paths only.** The
agent's cwd is the workspace root; absolute paths bypass it and
edit the main checkout.

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
# Workstream (4)
mu workstream init <name>            # create tmux session mu-<name> + DB row
mu workstream list                   # every workstream on this machine
mu workstream destroy [--yes] [--no-export] [--archive <label>]  # tear down; auto-exports to <state-dir>/exports/<ws>-<ts>/; --archive snapshots into an existing archive BEFORE destroy (atomic)
mu workstream export [--out <dir>]   # render task graph + notes to a bucket dir (<out>/<ws>/{README,INDEX,tasks/<id>.md} + bucket-level README/INDEX/manifest.json); additive across workstreams; idempotent

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

# Tasks (18)
mu task add [id] --title T --impact N --effort-days N [--blocked-by A,B]
mu task list [--status S] [--sort K]   # every task; --sort id|roi|recency|age
mu task next [-n K] [--sort K]         # top-K ready (default K=1, --sort roi); -n 0 = all
                                     # --sort: id|roi|recency|age (time-based adds rel-time col)
mu task owned-by <agent>             # what is <agent> working on?
mu task show <id>                    # row + edges + notes
mu task tree <id> [--down]           # ASCII blockers (or dependents)
mu task notes <id>                   # notes only, oldest first
mu task note <id> "text"             # append (\n / \t / \\ escapes work)
mu task claim <id> [--for <worker> | --self [--actor <name>]]
mu task release <id> [--reopen]      # clear owner; optionally flip OPEN
mu task close <id>                   # → CLOSED (idempotent)
mu task open <id>                    # → OPEN (idempotent)
mu task reject <id> [--cascade [--yes]]   # → REJECTED (won't do; still blocks ↓)
                                     # --cascade alone is dry-run; --yes commits
mu task defer <id>  [--cascade [--yes]]   # → DEFERRED (parked; still blocks ↓)
mu task block <blocked> --by <blocker>     # cycle + workstream checked
mu task unblock <blocked> --by <blocker>
mu task update <id> [--title|--impact|--effort-days]
mu task reparent <id> --blocked-by A,B   # atomic edge replacement
mu task wait <id> [<id>...] [--status S] [--any] [--timeout SECONDS]
                                         # block until tasks reach status
                                         # (default CLOSED, all-of); exit 0 / 5
mu task delete <id>                  # cascades to edges+notes; no undo

# Self-identification (1 verb, 2 subcommands) — in-pane only
mu me                                # name + workstream + cli + owned tasks
mu me tasks                          # just the owned-tasks table
mu me next [-n K]                    # top-K ready in <self.ws> (-n 0 = all)

# Workspace (4) — per-agent VCS working copies
mu workspace create <agent> [--backend jj|sl|git|none] [--from REF]
mu workspace list [--all]                # `behind` column: ≤ 2 green, 3–9 yellow, ≥ 10 red
mu workspace free <agent> [--commit]
mu workspace path <agent>            # cd $(mu workspace path X)
mu workspace orphans                 # on-disk dirs with no DB row

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

# Snapshots + undo (3) — every destructive verb auto-snapshots first
mu undo [--yes] [--to <id>]          # restore latest snapshot (or one chosen)
mu snapshot list [-n N]              # newest-first: id | label | ws | size
mu snapshot show <id>                # full metadata for one row

# Archives (7) — cross-workstream preservation of task graphs
mu archive create <label> [--description "..."]   # one-time bucket setup; labels GLOBALLY unique
mu archive list                                    # label | tasks | sources | created | last_added
mu archive show <label>                            # detail card + per-source-workstream summary
mu archive add <label> -w <ws> [--destroy]         # IDEMPOTENT; --destroy cascades to mu workstream destroy --yes
mu archive remove <label> -w <ws>                  # surgical un-archive of one source workstream
mu archive delete <label> [--yes]                  # two-phase; --yes captures a snapshot first
mu archive search <pattern> [--label <l>]          # LIKE-search archived titles + note content (--limit N, --json)
mu archive export <label> --out <bucket-dir>       # render every source-ws to a bucket of markdown (same shape as mu workstream export; additive)

# Escape hatch + state + health
mu sql "<query>"                     # SELECT / UPDATE / DELETE / WITH
mu                                   # bare: quick mission control
mu state                             # canonical state card
mu hud [-w X | --workstreams a,b | --all] [--json]   # dynamic table HUD; fills pane h×w; multi-workstream when N≥2
mu doctor                            # tmux + db + schema + workstream stats
```

Universal flags worth knowing without `--help`:

- **`-w, --workstream <name>`** — explicit > `$MU_SESSION` > current
  tmux session minus `mu-` prefix > error. On verbs that take an
  entity by id, `-w` is a SCOPE check (errors with
  `*NotInWorkstreamError`); on verbs that pick which entity
  (`mu task next`, `mu agent list`), it picks WHICH.
- **Qualified entity refs** — every verb that takes a task /
  agent / approval / workspace name accepts `<workstream>/<name>`
  in addition to bare `<name>`. The qualified form skips `-w`
  resolution: `mu task show roadmap-v0-2/snap_dogfood` works from
  any shell. Mixing qualified ref with a non-matching `-w` errors
  out (exit 2). When a bare name appears AND no `-w` resolves AND
  ≥2 workstreams contain that name, mu raises `NameAmbiguousError`
  (exit 4) and lists every candidate as a one-paste qualified-form
  fix.
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

`mu sql "<query>"` for anything not yet typed. Schema (v5): 10
tables (`workstreams`, `agents`, `tasks`, `task_edges`,
`task_notes`, `agent_logs`, `vcs_workspaces`, `approvals`,
`snapshots`, `schema_version`) + 3 views (`ready`, `blocked`,
`goals`). Every entity table has an INTEGER `id` PK; the
operator-facing TEXT name is per-workstream `UNIQUE`. Inspect with
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

```bash
mu workstream init <ws>
mu task add -w <ws> --title "Design X" --impact 70 --effort-days 1
mu task add -w <ws> --title "Build X"  --impact 70 --effort-days 5 --blocked-by design_x
mu task add -w <ws> --title "Review X" --impact 60 --effort-days 1 --blocked-by build_x
mu agent spawn worker-1   -w <ws> --workspace
mu agent spawn reviewer-1 -w <ws> --workspace --role read-only
mu -w <ws>    # mission control
```

IDs auto-derive from titles via slugify.

### Pick the highest-ROI ready task for the next agent

```bash
NEXT=$(mu task next -w <ws> --json | jq -r '.[0].localId')
mu task claim "$NEXT" --for worker-1 --evidence "highest ROI from ready set"
mu agent send worker-1 "Working on $NEXT."
```

### Parallel heavy-task + read-only audit

One worker does CPU-heavy work; a sibling audits read-only.

```bash
mu agent spawn worker-1 -w <ws> --workspace
mu task claim profile_hotspot -w <ws> --for worker-1 --evidence "only ready CPU-bound task"
mu agent send worker-1 'Run the benchmark; capture results.'

mu agent spawn scout-1 -w <ws> --role read-only
mu task claim audit_x -w <ws> --for scout-1 --evidence "safe parallel; read-only"
mu agent send scout-1 'Read-only audit. Do NOT build/test; report via task notes.'
```

`--role read-only` is the safety belt; the prompt reinforces it.
Without both, a parallel build can trash the other agent's timing.

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

The status emoji is a 4-state heuristic from prompt shape — it
doesn't say WHAT the agent is doing. For high-stakes calls,
combine:

```bash
mu agent read worker-1 -n 100         # pane scrollback
mu log -w <ws> --kind event --tail    # state-change stream
mu task notes <id>                    # decisions + grounding
```

Custom `--command` wrappers can misclassify; trust the three
above over the emoji.

### After spawning, observe — don't fire-and-forget

Three patterns, three shapes:

```bash
# Block until N tasks reach a status (the common case)
mu task wait worker-task-a worker-task-b --timeout 1200

# Stream all events as a dashboard tab
mu log -w <ws> --kind event --tail

# Watch agent-status transitions (per-agent narrative; rare)
last=""
while true; do
  cur=$(mu agent show worker-1 --json | jq -r .agent.status)
  [[ "$cur" != "$last" ]] && echo "[$(date -Iseconds)] worker-1: $last → $cur" && last="$cur"
  [[ "$cur" == "needs_input" || "$cur" == "done" ]] && break
  sleep 5
done
```

Don't pipe `mu log --tail | awk '...'` for waits — the awk
pattern doesn't compose past one task; use `mu task wait`. Don't
fire-and-forget; the worker stalls in `needs_input` and you
find out hours later.

### Sending follow-on work to an existing agent

A new prompt is appended to whatever context the agent had from
the previous task. For **related** work (design → impl) that's a
feature. For **unrelated** work, send `/new` first (pi /
claude-code; codex uses `/clear`) to wipe the LLM's working set
— pane scrollback is preserved:

```bash
mu agent send worker-1 '/new'
sleep 1                              # let the CLI swallow the slash command
mu agent send worker-1 "$(cat <<'EOF_PROMPT'
Claim and work on $TASK. Read the task notes before starting...
EOF_PROMPT
)"
```

### Tear down a workstream

`mu workstream destroy` is two-phase: dry-run by default, `--yes`
to commit. A pre-destroy snapshot is captured; `mu undo --yes`
restores the DB but NOT the killed tmux session or freed
workspace dirs. FK CASCADE handles DB cleanup (agents, tasks,
edges, notes, workspaces, logs).

## If you ARE the agent (in-pane patterns)

Verbs auto-resolve via `$TMUX_PANE` — `mu me`, `mu me next`,
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
mu me                                                  # orient
mu me next                                             # find work
mu task show <id>; mu task notes <id>                  # read context
mu task claim <id> --evidence "..."                    # claim
mu task note <id> "FILES: ...\nDECISION: ..."          # work; drop notes
mu task close <id> --evidence "tests pass: ..."        # close
# repeat
```

- **Close as the LAST action.** Skipping `mu task close` makes the
  orchestrator's `mu task wait` hang.

### When you need to do something irreversible

Gate on a human approval. Don't `mu workstream destroy` or
`mu task delete` autonomously — the DB is undoable but the tmux
side effects (pane kills, workspace dirs freed) are not.

```bash
slug=$(mu approve add --reason "..." --json | jq -r .slug)
if mu approve wait "$slug" --timeout 600; then mu task delete X; else exit 1; fi
```

`mu approve wait` exits 0/4/5 for granted/denied/timeout.

### Recover from a destructive verb

`mu snapshot list` then `mu undo --yes` (dry-run by default; add
`--to <id>` to pick one). Two invariants `mu undo --help` doesn't
spell out:

- **DB only.** Killed tmux panes and freed workspace dirs do NOT
  come back; restore output reports the resulting DB-vs-tmux drift.
- **No `mu redo`.** Each restore takes a pre-restore snapshot, so
  a second `mu undo --yes` rolls forward.

### When you need to wait for another agent to finish

```bash
# Wait until 'design' closes, then start the next thing
mu task wait design && mu task claim build_auth --self --evidence 'design closed'

# Dispatch N workers, wait for ALL
mu task wait design build_a build_b --timeout 1200

# Race: act on the FIRST done (--any)
mu task wait probe_a probe_b probe_c --any --json | jq .tasks
```

Default target status is CLOSED. Exit 0 = met; 5 = timeout; 3 =
missing task id. See `mu task wait --help`.

## DOs

- **`mu state -w <ws>` before every action.** State card is the
  source of truth.
- **Add a task before assigning work.** "What is worker-1 doing?"
  is a graph query, not a memory test.
- **Claim BEFORE sending.** Otherwise ownership is murky.
- **Read existing notes before claiming.**
- **Pass `--evidence` on claim AND close.** Audit trail is only
  as useful as what's recorded.
- **Drop notes per the task note contract** (FILES / COMMANDS /
  FINDINGS / DECISION / NEXT / VERIFIED / ODDITIES).
- **Set `impact` and `effort_days` honestly.** They drive ROI.
- **Don't spawn more agents than independent ready tracks.**
- **Send `/new` before unrelated follow-on work** to a still-spawned
  agent. See "Sending follow-on work" above.
- **`--workspace` whenever the agent might edit/build/test.**
  Default-on.
- **Single-quote prompts with `$VAR`, `$(...)`, backticks.**
- **`mu task wait` for waits; `mu log --tail` for streaming.**
- **`--json` for scripting; `mu sql` for what's not yet typed.**
- **`mu doctor` if anything looks off.**

## DON'Ts

- **Don't fire-and-forget** after `mu agent send`. See "After
  spawning, observe".
- **Don't trust the status emoji alone for high-stakes calls.**
  Cross-check scrollback + notes + event log.
- **Don't double-quote a `$VAR`-laden prompt** — your shell
  expands it. Single-quote or quoted-heredoc.
- **Don't bypass mu with `sqlite3`.** Use `mu sql`.
- **Don't spawn an agent without a workstream.**
- **Don't anthropomorphize agent names.** `worker-1`, not `alice`.
- **Don't poll `mu agent read` in tight loops.** Use
  `mu log --tail` instead.
- **Don't add cross-workstream edges.** Model as one workstream.
- **Don't `mu workstream destroy --yes` without the dry-run.**
- **Don't use the `mu_` task-id prefix.** Reserved.
- **Don't message agents directly.** Coordinate via task notes
  and the activity log.

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
