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
- **`nextSteps` survives in JSON**. `mu task wait --first --json`
  puts the cherry-pick command in `.nextSteps[0].command`.

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

Use mu for multi-phase work, review-gated work (`implement → review
→ address → ship`), parallel audits, implementation/reviewer splits,
and anything that must survive context compaction via task notes.

Don't use mu for tiny one-file edits, one-off inspection, or
single-context work where durable coordination adds ceremony.

### Off-the-cuff helpers (the `scratch` workstream)

Want a sub-agent you'll **keep talking to** without a crew or task
DAG? Spawn into the reserved `scratch` workstream. No `mu workstream
init`; it auto-creates and is task-less by design.

```bash
mu agent spawn helper-1 -w scratch     # auto-creates mu-scratch
mu agent send helper-1 'Investigate X. Report findings.'
mu agent read helper-1 -n 50           # check at a natural pause, not in a loop
mu agent close helper-1 -w scratch     # done
```

- **Background watcher:** send the task, then `mu agent wait <name>
  --first` to block until it finishes (busy → idle) instead of a
  `sleep` loop; re-nudge with another `send` (e.g. `'run again'`).
- **Watcher dedupe/memory (log ledger):** a watcher reacting to
  changing external state must remember what it last saw. Chat
  context dies on compaction; use a custom `--kind` tag as a durable
  SQLite ledger instead. Each tick records last-seen state with `mu
  log -w scratch --kind pr-state 'pr=1234 sha=abc ci=red -> spawned
  fixer-1'`; the next tick reads it back with `mu log -w scratch
  --kind pr-state -n 1 --json` (latest wins; `--since <seq>` replays
  missed history). Act only when the new observation differs.
- **Fan-out, one per unit:** loop `mu agent spawn dep-$pkg -w scratch
  --workspace`, then `mu agent wait dep-core dep-cli dep-web` (all) or
  `--any` to react to whichever finishes first. Add `--workspace`
  whenever a helper will edit/build/test a shared repo (see
  "Workspaces prevent trampling"); skip it for read-only helpers.
  `mu state -w scratch` watches them all.

If a helper wedges at `needs_input` right after spawn, it's likely
pi's project-trust prompt; add `--approve` to the existing
`MU_<CLI>_COMMAND`, or pass `--command 'pi --approve'` only when you
intend to override the env-configured command.

**Escalate off `scratch`** the moment helpers have dependencies
(B needs A) or you want gated review → `mu workstream init` + task
DAG. One focused answer, no follow-up → `pi-subagents`. `scratch` is
the middle: "fire, but keep the channel open."

## Mental model

### Workstreams, DAGs, tracks

One workstream = one mux session named `mu-<workstream>`. Every
agent is a pane in that session. DB rows are partitioned by
`workstream`.

One edge type: `blocks`. `mu task block A --by B` means **B blocks
A**. `--by` takes multiple blockers (`--by B,C` or `--by B --by C`),
same shape as `mu task add --blocked-by`. Built-in views: `ready`, `blocked`, `goals`. Bare `mu` shows
parallel tracks with automatic diamond-merge: goals sharing a
prerequisite collapse into one track.

### Workspaces prevent trampling

If an agent may edit/build/test while another agent is active in the
same repo, spawn with `--workspace`. Keep the main checkout for
orchestration: two builds in one checkout corrupt each other.

Workspaces auto-detect jj/sl/git; non-VCS uses `cp -a`. They are
auto-freed on `mu agent close` **iff clean**: no uncommitted changes
and no commits since fork. Non-clean close fails with
`WorkspacePreservedError`; then use `mu workspace free <agent>` or
`mu agent close <agent> --discard-workspace` (lossy).

Between waves:
- `mu workspace refresh <agent>` rebases onto fresh main without
  killing LLM context.
- `mu workspace free <agent>` throws the workspace away for good; a
  later `mu agent spawn --workspace` allocates a fresh one. There is
  no standalone create verb.
- `mu workspace commits <agent>` lists since-fork commits for
  cherry-picking.

Claim/send warn when a target workspace is ≥10 commits behind main;
refresh first or pass `--strict-staleness` in scripts.

### Remote agents

Agents can run on another machine: the PANE is local, the PROCESS is
remote (`--command 'ssh <host> -t "..."'`), so `send`, `read`, status
detection and the reaper all keep working unchanged. **One orchestrator
DB; panes may be remote** — never run a second mu on the host, since
`tasks.owner_id` is an FK into the machine-local `agents` table and a
remote mu could not claim your tasks anyway. You create the remote
workspace yourself (`--workspace` is local-only) and collect with
`git fetch "ssh://<host>/<path>" HEAD && git cherry-pick FETCH_HEAD`.

**Read [REMOTE_WORKERS.md](REMOTE_WORKERS.md) before spawning your first
remote agent, and again before waiting on one.** Everything below is in
it; these are the four that cost real time when learned late:

- **Never block, and never sleep inside a tool call.** `sleep N && ssh
  dev ...` wedged a host three times in one session. Poll once per turn.
- **On a session-capped host, route LONG commands through
  [coop](https://github.com/martintrojer/coop)** — measured 1 of 5
  concurrent calls succeeded ungated, 5 of 5 through coop. Threshold is
  roughly one second of COMMAND time, so a poll loop does not qualify
  however long it runs. Bound dispatches with `--max-secs`.
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

6. `mu task wait ... --first --any --json --on-stall exit`.
7. Cherry-pick the closed worker's **new** commit(s), verify the MERGE
   (see below), return control. Do not barrier or loop in shell.
8. Repeat from `mu state`.

## Dispatch rules that prevent real failures

- **Pipeline cherry-picks; don't barrier.** One wait, one
  cherry-pick, one verify, return control. Do not wait on an
  umbrella task for the whole wave; that hides partial progress.
- **Use `--on-stall exit` in non-interactive flows.** Default wait
  warns on stalled alive workers and keeps polling. Exit 7 =
  `STALL_DETECTED`; exit 6 = `REAPER_DETECTED` (dead pane) and wins
  if both happen. **Not for remote workers** — stall detection reads
  pane scrollback, which over ssh gives false positives both ways. Use
  a generous `--timeout` instead; see
  [REMOTE_WORKERS.md](REMOTE_WORKERS.md).
- **Cherry-pick worker commits onto main; don't merge.** Stale
  branches can drag re-reverts.
- **Verify the MERGE, never re-run the worker's own suite.** The worker
  already ran it and reported green; running the same commits again on
  the orchestrator proves nothing and is the single most expensive habit
  in this loop. What is genuinely unverified is the COMBINATION: the
  worker validated its change against the base it forked from, and main
  has moved since. Measured on one real session: re-running a worker's
  own commit never once found anything, while the merge broke tests in
  files no worker had touched three separate times.

  So verify, but verify the right thing, and prefer to verify it where
  the compute is. If workers run on a remote host, push the merged head
  and run the gate THERE — it already has a checkout and warm
  dependencies, and the orchestrator's job becomes `cherry-pick` plus
  `push`, which is IO rather than CPU. A 500s suite times thirty
  integrations is four hours of laptop that bought nothing.

  Two things still belong local: a **platform-sensitive** subset, because
  a remote green does not prove a local green when the bug is
  platform-shaped (a real one: macOS `ps` omits the environment that
  Linux `ps` appends, so the remote suite could not have caught it), and
  the **final** gate before the push that matters.
- **Cherry-pick only new shas.** `workspace commits` lists since
  fork; track what you've already integrated. Don't replay the whole
  worker range each time.
- **Bucket fix waves by file cluster, not severity.** Two workers
  editing one file create merge conflicts.
- **Refresh workspaces between waves.** The `behind` column
  in `mu workspace list` shows stale-parent risk.
- **Cross-workstream wait/claim:** pass qualified refs
  `<workstream>/<name>`. For `claim --for A/worker-1` on a task in
  B, the agent stays in A; only task ownership crosses.
- **Recover idle agents:** `mu agent show <name> -n N`; then send a
  retry or `mu task release <id>` (bare release reopens
  IN_PROGRESS). Idle threshold: `MU_IDLE_THRESHOLD_MS`, default 5m.
- **Recover wedged tool subprocesses:** `mu agent kick <name>` sends
  SIGINT to the pane TTY foreground process group. Escalate with
  `--signal SIGTERM` / `SIGKILL`. It refuses when the foreground is
  the wrapping CLI; use `mu agent close` then.
- **Use `mu agent send`; never raw `tmux send-keys <text>` or
  `herdr pane send-text`.** mu delivers text atomically — bracketed
  paste on tmux, `agent prompt` on herdr — so `/`, `?`, `f`, etc.
  arrive as text instead of agent-TUI keybindings, and the Enter
  cannot be swallowed by a modal.
- **Prompt quoting:** single-quote prompts containing `$VAR`,
  `$(...)`, backticks, or `!history`, or use a quoted heredoc.

Example wait/cherry-pick skeleton:

```bash
res=$(mu task wait t1 t2 t3 -w ws --any --first --json \
        --timeout 600 --on-stall exit)
worker=$(jq -r .firing.owner <<<"$res")
sha=$(mu workspace commits "$worker" -w ws --json | jq -r '.items[0].sha')
git cherry-pick "$sha" && npm test
```

## Universal flags

- `-w, --workstream <name>` resolves explicit > `$MU_SESSION` >
  current mux session minus `mu-` > error. For entity verbs it is a
  scope check; for pickers it selects which workstream.
- Qualified refs `<workstream>/<name>` skip `-w`; mismatched `-w`
  errors. Bare ambiguous names raise `NameAmbiguousError` (exit 4)
  with one-paste fixes.
- `--evidence "text"` on task `claim` / `close` / `open` / `release`;
  recorded verbatim on the emitted op.
- `--json` for composition; `nextSteps` survives.

## CLI overview (gotchas only — `--help` is the verb list)

Every verb and flag is in `mu <verb> --help`, which cannot go stale. What
follows is only what `--help` does not say.

- **`workstream teardown`** is dry-run by default; `--yes` commits. It writes
  TOMBSTONE ops, so history survives and `mu undo <group> --yes` reverses the
  deletions — do NOT `mu db backup` first, the log IS the backup.
  `workstream list --torn-down` replays past teardowns with the group id to
  undo, newest first, marking ones already recreated.
- **`agent wait <names...> --first`** blocks until an agent stops working
  (busy → anything else) — the task-less counterpart to `mu task wait`, for
  helpers that own no task. Use it instead of a `sleep` loop. Exit 0 met,
  5 timeout, 6 pane died.
- **`agent adopt <pane-id|title>`** claims an orphan pane mu did not spawn.
- **`task close --if-ready`** no-ops until every blocker is CLOSED.
  **`task release --reopen`** un-closes; bare `release` reopens IN_PROGRESS.
  Edge direction is `task block <blocked> --by <blocker>`.
- **`task notes`** takes `--tail`, `--since` and `--since-claim` — the last is
  how a worker re-reads only what arrived after it claimed.
- **Workspace creation is not a verb.** It happens inside
  `mu agent spawn --workspace`; `mu workspace free` then `spawn` again to
  reallocate. `list` shows `behind` (stale-parent risk).
- **`mu log` filters:** `--intent task.close` (what mu recorded), `--kind <tag>`
  (your own channel — the log-ledger pattern), `--group <id>` (every op of one
  action, for undo). `--json` adds a `rendered` field so scripts never parse
  payloads. For waits use `task wait`, not `log --tail`.
- **`mu undo`** bare lists undoable actions with group ids; `<group>` previews;
  `<group> --yes` applies. It emits INVERSE ops for that one group, so it
  touches nothing else, and the undo is itself an op — REDO is
  `mu undo <that group> --yes`. Refuses with exit 4 if a later action changed
  the same fields (`--force` discards that newer work). Rows only: killed panes
  and freed workspace dirs do not come back. No snapshots, no `--to`.
- **`mu rebuild <file>`** replays the ops log into a NEW DB and prints the `mv`
  to swap it in; never in place. Agents and workspaces are NOT rebuilt (no
  capture triggers, so no ops) — re-spawn after swapping.
- **`mu sql`** is the escape hatch for a missing verb, and the ONE verb that
  does not ambient-sync (its no-surprise-mutations guarantee is load-bearing).
- **`mu db backup <file>`** is a `VACUUM INTO` copy that never overwrites — the
  "one file I can scp" convenience. Real recovery is `mu rebuild`.
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

## `mu task wait` exits

Default target: CLOSED. `--first` = `--any` plus the firing id/object.
**`firing` is `--first`-only.** `--any` exits 0 with `firing: null`, so
`.firing.owner` after `--any` crashes on a successful wait.

| Code | Meaning |
|------|---------|
| 0 | All targets met, or `--any` and one met |
| 3 | Missing task id |
| 5 | Timeout |
| 6 | Reaper flipped watched task back to OPEN (target=CLOSED only) |
| 7 | Stall with `--on-stall exit` |

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

## DON'T

The DO list lived here as a second copy of the Orchestrator loop and Dispatch
rules; those sections are the source of truth. What follows appears nowhere
else:

- Trust status emoji alone — task ownership is durable, status is scraped.
- Double-quote `$VAR`-laden prompts; single-quote or use a quoted heredoc.
- Bypass mu with `sqlite3`; use `mu sql`.
- Anthropomorphize agent names — roles, not humans.
- Add cross-workstream edges; model the work as one workstream.
- Use the reserved `mu_` task-id prefix.
- Message agents directly to coordinate; use task notes and the activity log.
- Prompt workers to run filesystem-wide `find` or broad `grep -r /`, or
  unbounded loops. Pass paths; if one wedges, `mu agent kick`.

## What mu is NOT

- Not a build tool, deploy tool, or chat protocol.
- Not a replacement for `pi-subagents`; mu is for long-lived crews.
- Not a place to add config files, daemons, wrapper layers, codegen,
  template discovery, or a render layer beyond current deps.

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
