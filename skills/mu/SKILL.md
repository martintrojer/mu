---
name: mu
description: Manage a persistent crew of pi agents in tmux panes coordinated through a built-in task graph. Use when the user asks to spawn, send work to, observe, or coordinate multiple sub-agents — especially long-lived ones, or work that benefits from a dependency graph and parallel-track detection.
---

# mu — Multi-agent orchestration

`mu` is a CLI for managing a persistent crew of AI agents in tmux
panes coordinated through a task graph. State lives at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db` (SQLite). Every verb
not listed here does not exist; trust `mu --help`.

## Vocabulary

- **workstream** — unit of organization; one tmux session.
- **agent** — a named worker in a tmux pane (you may be one).
- **task** — a node in the DAG; mandatory `impact` (1–100) and
  `effort_days`; status one of `OPEN`, `IN_PROGRESS`, `CLOSED`
  (the only state that satisfies a `--blocked-by` edge), `REJECTED`
  (terminal won't-do; still blocks downstream), or `DEFERRED`
  (parked; still blocks downstream).
- **claim / release** — atomic CAS take/clear of `tasks.owner`.
- **free** — mark the *agent* available (`mu agent free`); pane
  untouched. Different from release: free is about the agent,
  release is about the task.
- **note** — append-only context attached to a task; survives
  across sessions.
- **track** — an independent subtree of the DAG (parallel-track
  detection; visible in mission control).
- **workspace** — per-agent isolated VCS working copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

## When to reach for mu

**Use mu for:**
- Multi-phase investigations where context loss across the session
  would hurt (benchmark + profile + fix + review + parity).
- Tasks worth gating with review (DAG enforces
  `implement → review → address → ship`).
- Parallel read-only/audit work alongside heavier tasks.
- Implementation + reviewer/tester splits with isolated workspaces.
- Work likely to survive context compaction — durable task notes
  are the project memory the next agent inherits.

**Do NOT use mu for:**
- Tiny direct edits (5-minute one-file changes).
- One-off local inspection / single shell commands.
- Single-context work where no durable coordination is needed.

The orchestrator's first decision is whether to reach for mu at
all. mu is a pi orchestrator; status detection is pi-only. Pairs
well with `tmux attach` for live observation.

## Mental model

### One workstream = one tmux session

Named `mu-<workstream>`. Every agent is a pane;
`tmux a -t mu-<workstream>` shows the crew. Multiple workstreams =
multiple tmux sessions, partitioned in the DB by `workstream`.

### The task DAG drives coordination

One edge type: `blocks`. `A → B` = A must close before B starts.
Built-in views: `ready`, `blocked`, `goals`. Bare `mu` shows
**parallel tracks** with **automatic diamond-merge**: goals
sharing a prerequisite collapse into one track. Don't spawn more
agents than there are tracks. Notes are append-only per task —
conventions `FILES:`, `DECISION:`, `VERIFIED:` cure context loss.

### Per-agent workspaces stop trampling

For two agents editing the same project, use `--workspace` on
spawn. Each gets an isolated working copy under
`<state-dir>/workspaces/<workstream>/<agent>/`. Auto-detects
jj/sl/git; `cp -a` for non-VCS. Workspaces are NOT freed when you
close an agent (uncommitted artifacts shouldn't get auto-deleted);
run `mu workspace free <agent>` explicitly.

### Name agents by role, not by person

Use `worker-1`, `worker-2`, `reviewer-1`, `scout-1`, `auditor-1`,
`planner-1`. Smallest unused suffix. Avoid human names and
pejoratives. `[a-z][a-z0-9_-]{0,31}` is allowed but stick to
convention — names show up in `mu agent list`, the tmux window
list, and the pane title.

### Pane border carries mu's interpreted state

In `mu-<ws>` sessions every pane shows a one-row top border:
`[mu] <name> · <emoji> · <task-id>`. Updated on every state-touching
verb and on every `mu state` / `mu agent list` reconcile. Glance at
the pane to see what mu thinks. Opt out with `MU_BANNER_QUIET=1`.

## Orchestrator loop

Every turn:

1. `mu state -w <ws>` — read the card. Agents, IN_PROGRESS, ready,
   parallel tracks.
2. Don't spawn more agents than independent ready tracks.
3. **Claim before sending — even for one-shot reviewers / scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`. No
   task = nothing for `mu task wait` to wait on; agent status flips
   are too noisy. If the dispatch has no task, `mu task add` first.
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
- **`--on-stall exit` is the unattended-orchestrator escape.** Default
  `mu task wait` warns on a stuck worker (yellow STUCK line + an
  `agent stalled` event in the log) and KEEPS POLLING — fine when
  you're at the keyboard. For wrapping policies / cron-driven sweeps
  / long pipelines, pass `--on-stall exit` and the wait exits with
  code 7 (`STALL_DETECTED`) the moment the predicate fires, so the
  wrapper can branch (poke vs release vs rollover). Distinct from
  exit 6 (`REAPER_DETECTED`, dead pane — unambiguous, re-dispatch);
  exit 7 is the ambiguous sibling (alive but idle — operator
  decides). If both fire in the same poll, exit 6 wins.
- **Pipeline cherry-picks; don't barrier.** One wait, one cherry-pick,
  one verify, one workspace recycle, repeat. Don't block on all-N
  before picking the first. `mu task wait <ref> [<ref>...] --first
  --json` prints the firing ref's qualified id to stdout AND emits a
  `firing` field, so `closed=$(mu task wait ... --first --json | jq
  -r .firing.qualifiedId)` is the loop body.
- **Cross-workstream `mu task wait` is built in.** Pass qualified
  refs `<workstream>/<name>` directly; `-w` is dropped when every
  ref is qualified, and the per-poll reconcile loops over every
  workstream in the set (so dead-pane reaping fires across the
  whole wait surface).
- **Keep dispatch prompts terse.** Workers have the same skills as
  the orchestrator and can `mu task notes <id>` for the full spec.
  The prompt only needs: who they are, the task id, the workspace
  path, the validate command, and the loud final-action block. Long
  re-stating of design notes from the prompt is wasted context window.
- **Cross-workstream `mu task claim --for` is built in.** When
  per-workstream worker pools leave a free worker in workstream A
  and a queued task in workstream B, dispatch with `mu task claim X
  -w B --for A/worker-1`. The agent stays in A; only the task's
  `owner_id` crosses. No need to close + re-spawn the worker in B
  (which would lose its LLM context) or reach for `mu sql`.
- **Idle agent (⚠ glyph; alive but assigned, no recent progress)** —
  see scrollback via `mu agent show <name> -n N`; recover via
  `mu agent send <name> '<retry>'` OR `mu task release <id>` (bare
  release auto-flips IN_PROGRESS → OPEN; `--reopen` is only for
  un-closing CLOSED/REJECTED/DEFERRED). Tunable via
  `MU_IDLE_THRESHOLD_MS` (default 5 min).

### Parallelisation decision table

| Situation | Action |
|-----------|--------|
| One ready task / one track | Reuse one existing agent |
| Multiple independent ready tasks | Spawn one agent per ready track; cherry-pick each as it closes (don't barrier) |
| CPU-heavy benchmark in progress | Only parallelise read-only / audit tasks |
| Two agents editing/building/testing same repo | Use `--workspace` |
| Agent only reading docs/source | `--cli pi` (or operator alias) without `--workspace` is OK |
| Agent making code changes | `--workspace` strongly preferred |
| Agent reviewing/testing another agent's patch | Separate `--workspace` (or wait for the patch to merge) |

### Default workspace rule

**If an agent may edit, build, test, or generate artifacts while
another agent is active in the same repo, spawn with `--workspace`.**
Reserve the main checkout for orchestration.

```bash
mu agent spawn worker-1   -w <ws> --workspace
mu agent spawn reviewer-1 -w <ws> --workspace --role read-only
```

Two builds in the same checkout corrupt each other's artifacts.
**Prompt workspace agents with repo-relative paths only** — the
agent's cwd is the workspace root; absolute paths bypass it.

### Task note contract

Every delegated task should end with a note containing six fields
(omit only the ones genuinely N/A):

```
FILES:    paths inspected/changed (with line ranges if precise)
COMMANDS: shell commands run + exit codes
FINDINGS: what you observed
DECISION: what you chose, and why
NEXT:     follow-on tasks the next agent should know about
VERIFIED: how you confirmed it works (test names, command output)
ODDITIES: anything weird you saw but didn't act on
```

Then close with grounding:

```bash
mu task close <id> -w <ws> --evidence "tests pass: cargo test exit 0"
```

This turns the DAG from a coordination tool into a durable project
log. Future agents can `mu task notes <id>` to reconstruct the why
without reading the diff.

## CLI — complete verb list

One-liners only. Run `mu <verb> --help` for every flag, default,
and interaction — the CLI is the canonical reference. Every verb
accepts `--json` (the one exception is `mu agent attach`, which
prints a tmux command for a human). Every successful verb prints
a `Next:` block of suggested follow-ups.

```bash
# Workstream
mu workstream init <name>            # create tmux session mu-<name> + DB row
mu workstream list                   # every workstream on this machine
mu workstream destroy [--yes] [--no-export] [--archive <label>] [--empty]
                                     # tear down; auto-exports to <state-dir>/exports/<ws>-<ts>/;
                                     # --archive snapshots into an archive BEFORE destroy (atomic);
                                     # --empty sweeps zero-content workstreams + unregistered mu-* tmux sessions
mu workstream export [--out <dir>]   # render task graph + notes to a bucket dir; additive; idempotent
mu workstream import <bucket-dir> [--workstream <name>] [--dry-run] [--json]
                                     # inverse of export: rebuild every source-ws as live tasks/edges/notes;
                                     # markdown-only; per-source-ws transactional; refuses silent merge

# Agents
mu agent spawn <name> [--workspace]  # spawn into mu-<workstream>
mu agent send <name> "text"          # bracketed-paste safe
mu agent read <name> [-n N]          # capture-pane scrollback
mu agent show <name> [-n N]          # registry row + last N lines
mu agent list                        # reconciled with tmux; surfaces orphans
mu agent close <name>                # kill pane + drop row (workspace untouched)
mu agent free <name>                 # status='free'; pane untouched
mu agent attach <name>               # print scrollback + tmux attach hint

# Registration — the inverse of spawn
mu adopt <pane-id|pane-title>        # register an orphan pane as a managed agent

# Tasks
mu task add [id] --title T --impact N --effort-days N [--blocked-by A,B]
mu task list [--status S...] [--sort K]
                                     # --sort id|roi|recency|age
                                     # --status accepts repeat OR comma-separate OR mix (union)
mu task next [-n K] [--sort K] [--status S...]
                                     # top-K ready (default K=1, --sort roi); -n 0 = all
mu task owned-by <agent>             # what is <agent> working on?
mu task show <id>                    # row + edges + notes
mu task tree <id> [--down]           # ASCII blockers (or dependents)
mu task notes <id>                   # notes only, oldest first
mu task note <id> "text"             # append (\n / \t / \\ escapes work)
mu task claim <id> [--for <worker> | --self [--actor <name>]]
                                     # --for accepts bare 'name' or qualified '<ws>/<name>'
mu task release <id>                 # clear owner; IN_PROGRESS → OPEN auto
mu task release <id> --reopen        # un-close: forces OPEN from CLOSED/REJECTED/DEFERRED
mu task close <id>                   # → CLOSED (idempotent)
mu task open <id>                    # → OPEN (idempotent)
mu task reject <id> [--cascade [--yes]]   # → REJECTED (won't do; still blocks ↓)
mu task defer  <id> [--cascade [--yes]]   # → DEFERRED (parked; still blocks ↓)
mu task block   <blocked> --by <blocker>  # cycle + workstream checked
mu task unblock <blocked> --by <blocker>
mu task update <id> [--title|--impact|--effort-days]
mu task reparent <id> --blocked-by A,B    # atomic edge replacement
mu task wait <ref> [<ref>...] [--status S] [--first|--any] [--timeout SECONDS]
                                     # block until tasks reach status (default CLOSED, all-of).
                                     # Each <ref> bare (uses -w) or qualified `<ws>/<name>`
                                     # (cross-workstream; -w not required when ALL qualified).
                                     # --first = --any + prints firing qualified id + JSON {firing}.
                                     # Reconciles each ws-in-set per poll: dead pane fails fast.
                                     # Exits: 0 met / 5 timeout / 6 reaper-flipped a watched task
                                     # back to OPEN (target=CLOSED only) / 7 stall (--on-stall exit).
mu task delete <id>                  # cascades to edges+notes; no undo

# Self-identification — in-pane only
mu me                                # name + workstream + cli + owned tasks
mu me tasks                          # just the owned-tasks table
mu me next [-n K]                    # top-K ready in <self.ws> (-n 0 = all)

# Workspace — per-agent VCS working copies
mu workspace create <agent> [--backend jj|sl|git|none] [--from REF]
mu workspace list [--all]            # `behind` column: ≤ 2 green, 3–9 yellow, ≥ 10 red
mu workspace free <agent> [--commit]
mu workspace path <agent>            # cd $(mu workspace path X)
mu workspace orphans                 # on-disk dirs with no DB row

# Activity log
mu log "text" [--as N] [--kind K]    # write
mu log [-n N] [--source X] [--kind X] [--since SEQ] [--all]   # read
mu log --tail [--since SEQ]          # subscribe

# Snapshots + undo — every destructive verb auto-snapshots first
mu undo [--yes] [--to <id>]          # restore latest snapshot (or one chosen)
mu snapshot list [-n N]              # newest-first: id | label | ws | size
mu snapshot show <id>                # full metadata for one row

# Archives — cross-workstream preservation of task graphs
mu archive create <label> [--description "..."]   # one-time bucket; labels GLOBALLY unique
mu archive list                                    # label | tasks | sources | created | last_added
mu archive show <label>                            # detail card + per-source-ws summary
mu archive add <label> -w <ws> [--destroy]         # IDEMPOTENT; --destroy cascades to destroy --yes
mu archive remove <label> -w <ws>                  # surgical un-archive of one source workstream
mu archive delete <label> [--yes]                  # two-phase; --yes captures a snapshot first
mu archive search <pattern> [--label <l>]          # LIKE-search archived titles + note content
mu archive export <label> --out <bucket-dir>       # render every source-ws to a bucket of markdown

# Escape hatch + state + health
mu sql "<query>"                     # SELECT / UPDATE / DELETE / WITH
mu                                   # bare: alias for `mu state --mission`
mu state [-w X[,Y]... | -w X -w Y | --all] [--hud | --mission] [--json]
                                     # canonical state card. Three render modes:
                                     #   default      — full top-to-bottom card
                                     #   --hud        — dynamic table HUD; fills pane h×w; '… +N more' footers
                                     #   --mission    — stripped 5-col glance (agents + orphans + tracks + ready)
                                     # -w accepts multi (repeat/CSV); --all spans every workstream
mu doctor                            # tmux + db + schema + workstream stats
```

Universal flags worth knowing without `--help`:

- **`-w, --workstream <name>`** — explicit > `$MU_SESSION` > current
  tmux session minus `mu-` prefix > error. On verbs that take an
  entity by id, `-w` is a SCOPE check (errors with
  `*NotInWorkstreamError`); on picker verbs (`mu task next`,
  `mu agent list`), it picks WHICH.
- **Qualified entity refs** — every verb accepts
  `<workstream>/<name>` in addition to bare `<name>`. The qualified
  form skips `-w` resolution: `mu task show ws/foo` works from any
  shell. Mixing a qualified ref with a non-matching `-w` errors out
  (exit 2). When a bare name appears AND no `-w` resolves AND ≥2
  workstreams contain that name, mu raises `NameAmbiguousError`
  (exit 4) and lists every candidate as a one-paste fix.
- **`--evidence "<text>"`** — on `task close / open / claim / release`.
  Recorded verbatim in the auto-emitted event payload. Use it for
  grounding ("tests pass: npm test exit 0").
- **`--json`** — on every verb. Success path emits one JSON object
  (or array for collection reads); errors emit
  `{ error, message, nextSteps, exitCode }` to stderr.

### Picking model + thinking effort per agent

The zen of mu: **mu doesn't reason about models.** Pi speaks
`--model sonnet:high` and `--thinking off|minimal|low|medium|high|xhigh`.
Mu has no tier abstraction on purpose
(see [VISION.md § 10](../../docs/VISION.md#10-get-out-of-the-models-way)).

Three controls, smallest first:

- **Per-spawn**: `mu agent spawn r --command "pi --model opus:high"`
- **Shell default**: `export MU_PI_COMMAND="pi --model sonnet:medium"`
- **Operator aliases**: any `--cli <key>` uppercases to
  `$MU_<KEY>_COMMAND` (use underscores). Convention for tiers:
  `pi_mini` / `pi` / `pi_big`. Mu doesn't enforce these.

**Rubric (convention)**: mini for probing/fan-out; modest for
build/edit/refactor; big for design/review/incident/gnarly debugging.
Discover valid model strings: `pi --list-models [fuzzy-search]`.

### The reaper

When an agent's pane dies (or you `mu agent close` mid-task), any
IN_PROGRESS task it owned auto-reverts to OPEN with a `[reaper]` note
plus a `task reap` event in `agent_logs`. You don't have to manually
`task release` after a crash.

### Known limitations

- **Status detection lags with custom `--command` wrappers.** Agents
  may show `needs_input` while running commands. Trust scrollback,
  task notes, and event log over the status emoji for monitoring
  decisions.
- **Workspace patch flow needs explicit apply.** Worker writes in
  isolated workspace → review → parity tests in workspace → manual
  apply to main → sanity test. Worth it for any patch that benefits
  from review; overkill for a one-line typo fix.
- **Orchestration overhead is real for tiny tasks.** Task create +
  claim + send + monitor + notes + close is ~6 verbs of ceremony.
  See "When to reach for mu" above.

## SQL escape hatch

`mu sql "<query>"` for anything not yet typed. Inspect the live
schema with `mu doctor --json | jq .db.schema` (or
`mu sql "SELECT name FROM sqlite_master WHERE type IN ('table','view')"`)
— don't memorize column names, they drift. Every entity table has
an INTEGER `id` PK; the operator-facing TEXT name is per-workstream
unique.

```bash
# Cross-agent join (column names: confirm via the schema query above)
mu sql "SELECT a.name, t.local_id, t.title
          FROM agents a JOIN tasks t ON t.owner = a.name
         WHERE a.status IN ('busy','needs_input')"
```

`mu sql --help` has more recipes (recursive CTEs, rename-with-cascade,
etc.). FK CASCADE on `ON UPDATE` makes workstream renames atomic
across children.

## Common patterns

The verbs themselves emit a `Next:` block of natural follow-ups.
The patterns below are the **multi-verb composites** that no single
verb's hint can show.

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

```bash
mu agent spawn worker-1 -w <ws> --workspace
mu task claim profile_hotspot -w <ws> --for worker-1 --evidence "only ready CPU-bound task"
mu agent send worker-1 'Run the benchmark; capture results.'

mu agent spawn scout-1 -w <ws> --role read-only
mu task claim audit_x -w <ws> --for scout-1 --evidence "safe parallel; read-only"
mu agent send scout-1 'Read-only audit. Do NOT build/test; report via task notes.'
```

`--role read-only` is the safety belt; the prompt reinforces it.

### Quote command-rich prompts (avoid `$VAR` expanding in YOUR shell)

`$VAR`, `$(...)`, backticks, and `!history` in a double-quoted prompt
expand in YOUR shell before mu sees them. Single-quote (or use a
quoted heredoc) to defer expansion to the agent.

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

The status emoji is a 4-state heuristic from prompt shape — it doesn't
say WHAT the agent is doing. For high-stakes calls, combine:

```bash
mu agent read worker-1 -n 100         # pane scrollback
mu log -w <ws> --kind event --tail    # state-change stream
mu task notes <id>                    # decisions + grounding
```

### After spawning, observe — don't fire-and-forget

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

Don't pipe `mu log --tail | awk '...'` for waits — `mu task wait` is
the right primitive. Don't fire-and-forget; the worker stalls in
`needs_input` and you find out hours later.

### Sending follow-on work to an existing agent

A new prompt is appended to whatever context the agent had from the
previous task. For **related** work that's a feature. For **unrelated**
work, send `/new` first (pi / claude-code; codex uses `/clear`) to
wipe the LLM's working set — pane scrollback is preserved:

```bash
mu agent send worker-1 '/new'
sleep 1                              # let the CLI swallow the slash command
mu agent send worker-1 "$(cat <<'EOF_PROMPT'
Claim and work on $TASK. Read the task notes before starting...
EOF_PROMPT
)"
```

### Tear down a workstream

`mu workstream destroy` is two-phase: dry-run by default, `--yes` to
commit. A pre-destroy snapshot is captured; `mu undo --yes` restores
the DB but NOT the killed tmux session or freed workspace dirs. FK
CASCADE handles DB cleanup.

## If you ARE the agent (in-pane patterns)

Verbs auto-resolve via `$TMUX_PANE` — `mu me`, `mu me next`,
`mu task claim` all work without a name argument. The pane title (set
at spawn) IS the agent identity.

Two patterns:

- **Worker** — your pane was created by `mu agent spawn` (or promoted
  via `mu adopt`). Has a row in `agents`. Bare `mu task claim <id>`
  Just Works.
- **Orchestrator** — a top-level pi session NOT in `agents` (e.g.
  running mu from a host shell to coordinate workers). Bare
  `mu task claim` errors with `ClaimerNotRegisteredError` whose
  `errorNextSteps()` lists three options: `--self` (work directly,
  owner=NULL, actor in log), `--for <worker>` (dispatch), or
  `mu adopt <pane>` (promote the pane to a worker).

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

**Close as the LAST action.** Skipping `mu task close` makes the
orchestrator's `mu task wait` hang.

### Recover from a destructive verb

`mu snapshot list` then `mu undo --yes` (dry-run by default; add
`--to <id>` to pick one). Two invariants `mu undo --help` doesn't
spell out:

- **DB only.** Killed tmux panes and freed workspace dirs do NOT come
  back; restore output reports the resulting DB-vs-tmux drift.
- **No `mu redo`.** Each restore takes a pre-restore snapshot, so a
  second `mu undo --yes` rolls forward.

### When you need to wait for another agent to finish

```bash
# Wait until 'design' closes, then start the next thing
mu task wait design && mu task claim build_auth --self --evidence 'design closed'

# Dispatch N workers, wait for ALL (single workstream)
mu task wait design build_a build_b --timeout 1200

# Cross-workstream: qualified refs, no -w needed
mu task wait wsa/archive wsb/cli_audit --timeout 1800

# Pipeline-cherry-pick loop: --first prints WHICH closed; act on it,
# then loop. The recipe is in nextSteps too — jq it out.
closed=$(mu task wait wsa/foo wsb/bar --first --json | jq -r .firing.qualifiedId)
# closed="wsb/bar" — cherry-pick that worker's HEAD; verify; free; loop.
```

Default target status is CLOSED. Exit 0 = met; 5 = timeout; 6 = the
reaper flipped a watched task back to OPEN (target=CLOSED only); 7 =
stall (`--on-stall exit`); 3 = missing task id.

## DOs

- **`mu state -w <ws>` before every action.** State card is the
  source of truth.
- **Add a task before assigning work.** "What is worker-1 doing?" is
  a graph query, not a memory test.
- **Claim BEFORE sending.** Otherwise ownership is murky.
- **Read existing notes before claiming.**
- **Pass `--evidence` on claim AND close.** Audit trail is only as
  useful as what's recorded.
- **Drop notes per the task note contract.**
- **Set `impact` and `effort_days` honestly.** They drive ROI.
- **Don't spawn more agents than independent ready tracks.**
- **Send `/new` before unrelated follow-on work** to a still-spawned
  agent.
- **`--workspace` whenever the agent might edit/build/test.**
  Default-on.
- **Single-quote prompts with `$VAR`, `$(...)`, backticks.**
- **`mu task wait` for waits; `mu log --tail` for streaming.**
- **`--json` for scripting; `mu sql` for what's not yet typed.**
- **`mu doctor` if anything looks off.**

## DON'Ts

- **Don't fire-and-forget** after `mu agent send`.
- **Don't trust the status emoji alone for high-stakes calls.**
- **Don't double-quote a `$VAR`-laden prompt** — your shell expands
  it. Single-quote or quoted-heredoc.
- **Don't bypass mu with `sqlite3`.** Use `mu sql`.
- **Don't spawn an agent without a workstream.**
- **Don't anthropomorphize agent names.** `worker-1`, not `alice`.
- **Don't poll `mu agent read` in tight loops.** Use `mu log --tail`.
- **Don't add cross-workstream edges.** Model as one workstream.
- **Don't `mu workstream destroy --yes` without the dry-run.**
- **Don't use the `mu_` task-id prefix.** Reserved.
- **Don't message agents directly.** Coordinate via task notes and
  the activity log.

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
