---
name: mu
description: Manage a persistent crew of pi agents in tmux panes coordinated through a built-in task graph. Use when the user asks to spawn, send work to, observe, or coordinate multiple sub-agents — especially long-lived ones, or work that benefits from a dependency graph and parallel-track detection.
---

# mu — Multi-agent orchestration

`mu` manages long-lived AI agents in tmux panes, coordinated by a
SQLite task DAG at `<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

**Trust `mu --help` / `mu <verb> --help` over this skill.** Verbs
not in `--help` do not exist.

## Output + JSON shapes

Default output: textual card on stdout plus a `Next:` block. Read
both.

`--json` exists on every verb:
- Success: one stdout object.
- Collection reads (`task list`, `workspace commits`, `archive
  search`, ...): `{items: T[], count: number}`.
- Singletons keep named fields.
- `mu sql --json`: bare array rows.
- `mu log --tail`: NDJSON (one object per line).
- Errors: `{error,message,nextSteps,exitCode}` on stderr.
- Validation errors also include structured `usage`.
- **`nextSteps` survives in JSON**. `mu task wait --first --json`
  puts the cherry-pick command in `.nextSteps[0].command`.

## Vocabulary

- **workstream** — unit of organization; tmux session `mu-<name>`.
- **agent** — named worker in a tmux pane (you may be one).
- **task** — DAG node with mandatory `impact` (1–100) and
  `effort_days`. Status: `OPEN`, `IN_PROGRESS`, `CLOSED`
  (satisfies `--blocked-by`), `REJECTED` (terminal won't-do; still
  blocks), `DEFERRED` (parked; still blocks).
- **claim / release** — atomic take/clear of `tasks.owner`.
- **free** — mark the *agent* available (`mu agent free`); pane
  untouched. **Release is about the task; free is about the agent.**
- **note** — append-only task context; survives sessions.
- **track** — independent DAG subtree; don't spawn more agents than
  ready tracks.
- **workspace** — per-agent VCS copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

## When to use mu

Use mu for multi-phase work, review-gated work (`implement → review
→ address → ship`), parallel audits, implementation/reviewer splits,
and anything that must survive context compaction via task notes.

Do **not** use mu for tiny one-file edits, one-off local inspection,
or single-context work where durable coordination adds ceremony.

## Mental model

### Workstreams, DAGs, tracks

One workstream = one tmux session named `mu-<workstream>`. Every
agent is a pane in that session. DB rows are partitioned by
`workstream`.

One edge type: `blocks`. `mu task block A --by B` means **B blocks
A**. Built-in views: `ready`, `blocked`, `goals`. Bare `mu` shows
parallel tracks with automatic diamond-merge: goals sharing a
prerequisite collapse into one track.

### Workspaces prevent trampling

If an agent may edit/build/test/generate artifacts while another
agent is active in the same repo, spawn with `--workspace`. Keep the
main checkout for orchestration. Two builds in one checkout corrupt
each other's artifacts.

Workspaces auto-detect jj/sl/git; non-VCS uses `cp -a`. They are
auto-freed on `mu agent close` **iff clean**: no uncommitted changes
and no commits since fork. Non-clean close fails with
`WorkspacePreservedError`; then use `mu workspace free <agent>` or
`mu agent close <agent> --discard-workspace` (lossy).

Between waves:
- `mu workspace refresh <agent>` rebases onto fresh main without
  killing LLM context.
- `mu workspace recreate <agent>` = free + create for fresh
  single-purpose workers; `--force` discards dirty edits.
- `mu workspace commits <agent>` lists since-fork commits for
  cherry-picking.

Claim/send warn when a target workspace is ≥10 commits behind main;
refresh first or pass `--strict-staleness` in scripts.

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
   If no task exists, `mu task add` first. Agent status is noisy;
   task ownership is durable and waitable.
4. Send terse instructions: task id, files/notes to read, workspace
   path, validation command, scope guards, task note contract.
5. End with a loud final-action block:

   ```text
   ⚠️ FINAL ACTION
   git commit -am '...' THEN
   mu task close <id> -w <ws> --evidence '...'
   ```

6. `mu task wait ... --first --any --json --on-stall exit`.
7. Cherry-pick the closed worker's **new** commit(s), verify, return
   control. Do not barrier or loop in shell.
8. Repeat from `mu state`.

## Dispatch rules that prevent real failures

- **Pipeline cherry-picks; don't barrier.** One wait, one
  cherry-pick, one verify, return control. Do not wait on an
  umbrella task for the whole wave; that hides partial progress.
- **Use `--on-stall exit` in non-interactive flows.** Default wait
  warns on stalled alive workers and keeps polling. Exit 7 =
  `STALL_DETECTED`; exit 6 = `REAPER_DETECTED` (dead pane) and wins
  if both happen.
- **Cherry-pick worker commits onto main; don't merge.** Stale
  branches can drag re-reverts.
- **Cherry-pick only new shas.** `workspace commits` lists since
  fork; track what you've already integrated. Don't replay the whole
  worker range each time.
- **Bucket fix waves by file cluster, not severity.** Two workers
  editing one file create merge conflicts.
- **Refresh/recreate workspaces between waves.** The `behind` column
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
- **Use `mu agent send`; never raw `tmux send-keys <text>`.** mu uses
  bracketed paste so `/`, `?`, `f`, etc. are delivered as text
  instead of agent-TUI keybindings.
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
  current tmux session minus `mu-` > error. For entity verbs it is a
  scope check; for pickers it selects which workstream.
- Qualified refs `<workstream>/<name>` skip `-w`; mismatched `-w`
  errors. Bare ambiguous names raise `NameAmbiguousError` (exit 4)
  with one-paste fixes.
- `--evidence "text"` on task `claim/close/open/release`; recorded
  verbatim in emitted events.
- `--json` for composition; `nextSteps` survives.

## CLI overview (only gotchas; use `--help` for full syntax)

- **Workstream:** `init`, `list`, `destroy` (auto-snapshot;
  `--archive <label>` preserves graph), `export`, `import`.
- **Agents:** `spawn` (`--workspace`, `--role read-only`,
  `--command`), `send`, `read`, `show`, `list`, `close`, `free`,
  `kick`, `adopt <pane-id|title>` for orphan panes.
- **Tasks:** `add`, `list`, `next`, `show`, `tree`, `notes`
  (`--tail`, `--since`, `--since-claim`), `note`, `claim`
  (`--for | --self`), `release` (`--reopen` only for un-closing
  terminal tasks), `close` (`--if-ready` no-ops until blockers
  terminal), `open`, `reject`, `defer`, `block`, `unblock`,
  `update`, `reparent`, `wait`, `delete --yes`. Edge direction:
  `block <blocked> --by <blocker>`.
- **Self:** `mu me`, `mu me tasks`, `mu me next`.
- **Workspace:** `create`, `list` (`behind`), `refresh`, `recreate`,
  `commits`, `free`, `path`, `orphans`.
- **Log:** `mu log "text"`, `mu log -n N`, `mu log --tail`. Use
  `task wait`, not `log --tail`, for waits.
- **Snapshots:** destructive verbs auto-snapshot. `mu undo --yes`
  restores DB only, not tmux/workspace dirs. No redo; each restore
  takes a pre-restore snapshot.
- **Archives:** `create`, `list`, `show`, `add <label> -w <ws>
  [--destroy]`, `remove`, `delete`, `search`, `export`. Labels are
  global.
- **State/TUI:** bare `mu` opens the all-workstream TUI on a TTY;
  agents/scripts use `mu state --json`. `mu state --tui` is
  read-only, yanks commands, `?` shows keys, `/` filters popups,
  `Esc`/`q` back, `q`/`Ctrl-C` quits. Non-TTY bare `mu` (or
  `MU_NO_TUI=1`) prints help.
- **Escape hatch:** `mu sql "<query>"` for missing typed verbs.
- **Health:** `mu doctor`.

## `mu task wait` exits

Default target: CLOSED. `--first` = `--any` plus firing id/object.

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
reap` event. No manual release after crashes.

Status detection is heuristic and can lag, especially behind custom
`--command` wrappers. For high-stakes decisions:

```bash
mu agent read worker-1 -n 100
mu log -w <ws> --kind event --tail
mu task notes <id>
```

## In-pane worker loop

`$TMUX_PANE` resolves identity. Pane title set at spawn is the agent
identity.

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
sleep 1
mu agent send worker-1 'Claim and work on task_x. Read notes first...'
```

## Recover destructive verbs

`mu snapshot list`, then `mu undo --yes` (dry-run by default; add
`--to <id>` to choose one). DB only: killed panes and freed
workspace dirs do not return.

## DO / DON'T

DO:
- `mu state -w <ws>` before actions.
- Add a task before assigning work.
- Claim before sending; read notes before claiming.
- Pass `--evidence` on claim and close.
- Drop task notes using the note contract.
- Set `impact` and `effort_days` honestly.
- Use `--workspace` whenever an agent may edit/build/test.
- Send `/new` before unrelated follow-on work.
- Use `mu task wait --first --json`, never shell polling.
- Use `mu doctor` when state looks wrong.

DON'T:
- Barrier on a wave umbrella or loop until "everything is done".
- Fire-and-forget after `mu agent send`.
- Trust status emoji alone.
- Double-quote `$VAR`-laden prompts.
- Bypass mu with `sqlite3`; use `mu sql`.
- Spawn without a workstream.
- Anthropomorphize agent names.
- Poll `mu agent read` in tight loops.
- Add cross-workstream edges; model as one workstream.
- `mu workstream destroy --yes` without dry-run.
- Use the reserved `mu_` task-id prefix.
- Message agents directly; use task notes and the activity log.
- Prompt workers to run filesystem-wide `find`, broad `grep -r /`,
  or unbounded loops. Pass paths; if wedged, `mu agent kick`.

## What mu is NOT

- Not a build tool, deploy tool, or chat protocol.
- Not a replacement for `pi-subagents`; mu is for long-lived crews.
- Not a place to add config files, daemons, wrapper layers, codegen,
  template discovery, or a render layer beyond current deps. See
  `docs/ROADMAP.md` anti-feature pledges before expanding surface.

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
- `docs/USAGE_GUIDE.md`, `CHANGELOG.md`, `docs/VOCABULARY.md`.
