# Architecture

mu is layered: callers on top, a shared TypeScript core in the middle,
SQLite + tmux + VCS substrates at the base. The CLI and the pi
extension are thin facades over the same core modules.

- For canonical terms (*workstream*, *agent*, *task DAG*, *track*,
  *claim*, *free*, *workspace*, *substrate*, ...) see
  [VOCABULARY.md](VOCABULARY.md). It is the source of truth.
- For design rationale, rejected alternatives, and what's on the
  roadmap, see [ROADMAP.md](ROADMAP.md).
- For principles, see [VISION.md](VISION.md).

```
┌────────────────────────────────────────────────────────────────┐
│  Callers                                                        │
│  ┌────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  Pi    │  │  Bash +  │  │  Pi sub-     │  │ mu log       │ │
│  │  shell │  │  jq      │  │  agent       │  │ --tail subs  │ │
│  └───┬────┘  └────┬─────┘  └──────┬───────┘  └──────┬───────┘ │
│      │            │               │                  │         │
└──────┼────────────┼───────────────┼──────────────────┼─────────┘
       │  in-proc   │ subprocess    │ subprocess       │ in-proc
       ▼            ▼               ▼                  ▼
┌────────────────────────────────────────────────────────────────┐
│  mu core (shared TS modules)                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐│
│  │ agents/  │ │  tasks/  │ │   vcs/   │ │ registry/│ │ eval/ ││
│  │ tmux     │ │ schema   │ │ jj       │ │ snapshot │ │ vm    ││
│  │ detect   │ │ queries  │ │ sapling  │ │ logs     │ │ defer ││
│  │ state    │ │ tracks   │ │ git      │ │ doctor   │ │ refs  ││
│  │          │ │ claim    │ │ none     │ │          │ │       ││
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬───┘│
└───────┼────────────┼────────────┼────────────┼───────────┼────┘
        ▼            ▼            ▼            ▼           ▼
┌────────────────────────────────────────────────────────────────┐
│  Substrates                                                     │
│  SQLite (~/.local/state/mu/mu.db) · tmux panes · jj/sl/git workspaces       │
└────────────────────────────────────────────────────────────────┘
```

## The task DAG

mu's coordination model is built around a **directed acyclic graph of
tasks** (cloned from a prior internal task-graph crate). This is not
a sidecar feature — it's the central organizing primitive that makes
deterministic multi-agent orchestration possible. Without it, mu is
just a fancier agent runner.

### Model

- **Tasks** are nodes with mandatory `impact (1-100)` and `effort_days`.
  `ROI = impact / effort` drives prioritization.
- **One edge type**: `blocks`. `A → B` means A must close before B can
  start. Multiple edge types create ambiguity that defeats the purpose.
- **Status lifecycle**: `OPEN → IN_PROGRESS → CLOSED/RESOLVED`.
- **Notes** are append-only per task; survive across LLM sessions and
  agent restarts. The fix for context loss at the *task* level rather
  than the agent level.

### Built-in queries (SQL views)

| View      | Returns                                                                |
| --------- | ---------------------------------------------------------------------- |
| `ready`   | OPEN tasks with no unresolved blockers — work that can start *now*     |
| `blocked` | OPEN tasks waiting on something                                        |
| `goals`   | Tasks with no dependents — graph endpoints                             |

Agents and humans both query these views directly via `mu sql`. No
separate query layer.

### Parallel-track detection (the killer feature)

`mu task tracks` runs union-find on the graph to identify independent
subtrees that can be assigned to different agents in parallel.

**Diamond patterns get merged automatically.** If two roots share a
prerequisite, they collapse into one track — preventing two agents
from colliding on the shared dependency:

```
  Independent (2 tracks):       Diamond (1 merged track):

    goal_a    goal_b              goal_a   goal_b     ← Spawn 2 agents
       |         |                   \      /
    task_a    task_b                  shared          ← Spawn 1 (would
       |         |                      |               collide otherwise)
    leaf_a    leaf_b                  leaf
```

This is **deterministic** — not "the LLM decides whether to
parallelize." The graph algorithm gives the right answer; the LLM
follows it.

### Claim protocol via tmux pane title

`mu task claim <task>` reads the current pane's **pane title** (set on
spawn via `select-pane -T <agent-name>`) and atomically:

1. Sets `tasks.owner = <agent_name>`
2. Flips `tasks.status = IN_PROGRESS`
3. Records an `agent_logs` row of kind `claim`

Reads via `tmux display-message -p '#{pane_title}'`, **not** `#W`
(window name). Window names come from the `tab:` frontmatter and may
group multiple agents in one window.

Two agents can't claim the same task — atomic CAS in SQLite. Zero-
config identity: the agent doesn't have to know its own name.

### Scoped subtree views

`mu task <id>` shows mission-control output filtered to that task's
subtree. Enables recursive delegation: a sub-orchestrator agent runs
`mu --scope feature_a` and sees only its slice of the graph.

### Why this is in the core

- "What should this agent do next?" becomes a SQL query, not an LLM call
- Parallelization correctness is structural (union-find + diamond-merge),
  not a prompt
- Notes give every task a durable knowledge container that outlives any
  LLM session
- Recursion works because subtree-scoping is just a `WHERE` clause

---

## Tmux session topology

mu organizes agents into **one tmux session per workstream**. One mu
workstream = one tmux session = one `session_id` partition in
`~/.local/state/mu/mu.db`. Multiple workstreams on one machine coexist as
independent tmux sessions, fully isolated.

```
  tmux session: mu-auth-refactor              (one mu workstream)
  ┌────────────────────────────────────────────────┐
  │  Window: Backend          Window: Review              │
  │  ┌──────────┐ ┌────────┐    ┌─────────────────────┐   │
  │  │ worker-1    │ │  worker-2   │    │ reviewer-1              │   │
  │  │ (pi)     │ │ (pi)   │    │ (pi, role=read-only)   │   │
  │  └──────────┘ └────────┘    └─────────────────────┘   │
  │                                                       │
  │  Window: mu-orchestrator                              │
  │  ┌────────────────────────────────────────────┐    │
  │  │  pi (you, with mu extension loaded)              │    │
  │  └────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────┘

  tmux session: mu-migration-2024q4           (different workstream)
  ┌───────────────────────────────────────────────┐
  │  ...different agents, different graph, no overlap     │
  └───────────────────────────────────────────────┘
```

### Concretely

- **First `mu agent spawn` creates the tmux session** if you're not already
  in one. Default name `mu-<auto>`. Override with `mu workstream init <name>` or
  `MU_SESSION=<name>`.
- **Subsequent operations** in the same shell (or any child shell with
  `MU_SESSION_ID` set) target the same session.
- **`mu agent attach`** → attach to the whole workstream's tmux session
- **`mu agent attach <agent>`** → attach and focus that agent's window/pane
- **`mu agent list`** shows only the current workstream's agents by default
- **`mu agent list --all`** shows agents across all workstreams on the box
- **`session_id`** is the partition key on the `agents` table; queries
  filter to the active session unless `--all` is set
- **`mu doctor`** warns about cross-session pollution (orphan panes,
  ghost rows, agents whose tmux session no longer exists)

### Window vs pane

By default each agent gets its own **tmux window** (tmux's term for
what most terminals call a "tab"), with the window name set to the
agent's `tab:` value (default: the agent name itself, so a single
agent's window is named after them). Agents that share a `tab:` value
share a window with multiple panes inside it.

The claim/identity logic depends on the **pane title**, not the
window name — every agent pane has its title set to the agent's name
via `select-pane -T <name>` on spawn, regardless of how panes are
grouped into windows. (See [VOCABULARY.md](VOCABULARY.md) and
the comment block at the top of `src/tmux.ts` for the canonical
tmux protocol.)

### Why one session per workstream

- **Visual co-location.** `tmux a -t mu-auth-refactor` shows the whole
  crew at once. No session-switching.
- **Trivial isolation.** Kill the tmux session = kill the workstream.
  No leaked panes.
- **Detach and reattach freely.** Close your laptop, open it later,
  `tmux a -t mu-auth-refactor`, the crew is still there.
- **The claim protocol falls out naturally.** Pane title = agent name
  = ownership identity. Zero-config.
- **Multiple workstreams coexist.** session_id partitioning (a
  pattern borrowed from a prior internal multi-agent runtime)
  prevents the auth-refactor crew from polluting the migration crew.

---

## Operations registry

Every mu action is defined exactly once via `defineOperation(...)`.
The registry is collected at module import time (no codegen step) and
from one source produces six surfaces:

```
              ┌─────────────────────────────┐
              │  defineOperation(...)  │
              │   name, category,      │
              │   caps[], params,      │
              │   handler              │
              └─────────────┬──────────────┘
                            │
          ┌────────────┬──────┼──────┬───────────┐
          ▼            ▼            ▼            ▼           ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────┐  ┌────────┐
   │ CLI verb│  │ Pi tool │  │ mu.d.ts │  │ skill │  │ doctor │
   └─────────┘  └─────────┘  └─────────┘  └───────┘  └────────┘
```

No operation may exist outside the registry. CLI verbs that are not
operations (e.g., `mu workstream init`, `mu agent attach`, `mu doctor`) are exceptions
listed explicitly in the CLI module and motivated.

(A capability-tag system on operations was considered and dropped
as an abstraction with no current consumer; see
[ROADMAP.md § Open questions](ROADMAP.md#open-questions).)

---

## Reconciliation

`mu agent list` always reconciles the registry against tmux reality before
returning. Three steps, in order:

1. **Prune ghosts.** For each `agents` row, if its `pane_id` no longer
   exists in tmux, delete the row.
2. **Detect status from scrollback.** For each surviving agent, capture
   the pane and run the per-CLI detector. Update `agents.status` if
   the detected value differs from the stored one.
3. **Surface orphans.** For each tmux pane in the workstream's session
   that has no matching `agents` row but whose pane title looks like
   an agent name, add it to the orphans list. **Do not auto-adopt** —
   `mu agent list` shows orphans under a separate "(orphans)" section and
   the user runs `mu adopt %15 [--name X]` to formally claim them.

Full algorithm lives in `src/reconcile.ts` (the canonical
implementation).

Key properties:

- **Reality wins**: tmux is the source of truth for what panes exist.
  The DB records what we last *observed*. Reconciliation closes the
  gap on every `mu agent list`.
- **Pi-only status detection** (`src/detect.ts`): the `busy` /
  `needs_input` / `idle` / `done` classification works for pi via
  a known marker. Other CLIs would need their own detectors; none
  are built today and none are currently planned.
- **No silent adoption**: orphans are reported, never claimed without
  user consent. Avoids surprising the user with random panes.
- **`mu doctor` calls the same routine** and reports counts. The
  algorithm has no other implementation.

---

## Modules (actual src/ layout)

Flat `src/` directory; ~12 files. No `core/` subdirectory; no
anticipatory layering. Each module is concrete and consumed today.

| Module                | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/db.ts`           | SQLite (better-sqlite3) connection, WAL mode, schema (15 tables + 3 views, **schema v6** — v5 surrogate-INTEGER-PK substrate plus 5 additive `archive_*` tables), default paths, `resolveWorkstreamId` (the SDK boundary's first leg). v5 → v6 in-place bump on open (additive only). |
| `src/tmux.ts`         | Single tmux executor wrapper, send protocol (bracketed-paste), pane validation            |
| `src/detect.ts`       | Pi-only status detector (`busy` / `needs_input` / `idle` / `done`)                        |
| `src/reconcile.ts`    | Ghost prune + status detect + orphan surface; "reality wins"                              |
| `src/agents.ts`       | CRUD + spawn / send / read / list / show / close / free / adopt; spawn liveness; reaper; pane-title composition (`composeAgentTitle`) |
| `src/tasks.ts`        | CRUD + every read/write verb on the DAG; cycle check; claim CAS; auto-event emission      |
| `src/tracks.ts`       | Parallel-tracks union-find with diamond merge                                             |
| `src/workstream.ts`   | ensureWorkstream / list / summarize / destroy / export (thin wrapper around the bucket renderer) |
| `src/exporting.ts`    | Unified bucket renderer for `mu workstream export` and `mu archive export`: per-task markdown + manifest.json (`bucketVersion: 2`); idempotent via per-file sha256; deleted-task preservation banner; refuses pre-0.3 single-source layouts |
| `src/importing.ts`    | Inverse of `src/exporting.ts`: parses a v0.3 bucket directory and rebuilds every source-ws as live tasks + edges + notes. Markdown-only (never reads .db); per-source-ws transactional; refuses silent merges into existing workstreams |
| `src/archives.ts`     | Cross-workstream **archives** (Phase 1 SDK; CLI in Phase 2): `createArchive` / `listArchives` / `getArchive` / `deleteArchive` / `addToArchive` (idempotent at `(archive, source_workstream)`) / `removeFromArchive` / `listArchivedTasks`. Backed by the v6 `archives` + `archived_tasks` + `archived_edges` + `archived_notes` + `archived_events` tables; archives outlive workstreams (TEXT `source_workstream` columns, no FK). |
| `src/logs.ts`         | `agent_logs` SDK: appendLog / listLogs / latestSeq / emitEvent                            |
| `src/vcs.ts`          | `VcsBackend` interface + jj / sl / git / none impls; detection precedence; `commitsBehind(workspacePath, ref)` for staleness signal (no auto-fetch; pure observation) |
| `src/workspace.ts`    | Per-agent VCS workspaces (registry layer on top of vcs.ts); CRUD + cascade; orphan-dir detection (`listWorkspaceOrphans`); staleness decoration (`decorateWithStaleness` populates `commitsBehindMain` per row) |
| `src/snapshots.ts`    | Whole-DB snapshots (`VACUUM INTO`); auto-captured before destructive verbs (schema v4); SDK for `mu undo` |
| `src/output.ts`       | NextStep type + `printNextSteps` + `errorNextSteps` plumbing for self-documenting output |
| `src/approvals.ts`    | Human-in-the-loop gate: add/grant/deny/wait verbs                                         |
| `src/cli.ts`          | commander entry; `buildProgram()` + `handle()` (exit-code map); shared format helpers (`formatTaskListTable` / `formatAgentsTable` / `formatReadyTable` / `formatTracks`); `pc.dim`/`pc.cyan` colour palette helpers |
| `src/cli/*.ts`        | one file per verb-namespace; thin wrappers over the SDK; `--json` rendering for every read verb. Currently: `workstream.ts`, `agents.ts`, `tasks.ts`, `workspace.ts`, `log.ts`, `approve.ts`, `hud.ts`, `snapshot.ts`, `sql.ts`, `doctor.ts`. Imports flow cluster → root (never the other way). |
| `src/cli/tasks/*.ts`  | sub-cluster of the `mu task` namespace; `tasks.ts` at the root re-exports only what callers outside the cluster import (`wireTaskCommands`, `cmdMyNext`/`cmdMyTasks`, `unescapeNoteText`). One file per concern: `queries.ts` (list/next/owned-by + the `cmdMyTasks` / `cmdMyNext` helpers that back `mu me tasks` / `mu me next`), `lifecycle.ts` (close/open/reject/defer + cascade preview), `edit.ts` (add/show/notes/note/update + helpers), `edges.ts` (block/unblock/reparent/delete), `claim.ts` (claim/release/wait), `tree.ts` (tree rendering), `wire.ts` (Commander glue). Each file < 500 LOC; the hub is < 30. |
| `src/index.ts`        | SDK entrypoint (re-exports)                                                               |
| `skills/mu/`          | Bundled skill teaching the LLM the model + verb list + jq pipelines                       |
| `agents/`             | Two builtin agent .md role docs (read by the LLM in the pane; not part of spawn contract) |

## Data flow

1. **A caller invokes a verb** — the CLI subprocess, or in-proc SDK
   use.
2. **CLI handler dispatches to an SDK function** in `src/agents.ts`
   / `src/tasks.ts` / etc.
3. **For multi-statement writes, opens a transaction** via
   better-sqlite3's `db.transaction(fn)()` wrapper.
4. **Executes the operation** — agent ops shell out to tmux (and to
   jj/sl/git for workspaces); task ops are pure SQL.
5. **Reconciles with reality** — for read-paths that need accuracy
   (`mu agent list`, mission control), queries tmux for live pane
   state and updates the DB (ghost prune + status detect).
6. **Auto-emits a `kind='event'` row** to `agent_logs` for any
   state-changing verb, conditional on actual change. `mu log
   --tail` subscribers see it on the next 1-second poll.
7. **Commits or rolls back** — exception propagates after rollback
   so the caller sees the real error and the typed error class
   maps to a specific exit code in `handle()`.

## Key seams

These are the abstraction points designed for extension. New impls of
each are deliberately small.

| Seam                | Add a new impl by...                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VcsBackend`        | Implementing `detect / createWorkspace / freeWorkspace / commitsBehind` (~80–150 LOC; jj/sl/git/none are working examples)        |
| Per-CLI `Detector`  | Adding patterns to `detectPiStatus` (vanilla pi `to interrupt)`; pi-meta + every TUI wrapper covered by Braille spinner glyph fallback `[\u2800-\u28FF]`)                  |
| New typed verb      | Add an SDK function in the relevant `src/*.ts`; add a `cmd<Verb>` to the matching `src/cli/<namespace>.ts` (or create a new namespace if the verb doesn't fit existing ones); wire one commander block in `src/cli.ts`'s `buildProgram()` (use `handle()` for the exit-code map; route through `printNextSteps` for self-documenting output) |
| New schema migration| Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts`; mirror the new shape in `CURRENT_SCHEMA`; ship a one-shot script under `scripts/` (the v4→v5 transition was the canonical example; restore from git history if you need to see the shape). The loud-fail hook in `openDb` rejects pre-current DBs with `SchemaTooOldError` (exit code 4) and a `npx tsx scripts/migrate-vN-to-vM.ts` instruction |
| Snapshot hook       | Add `await captureSnapshot(db, 'verb-name', workstream)` at the top of any new destructive verb (one-liner; GC + restore behaviour automatic) |

## Surrogate-PK + SDK-boundary discipline (load-bearing)

This is the load-bearing pattern v5 turned into a substrate-wide
invariant; every entity table follows it.

**Schema shape — every entity table:**

```
(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate; internal
  <scope_id>    INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE,
  <name>        TEXT NOT NULL,                        -- operator-facing; mutable
  -- ... domain attributes
  UNIQUE (<scope_id>, <name>)                         -- per-scope unique
)
```

FKs reference `<child>.<parent>_id` (INTEGER), never the TEXT name.
The TEXT name is JUST an operator-facing attribute — searchable,
displayable, renamable cheaply. The surrogate id is the identity.

**TEXT-by-design exceptions** (each one a justified skip): the
workstream's own `name` (it IS a tmux session name; globally
unique), `task_notes.author` / `agent_logs.source` (free-text actor
labels — `"orchestrator"`, `"user"`, `"system"`), `agent_logs.kind`
(open enum — future kinds need no migration), `agents.cli`
(adding a new CLI must not require a schema change), and the
`snapshots.workstream` text column (intentionally NOT an FK so
the snapshot outlives its workstream).

**SDK boundary discipline** — same shape as REST: external API
uses business identifiers, internal layer uses primary keys.

> **Public SDK functions take operator-facing names.**
> **Internal helpers take surrogate ids.**
> **Resolution happens at the public-function entry, exactly once.**

```ts
// PUBLIC: takes operator-facing names
export function claimTask(
  db: Db,
  workstream: string,
  localId: string,
  opts?: ClaimOptions,
): ClaimResult {
  const wsId = resolveWorkstreamId(db, workstream);
  const taskId = resolveTaskId(db, wsId, localId);
  const agentId = resolveCurrentAgentId(db, wsId);
  return claimTaskById(db, taskId, agentId, opts);
}

// INTERNAL: takes surrogate ids; never re-resolves
function claimTaskById(db, taskId, agentId, opts): ClaimResult { ... }
```

Why exactly once at the boundary: no double-resolution; no
mid-function ambiguity (once surrogate ids exist, internal helpers
don't need to thread workstream context — the FKs make scope
implicit); one place to do error mapping
(`WorkstreamNotFoundError` / `TaskNotFoundError` /
`AgentNotFoundError` all originate at resolve-time, with the
operator's input string in the error payload).

**`--json` output preserves operator-facing names.** Surrogate ids
stay strictly internal — they never leak into `--json`, error
payloads, log lines, or markdown exports. Promoting them to the
public shape would re-introduce a global namespace through the
back door (anti-feature pledge).

## State of truth

- **`~/.local/state/mu/mu.db` is canonical.** Everything else is a
  cache, including tmux pane titles (mu re-pushes them via
  `composeAgentTitle` after every state change).
- **Reads are cheap** via SQLite views (`ready`, `blocked`, `goals`).
- **Writes go through the typed SDK functions** (`src/agents.ts`,
  `src/tasks.ts`, etc.) which validate, transact, snapshot (for
  destructive verbs), and reconcile.
- **Workstream scoping is mandatory at the CLI boundary.** Post-v5,
  TEXT names (`tasks.local_id`, `agents.name`, `approvals.slug`) are
  per-workstream unique — the same name may legitimately exist in two
  workstreams. Every public SDK function that takes such a name also
  takes (or threads from a parent context) the workstream; internal
  SQL filters by `(workstream_id, name)`. Test fixtures and `mu sql`
  read paths can omit the workstream and fall back to the v4
  first-match-by-name contract; those branches are sealed by
  `scripts/grep-name-without-workstream.sh` (a CI guard wired into
  `npm run lint`) which scans every `db.prepare(…)` call for unscoped
  name lookups. Allow-list lives at
  `scripts/grep-name-without-workstream.allowlist`.
- **Snapshots are insurance, not version history.** Captured only
  before destructive verbs (workstream destroy, agent close, task
  close/reject/defer/release/delete, workspace free, approve
  grant/deny). Status flips and additive ops do NOT snapshot.
- **In-memory state is short-lived** — the CLI's per-command
  connection. Gone on process exit.
- **Cross-process coordination** is via SQLite WAL — multiple `mu`
  processes share the file safely.

## Errors

Curated error classes per layer; no try/catch swallowing. CLI exit
codes:

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | success                                                  |
| 1    | generic error                                            |
| 2    | usage error (commander's default)                        |
| 3    | not found (no such agent / task / workspace)             |
| 4    | conflict (name collision, double-claim, dirty tree)      |
| 5    | substrate unavailable (`tmux` not running, DB locked)    |

Errors carry structured context (operation name, target, attempted
action) so `mu doctor` can surface them readably.

## Testing layers

| Layer                              | Test approach                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `src/db.ts`                        | Real SQLite in temp dir; schema/table-count assertions                          |
| `src/tasks.ts`                     | Real SQLite in temp dir; pure functions over fixture data                       |
| `src/tracks.ts`                    | Pure functions; union-find + diamond-merge properties                           |
| `src/agents.ts`                    | Mocked tmux executor via `setTmuxExecutor()`; reaper integration tests          |
| `src/logs.ts`                      | Real SQLite; cursor semantics, AUTOINCREMENT durability, FK CASCADE             |
| `src/vcs.ts` + `src/workspace.ts`  | Real git in `os.tmpdir()`; jj/sl tests feature-detect (skip if binary missing)  |
| `src/cli.ts` / verb integration    | `*.integration.test.ts` files; real tmux server, unique session per test        |
| End-to-end                         | `test/acceptance.test.ts` — the canonical 10-task / 3-agent demo                |

## Distribution

Single npm package `@you/mu`:

- `dist/cli/mu.js` — CLI entry, executable
- `dist/index.js` — programmatic API for SDK callers
- `dist/pi-extension.js` — pi extension entry
- `dist/mu.d.ts` — types for `.mu.ts` user scripts
- `skills/mu/SKILL.md`, `agents/*.md`, `prompts/*.md` — bundled assets

`tsup` bundles everything from `src/`. No runtime build step on the
user's machine; `npm install` just unpacks.

The dependency list lives in `package.json`; the rule for adding
new ones is the anti-feature pledge in
[ROADMAP.md § Anti-feature pledges](ROADMAP.md#anti-feature-pledges-still-in-force-reinforced-by-an-internal-critique).
