# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [Unreleased]

### Fixed

- **`mu workstream init <name>` now validates the name.** Names
  containing `.`, `:`, `/`, uppercase, leading digit/hyphen, or
  >32 chars are rejected with `WorkstreamNameInvalidError` (exit
  2). The motivating bug: `mu workstream init roadmap-v0.2`
  succeeded, but tmux silently rewrote the session name to
  `mu-roadmap-v0_2` (because `.` is the window/pane separator in
  tmux's `session:window.pane` target syntax). Every downstream
  verb — `mu agent list`, `mu state`, bare `mu`, `mu agent
  spawn` — then failed with `can't find pane: 2` or `duplicate
  session` because mu queried the unmangled name. Fail loud at
  init time instead.
  - **Migration:** existing workstreams with invalid names need
    to be renamed via SQL: `INSERT INTO workstreams (name,
    created_at) SELECT '<new>', created_at FROM workstreams WHERE
    name='<old>'; UPDATE tasks SET workstream='<new>' WHERE
    workstream='<old>'; UPDATE agent_logs SET workstream='<new>'
    WHERE workstream='<old>'; DELETE FROM workstreams WHERE
    name='<old>';` (each statement separately; `mu sql` doesn't
    accept multi-statement scripts yet). Then
    `tmux kill-session -t <old-mangled-session>`.
  - The same regex applies to `ensureWorkstream` (the auto-create
    path on first `mu agent spawn` / `mu task add`), so the
    invariant holds even for callers that skip `mu workstream init`.
  - SDK: `WorkstreamNameInvalidError` and `isValidWorkstreamName`
    exported from `src/index.ts`.

### Breaking

- **`mu agent close` no longer touches the workspace.** Previously,
  closing an agent auto-freed its workspace dir; the
  `--keep-workspace` flag opted out. The default lost any
  uncommitted artifacts (benchmark output, profiles, scratch logs)
  produced into the workspace cwd. The new behaviour: closing an
  agent kills the pane and removes the registry row only. Run
  `mu workspace free <agent>` (or `mu workspace free <agent>
  --commit`) explicitly to remove the on-disk dir. The
  `--keep-workspace` and `--commit-workspace` flags on `agent
  close` are removed.
  - **Migration:** any script that did `mu agent close X` and
    relied on the workspace being cleaned up should add
    `mu workspace free X` after.
  - **Why:** mu has no `mu undo`; destructive defaults are bad
    form. The split also matches mu's general principle that each
    verb does one thing.

---

## [0.1.0] — Initial release

First public release. Mu is a CLI that manages a persistent crew
of pi agents in tmux panes, coordinated through a built-in task
DAG and per-agent VCS workspaces. State lives in one SQLite file
at `<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

This release packages a body of work developed against real
multi-day investigations. The version number resets at the
public boundary; see git history for the per-step evolution.

### What's in 0.1.0

**~50 typed verbs across 6 namespaces, plus `mu`, `mu state`,
`mu sql`, `mu doctor`.** Every read verb supports `--json`.

| Area                     | Verbs                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| **workstream** (3)       | `init`, `list`, `destroy`                                             |
| **agent** (8)            | `spawn` (with `--workspace*`), `send`, `read`, `show`, `list`, `close`, `free`, `attach` |
| **task** (22)            | `add` (id auto-derived from title), `list`, `show`, `notes`, `note`, `tree`, `next`, `ready`, `blocked`, `goals`, `owned-by`, `search`, `claim` (`--evidence`), `release` (`--evidence`), `close` (`--evidence`), `open` (`--evidence`), `block`, `unblock`, `update`, `delete`, `reparent` |
| **workspace** (4)        | `create`, `list`, `free` (`--commit`), `path`                         |
| **log** (1, overloaded)  | write, read, `--tail` subscription; auto-emits on every state change  |
| **approve** (5)          | `add`, `list`, `grant`, `deny`, `wait` (exit 0/4/5 = granted/denied/timeout) |
| **self-id** (3)          | `whoami`, `my-tasks`, `my-next` (resolves agent via `$TMUX_PANE`)     |
| **utilities** (4)        | bare `mu` (quick mission control), `mu state` (canonical state card), `sql`, `doctor` |

### Pillars (what makes mu mu)

- **One workstream = one tmux session.** All agents live as
  panes/windows inside it. Detach and reattach freely; the crew
  survives.
- **The CLI is the product.** Anything mu can do, you can do from
  a shell. No daemon, no config file, no extension required.
- **One DB is canonical.** SQLite WAL at `~/.local/state/mu/mu.db`.
  Multiple processes share it safely.
- **Reality wins reconciliation.** Every list-style verb queries
  tmux, prunes ghost agents, and surfaces orphan panes.
- **Agents are dumb workers; the task DAG is the brain.** Tasks
  have mandatory `impact` and `effort_days`; edges are `blocks`
  relationships; the parallel-tracks union-find with diamond-merge
  guarantees two agents never collide on a shared dependency.
- **Per-agent VCS workspaces.** `--workspace` auto-creates
  isolated jj workspaces / sl shares / git worktrees / `cp -a`
  snapshots; auto-freed on `mu agent close`.
- **Async coordination via `mu log`.** Every state-changing verb
  auto-emits a `kind='event'` row; subscribers `mu log --tail`
  instead of polling.
- **Human-in-the-loop approvals.** `mu approve add/wait` lets
  agent scripts gate destructive actions on operator sign-off.
- **Audit trail with grounding.** `--evidence` on lifecycle verbs
  records what the caller observed. First inch of "observed vs
  claimed state" discipline.
- **Crash recovery.** Reconciliation prunes ghost agents; the
  reaper reverts their IN_PROGRESS tasks to OPEN with an
  explanatory note; no manual cleanup.
- **Get out of the model's way.** Mu owns no model selection,
  effort tier, prompt engineering, or tool routing. Pi already
  has those abstractions; mu doesn't recreate them.

### Schema (8 tables)

- `workstreams` — top-level partition; one tmux session each.
- `agents` — pane registry; identity is `(workstream, name)`.
- `tasks` — the work graph nodes. Mandatory `impact` (1–100) +
  `effort_days`.
- `task_edges` — `blocks` relationships; cycles rejected at write
  time.
- `task_notes` — append-only per-task notes. FILES / DECISION /
  VERIFIED conventions documented in SKILL.md.
- `vcs_workspaces` — per-agent isolated working copies.
- `agent_logs` — append-only timeline. Manual broadcasts, auto
  state-change events, and external `--as` writes share one table
  via the `kind` column. `seq` is AUTOINCREMENT for tail cursors.
- `approvals` — human-in-the-loop gate state. FK CASCADE on
  workstreams; CHECK constraint on status enum.

Built-in views: `ready`, `blocked`, `goals` (in `tasks` schema).

### Environment variables

| Variable                     | Purpose                                                |
|------------------------------|--------------------------------------------------------|
| `MU_DB_PATH`                 | Override the SQLite file path                          |
| `MU_STATE_DIR`               | Override the state directory (`<dir>/mu.db`)           |
| `XDG_STATE_HOME`             | Standard XDG fallback                                  |
| `MU_SESSION`                 | Override active workstream name                        |
| `MU_<UPPER_CLI>_COMMAND`     | Pick the executable for `--cli <cli>` (e.g. `MU_PI_COMMAND="pi-alt --some-flag"`) |
| `MU_SEND_DELAY_MS`           | Bracketed-paste → Enter delay (default 500)            |
| `MU_SPAWN_LIVENESS_MS`       | Spawn liveness window (default 1500; 0 disables)      |
| `MU_TMUX_SOCKET`             | Override tmux socket (`-L <name>`); default uses `$TMUX` |

### Known limits in 0.1.0

- **Pi-only status detection.** Other CLIs (claude, codex) can be
  spawned via `--cli <name>` + `MU_<UPPER_CLI>_COMMAND` but always
  show `needs_input`. See [docs/ROADMAP.md](docs/ROADMAP.md).
- **Polling-based subscriptions.** `mu log --tail` and `mu approve
  wait` poll SQLite once per second. Real subscription mechanisms
  (SQLite update hooks, fs.watch on the WAL) are deferred.
- **No `mu undo`.** Snapshots / undo are deferred. `mu workstream
  destroy --yes` is irreversible; recovery is restoring `mu.db`
  from a backup.
- **No capability enforcement.** The `role` field on agents
  (`full-access` / `read-only`) is stored but not enforced. The
  flag is operator discipline, not a guard.
- **Local-only state.** No cross-machine sync. Layer something
  like syncthing on top if you want it.
- **Pi extension not yet shipped.** Mu is CLI-only in 0.1.0; a
  pi extension is on the roadmap.

### Inspirations

- **[pi-subagents](https://github.com/nicobailon/pi-subagents)** by
  Nico Bailon — the pi-native delegation pattern. mu reuses its
  frontmatter format and borrows operational machinery (worktrees,
  mutation guards, model fallback, doctor).
- A prior internal multi-agent runtime (Rust) — the "tmux as
  universal substrate + per-CLI status detection + reality-wins
  reconciliation + parallel-track union-find with diamond-merge"
  patterns originated there. Mu adopts the patterns; not the
  deps.
- An internal critique of that prior runtime — sharpened the case
  for the anti-feature pledges (no DSL, no plugins, no daemon, no
  config file, no web UI) and motivated several of the verbs in
  this release (state cards, approvals, observed-vs-claimed
  evidence on lifecycle verbs).
