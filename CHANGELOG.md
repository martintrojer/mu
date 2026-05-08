# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [Unreleased]

### Schema

- **`schema_version` table + migration framework.** First
  non-additive schema change earns its first migration. `openDb`
  now sniffs the existing DB shape, stamps the version, and runs
  any pending migrations from `src/migrations.ts` (forward-only,
  one transaction each, post-migration `PRAGMA foreign_key_check`
  for safety). The framework lives in `src/migrations.ts`;
  `src/db.ts` keeps the schema definition and exports
  `CURRENT_SCHEMA_VERSION` as the single source of truth.

- **All 10 foreign keys gain `ON UPDATE CASCADE`** (v1 → v2
  migration). Previously the FKs only had `ON DELETE CASCADE`,
  so renaming a workstream / task / agent name would have left
  every child row dangling. Now every child column follows
  atomically. Affected FKs:
  - `agents.workstream` → `workstreams.name`
  - `tasks.workstream` → `workstreams.name`
  - `tasks.owner` → `agents.name` (already SET NULL on delete)
  - `task_edges.from_task` → `tasks.local_id`
  - `task_edges.to_task` → `tasks.local_id`
  - `task_notes.task_id` → `tasks.local_id`
  - `agent_logs.workstream` → `workstreams.name`
  - `vcs_workspaces.agent` → `agents.name`
  - `vcs_workspaces.workstream` → `workstreams.name`
  - `approvals.workstream` → `workstreams.name`

  The migration rebuilds 7 tables in place (CREATE _new / INSERT
  SELECT / DROP / RENAME) because SQLite can't `ALTER TABLE` to
  modify FK clauses. Existing data is preserved; the migration
  is covered end-to-end in `test/db.test.ts`. Recovery recipes
  for typo'd workstream names live in [USAGE_GUIDE § 14](docs/USAGE_GUIDE.md#you-typod-a-workstream-name-and-want-to-rename-it).

  **No new verb.** Renaming is a single-statement `mu sql`
  recipe; wrapping it in a typed verb would add surface area
  without buying anything (no atomicity to preserve, no
  validation a verb adds, single statement, no side effects).

### Added

- **`mu task claim --self` for the orchestrator pattern.** Two
  things mu has always conflated: a *worker* (a tmux pane mu
  spawned, with a row in `agents`, identity = pane title) and an
  *actor* (anything that causes a state change — may or may not
  be a worker; orchestrators, scripts, and humans are actors but
  not workers). The v2 schema migration tightened the FK on
  `tasks.owner` to `agents.name`, which exposed the conflation:
  bare `mu task claim` from an orchestrator pane (one not spawned
  by `mu agent spawn`) now had nowhere to write the claim.

  `--self` is the actor's opt-out:
  - `tasks.owner` stays NULL (no FK lookup; no synthetic agents
    row pollution).
  - The actor name is recorded in `agent_logs.source` for the
    auto-emitted `task claim` event — provenance is preserved,
    just attributed to the log instead of the FK column.
  - Resolution order for the actor name: `--actor <name>`, then
    pane title, then `$USER`, then the literal `unknown`.
  - Mutually exclusive with `--for` (they're alternative answers
    to "who's the actor for this claim?").
  - Workers are unaffected — they keep using bare
    `mu task claim` exactly as before. `--self` is opt-in for the
    unregistered-actor case.

  `mu task show` and `mu task show --json` now surface the actor
  for tasks where `owner IS NULL` by scanning recent `task claim`
  events, so 'who's working on this' is answerable from
  `mu task show` alone:

      $ mu task claim foo --self
      Claimed foo (--self by pi-mu; OPEN → IN_PROGRESS; owner=NULL)

      $ mu task show foo
      foo  —  ...
        owner      : (self: pi-mu)
        ...

  The `ClaimerNotRegisteredError` message (shipped in dbfc84d)
  has been updated to list `--self` as the first actionable next
  step, ahead of `--for` and `mu adopt`. Three actionable paths
  for an orchestrator who hits 'not a registered mu agent', in
  order of expected frequency.

  SDK: `claimTask({ self: true, actor?: string })` returns
  `{ owner: string | null, actor: string, ... }`. Existing
  `{ self: false }` callers are unchanged. The `ClaimResult.owner`
  type widens from `string` to `string | null`.

  **Vocabulary update:** `docs/VOCABULARY.md` adds canonical
  entries for **worker** (the registered side of identity),
  **actor** (the party that caused a state change), and
  **anonymous claim** (the `--self` operation). The **owner**
  entry now notes its NULL-on-self semantics. The **adopt** entry
  is updated from "deferred" to its current state.

- **`mu adopt <pane-or-title>` verb.** Register an existing tmux
  pane as a managed mu agent — the inverse of `mu agent list`'s
  "orphan" state. The orphan-list message has been advertising
  this verb since v0.1.0 ("`mu adopt` is on the roadmap"); now
  it ships.

  - Pane id form (`mu adopt %15`) or pane title form
    (`mu adopt worker-2`); both look up the pane and adopt it.
  - Defaults to using the pane's current title as the agent
    name; pass `--name <name>` to override (and retitle the
    pane in the process so the claim protocol invariant holds).
  - Idempotent: adopting the same pane twice is a no-op (returns
    `alreadyAdopted: true` from the SDK).
  - Scope-aware: pane must be in the matching `mu-<workstream>`
    tmux session, otherwise `AgentNotInWorkstreamError` (exit 4).
  - Emits an `agent adopt` event into `agent_logs` so the
    adoption is auditable.
  - SDK: `adoptAgent(db, opts)` in `src/agents.ts`; types
    `AdoptAgentOptions` and `AdoptAgentResult` exported.
  - New typed error `PaneNotFoundError` in `src/tmux.ts` for the
    "pane id doesn't exist on the tmux server" case (exit 5
    substrate).
  - Test cases mirror the design (`adopt_design` task note #100):
    8 unit cases (mocked tmux) + 2 integration cases (real tmux).

  The orphan-list message in `mu agent list` is updated to point
  at the new verb instead of the previous "is on the roadmap"
  copy. The `mu sql 'INSERT INTO agents ...'` workaround is
  removed from USAGE_GUIDE.md § "What's NOT in 0.1.0".

- **`mu task list --status <S>` filter.** Accepts case-insensitive
  `OPEN | IN_PROGRESS | CLOSED`. Invalid values exit 2 with a usage
  error. SDK gains a `ListTasksOptions` interface and an
  `isTaskStatus` type guard, both exported from `src/index.ts`.
  `listTasks` now takes an optional third argument; existing
  two-argument calls are unaffected.

### Fixed

- **`mu task claim` from an unregistered pane gives an actionable
  error instead of bare `FOREIGN KEY constraint failed`.** The v2
  schema migration tightened `tasks.owner`'s FK to `agents.name`,
  which surfaced a latent bug: claims from a pi session that
  wasn't itself spawned by mu (or invoked with `--for <ghost>`)
  failed with the unhelpful raw SQLite error.

  `claimTask` now does a `SELECT 1 FROM agents WHERE name=?`
  pre-check before the atomic CAS UPDATE, throwing a typed
  `ClaimerNotRegisteredError` (exit 4 conflict) when the claimer
  doesn't exist. The error message includes:
  - the resolved claimer name
  - the pane id (when resolved from `$TMUX_PANE`) plus the exact
    `mu adopt %<pane>` command to fix it
  - a fallback hint suggesting `--for` when the name came from
    `--for` itself

  Live before/after on the orchestrator's pane:

      $ mu task claim some-task                    # before v0.1.x
      error: FOREIGN KEY constraint failed

      $ mu task claim some-task                    # after
      conflict: claimer 'pi-mu' (pane %6441) is not a registered
        mu agent (no row in agents table).
        Register this pane with: mu adopt %6441
      exit: 4

  The pre-check adds essentially no overhead (one indexed lookup
  before the existing transactional UPDATE); the atomic CAS
  on `tasks.owner` is preserved end-to-end.

  `ClaimerNotRegisteredError` is exported from the SDK
  (`src/index.ts`) so programmatic callers can distinguish it
  from `TaskAlreadyOwnedError` / `TaskNotFoundError` without
  string-matching.

- **Workstream names with the `mu-` prefix are now rejected at
  init time.** `mu workstream init mu-foo` would have produced
  tmux session `mu-mu-foo` (because mu auto-prepends `mu-` to
  derive the session name). Almost never intended; same
  validation seam as the dot-mangle fix —
  `WorkstreamNameInvalidError`, exit 2, message names the
  resulting double-prefixed session so the gotcha is obvious.

- **Long task titles no longer blow out the terminal.** The
  `mu task list / next / ready / blocked / goals / owned-by`
  table views and the bare `mu` mission-control "Ready" table
  now compute a title-column budget from `process.stdout.columns`
  (default 100 when stdout isn't a TTY) and truncate titles with
  an ellipsis. **The `id` column is never truncated** — IDs are
  what callers copy to issue follow-up commands; titles are what
  callers visually scan. Symmetric with `git log --oneline`'s
  preserve-SHA / truncate-subject convention.

- **Task JSON output now includes `roi`** (impact ÷ effortDays).
  Previously `mu task next --json | jq 'sort_by(.roi)'` returned
  rows in arbitrary order because the JSON serialiser dropped the
  ROI that the table view computes inline. Affected verbs:
  `task list / next / ready / blocked / goals / owned-by / show`,
  `my-tasks`, `my-next`, bare `mu --json`, `mu state --json`.
  Tasks with `effortDays === 0` omit the field (JSON has no
  Infinity literal); callers can detect via `effortDays === 0`.
  The `TaskRow` SDK type is unchanged — ROI stays a
  CLI-rendering concern, decorated only on the JSON emit path.


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
