---
name: mu
description: Manage AI agents in terminal-multiplexer panes (tmux or herdr) — from a single off-the-cuff helper to a persistent crew coordinated through a built-in task graph. Use when the user asks to "create/spin up a subagent to X", "run X in the background", "do this in parallel", "use one subagent per X to do Y", "kick off a helper to watch/investigate/draft X", or to spawn, send work to, observe, or coordinate one or many agents — especially work you'll keep talking to, long-lived agents, background tasks, or anything that benefits from a dependency graph and parallel-track detection. For zero-ceremony single helpers use the reserved `scratch` workstream; for one-shot "fire and get a result back" prefer pi-subagents.
---

# mu — Multi-agent orchestration

`mu` manages long-lived AI agents in multiplexer panes (tmux or
herdr), coordinated by a SQLite task DAG at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

**Trust `mu --help` / `mu <verb> --help` over this skill.** Verbs
not in `--help` do not exist.

## Output + JSON shapes

Default output: textual card on stdout plus a `Next:` block. Read
both. `--json` exists on every verb:
- Success: one stdout object.
- Collection reads (`task list`, `workspace commits`, ...): `{items: T[], count: number}`.
- Singletons keep named fields.
- `mu sql --json`: bare array rows.
- `mu log --tail`: NDJSON (one object per line).
- Errors: `{error,message,nextSteps,exitCode}` on stderr.
- Validation errors also include structured `usage`.
- **`nextSteps` survives in JSON.**

## Vocabulary

- **workstream** — unit of organization; one **mux session** named
  `mu-<name>` (a tmux session, or a herdr workspace).
- **agent** — named worker in a pane (you may be one).
- **mux** — the multiplexer mu drives: tmux, or herdr. One per
  invocation. `mu doctor` names the active one; `MU_MUX` forces it.
  Spawn, send, read, and status detection work on both; `mu agent
  kick` is herdr's remaining gap (Linux-only there).
- **task** — DAG node with mandatory `impact` (1–100) and
  `effort_days`. Status: `OPEN`, `IN_PROGRESS`, `CLOSED`
  (satisfies `--blocked-by`). Record postponed/wont-do rationale as
  task notes; close the task to satisfy blockers.
- **claim / release** — atomic take/clear of `tasks.owner`.
- **note** — append-only task context; survives sessions.
- **track** — independent DAG subtree; don't spawn more agents than
  ready tracks.
- **workspace** — per-agent VCS copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

## When to use mu

Use mu for persistent helpers, parallel work, dependencies, gated review, or
work that must survive context compaction. Use `pi-subagents` for one focused
answer and no follow-up; stay in one context for tiny edits or inspection.

### Off-the-cuff helpers (`scratch`)

Use the reserved `scratch` workstream for a helper you will keep driving but
that needs no task DAG. It auto-creates on spawn.

- For task-less work, `mu agent wait <name> --first` waits for busy → idle;
  exit 0 means met, 5 timeout, 6 pane died.
- For a watcher, persist last-seen state in a log ledger: write `mu log -w
  scratch --kind pr-state 'pr=1234 sha=abc ci=red'`, then read `mu log -w
  scratch --kind pr-state -n 1 --json`. Act only on change; chat context is not
  durable.
- Use one agent per independent unit and `--workspace` for any helper that may
  edit, build, or test the shared repo.

A helper stuck at `needs_input` immediately after spawn likely hit pi's project
trust prompt. Add `--approve` to the existing `MU_<CLI>_COMMAND`; use
`--command` only to replace that configured command deliberately.

Move off `scratch` when work gains dependencies or review gates.

## Mental model

### Workstreams, DAGs, tracks

One workstream is one mux session and DB partition. Its task DAG has one edge:
`mu task block A --by B` means **B blocks A**. Parallel tracks sharing a
prerequisite collapse, preventing two agents from taking the same dependency.

### Workspaces prevent trampling

If an agent may edit/build/test while another agent is active in the
same repo, spawn with `--workspace`. Keep the main checkout for
orchestration: two builds in one checkout corrupt each other.

Workspaces auto-detect jj/sl/git; non-VCS uses `cp -a`. They are
auto-freed on `mu agent close` **iff clean**: no uncommitted changes
and no commits since fork. Non-clean close fails with
`WorkspacePreservedError`; then use `mu workspace free <agent>` or
`mu agent close <agent> --discard-workspace` (lossy).

Between waves, `mu workspace refresh <agent>` rebases onto fresh main without
killing LLM context. Claim/send warn at ≥10 commits behind; scripts can make
that a refusal with `--strict-staleness`.

### Remote agents

Agents can run on another machine: the PANE is local, the PROCESS is
remote (`--command 'ssh <host> -t "..."'`), so `send`, `read`, status
detection and the reaper all keep working unchanged. **One orchestrator
DB; panes may be remote** — never run a second mu on the host, since
`tasks.owner_id` is an FK into the machine-local `agents` table and a
remote mu could not claim your tasks anyway. You create the remote
workspace yourself (`--workspace` is local-only).

**Read [REMOTE_WORKERS.md](REMOTE_WORKERS.md) before spawning your first
remote agent, and again before waiting on one; poll once per turn and run
the claim's one-shot `Next:` command.** These are the other three traps
that cost real time when learned late:
- **On a session-capped host, route long commands and silent-failure
  polls through [coop](https://github.com/martintrojer/coop).** A refused
  bare `rev-parse` can return an empty sha that looks like progress;
  batch all workers in one `--max-secs`-bounded coop job.
- **`coop` exit 3 is a HANDBACK** — no ssh master, and opening one can
  need a human to touch a hardware key. Ask the operator; never retry,
  never run `ssh -MNf` yourself, never fall back to `ssh <host> <cmd>`.
- **Exit 4 and 6 mean wait again; 5 means never.** Neither says the work
  failed.

### Agent names

Use roles: `worker-1`, `worker-2`, `reviewer-1`, `scout-1`,
`auditor-1`, `planner-1`. Smallest unused suffix. Avoid human names.

### Task note contract

End every delegated task with a note containing the applicable
fields:

```text
FILES:    paths inspected/changed (line ranges if precise)
COMMANDS: commands run + exit codes
FINDINGS: what you observed
DECISION: what you chose, and why
NEXT:     follow-on tasks
VERIFIED: tests/checks/output
ODDITIES: weird things not acted on
```

Then close with grounding:

```bash
mu task close <id> -w <ws> --evidence "tests pass: cargo test exit 0"
```

Future agents can reconstruct context via `mu task notes <id>`.

## Orchestrator loop

Every turn:

1. `mu state -w <ws>` — read agents, IN_PROGRESS, ready tasks,
   parallel tracks.
2. Spawn at most one agent per independent ready track.
3. **Claim before sending — even one-shot reviewers/scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   If no task exists, `mu task add` first; include initial context with
   `--note 'REPRO: ...\nSCOPE: ...'` when the title alone is not
   enough. Agent status is noisy; task ownership is durable and
   waitable.
4. Send terse instructions: task id, files/notes to read, workspace
   path, validation command, scope guards, task note contract.
5. End with a loud final-action block:

   ```text
   ⚠️ FINAL ACTION
   git commit -am '...' THEN
   mu task close <id> -w <ws> --evidence '...'
   ```

6. `mu task wait ... --first --json` (choose stall handling from `--help`).
7. Cherry-pick the closed worker's **new** commit(s), verify the MERGE
   (see below), return control. Do not barrier or loop in shell.
8. Repeat from `mu state`.

## Dispatch rules that prevent real failures

- **Pipeline; don't barrier.** Wait for one task, cherry-pick only its new
  commits onto main, verify the combined tree, then return control. Waiting on an
  umbrella task hides partial progress; merging stale branches can restore
  reverted code.
- **Verify the merge, not the worker's rerun.** The worker tested against its
  fork point; only the combination with moved main is new. This found three
  integration breaks where rerunning worker suites found none. For remote work,
  run the merged gate on the host with warm dependencies: 500s × 30 integrations
  is four laptop-hours. Keep platform-sensitive checks and the final release gate
  local; macOS `ps` once exposed a bug Linux could not.
- Bucket waves by file cluster, not severity; two agents editing one file
  conflict. Refresh workspaces between waves.
- Cross-workstream wait/claim uses qualified refs. The owner stays in its own
  workstream; only task ownership crosses.
- For an idle worker, inspect scrollback, then send a retry or release its task.
  `MU_IDLE_THRESHOLD_MS` defaults to 5m.
- `mu agent kick` targets a wedged foreground subprocess. It refuses to signal
  the wrapping CLI; close the agent if that is what must stop.
- Use `mu agent send`, not raw mux input: mu preserves literal text and confirms
  submission. Single-quote prompts containing shell expansions, or use a quoted
  heredoc.

## CLI gotchas

- **`workstream teardown`** is dry-run by default; `--yes` commits. It writes
  TOMBSTONE ops, so history survives and `mu undo <group> --yes` reverses the
  deletions — do NOT `mu db backup` first, the log IS the backup.
  `workstream list --torn-down` replays past teardowns with the group id to
  undo, newest first, marking ones already recreated.
- **`agent wait <names...> --first`** blocks until an agent stops working
  (busy → anything else) — the task-less counterpart to `mu task wait`, for
  helpers that own no task. Use it instead of a `sleep` loop. Exit 0 met,
  5 timeout, 6 pane died.
- **`task close --if-ready`** no-ops until every blocker is CLOSED; bare
  `task release` reopens IN_PROGRESS.
- **For waits use `task wait`, not `log --tail`.** `--kind` is the operator's
  log-ledger channel; `--intent` is what mu recorded.
- **`mu undo`** bare lists undoable actions with group ids; `<group>` previews;
  `<group> --yes` applies. It emits INVERSE ops for that one group, so it
  touches nothing else, and the undo is itself an op — REDO is
  `mu undo <that group> --yes`. Refuses with exit 4 if a later action changed
  the same fields (`--force` discards that newer work). Rows only: killed panes
  and freed workspace dirs do not come back. No snapshots, no `--to`.
- **`mu rebuild <file>`** writes a NEW DB from the ops log. Agents and
  workspaces are absent because they have no captured ops; re-spawn after swap.
- **`mu sql`** alone skips ambient sync, preserving no-surprise mutations.
- **`mu db backup`** is a convenient copy; real recovery is `mu rebuild`.
- **Sync (laptop ↔ devserver):** `export MU_SYNC_DIR=$HOME/Sync/mu` on each
  machine pointing at a shared folder (Syncthing recommended). Every command
  then flushes your ops and ingests peers' — ambient, no daemon — so a bare
  `mu task list` on the other box already shows what you added here. Merge is
  per-FIELD, so two machines editing different fields of one task both keep
  their edit. `mu sync` bare reports peer status plus a copy-pasteable rsync
  line; mu never runs ssh/scp/rsync itself. `--from <peer-mu.db>` reads a
  peer's ops directly; `--repair <peer>` re-reads from zero and is always safe
  (ingest is idempotent).
  **NEVER put `MU_DB_PATH` inside `MU_SYNC_DIR`** — it corrupts the DB and
  `mu doctor` hard-fails. Agent/workspace state and task OWNERSHIP are
  machine-local and never travel.
- **`mu doctor`** runs fast checks; `--deep` rebuilds the log into a temp DB and
  diffs it field-by-field. DRIFT means the log and the tables disagree, which
  breaks undo and sync at once (exit 5, naming table, key and field). It is a
  capture bug, not operator error: back up and report it, do NOT reflexively
  rebuild — if capture missed a mutation, the live rows hold the real work.
  The `disk` section reconciles state-dir against DB both ways and is
  **report-only**: `ws-rows` is a row whose directory is gone (nothing else
  reports it), `ws-dirs` blocks the next `--workspace` spawn, and an orphan dir
  may hold the only copy of uncommitted work — which is why mu prints the
  cleanup command and runs none of them. `--disk` adds per-checkout byte usage.

## `mu task wait`

Use `--first` when the next step needs the firing task: unlike `--any`, it
populates `.firing`. Exit 6 means a dead pane; exit 7 means stall. For remote
workers, see [REMOTE_WORKERS.md](REMOTE_WORKERS.md) before choosing timeout or
stall handling.

## Models and thinking effort

mu doesn't reason about models; pi does. Controls:

```bash
mu agent spawn r --command "pi --model opus:high"
export MU_PI_COMMAND="pi --model sonnet:medium"
mu agent spawn a --cli pi_big   # uses $MU_PI_BIG_COMMAND
```

Convention: `pi_mini` / `pi` / `pi_big`. Use mini for probing,
modest for build/edit/refactor, big for design/review/incidents.
Discover model strings with `pi --list-models [fuzzy-search]`.

## Reaper and status limits

If an agent pane dies, or `mu agent close` kills it mid-task, owned
IN_PROGRESS tasks revert to OPEN with a `[reaper]` note and `task
reap` op. No manual release after crashes.

Status detection is heuristic and can lag behind custom `--command`
wrappers. It is weakest for a remote worker, where the scrollback is a
nested tmux rendered over ssh.

**[murmur](https://github.com/martintrojer/murmur), if installed, is
authoritative there** — its extension pushes state from inside the agent
on the host rather than scraping a pane, and it answers across machines.
Optional and strictly additive: nothing here needs it, and the seam is
the env vars `mu agent spawn` already injects (`MU_MANAGED_AGENT`,
`MU_AGENT_NAME`, `MU_WORKSTREAM`), which murmur reads to mark a pane as
crew. **mu owns the work; murmur owns what an agent is doing.** See
[REMOTE_WORKERS.md](REMOTE_WORKERS.md) § mu and murmur.

For high-stakes decisions:

```bash
mu agent read worker-1 -n 100
mu log -w <ws> --tail
mu task notes <id>
```

## In-pane worker loop

`$MU_AGENT_NAME`, injected at spawn, resolves identity; the pane title
is the fallback that adopted panes need. Env-first means this loop is
identical whichever multiplexer you are in — you never need to know.

- Worker pane: spawned/adopted by mu; bare `mu task claim <id>` works.
- Orchestrator pane: not registered; bare `claim` errors with next
  steps: `--self`, `--for <worker>`, or `mu agent adopt <pane>`.

```bash
mu me
mu me next
mu task show <id>; mu task notes <id>
mu task claim <id> --evidence "starting; read notes"
mu task note <id> "FILES: ...\nDECISION: ...\nVERIFIED: ..."
mu task close <id> --evidence "tests pass: ..."  # LAST action
```

Skipping close makes the orchestrator's wait hang.

## Follow-on prompts

A new `mu agent send` appends to prior LLM context. For unrelated
work, clear first (`/new` for pi/claude-code; `/clear` for codex):

```bash
mu agent send worker-1 '/new'
mu agent send worker-1 'Claim and work on task_x. Read notes first...'
```

No `sleep` needed. `mu agent send` waits for the pane to finish any
re-initialisation before pasting, and re-submits if the TUI swallowed
the Enter. If a send cannot be confirmed it prints a `warning:` to
stderr naming the pane; exit 0 with no warning means submitted.

Budget is `MU_SEND_READINESS_MS` (default 15000; 0 = fire-and-forget).
Sending to a BUSY agent is not delayed — that input queues normally.

## Guardrails

Task ownership outranks scraped status. Coordinate through task notes and the
activity log. Keep edges within one workstream, role-name agents, and reserve
the `mu_` task-id prefix. Give workers bounded paths and commands; use `mu
agent kick` if a subprocess wedges.

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
