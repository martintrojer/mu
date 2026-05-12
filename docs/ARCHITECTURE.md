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
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ agents/  │  │  tasks/  │  │   vcs/   │  │  registry/   │   │
│  │ tmux     │  │ schema   │  │ jj       │  │  snapshot    │   │
│  │ detect   │  │ queries  │  │ sapling  │  │  logs        │   │
│  │ state    │  │ tracks   │  │ git      │  │  doctor      │   │
│  │          │  │ claim    │  │ none     │  │              │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
└───────┼─────────────┼─────────────┼───────────────┼───────────┘
        ▼             ▼             ▼               ▼
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

`mu task tree <id>` and task queries show the portion of the graph
reachable from a task. This enables recursive delegation: a
sub-orchestrator agent can inspect only its slice of the graph without
asking an LLM to infer the scope.

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
- **`mu agent list`** is scoped to one workstream; list workstreams first,
  then run `mu agent list -w <workstream>` for the scope you want
- **`session_id`** is the partition key on the `agents` table; agent-list
  queries filter to the active workstream
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

## Dual-audience CLI contract

The top-level `mu` binary serves two audiences without creating a
second namespace.

- **Human entrypoint:** bare `mu` launches the read-only TUI when
  `process.stdout.isTTY === true`. It loads every workstream on the
  machine and chooses the initial active tab with the shared focus
  ladder (`$MU_SESSION` → tmux session name → cwd inside a workspace
  → cwd equal to a workspace's VCS-derived project root, with latest
  activity breaking project-root ties → tab 0). If no
  workstreams exist, it prints `mu --help` plus the one-paste
  `Get started: mu workstream init <name>` hint and exits 0.
- **Agent / script entrypoint:** typed verbs remain the API, with
  `--json` on reads and structured errors. Bare `mu` on non-TTY
  stdout (pipes, redirects, CI, most harnessed agent calls) prints
  help instead of entering Ink. `MU_NO_TUI=1` forces that same path
  for scripted use inside an otherwise-interactive terminal.
- **Back-compat:** `mu state` remains the static state card, and
  `mu state --tui` remains an explicit TUI selector. The split is
  stdout-is-TTY plus the opt-out env var, not a separate
  human-vs-agent command namespace.

The TUI import stays dynamic (`await import("./cli/tui/index.js")` or
the sibling state-module equivalent). No module outside
`src/cli/tui/` may statically import ink/react; this prevents the
static CLI bundle from pulling the TUI graph into help/version/json
paths and preserves the ROADMAP render-layer pledge.

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
   the user runs `mu agent adopt %15 [--name X]` to formally claim them.

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

Mostly-flat `src/`: 18 root `.ts` files plus two cohesive
subclusters (`src/agents/`, `src/tasks/`) and the `src/cli/` verb
wrappers (with their own `src/cli/tasks/` sub-cluster). No
`core/` subdirectory; no anticipatory layering. Subclusters obey
the AGENTS.md rule: imports flow cluster → root, never upward.
Each module is concrete and consumed today.

| Module                | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/db.ts`           | SQLite (better-sqlite3) connection, WAL mode, schema (14 tables + 3 views, **schema v7** — v5 surrogate-INTEGER-PK substrate, plus v6's 5 additive `archive_*` tables, minus v7's drop of `approvals`), default paths, `resolveWorkstreamId` (the SDK boundary's first leg). Pre-current DBs are upgraded in place on `openDb`: v5 → v6 was additive (CREATE-TABLE-IF-NOT-EXISTS), v6 → v7 is destructive-but-idempotent (`DROP TABLE IF EXISTS approvals` runs before `applySchema`); both happen with no migration script. |
| `src/tmux.ts`         | Single tmux executor wrapper, send protocol (bracketed-paste), pane validation            |
| `src/detect.ts`       | Pi-only status detector (`busy` / `needs_input` / `idle` / `done`)                        |
| `src/reconcile.ts`    | Ghost prune + status detect + orphan surface; "reality wins"                              |
| `src/agents.ts`       | Hub: CRUD + send / read / list / close / free + liveness + reaper. Re-exports `src/agents/*` (spawn, adopt, errors); pane-title composition (`composeAgentTitle`) lives here. |
| `src/agents/*.ts`     | Cohesive cluster of agent-lifecycle internals: `spawn.ts` (spawnAgent + resolveCliCommand / awaitSpawnLiveness / pane create-or-reuse / prestage / rollback), `adopt.ts` (register an existing tmux pane as a managed agent), `kick.ts` (signal the foreground pgid of an agent pane's TTY — escape hatch for wedged tool subprocesses), `errors.ts` (typed agent error classes — `AgentNotFoundError`, `AgentDiedOnSpawnError`, …). |
| `src/dag.ts`          | Shared DAG read/render helpers: `loadFullDag(db, workstream)` for whole-workstream root+edge forests and pure `renderForest` / `renderTaskTree` ASCII rendering reused by `mu task tree` and the TUI DAG popup. |
| `src/tasks.ts`        | Hub: every read/write verb on the DAG (edit / edges / queries) + cycle check + auto-event emission. Re-exports `src/tasks/*` (status, claim, lifecycle, wait, errors). |
| `src/tasks/*.ts`      | Cohesive cluster of task-graph internals: `status.ts` (TaskStatus enum + helpers — single source of truth), `claim.ts` (claim/release + `resolveActorIdentity`, atomic CAS), `lifecycle.ts` (setTaskStatus / closeTask / openTask / rejectTask / deferTask + cascade), `wait.ts` (waitForTasks: block until tasks reach a target status), `errors.ts` (typed task error classes — `TaskAlreadyOwnedError`, `CycleError`, …). |
| `src/tracks.ts`       | Parallel-tracks union-find with diamond merge                                             |
| `src/staleness.ts`    | Shared workspace staleness threshold (`WORKSPACE_STALE_THRESHOLD = 10`) and pure `isWorkspaceStale` predicate consumed by static state, the TUI Workspaces card, and dispatch-time warn/refuse checks. |
| `src/workstream.ts`   | ensureWorkstream / list / summarize / destroy / export (thin wrapper around the bucket renderer) |
| `src/exporting.ts`    | Unified bucket renderer for `mu workstream export` and `mu archive export`: per-task markdown + manifest.json (`bucketVersion: 2`); idempotent via per-file sha256; deleted-task preservation banner; refuses pre-0.3 single-source layouts |
| `src/importing.ts`    | Inverse of `src/exporting.ts`: parses a v0.3 bucket directory and rebuilds every source-ws as live tasks + edges + notes. Markdown-only (never reads .db); per-source-ws transactional; refuses silent merges into existing workstreams |
| `src/archives.ts`     | Cross-workstream **archives** — feature complete (SDK + 6 CLI verbs: `mu archive create / list / show / add / remove / delete`, plus `search` and `export` via the unified bucket renderer): `createArchive` / `listArchives` / `getArchive` / `deleteArchive` / `addToArchive` (idempotent at `(archive, source_workstream)`) / `removeFromArchive` / `listArchivedTasks`. Backed by the v6 `archives` + `archived_tasks` + `archived_edges` + `archived_notes` + `archived_events` tables; archives outlive workstreams (TEXT `source_workstream` columns, no FK). |
| `src/logs.ts`         | `agent_logs` SDK: appendLog / listLogs / latestSeq / emitEvent                            |
| `src/vcs.ts`          | `VcsBackend` interface + jj / sl / git / none impls; detection precedence (`jj root` → `sl root` → `git rev-parse --show-toplevel` → none, one subprocess probe per backend per cold detection; callers such as the TUI snapshot loop cache per tick rather than vcs.ts caching internally; `sl root --dotdir` distinguishes true `.sl` / `.hg` repos from Sapling's transparent plain-git mode); `commitsBehind(workspacePath, ref)` for staleness signal (no auto-fetch; pure observation); `recentCommits(projectRoot, limit)` + `showCommit(projectRoot, sha)` for the TUI's project-root Commits card/popup; `isClean(workspacePath)` cheap working-copy probe used by `closeAgent`'s clean-workspace auto-free path |
| `src/workspace.ts`    | Per-agent VCS workspaces (registry layer on top of vcs.ts); CRUD + cascade; orphan-dir detection (`listWorkspaceOrphans`); staleness decoration (`decorateWithStaleness` populates `commitsBehindMain` per row) |
| `src/snapshots.ts`    | Whole-DB snapshots (`VACUUM INTO`); auto-captured before destructive verbs; SDK for `mu undo`. The `snapshots` table is schema v4 (carried forward unchanged through v5/v6/v7). |
| `src/output.ts`       | NextStep type + `printNextSteps` + `errorNextSteps` plumbing for self-documenting output |
| `src/state.ts`        | SDK seam for the `mu state` verb. `loadWorkstreamSnapshot(db, ws, opts?)` is the one read pass over the SDK both the static renderer (`src/cli/state.ts`) and the TUI (`src/cli/tui/`) consume. Opt-in flags: `withDirty` (Workspaces card; populates `WorkspaceRow.dirty`), `withDoctor` (Doctor card; populates `WorkstreamSnapshot.doctor` via `loadDoctorSummary`), `withRecentCommits` (Commits card/popup; populates `recentCommits` plus `commitsBackend`). Plus pure derivation helpers: `agentStatusHistogram(agents)`, `summarizeOwnedTasks(owned)`, `roiBucket(impact, effortDays)`. |
| `src/doctor-summary.ts` | TUI-friendly slice of `mu doctor`'s checks. `loadDoctorSummary(db, snapshot)` returns a `DoctorSummary` (`{ checks: DoctorCheck[], problemCount }`) using only synchronous DB pragmas + COUNT-shape SELECTs and snapshot-derived counts (ghosts / orphan panes / orphan workspace dirs) — cheap enough for the per-tick poll-loop the TUI's slot-9 Doctor card runs on. `loadDoctorChecks(db, snapshot)` is a thin wrapper that returns the full check array (OK + warn + fail) for the slot-9 Doctor popup, which renders every row rather than just the non-OK subset. The textual `mu doctor` verb (`src/cli/doctor.ts`) keeps its own renderer; this is the data seam consumed by the dashboard. |
| `src/cli.ts`          | commander entry; `buildProgram()` (re-exports `format`/`handle` symbols for back-compat with existing import sites). |
| `src/cli/*.ts`        | one file per verb-namespace; thin wrappers over the SDK; `--json` rendering for every read verb. Currently: `workstream.ts`, `agents.ts`, `tasks.ts`, `workspace.ts`, `log.ts`, `archive.ts`, `state.ts` (canonical static state card + explicit `--tui` back-compat dispatch; bare `mu` TTY routing lives in `src/cli.ts` so it can inspect the root argv/TTY seam), `tui-launch-focus.ts` (pure shared initial-tab focus ladder for bare `mu` and `mu state --tui`: `$MU_SESSION`, tmux session, cwd inside workspace, cwd at VCS-derived project root with latest-activity tie-break, tab 0), `snapshot.ts`, `sql.ts`, `doctor.ts`. Two non-verb cluster-mates carry the rendering + error-handling primitives that every verb wrapper imports: `format.ts` (table renderers, status colourers, `truncate`/`relTime`) and `handle.ts` (typed-error → exit-code map + the `handle()` wrapper). Imports flow cluster → root (never the other way). |
| `src/cli/tui/*.tsx`   | Cohesive cluster of the interactive ink-based TUI (`mu state --tui`). Lazy-imported by `src/cli/state.ts` so non-TUI verbs avoid the ink/react cost. Per-file: `index.ts` (runTui entrypoint; writes the alt-screen enter/exit sequences from `escapes.ts` around the ink render), `escapes.ts` (pure ANSI escape constants `ALT_SCREEN_ENTER`/`ALT_SCREEN_EXIT` — no ink/react imports so unit tests can assert exact bytes without booting a renderer), `app.tsx` (root `<App>` with popup state machine + global keymap dispatch + footer + tick state + active-workstream-tab state per feat_tui_multi_workstream), `state.ts` (poll-loop hook `useDashboardSnapshot` + pure `snapshotKey`/`snapshotKeyString` re-render guard so the hook returns the SAME `data` reference across no-op ticks — the cards stop flickering 1×/sec; `lastTickMs` lives in its own useState so its tick-rate display can update without dragging the cards along; plus `clampTick`/`fasterTick`/`slowerTick` constants), `keys.ts` (pure `dispatchGlobalKey` + `dispatchPopupKey` keymap dispatchers), `yank.ts` (clipboard probe + write: pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52 fallback), `list-row.tsx` (`<ListRow>` — the centralised non-selected row primitive every popup/card consumes per feat_centralize_list_row_render; owns four invariants in one place: outer `<Box width={contentWidth}>` pin, canonical `COL_GUTTER`-spaced cells, `wrap="truncate"` on the outer `<Text>`, and selected→`<CursorRow>` delegation. Per-cell colours pass in declaratively as a `colors` array sibling of `COLUMN_SPECS`. Replaces 18 near-identical hand-rolled row JSX blocks across `popups/*.tsx`+`cards/*.tsx`; the test/tui-card-render-width.test.ts invariant is now "every renderRow consumer routes through ListRow OR CursorRow" — enforced by static-source assertions so a future popup author can't drift the gutter, forget the width pin, or skip wrap=truncate), `titled-box.tsx` (rounded-border primitive with section header inset into the top border; optional `bottomLabel` prop insets a `+M more · Shift+N` truncation hint into the BOTTOM border line per feat_card_footer_inset, suppressing the inner Box's bottom edge — the geometry is shared with the top-border path via the pure `computeBorderRowDashes` helper), `layout.ts` (pure responsive-dashboard helpers: breakpoint-driven pair-aware card columns plus per-card row-budget allocation with min/max/chrome config; columns use slot-stable ordering, slot 0 trails, and the 2-column layout splits stream cards as bottom trailers to keep the all-cards view balanced), `columns.ts` (column-aligned row layout with protect/clip clipping policy; exposes `contentWidthFromCols(cols)` + `termColsForLayout()` helpers — every card/popup feeds the result as `layoutColumns(rows, specs, contentWidth)` so clip cells actually clip instead of overflowing the row to a second line per bug_tui_long_lines_overflow), `help.tsx` (? keymap overlay), `cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` (10 dashboard glance cards; slot 0 is Commits, slot 5 promoted by feat_card_5_workspaces, slot 6 by feat_card_6_inprogress, slot 7 by feat_card_7_blocked, slot 8 is Recent, slot 9 by feat_card_9_doctor; DAG and all-tasks are keybind-only popup conventions, not cards), `popups/{dag,agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` (11 fullscreen drill-down popups; `dag.tsx` is keybind-only on `g` and renders the active workstream's full task-DAG forest; `commits.tsx` is slot-0 via Shift+0 and drills into backend show output; slot-5 popup promoted by feat_popup_5_workspaces, slot-6 by feat_popup_6_inprogress, slot-7 by feat_popup_7_blocked, slot-8 by feat_popup_8_recent (yanks `mu task open <id>`); slot-9 by feat_popup_9_doctor (the Doctor drill is a small ad-hoc detail view via `DrillScrollView`, NOT TaskDetailDrill — rows are doctor checks rather than tasks). All reserved numeric popup slots are now filled), `popups/drill.tsx` (`DrillScrollView` — the scroll-list primitive every popup-drill body shares; re-exports `clampScrollTop` from `popups/scroll.ts` for back-compat), `popups/scroll.ts` (pure `applyCursor` + `applyScroll` + `clampScrollTop` + `isNavAction` — the centralised navigation primitive every popup + drill consumes per feat_centralize_scroll_navigation; replaces ~60 near-duplicate `case "moveDown"/"moveUp"/"jumpTop"/"jumpBottom"/"pageUp"/"pageDown"` switch arms across 9 popups so j/k/g/G/Ctrl-D/U/PgUp/PgDn behave identically in every list-mode AND every drill-mode; pure TS with no ink/react imports, covered by test/tui-scroll.test.ts), `popups/viewport.ts` (pure `popupViewport(rows, chromeOverride?)` + `POPUP_CHROME_ROWS` + `POPUP_VIEWPORT_FLOOR` — each popup reads `useStdout().rows` at render time and calls `popupViewport` to size the body slice; replaces the prior hardcoded `const VIEWPORT = 20` per bug_tui_popup_data_doesnt_fill so the row data inside a `flexGrow={1}` popup Shell actually fills the pane), `popups/task-detail.tsx` (`TaskDetailDrill` — the read-only task-notes leaf consumed by the Tasks popup drill AND by the Tracks-popup `drill → task-detail` chain; future task-list popups under feat_more_cards_umbrella plug in unchanged), `use-popup-filter.tsx` (shared `/` filter state-machine: pure `popupFilterReducer` + `usePopupFilter` hook + `applyFilter<T>(items, query, blobOf)` + `<FilterPrompt>`. Every list popup wires the hook in ~5 LOC and gets the full UX — incremental edit, Enter commit, Esc cancel, status-bar mode flip, no-matches fallback — for free; new card popups under feat_more_cards_umbrella MUST consume it rather than re-implement), `tab-strip.tsx` (`<TabStrip>` — multi-workstream tab switcher rendered above the cards when `<App>` is launched with N≥2 workstreams; bold/cyan + `▸ ` marker for the active tab, dim names + ` · ` separators for the rest, plus a `(Tab / Shift-Tab)` affordance hint; renders nothing for N=1 so the single-ws frame is byte-identical to the pre-multi-ws build; pure presentational — the active index lives in `<App>`, `Tab`/`Shift-Tab` keys come through `dispatchGlobalKey`'s `nextTab`/`prevTab` actions). **The ONLY place ink/react are imported** — enforced by ROADMAP pledge. |
| `src/cli/*.ts`        | one file per verb-namespace; thin wrappers over the SDK; `--json` rendering for every read verb. Currently: `workstream.ts`, `agents.ts`, `tasks.ts`, `workspace.ts`, `log.ts`, `archive.ts`, `state.ts` (canonical static state card + explicit `--tui` back-compat dispatch; bare `mu` TTY routing lives in `src/cli.ts` so it can inspect the root argv/TTY seam), `snapshot.ts`, `sql.ts`, `doctor.ts`. Two non-verb cluster-mates carry the rendering + error-handling primitives that every verb wrapper imports: `format.ts` (table renderers, status colourers, `truncate`/`relTime`) and `handle.ts` (typed-error → exit-code map + the `handle()` wrapper). Imports flow cluster → root (never the other way). |
| `src/cli/tui/*.tsx`   | Cohesive cluster of the interactive ink-based TUI (`mu state --tui`). Lazy-imported by `src/cli/state.ts` so non-TUI verbs avoid the ink/react cost. Per-file: `index.ts` (runTui entrypoint; writes the alt-screen enter/exit sequences from `escapes.ts` around the ink render), `escapes.ts` (pure ANSI escape constants `ALT_SCREEN_ENTER`/`ALT_SCREEN_EXIT` — no ink/react imports so unit tests can assert exact bytes without booting a renderer), `app.tsx` (root `<App>` with popup state machine + global keymap dispatch + footer + tick state + active-workstream-tab state per feat_tui_multi_workstream), `state.ts` (poll-loop hook `useDashboardSnapshot` + pure `snapshotKey`/`snapshotKeyString` re-render guard so the hook returns the SAME `data` reference across no-op ticks — the cards stop flickering 1×/sec; `lastTickMs` lives in its own useState so its tick-rate display can update without dragging the cards along; plus `clampTick`/`fasterTick`/`slowerTick` constants), `keys.ts` (pure `dispatchGlobalKey` + `dispatchPopupKey` keymap dispatchers), `yank.ts` (clipboard probe + write: pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52 fallback), `list-row.tsx` (`<ListRow>` — the centralised non-selected row primitive every popup/card consumes per feat_centralize_list_row_render; owns four invariants in one place: outer `<Box width={contentWidth}>` pin, canonical `COL_GUTTER`-spaced cells, `wrap="truncate"` on the outer `<Text>`, and selected→`<CursorRow>` delegation. Per-cell colours pass in declaratively as a `colors` array sibling of `COLUMN_SPECS`. Replaces 18 near-identical hand-rolled row JSX blocks across `popups/*.tsx`+`cards/*.tsx`; the test/tui-card-render-width.test.ts invariant is now "every renderRow consumer routes through ListRow OR CursorRow" — enforced by static-source assertions so a future popup author can't drift the gutter, forget the width pin, or skip wrap=truncate), `titled-box.tsx` (rounded-border primitive with section header inset into the top border; optional `bottomLabel` prop insets a `+M more · Shift+N` truncation hint into the BOTTOM border line per feat_card_footer_inset, suppressing the inner Box's bottom edge — the geometry is shared with the top-border path via the pure `computeBorderRowDashes` helper), `layout.ts` (pure responsive-dashboard helpers: breakpoint-driven pair-aware card columns plus per-card row-budget allocation with min/max/chrome config; columns use slot-stable ordering, slot 0 trails, and the 2-column layout splits stream cards as bottom trailers to keep the all-cards view balanced), `columns.ts` (column-aligned row layout with protect/clip clipping policy; exposes `contentWidthFromCols(cols)` + `termColsForLayout()` helpers — every card/popup feeds the result as `layoutColumns(rows, specs, contentWidth)` so clip cells actually clip instead of overflowing the row to a second line per bug_tui_long_lines_overflow), `help.tsx` (? keymap overlay), `cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` (10 dashboard glance cards; slot 0 is Commits, slot 5 promoted by feat_card_5_workspaces, slot 6 by feat_card_6_inprogress, slot 7 by feat_card_7_blocked, slot 8 is Recent, slot 9 by feat_card_9_doctor; DAG and all-tasks are keybind-only popup conventions, not cards), `popups/{dag,agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` (11 fullscreen drill-down popups; `dag.tsx` is keybind-only on `g` and renders the active workstream's full task-DAG forest; `commits.tsx` is slot-0 via Shift+0 and drills into backend show output; slot-5 popup promoted by feat_popup_5_workspaces, slot-6 by feat_popup_6_inprogress, slot-7 by feat_popup_7_blocked, slot-8 by feat_popup_8_recent (yanks `mu task open <id>`); slot-9 by feat_popup_9_doctor (the Doctor drill is a small ad-hoc detail view via `DrillScrollView`, NOT TaskDetailDrill — rows are doctor checks rather than tasks). All reserved numeric popup slots are now filled), `popups/drill.tsx` (`DrillScrollView` — the scroll-list primitive every popup-drill body shares; re-exports `clampScrollTop` from `popups/scroll.ts` for back-compat), `popups/scroll.ts` (pure `applyCursor` + `applyScroll` + `clampScrollTop` + `isNavAction` — the centralised navigation primitive every popup + drill consumes per feat_centralize_scroll_navigation; replaces ~60 near-duplicate `case "moveDown"/"moveUp"/"jumpTop"/"jumpBottom"/"pageUp"/"pageDown"` switch arms across 9 popups so j/k/g/G/Ctrl-D/U/PgUp/PgDn behave identically in every list-mode AND every drill-mode; pure TS with no ink/react imports, covered by test/tui-scroll.test.ts), `popups/viewport.ts` (pure `popupViewport(rows, chromeOverride?)` + `POPUP_CHROME_ROWS` + `POPUP_VIEWPORT_FLOOR` — each popup reads `useStdout().rows` at render time and calls `popupViewport` to size the body slice; replaces the prior hardcoded `const VIEWPORT = 20` per bug_tui_popup_data_doesnt_fill so the row data inside a `flexGrow={1}` popup Shell actually fills the pane), `popups/task-detail.tsx` (`TaskDetailDrill` — the read-only task-notes leaf consumed by the Tasks popup drill AND by the Tracks-popup `drill → task-detail` chain; future task-list popups under feat_more_cards_umbrella plug in unchanged), `use-popup-filter.tsx` (shared `/` filter state-machine: pure `popupFilterReducer` + `usePopupFilter` hook + `applyFilter<T>(items, query, blobOf)` + `<FilterPrompt>`. Every list popup wires the hook in ~5 LOC and gets the full UX — incremental edit, Enter commit, Esc cancel, status-bar mode flip, no-matches fallback — for free; new card popups under feat_more_cards_umbrella MUST consume it rather than re-implement), `tab-strip.tsx` (`<TabStrip>` — multi-workstream tab switcher rendered above the cards when `<App>` is launched with N≥2 workstreams; bold/cyan + `▸ ` marker for the active tab, dim names + ` · ` separators for the rest, plus a `(Tab / Shift-Tab)` affordance hint; renders nothing for N=1 so the single-ws frame is byte-identical to the pre-multi-ws build; pure presentational — the active index lives in `<App>`, `Tab`/`Shift-Tab` keys come through `dispatchGlobalKey`'s `nextTab`/`prevTab` actions). **The ONLY place ink/react are imported** — enforced by ROADMAP pledge. |
| `src/cli/tasks/*.ts`  | sub-cluster of the `mu task` namespace; `tasks.ts` at the root re-exports only what callers outside the cluster import (`wireTaskCommands`, `cmdMyNext`/`cmdMyTasks`, `unescapeNoteText`). One file per concern: `queries.ts` (list/next/owned-by + the `cmdMyTasks` / `cmdMyNext` helpers that back `mu me tasks` / `mu me next`), `lifecycle.ts` (close/open/reject/defer + cascade preview), `edit.ts` (add/show/notes/note/update + helpers), `edges.ts` (block/unblock/reparent/delete), `claim.ts` (claim/release/wait), `tree.ts` (tree rendering), `wire.ts` (Commander glue). Each file < 600 LOC; the hub is < 35. |
| `src/index.ts`        | SDK entrypoint (re-exports)                                                               |
| `skills/mu/SKILL.md`  | Bundled skill teaching the LLM the model + verb list + jq pipelines                       |

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
   (`mu agent list`, state views), queries tmux for live pane
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
| `VcsBackend`        | Implementing `detect / createWorkspace / freeWorkspace / isClean / commitsBehind / rebaseTo / commitsSinceBase / recentCommits / showCommit` (~80–150 LOC; jj/sl/git/none are working examples)        |
| Per-CLI `Detector`  | Adding patterns to `detectPiStatus` (vanilla pi `to interrupt)`; pi-meta + every TUI wrapper covered by Braille spinner glyph fallback `[\u2800-\u28FF]`)                  |
| New typed verb      | Add an SDK function in the relevant `src/*.ts`; add a `cmd<Verb>` to the matching `src/cli/<namespace>.ts` (or create a new namespace if the verb doesn't fit existing ones); wire one commander block in `src/cli.ts`'s `buildProgram()` (use `handle()` for the exit-code map; route through `printNextSteps` for self-documenting output) |
| New schema migration| Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts`; mirror the new shape in `CURRENT_SCHEMA`. Two of the three post-v5 bumps were script-free: v5 → v6 was purely additive (the existing CREATE-TABLE-IF-NOT-EXISTS pass picked up the new `archive_*` tables), and v6 → v7 was a destructive-but-idempotent in-place migration (a `DROP TABLE IF EXISTS approvals` block in `applySchema`). Reach for a one-shot migration script only when the change can't be expressed that way (the v4 → v5 surrogate-PK substrate switch was the canonical example; restore from git history if you need to see the shape). The loud-fail hook in `openDb` rejects pre-current DBs with `SchemaTooOldError` (exit code 4) and a migration instruction. |
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
  TEXT names (`tasks.local_id`, `agents.name`) are
  per-workstream unique — the same name may legitimately exist in two
  workstreams. Every public SDK function that takes such a name also
  takes (or threads from a parent context) the workstream; internal
  SQL filters by `(workstream_id, name)`. Test fixtures and `mu sql`
  read paths can omit the workstream and fall back to the v4
  first-match-by-name contract. The invariant is now structurally
  enforced by the surrogate-id schema (per-workstream UNIQUE on
  name + INTEGER FKs); the previous CI grep guard was retired.
- **Snapshots are insurance, not version history.** Captured only
  before destructive verbs (workstream destroy, agent close, task
  close/reject/defer/release/delete, workspace free). Status flips and additive ops do NOT snapshot.
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

Single npm package `mu` (see `package.json`):

- `dist/cli.js` — CLI entry, executable (`bin: { mu: ./dist/cli.js }`; shebang preserved by `tsup`)
- `dist/index.js` + `dist/index.d.ts` — programmatic API + types for SDK callers
- `skills/mu/SKILL.md` — bundled skill (the only non-`dist` asset shipped)

`tsup` bundles two entries (`index`, `cli`) from `src/`. No
runtime build step on the user's machine; `npm install` just
unpacks. There is no pi-extension entry today — pi is a peer dep,
and the anti-feature pledge in ROADMAP.md keeps it that way.
Likewise no bundled `agents/*.md` or `prompts/*.md` directory
exists; per-role agent guidance lives in the user's project repo,
not in the mu package.

The dependency list lives in `package.json`; the rule for adding
new ones is the anti-feature pledge in
[ROADMAP.md § Anti-feature pledges](ROADMAP.md#anti-feature-pledges-still-in-force-reinforced-by-an-internal-critique).
