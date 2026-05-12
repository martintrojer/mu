---
name: mu
description: Manage a persistent crew of pi agents in tmux panes coordinated through a built-in task graph. Use when the user asks to spawn, send work to, observe, or coordinate multiple sub-agents — especially long-lived ones, or work that benefits from a dependency graph and parallel-track detection.
---

# mu — Multi-agent orchestration

`mu` is a CLI for managing a persistent crew of AI agents in tmux
panes coordinated through a task graph. State lives at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db` (SQLite).

**Output:**
- Default: every verb prints a textual card on stdout AND a `Next:`
  block of suggested follow-up commands. Read both.
- `--json` (every verb): success → one object on stdout. Collection
  reads (`task list`, `workspace commits`, `archive search`, ...)
  emit `{items: T[], count: number}`; singletons keep named fields.
  Carve-outs: `mu sql --json` is bare-array rows; `mu log --tail`
  is NDJSON (one object per line). Errors →
  `{error,message,nextSteps,exitCode}` on stderr; validation errors
  ALSO carry `usage` (structured `--help`). **`nextSteps` survives
  in JSON** — `mu task wait --first --json` literally puts the
  cherry-pick command in `.nextSteps[0].command`.

**Trust `mu --help` and `mu <verb> --help` over this skill** if they
disagree. Verbs not in `--help` do not exist.

## Vocabulary

- **workstream** — unit of organization; one tmux session
  (`mu-<name>`).
- **agent** — a named worker in a tmux pane (you may be one).
- **task** — a node in the DAG; mandatory `impact` (1–100) and
  `effort_days`. Status: `OPEN`, `IN_PROGRESS`, `CLOSED` (the only
  state that satisfies a `--blocked-by` edge), `REJECTED` (terminal
  won't-do; still blocks downstream), `DEFERRED` (parked; still
  blocks downstream).
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

The orchestrator's first decision is whether to reach for mu at all.

## Mental model

### One workstream = one tmux session

Named `mu-<workstream>`. Every agent is a pane in that session.
Multiple workstreams = multiple tmux sessions, partitioned in the
DB by `workstream`.

### The task DAG drives coordination

One edge type: `blocks`. `mu task block A --by B` means **B blocks
A** (B must close first). Built-in views: `ready`, `blocked`,
`goals`. Bare `mu` shows **parallel tracks** with **automatic
diamond-merge**: goals sharing a prerequisite collapse into one
track. Don't spawn more agents than there are tracks.

### Per-agent workspaces stop trampling

For two agents editing the same project, use `--workspace` on spawn.
Each gets an isolated working copy under
`<state-dir>/workspaces/<workstream>/<agent>/`. Auto-detects
jj/sl/git; `cp -a` for non-VCS. Workspaces are auto-freed when
you close an agent **iff the workspace is clean** (no uncommitted
changes AND no commits since fork); a non-clean workspace blocks
`mu agent close` with `WorkspacePreservedError` and forces an
explicit `mu workspace free <agent>` (or
`mu agent close <agent> --discard-workspace` for the lossy override).
Between
waves, `mu workspace refresh <agent>` rebases the dir onto fresh
main without killing the agent's LLM context; `mu workspace commits
<agent>` lists since-fork commits for cherry-picking.

**Default rule:** if an agent may edit/build/test/generate
artifacts while another agent is active in the same repo, spawn
with `--workspace`. Reserve the main checkout for orchestration.
Two builds in the same checkout corrupt each other's artifacts.

### Name agents by role, not by person

Use `worker-1`, `worker-2`, `reviewer-1`, `scout-1`, `auditor-1`,
`planner-1`. Smallest unused suffix. Avoid human names —
anthropomorphizing makes coordination prompts ambiguous ("send
follow-up to alice" vs "send to worker-1").

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
   scope guards, the task note contract. End with the loud
   `⚠️ FINAL ACTION` block (see lessons below).
5. Wait for *one* task to close (`--first`), cherry-pick, return
   control. Do NOT loop in your own shell — see lessons.
6. On close, repeat from 1.

## Hard-earned dispatch lessons

Every one of these came from real failure modes. Re-read before
running a wave.

- **Pipeline cherry-picks; DON'T BARRIER.** This is the single most
  important rule. One wait, one cherry-pick, one verify, return
  control. Do NOT `mu task wait umbrella_wave_X` and block until
  everything in the wave finishes — you give up the ability to
  react per-finish, and you can't surface partial progress.
  Don't loop in a shell script either; that's a barrier with extra
  steps.

  ```bash
  # YES — pipeline (returns the moment one task closes)
  closed=$(mu task wait t1 t2 t3 -w ws --any --first --json \
           --on-stall exit | jq -r .firing.qualifiedId)
  # cherry-pick that worker's commit, verify, return control.
  # Next turn: same wait on the smaller set.
  ```

  The recipe is also in `mu task wait`'s `nextSteps` — `jq` it out.

- **Refresh workspaces between waves.** `mu workspace refresh
  <agent>` rebases the agent's dir onto fresh main without killing
  the LLM context. The `behind` column in `mu workspace list` shows
  the cost of skipping it. Worker ships clean code against a stale
  parent otherwise; you find out at cherry-pick time.

- **Cherry-pick worker commits onto main, don't merge.** Stale-parent
  worker branches drag in re-reverts of everything they missed.

- **Bucket fix waves by file cluster, not by severity.** Two workers
  editing the same file = cherry-pick conflicts at merge time. mu
  doesn't help you here; you have to know the codebase.

- **End every dispatch prompt with a loud `⚠️ FINAL ACTION: git
  commit -am '...' THEN mu task close <id> --evidence '...'`.**
  Without the literal reminder, agents commit + report success in
  chat without running the typed close, and `mu task wait` hangs.

- **`--on-stall exit` is the unattended-orchestrator escape.**
  Default `mu task wait` warns on a stuck worker and KEEPS POLLING.
  In any non-interactive flow (wrapping policies, cron, long
  pipelines, multi-step orchestration), pass `--on-stall exit`:
  exits 7 (`STALL_DETECTED`) the moment the predicate fires.
  Distinct from exit 6 (`REAPER_DETECTED`, dead pane —
  re-dispatch); exit 7 is the ambiguous sibling (alive but idle —
  decide whether to poke, release, or roll over). If both fire in
  the same poll, exit 6 wins.

- **Cross-workstream `mu task wait` is built in.** Pass qualified
  refs `<workstream>/<name>` directly; `-w` is dropped when every
  ref is qualified, and the per-poll reconcile loops over every
  workstream in the set.

- **Cross-workstream `mu task claim --for` is built in.** When
  per-workstream worker pools leave a free worker in workstream A
  and a queued task in workstream B, dispatch with `mu task claim X
  -w B --for A/worker-1`. The agent stays in A; only the task's
  `owner_id` crosses. No need to close + re-spawn (which loses LLM
  context) or reach for `mu sql`.

- **Keep dispatch prompts terse.** Workers have the same skills as
  the orchestrator and can `mu task notes <id>` for the full spec.
  The prompt only needs: who they are, the task id, the workspace
  path, the validate command, and the loud final-action block.

- **Idle agent (⚠ glyph; alive but assigned, no recent progress)** —
  see scrollback via `mu agent show <name> -n N`; recover via
  `mu agent send <name> '<retry>'` OR `mu task release <id>` (bare
  release auto-flips IN_PROGRESS → OPEN; `--reopen` is only for
  un-closing CLOSED/REJECTED/DEFERRED). Tunable via
  `MU_IDLE_THRESHOLD_MS` (default 5 min).

- **Wedged on an unbounded tool subprocess (`find /`, busy-wait
  loop)** — `mu agent send` queues until the tool returns;
  `tmux send-keys C-c` doesn't propagate (the wrapping CLI eats
  it as TUI input). Use `mu agent kick <name>` to SIGINT the
  foreground process group of the pane's TTY directly from
  outside. Default `--signal SIGINT` is graceful; escalate to
  `--signal SIGTERM` then `--signal SIGKILL` if the tool
  ignores it. Refuses when the foreground IS the wrapping CLI
  itself — use `mu agent close` for that.

## Parallelisation decision table

| Situation | Action |
|-----------|--------|
| One ready task / one track | Reuse one existing agent |
| Multiple independent ready tasks | Spawn one agent per ready track; cherry-pick each as it closes (don't barrier) |
| CPU-heavy benchmark in progress | Only parallelise read-only / audit tasks |
| Two agents editing/building/testing same repo | Use `--workspace` |
| Agent only reading docs/source | `--cli pi` (or operator alias) without `--workspace` is OK |
| Agent making code changes | `--workspace` strongly preferred |
| Agent reviewing/testing another agent's patch | Separate `--workspace` (or wait for the patch to merge) |

## Universal flags (worth knowing without `--help`)

- **`-w, --workstream <name>`** — explicit > `$MU_SESSION` > current
  tmux session minus `mu-` prefix > error. On verbs that take an
  entity by id, `-w` is a SCOPE check; on picker verbs (`mu task
  next`, `mu agent list`), it picks WHICH.
- **Qualified entity refs** — every verb accepts
  `<workstream>/<name>` in addition to bare `<name>`. The qualified
  form skips `-w` resolution: `mu task show ws/foo` works from any
  shell. Mixing a qualified ref with a non-matching `-w` errors out
  (exit 2). When a bare name appears AND no `-w` resolves AND ≥2
  workstreams contain that name, mu raises `NameAmbiguousError`
  (exit 4) and lists every candidate as a one-paste fix.
- **`--evidence "<text>"`** — on `task close / open / claim /
  release`. Recorded verbatim in the auto-emitted event payload.
  Use it for grounding ("tests pass: cargo test exit 0").
- **`--json`** — on every verb. Use it whenever you compose mu
  output into another command. `nextSteps` survives in JSON.

## CLI overview (one line each; trust `mu <verb> --help`)

- **Workstream**: `init`, `list`, `destroy` (auto-snapshots and
  `--archive <label>` to preserve graph atomically), `export`,
  `import`.
- **Agents**: `spawn` (`--workspace`, `--role read-only`,
  `--command`), `send`, `read`, `show`, `list`, `close`, `free`,
  `kick` (signal a wedged foreground tool subprocess from outside
  the pane). **`mu agent adopt <pane-id|title>`** registers an
  orphan pane as a managed agent.
- **Tasks**: `add`, `list`, `next`, `show`, `tree`, `notes`
  (`--tail N` / `--since <iso>` / `--since-claim` to slice the
  timeline; default = every note, oldest first), `note`,
  `claim` (`--for | --self`), `release` (`--reopen` to un-close),
  `close` (`--if-ready` = no-op unless every blocker terminal),
  `open`, `reject`, `defer`, `block`, `unblock`, `update`,
  `reparent`, `wait`, `delete` (two-phase; `--yes` commits).
  Edge direction: `block <blocked> --by <blocker>`.
- **Self (in-pane)**: `mu me`, `mu me tasks`, `mu me next`.
- **Workspace**: `create`, `list` (`behind` column), `refresh`
  (rebase onto fresh base, agent stays alive), `recreate` (free +
  create in one shot for between-wave prep; `--force` to discard
  dirty edits), `commits` (since-fork `<sha> <subject>`; `--json`
  for piping), `free`, `path` (`cd $(mu workspace path X)`),
  `orphans`.
- **Activity log**: `mu log "text"` (write), `mu log -n N` (read),
  `mu log --tail` (subscribe). Don't pipe `--tail` for waits — use
  `mu task wait`.
- **Snapshots/undo**: every destructive verb auto-snapshots first.
  `mu undo --yes` restores the latest (DB only, NOT tmux/workspace
  dirs). `mu snapshot list/show/prune/delete`.
- **Archives**: `create <label>`, `list`, `show`, `add <label> -w
  <ws> [--destroy]` (idempotent; preserves task graph atomically),
  `remove`, `delete`, `search`, `export`. Labels globally unique.
- **Escape hatch + state**: `mu sql "<query>"` for anything not yet
  typed. `mu` alone = `mu state --mission`. `mu state` has `--tui`
  (interactive ink dashboard; read-only, yanks `mu` commands;
  `1`-`5` toggle cards, `!`/`@`/`#`/`$` open list popups, `Enter`
  drills (in the Activity log popup it opens the focused event's
  full untruncated payload), `/` filters list popups incrementally, `?`/`F1` keymap,
  `q`/`Ctrl-C` quits), `--mission`, `--all`, `--json`. `mu doctor`
  for health.

## `mu task wait` exits

Default target: CLOSED. `--first` = `--any` + prints firing
qualified id and emits `firing` in JSON.

| Code | Meaning |
|------|---------|
| 0 | All targets met (or `--any` and one met) |
| 3 | Missing task id |
| 5 | Timeout |
| 6 | Reaper flipped a watched task back to OPEN (target=CLOSED only) |
| 7 | Stall (`--on-stall exit`) |

## Picking model + thinking effort per agent

mu doesn't reason about models. Pi speaks `--model sonnet:high` and
`--thinking off|minimal|low|medium|high|xhigh`.

Three controls, smallest first:
- **Per-spawn**: `mu agent spawn r --command "pi --model opus:high"`
- **Shell default**: `export MU_PI_COMMAND="pi --model sonnet:medium"`
- **Operator aliases**: any `--cli <key>` uppercases to
  `$MU_<KEY>_COMMAND` (use underscores). Convention: `pi_mini` /
  `pi` / `pi_big`. mu doesn't enforce these.

Rubric: mini for probing/fan-out; modest for build/edit/refactor;
big for design/review/incident/gnarly debugging. Discover valid
model strings: `pi --list-models [fuzzy-search]`.

## The reaper

When an agent's pane dies (or you `mu agent close` mid-task), any
IN_PROGRESS task it owned auto-reverts to OPEN with a `[reaper]`
note plus a `task reap` event in `agent_logs`. You don't have to
manually `task release` after a crash.

## Known limitations

- **Status detection lags with custom `--command` wrappers.**
  Agents may show `needs_input` while running commands. Trust
  scrollback, task notes, and event log over the status emoji for
  monitoring decisions.
- **Workspace patch flow needs explicit apply.** Worker writes in
  isolated workspace → review → parity tests in workspace → manual
  cherry-pick to main → sanity test. Worth it for any patch that
  benefits from review; overkill for a one-line typo fix.
- **Orchestration overhead is real for tiny tasks.** Task create +
  claim + send + monitor + notes + close is ~6 verbs of ceremony.
  See "When to reach for mu" above.

## Common patterns

The `Next:` block on every verb covers the single-step follow-ups.
These are the **multi-verb composites** that no hint can show.

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

### Pipeline cherry-pick (the canonical fix-wave loop)

```bash
# Wait for any-of N to close, cherry-pick that one, return.
res=$(mu task wait t1 t2 t3 -w ws --any --first --json \
        --timeout 600 --on-stall exit)
worker=$(jq -r .firing.owner <<<"$res")
# Workers run in fresh single-purpose workspaces, so HEAD is the
# task's commit. Don't filter on subject — workers don't prefix
# subjects with the task-id, and any such filter silently returns
# empty (then `git cherry-pick` fails with "empty commit set").
sha=$(mu workspace commits $worker -w ws --json | jq -r '.items[0].sha')
git cherry-pick $sha && cargo test --lib
# Next turn: same wait on the smaller set.
```

### Umbrella-on-wave-done

Fire `mu task close umbrella_wave_X --if-ready -w <ws>` after every
cherry-pick in the pipeline loop. No-op while any blocker is
OPEN/IN_PROGRESS; closes when the last terminates. JSON no-op shape
carries `skipped: "not_ready"` + `blockingIds: [...]`.

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

The status emoji is a 4-state heuristic from prompt shape. For
high-stakes calls, combine:

```bash
mu agent read worker-1 -n 100         # pane scrollback
mu log -w <ws> --kind event --tail    # state-change stream
mu task notes <id>                    # decisions + grounding
```

### Sending follow-on work to an existing agent

A new prompt is appended to whatever context the agent had. For
**unrelated** work, send `/new` first (pi / claude-code; codex uses
`/clear`) to wipe the LLM's working set — pane scrollback is preserved:

```bash
mu agent send worker-1 '/new'
sleep 1                              # let the CLI swallow the slash command
mu agent send worker-1 "$(cat <<'EOF_PROMPT'
Claim and work on $TASK. Read the task notes before starting...
EOF_PROMPT
)"
```

### Recover from a destructive verb

`mu snapshot list` then `mu undo --yes` (dry-run by default; add
`--to <id>` to pick one). DB only — killed tmux panes and freed
workspace dirs do NOT come back. There is no `mu redo`; each
restore takes a pre-restore snapshot, so a second `mu undo --yes`
rolls forward.

## If you ARE the agent (in-pane patterns)

Verbs auto-resolve via `$TMUX_PANE` — `mu me`, `mu me next`,
`mu task claim` all work without a name argument. The pane title
(set at spawn) IS the agent identity.

- **Worker**: pane was created by `mu agent spawn` (or promoted via
  `mu agent adopt`). Bare `mu task claim <id>` works.
- **Orchestrator**: a top-level pi session NOT in `agents`. Bare
  `mu task claim` errors with `ClaimerNotRegisteredError` whose
  `errorNextSteps()` lists three options: `--self` (work directly,
  owner=NULL), `--for <worker>` (dispatch), or `mu agent adopt <pane>`.

Working loop:

```bash
mu me                                            # orient
mu me next                                       # find work
mu task show <id>; mu task notes <id>            # read context
mu task claim <id> --evidence "..."              # claim
mu task note <id> "FILES: ...\nDECISION: ..."    # work; drop notes
mu task close <id> --evidence "tests pass: ..."  # close — LAST action
```

**Close as the LAST action.** Skipping `mu task close` makes the
orchestrator's `mu task wait` hang.

## DOs

- **`mu state -w <ws>` before every action.** State card is the
  source of truth.
- **Add a task before assigning work.** "What is worker-1 doing?"
  is a graph query, not a memory test.
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
- **`mu task wait --first --json` for waits; never `mu log --tail
  | awk` and never a shell `while` loop polling status.**
- **`--json` for scripting; `mu sql` for what's not yet typed.**
- **`mu doctor` if anything looks off.**

## DON'Ts

- **Don't barrier on a wave umbrella.** Use `--first --any` and
  cherry-pick per-finish. Returning control between picks is the
  point.
- **Don't loop in your own shell waiting for "everything to be
  done."** That's a barrier with extra steps. Single wait, single
  cherry-pick, return.
- **Don't fire-and-forget** after `mu agent send`.
- **Don't trust the status emoji alone for high-stakes calls.**
- **Don't double-quote a `$VAR`-laden prompt** — your shell expands
  it. Single-quote or quoted-heredoc.
- **Don't bypass mu with `sqlite3`.** Use `mu sql`.
- **Don't spawn an agent without a workstream.**
- **Don't anthropomorphize agent names.** `worker-1`, not `alice`.
- **Don't poll `mu agent read` in tight loops.** Use `mu log
  --tail` for streaming, `mu task wait` for waits.
- **Don't add cross-workstream edges.** Model as one workstream.
- **Don't `mu workstream destroy --yes` without the dry-run.**
- **Don't use the `mu_` task-id prefix.** Reserved.
- **Don't message agents directly.** Coordinate via task notes and
  the activity log.
- **Don't prompt workers to run filesystem-wide `find`, broad
  `grep -r /`, or unbounded busy-wait loops.** Pass paths
  explicitly or scope to `$WORKSPACE`. If a worker wedges on one,
  use `mu agent kick <name>` to SIGINT the foreground tool
  from outside the pane.

## What mu is NOT

- Not a build tool. mu doesn't compile, test, or deploy code.
- Not a chat protocol — agent-to-agent comms is via task notes
  (durable, per-task) and the `mu log` activity channel (timeline).
- Not a replacement for `pi-subagents` — for one-shot focused
  delegation with synthesis, use `pi-subagents`. mu is for
  long-lived crews you keep talking to.

## See also

- `mu --help` and `mu <verb> --help` — canonical CLI reference
  (always trust `--help` over this skill if they disagree).
- `docs/USAGE_GUIDE.md` — worked examples for every verb.
- `CHANGELOG.md` — release notes.
- `docs/VOCABULARY.md` — canonical terms.
