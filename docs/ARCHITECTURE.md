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
- **Status lifecycle**: `OPEN → IN_PROGRESS → CLOSED`, with
  `REJECTED` and `DEFERRED` as terminal still-blocking outcomes.
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

The Tracks section in `mu state` / bare `mu` runs union-find on the
graph to identify independent subtrees that can be assigned to
different agents in parallel.

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
- **`tmux attach -t mu-<workstream>`** → attach to the whole
  workstream's tmux session
- **`mu agent attach <agent>`** → print the agent's scrollback plus
  the one-paste tmux attach command for that pane
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

---

## TUI architecture

The TUI is a 10-card live-updating dashboard built on `ink` (React
for the terminal). It is mu's flagship human surface, but it is
**read-only** and lives entirely under `src/cli/tui/` — the static
CLI verbs remain the canonical mutation API. The TUI yanks `mu`
commands; the operator runs them.

### Cluster shape

`src/cli/tui/` is the only place ink/react are imported. The cluster
role-by-role:

```
src/cli/tui/
├── index.ts                    # runTui entrypoint; alt-screen + mouse-mode lifecycle
├── escapes.ts                  # pure ANSI byte sequences (alt-screen, SGR mouse mode)
├── app.tsx                     # <App> root: popup state machine, global keymap, tabs
├── state.ts                    # useDashboardSnapshot poll-loop hook (fast/slow tier split)
├── keys.ts                     # pure dispatchGlobalKey + dispatchPopupKey + shouldSwallowGlobalKey
├── keymap-spec.ts              # canonical keymap source-of-truth (drives help overlay + dispatch)
├── mouse.ts                    # vendored SGR mouse parser + double-click + useMouse hook
├── yank.ts                    # clipboard probe + write (pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52)
├── tuicr.ts                    # `t` shortcut: alt-screen handoff to tuicr -r <sha>
├── layout.ts                   # responsive multi-column dashboard + per-card row budgets
├── columns.ts                  # column-aligned row layout with protect/clip clipping
├── wrap-ansi.ts                # ANSI-aware visual-width line wrapper + SGR close-on-end
├── glyphs.ts                   # superscript digit + status glyphs
├── format-helpers.ts           # shared TUI formatters (relTime, sinceClaim, ROI)
├── titled-box.tsx              # rounded border with section-header / bottomLabel inset
├── popup-shell.tsx             # popup outer chrome (cyan TitledBox)
├── list-row.tsx                # centralised non-selected row primitive
├── padded-rows.tsx             # per-card body padder
├── status-bar.tsx              # bottom status bar (mode + active ws + tick + footer flash)
├── tab-strip.tsx               # multi-workstream tab switcher (N≥2)
├── tab-strip-layout.ts         # pure window-around-active layout helper
├── help.tsx                    # ?/F1 keymap overlay (scrollable on short panes)
├── use-popup-filter.tsx        # shared '/' substring filter hook + applyFilter + FilterPrompt
├── use-status-filter.tsx       # task-status toggles (o/i/c/r/d) for task-list popups
├── use-notes-drill.ts          # shared notes-drill memo (5 task popups consume it)
├── use-popup-action-queue.ts   # consume mouse PopupAction queue once per render
├── cards/                      # 10 dashboard glance cards (one slot each)
│   ├── _placeholder.tsx        # shared loading/empty body wrapper
│   └── {agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx
└── popups/                     # fullscreen drill-down popups
    ├── {agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx
    ├── dag.tsx                 # keybind-only on `g`: full task DAG forest
    ├── all-tasks.tsx           # keybind-only on `t`: sortable / filterable list of every task
    ├── drill.tsx               # DrillScrollView + useDrillKeymap (shared scrollable-text leaf)
    ├── task-detail.tsx         # TaskDetailDrill (notes timeline; the recursion sink)
    ├── cursor-row.tsx          # selected-row primitive (delegated to from list-row)
    ├── scroll.ts               # pure applyCursor / applyScroll / clampScrollTop / isNavAction
    ├── viewport.ts             # popupViewport + POPUP_CHROME_ROWS + POPUP_VIEWPORT_FLOOR
    └── show-loader.ts          # subprocess-preserving show loader (avoids blank-flash mid-refetch)
```

### State machine

`<App>` is the root. It owns:

- **Popup state** — `null` (dashboard) or one of the popup ids.
  Single-popup invariant; `Esc` / `q` returns to dashboard.
- **Card visibility** — `Record<CardId, boolean>` toggled by `0`-`9`.
- **Tick rate** — fast tick interval (1s default; adjustable with
  `+` / `-` / `=` / `0`).
- **Active workstream tab** — index into the resolved workstream
  set; `Tab` / `Shift-Tab` cycles when N≥2.
- **Footer flash** — transient status-bar message (yank confirm,
  tuicr exit, etc.).

Popups own their own local state (cursor, filter query, drill mode,
local modes like Workspaces' `list` / `commits` / `show`). Popups
NEVER mutate App-level state — they receive a read-only props bag
(`snapshot`, `db`, `workstream`, `fastTickNonce`, `slowTickNonce`,
`yank`, `onClose`, `onModeChange`, `onFilterEditingChange`,
`onFooter`).

### Polling tiers (fast vs slow)

The poll loop in `state.ts` (`useDashboardSnapshot`) splits work
into two intervals:

- **Fast tick** (default 1s, adjustable): SQL-only. `loadWorkstreamSnapshotFast`
  reads tasks, tracks, workspace registry rows, recent events,
  workspace orphans. Cheap (~p50 <1ms).
- **Slow tick** (10s, hardcoded `SLOW_TICK_MS`): subprocess-backed.
  `loadWorkstreamSnapshotSlow` runs tmux liveness, per-workspace
  dirty status, recent project commits, and the Doctor summary.
  Expensive (~p50 hundreds of ms).

The last slow result is merged into every fast render via
`mergeSnapshotFastSlow` so cards never flicker through a loading
state. `r` / `F5` triggers both intervals immediately. Workstream
tab switch clears the slow cache and eager-fetches the new
workstream so cards are fresh within 1s of switching.

A pure `snapshotKey` / `snapshotKeyString` re-render guard returns
the SAME `data` reference across no-op ticks so React's diffing
short-circuits cleanly.

### Render geometry

Responsive layout lives in `layout.ts`:

- **Breakpoint-driven columns**: stacked below 120 cols; 2 columns
  at 120; 3 at 180; 4 at 240. Stream cards (Commits, Activity log)
  trail; slot 0 (Commits) trails last.
- **Per-card row budgets**: each visible card gets a `min` /
  `max` / `chrome` budget; the allocator distributes available
  rows so a noisy list can't crowd siblings. Overflow surfaces as
  `+N more · Shift+N` inset into the card's bottom border.
- **Cull-on-tight-pane**: when even minimum budgets don't fit,
  cull cards by priority (Doctor → Recent → Workspaces → …) and
  show `+N cards hidden · resize taller` at the bottom. Outer
  height clip is the safety net.

Text rendering is ANSI-aware: `wrap-ansi.ts` wraps by visual width
(via `string-width`) and closes any open SGR state on the early-
return + end-of-loop paths so coloured fragments without trailing
`\x1b[0m` can't bleed into adjacent ink chrome cells. Drill bodies
are also space-padded to exact box width so ink's `wrap="truncate"`
ANSI miscount can't eat the trailing right-border glyph.

### Read-only invariant + the `tuicr` escape

Every popup row exposes one canonical `mu` command via `y`. `yank.ts`
probes for a clipboard backend (pbcopy / wl-copy / xclip / xsel /
clip.exe) and falls back to OSC-52 over stderr if none is found.
The command goes to the clipboard; the operator runs it.

The one user-driven escape is `t` inside any `git show` drill:
`tuicr.ts` writes `ALT_SCREEN_EXIT` + the SGR mouse-mode disable
bytes, exec's `tuicr -r <sha>` in the project root / workspace cwd
as a foreground subprocess, then on exit writes `ALT_SCREEN_ENTER`
+ mouse-mode-enable and the dashboard re-renders. This is a
deliberate handoff, not an in-process mutation.

The read-only pledge is in `docs/ROADMAP.md`'s anti-feature list;
any future TUI gesture that wants to mutate state must file a
roadmap entry first.

### Mouse + keyboard

Mouse support is opt-in via SGR mouse mode (`escapes.ts` provides
the enable/disable bytes). `mouse.ts` parses `ESC[<button;x;y;M/m`
from stdin, detects double-clicks, and exposes a `useMouse()` hook.

Keyboard dispatch flows through pure helpers in `keys.ts`:
`dispatchGlobalKey` (dashboard mode), `dispatchPopupKey` (popup
mode), and `shouldSwallowGlobalKey` (which keys popups consume
and do not bubble to the global dispatcher). The keymap source-of-
truth lives in `keymap-spec.ts` so the help overlay and the
dispatcher can never drift apart.

Double-click on a card emits `{kind: "setCursor", index}` followed
by `{kind: "drill"}` through `use-popup-action-queue.ts`, which
consumes one action per render (so the cursor update lands before
the drill resolves the focused row).

### Drill recursion

List popups drill via `Enter` into entity-specific leaves. The
central primitive is `popups/drill.tsx`'s `DrillScrollView` (a
scrollable text leaf shared by Workspaces' git-show, Agents'
scrollback, the Activity log payload drill, and the Doctor
remediation drill). Task popups drill into
`popups/task-detail.tsx`'s `TaskDetailDrill` (the notes timeline);
the Tracks popup chains track → task list → TaskDetailDrill via
the same leaf.

`useDrillKeymap` owns the scroll state, accepts an optional
`resetKey` (so identity-change resets scroll while tick-driven body
refreshes preserve it), an optional `onScrollChange` callback (so
the DAG popup's focused-root tracking stays in lockstep), and
shares ANSI-aware wrapped body metadata so the scroll-clamp math
and the painter can't desync.

Subprocess-backed drills (Workspaces git-show, Agents scrollback,
Commits show) use `popups/show-loader.ts` which preserves the
prior body during a refetch — no blank-flash flicker on the slow
tick.

### Test seam

TUI behaviour testing is documented in `test/README.md`. The
seam is `test/_ink-render.ts`'s `createInkInputStream` +
`createInkCaptureStream` + `simulateInput` + `latestRenderedFrame`.
Mount a popup or `<App>` into a CaptureStream, drive keystrokes,
assert against the visible frame and spy callbacks. Source-greps
are reserved for narrow structural guards (App ↔ keys ↔ layout
wiring; slot ↔ keymap glue) — not for behaviour.

---

## CLI / SDK surface

Every user-visible operation is a typed SDK function plus a thin
Commander wrapper. The CLI wiring in `src/cli.ts` and the verb
namespace files under `src/cli/` are the canonical verb surface;
there is no generated registry layer, DSL, or separate operation
schema. Programmatic callers import the same SDK functions from
`src/index.ts`, while agents/scripts compose CLI verbs with `--json`.

The boundary rule is: external surfaces accept operator-facing names
(`workstream`, task id, agent name); internal helpers resolve those to
surrogate INTEGER ids once and then stay on ids. See
[§ Surrogate-PK + SDK-boundary discipline](#surrogate-pk--sdk-boundary-discipline-load-bearing).

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

Mostly-flat `src/`: root `.ts` modules plus cohesive subclusters
(`src/agents/`, `src/tasks/`, and `src/cli/` wrappers with their own
`src/cli/tasks/` and `src/cli/tui/` sub-clusters). No `core/`
subdirectory; no anticipatory layering. Subclusters obey the
AGENTS.md rule: cluster files import from neighbours and root
substrate modules, never from the hub they're re-exported through.
Each module is concrete and consumed today.

| Module                | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/db.ts`           | SQLite (better-sqlite3) connection, WAL mode, schema (16 tables + 3 views, **schema v8** — v5 surrogate-INTEGER-PK substrate, v6's 5 additive `archive_*` tables, v7's drop of `approvals`, v8's additive `machine_identity` + `workstream_sync` sync substrate), default paths, `resolveWorkstreamId` (the SDK boundary's first leg). `openDb` refuses pre-v5 DBs loudly; v5+ DBs are brought to the current idempotent schema shape by `applySchema` (including v7's `DROP TABLE IF EXISTS approvals`) and `openDb` seeds `machine_identity` on open. |
| `src/tmux.ts`         | Single tmux executor wrapper, send protocol (bracketed-paste), pane validation            |
| `src/detect.ts`       | Pi-only status detector (`busy` / `needs_input` / `idle` / `done`)                        |
| `src/reconcile.ts`    | Ghost prune + status detect + orphan surface; "reality wins"                              |
| `src/agents.ts`       | Hub: CRUD + send / read / list / close / free + liveness + reaper. Re-exports `src/agents/*` (spawn, adopt, errors); pane-title composition (`composeAgentTitle`) lives here. |
| `src/agents/*.ts`     | Cohesive cluster of agent-lifecycle internals: `spawn.ts` (spawnAgent + resolveCliCommand / awaitSpawnLiveness / pane create-or-reuse / prestage / rollback), `adopt.ts` (register an existing tmux pane as a managed agent), `kick.ts` (signal the foreground pgid of an agent pane's TTY — escape hatch for wedged tool subprocesses), `errors.ts` (typed agent error classes — `AgentNotFoundError`, `AgentDiedOnSpawnError`, …). |
| `src/dag.ts`          | Shared DAG read/render helpers: `loadFullDag(db, workstream)` for whole-workstream root+edge forests and pure `renderForest` / `renderTaskTree` ASCII rendering reused by `mu task tree` and the TUI DAG popup. |
| `src/tasks.ts`        | Task SDK hub: re-exports the concrete task-graph cluster so external imports keep using `./tasks.js`; no implementation logic. |
| `src/tasks/*.ts`      | Cohesive cluster of task-graph internals: `core.ts` (row-shape mapping, surrogate-id resolution, `touchTask`), `id.ts` (task-id validation + title slug helpers), `queries.ts` (get/list/ready/blocked/goals/notes/owned/search reads), `edit.ts` (add task/note, update, delete), `edges.ts` (edge reads, cycle check, block/unblock/reparent), `status.ts` (TaskStatus enum + helpers — single source of truth), `sort.ts` (shared task sort keys/comparators for CLI + TUI), `claim.ts` (claim/release + `resolveActorIdentity`, atomic CAS), `lifecycle.ts` (setTaskStatus / closeTask / openTask / rejectTask / deferTask + cascade), `wait.ts` (waitForTasks: block until tasks reach a target status), `errors.ts` (typed task error classes — `TaskAlreadyOwnedError`, `CycleError`, …). Cluster files import neighbours/root substrate modules directly, never the `src/tasks.ts` hub. |
| `src/tracks.ts`       | Parallel-tracks union-find with diamond merge                                             |
| `src/staleness.ts`    | Shared workspace staleness threshold (`WORKSPACE_STALE_THRESHOLD = 10`) and pure `isWorkspaceStale` predicate consumed by static state, the TUI Workspaces card, and dispatch-time warn/refuse checks. |
| `src/workstream.ts`   | ensureWorkstream / list / summarize / destroy / export (thin wrapper around the bucket renderer) |
| `src/exporting.ts`    | Unified bucket renderer for `mu workstream export` and `mu archive export`: per-task markdown + manifest.json (`bucketVersion: 2`); idempotent via per-file sha256; deleted-task preservation banner; refuses pre-0.3 single-source layouts. Buckets are read-only artifacts for humans / git / docs, not a DB round-trip substrate. |
| `src/db-sync.ts`      | Whole-machine DB sync SDK: `exportDb` (`VACUUM INTO` + manifest), `importDb` (per-workstream drift plan over `machine_identity` + `workstream_sync`; dry-run by default; `--force-source` parks divergence sidecars), manifest/schema validation, workstream copy/replace helpers, typed db-sync errors. |
| `src/db-sync-replay.ts` | Manual replay planner/applier for divergence sidecars parked by `mu db import --force-source`: selects missing tasks/notes/eligible edges, refuses `local_id` collisions with diverged content, dry-run by default. Re-exported by `src/db-sync.ts` for SDK callers. |
| `src/archives.ts`     | Archive SDK hub: re-exports the concrete `src/archives/` cluster, including restore, so external imports keep using `./archives.js`; no implementation logic. |
| `src/archives/*.ts`   | Cohesive cluster for cross-workstream **archives** — feature complete (SDK + CLI verbs: `mu archive create / list / show / add / restore / remove / delete`, plus `search` and read-only `export` via the unified bucket renderer): `core.ts` (label validation, row types, typed archive errors, id resolution/summarise helpers), `query.ts` (`createArchive`, `listArchives`, `getArchive`, `listArchivedTasks`, `searchArchives`), `addremove.ts` (`addToArchive` idempotent at `(archive, source_workstream)`, `removeFromArchive`), `restore.ts` (`restoreArchive` lossless un-archive into a fresh workstream), `delete.ts` (`deleteArchive`). Backed by the v6 `archives` + `archived_tasks` + `archived_edges` + `archived_notes` + `archived_events` tables; archives outlive workstreams (TEXT `source_workstream` columns, no FK). Cluster files import neighbours/root substrate modules directly, never the `src/archives.ts` hub. |
| `src/archives/restore.ts` | Lossless un-archive implementation: validates `--source` when an archive has multiple source workstreams, refuses `--as` collisions through workstream creation, snapshots before writing, copies archived tasks/edges/notes directly from `archived_*` rows, and emits an archive-restore event. Does not restore agents, workspace paths, or the live `agent_logs` stream. |
| `src/logs.ts`         | `agent_logs` SDK: appendLog / listLogs / latestSeq / emitEvent                            |
| `src/vcs.ts`          | VCS SDK hub: re-exports the concrete `src/vcs/` cluster so external imports keep using `./vcs.js`; no implementation logic. |
| `src/vcs/*.ts`        | Cohesive cluster of VCS backends: `types.ts` (`VcsBackend` interface, result shapes, typed workspace errors, show-output cap), `helpers.ts` (exec/probe/run/show/commit-summary parsing helpers), `git.ts`, `jj.ts`, `sl.ts`, and `none.ts` (one concrete backend per file), `index.ts` (detection precedence dispatcher: `jj root` → `sl root` → `git rev-parse --show-toplevel` → none; `backendByName`). Backend methods cover `commitsBehind(workspacePath, ref)` for staleness (no auto-fetch; pure observation), `recentCommits(projectRoot, limit)` + `showCommit(projectRoot, sha)` for the TUI Commits card/popup, and `isClean(workspacePath)` for `closeAgent`'s clean-workspace auto-free path. Cluster files import neighbours/root substrate modules directly, never the `src/vcs.ts` hub. |
| `src/workspace.ts`    | Workspace SDK hub: re-exports the concrete `src/workspace/` cluster so external imports keep using `./workspace.js`; no implementation logic. |
| `src/workspace/*.ts`  | Cohesive cluster for per-agent VCS workspaces (registry layer on top of `vcs.ts`): `core.ts` (row shapes, path helpers, typed workspace errors), `crud.ts` (create/get/list/free/refresh/commits/clean checks), `decorate.ts` (staleness + dirty decoration), `orphans.ts` (per-workstream and all-workstream orphan-dir detection), `recreate.ts` (free+create between-wave verb). Cluster files import neighbours/root substrate modules directly, never the `src/workspace.ts` hub. |
| `src/snapshots.ts`    | Snapshot SDK hub: re-exports the concrete `src/snapshots/` cluster so external imports keep using `./snapshots.js`; no implementation logic. |
| `src/snapshots/*.ts`  | Cohesive cluster for whole-DB snapshots (`VACUUM INTO`): `core.ts` (row shapes, typed snapshot/prune errors, GC env readers, paths, size/version helpers), `capture.ts` (capture/list/auto-GC), `restore.ts` (`mu undo` restore file-swap), `prune.ts` (manual prune/delete cleanup verbs). The `snapshots` table is schema v4 (carried forward unchanged through v5/v6/v7/v8). Cluster files import neighbours/root substrate modules directly, never the `src/snapshots.ts` hub. |
| `src/output.ts`       | NextStep type + `printNextSteps` + `errorNextSteps` plumbing for self-documenting output |
| `src/state.ts`        | SDK seam for the `mu state` verb. `loadWorkstreamSnapshotFast(db, ws, opts?)` is the pure-SQL tier used by the TUI's 1s fast tick (tracks, task slices, workspace registry rows, workspace orphans, recent events; subprocess fields empty). `loadWorkstreamSnapshotSlow(db, ws, opts?)` is the subprocess tier (tmux-derived `view`, workspace dirty flags, recent project commits/backend, Doctor summary). `mergeSnapshotFastSlow` overlays the last slow result onto each fast result, and `loadWorkstreamSnapshot(db, ws, opts?)` stays as a back-compat wrapper that composes both tiers for static/non-TUI callers. Opt-in flags: `withDirty` (slow-tier dirty flag), `withDoctor` (Doctor summary), `withRecentCommits` (Commits card/popup), `withAllTasks` (legacy/full-snapshot all-task list; the TUI all-tasks popup can read SQLite directly while open). Plus pure derivation helpers: `agentStatusHistogram(agents)`, `summarizeOwnedTasks(owned)`, `roiBucket(impact, effortDays)`. |
| `src/doctor-summary.ts` | TUI-friendly slice of `mu doctor`'s checks. `loadDoctorSummary(db, snapshot)` returns a `DoctorSummary` (`{ checks: DoctorCheck[], problemCount }`) using only synchronous DB pragmas + COUNT-shape SELECTs and snapshot-derived counts (ghosts / orphan panes / orphan workspace dirs) — cheap enough for the per-tick poll-loop the TUI's slot-9 Doctor card runs on. `loadDoctorChecks(db, snapshot)` is a thin wrapper that returns the full check array (OK + warn + fail) for the slot-9 Doctor popup, which renders every row rather than just the non-OK subset. Also home to the per-check remediation helpers `yankCommandForCheck(check)` (informational SELECT-shape verb to yank for the focused row, with a `# ...` comment fallback for schema-shape checks) and `remediationParagraph(check)` (multi-line prose explaining the failure shape) — both pure, both re-exported from `src/index.ts`, both consumed by the slot-9 popup's drill view but living next to `DoctorCheck` so adding a new check is a single touchpoint. The textual `mu doctor` verb (`src/cli/doctor.ts`) keeps its own renderer; this is the data seam consumed by the dashboard. |
| `src/cli.ts`          | commander entry; `buildProgram()` (re-exports `format`/`handle` symbols for back-compat with existing import sites). |
| `src/cli/db.ts`       | Thin commander/renderer for `mu db export / import / replay`: summary tables, dry-run vs apply Next steps, `--only-ws` repeated-or-comma parsing, and JSON envelopes over the `src/db-sync.ts` SDK. |
| `src/cli/*.ts`        | one file per verb-namespace; thin wrappers over the SDK; `--json` rendering for every read verb. Currently: `workstream.ts`, `agents.ts`, `tasks.ts`, `workspace.ts`, `log.ts`, `archive.ts`, `db.ts` (whole-machine sync), `state.ts` (canonical static state card + explicit `--tui` back-compat dispatch; bare `mu` TTY routing lives in `src/cli.ts` so it can inspect the root argv/TTY seam), `tui-launch-focus.ts` (pure shared initial-tab focus ladder for bare `mu` and `mu state --tui`: `$MU_SESSION`, tmux session, cwd inside workspace, cwd at VCS-derived project root with latest-activity tie-break, tab 0), `snapshot.ts`, `sql.ts`, `doctor.ts`. Two non-verb cluster-mates carry the rendering + error-handling primitives that every verb wrapper imports: `format.ts` (table renderers, status colourers, `truncate`/`relTime`) and `handle.ts` (typed-error → exit-code map + the `handle()` wrapper). Imports flow cluster → root (never the other way). |
| `src/cli/tui/*.tsx`   | Cohesive cluster of the interactive ink-based TUI (`mu state --tui`). Lazy-imported by `src/cli/state.ts` so non-TUI verbs avoid the ink/react cost. Per-file: `index.ts` (runTui entrypoint; writes the alt-screen enter/exit sequences from `escapes.ts` around the ink render and enables/disables mouse mode in the same finally-guarded lifecycle), `escapes.ts` (pure ANSI escape constants `ALT_SCREEN_ENTER`/`ALT_SCREEN_EXIT` plus SGR mouse-mode enter/exit bytes — no ink/react imports so unit tests can assert exact bytes without booting a renderer), `mouse.ts` (tiny vendored SGR mouse layer: enable/disable helpers, stdin parser for `ESC[<button;x;y;M/m`, double-click detector, and `useMouse()` hook), `app.tsx` (root `<App>` with popup state machine + global keymap dispatch + footer + tick state + active-workstream-tab state per feat_tui_multi_workstream), `state.ts` (poll-loop hook `useDashboardSnapshot` split into a fast SQL-only interval controlled by `tickMs` and a hardcoded `SLOW_TICK_MS = 10_000` subprocess interval; cached slow fields are merged into every fast render, `r`/F5 triggers both intervals immediately, and workstream switches clear the slow cache then eager-fetch the new workstream; plus pure `snapshotKey`/`snapshotKeyString` re-render guard so the hook returns the SAME `data` reference across no-op ticks; `lastTickMs` lives in its own useState so its tick-rate display can update without dragging the cards along; plus `clampTick`/`fasterTick`/`slowerTick` constants), `keys.ts` (pure `dispatchGlobalKey` + `dispatchPopupKey` keymap dispatchers), `yank.ts` (clipboard probe + write: pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52 fallback), `list-row.tsx` (`<ListRow>` — the centralised non-selected row primitive every popup/card consumes per feat_centralize_list_row_render; owns four invariants in one place: outer `<Box width={contentWidth}>` pin, canonical `COL_GUTTER`-spaced cells, `wrap="truncate"` on the outer `<Text>`, and selected→`<CursorRow>` delegation. Per-cell colours pass in declaratively as a `colors` array sibling of `COLUMN_SPECS`. Replaces 18 near-identical hand-rolled row JSX blocks across `popups/*.tsx`+`cards/*.tsx`; the test/tui-card-render-width.test.ts invariant is now "every renderRow consumer routes through ListRow OR CursorRow" — enforced by static-source assertions so a future popup author can't drift the gutter, forget the width pin, or skip wrap=truncate), `titled-box.tsx` (rounded-border primitive with section header inset into the top border; optional `bottomLabel` prop insets a `+M more · Shift+N` truncation hint into the BOTTOM border line per feat_card_footer_inset, suppressing the inner Box's bottom edge — the geometry is shared with the top-border path via the pure `computeBorderRowDashes` helper), `layout.ts` (pure responsive-dashboard helpers: breakpoint-driven pair-aware card columns plus per-card row-budget allocation with min/max/chrome config; columns use slot-stable ordering, slot 0 trails, and the 2-column layout splits stream cards as bottom trailers to keep the all-cards view balanced), `columns.ts` (column-aligned row layout with protect/clip clipping policy; exposes `contentWidthFromCols(cols)` + `termColsForLayout()` helpers — every card/popup feeds the result as `layoutColumns(rows, specs, contentWidth)` so clip cells actually clip instead of overflowing the row to a second line per bug_tui_long_lines_overflow), `help.tsx` (? keymap overlay), `cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` + `cards/_placeholder.tsx` (`<CardPlaceholder>` — shared loading/empty body wrapper invoked as a function so the test walker still sees the underlying TitledBox/PaddedRows; collapses 20 near-identical 10-line `<TitledBox><PaddedRows><Text dimColor>...</Text></PaddedRows></TitledBox>` blocks across the 10 cards per review_tui_card_loading_empty_boilerplate) (10 dashboard glance cards; slot 0 is Commits, slot 5 promoted by feat_card_5_workspaces, slot 6 by feat_card_6_inprogress, slot 7 by feat_card_7_blocked, slot 8 is Recent, slot 9 by feat_card_9_doctor; DAG and all-tasks are keybind-only popup conventions, not cards), `popups/{dag,all-tasks,agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx` (12 fullscreen drill-down popups; `dag.tsx` is keybind-only on `g` and renders the active workstream's full task-DAG forest; `all-tasks.tsx` is keybind-only on `t`, renders every task as a sortable/filterable list via the shared `use-status-filter.tsx`, and drills into `TaskDetailDrill`; `commits.tsx` is slot-0 via Shift+0 and drills into backend show output; slot-5 popup promoted by feat_popup_5_workspaces, slot-6 by feat_popup_6_inprogress, slot-7 by feat_popup_7_blocked, slot-8 by feat_popup_8_recent (yanks `mu task open <id>`); slot-9 by feat_popup_9_doctor (the Doctor drill is a small ad-hoc detail view via `DrillScrollView`, NOT TaskDetailDrill — rows are doctor checks rather than tasks). All reserved numeric popup slots are now filled), `popups/drill.tsx` (`DrillScrollView` — the scroll-list primitive every popup-drill body shares; re-exports `clampScrollTop` from `popups/scroll.ts` for back-compat), `popups/scroll.ts` (pure `applyCursor` + `applyScroll` + `clampScrollTop` + `isNavAction` — the centralised navigation primitive every popup + drill consumes per feat_centralize_scroll_navigation; replaces ~60 near-duplicate `case "moveDown"/"moveUp"/"jumpTop"/"jumpBottom"/"pageUp"/"pageDown"` switch arms across 9 popups so j/k/g/G/Ctrl-D/U/PgUp/PgDn behave identically in every list-mode AND every drill-mode; pure TS with no ink/react imports, covered by test/tui-scroll.test.ts), `popups/viewport.ts` (pure `popupViewport(rows, chromeOverride?)` + `POPUP_CHROME_ROWS` + `POPUP_VIEWPORT_FLOOR` — each popup reads `useStdout().rows` at render time and calls `popupViewport` to size the body slice; replaces the prior hardcoded `const VIEWPORT = 20` per bug_tui_popup_data_doesnt_fill so the row data inside a `flexGrow={1}` popup Shell actually fills the pane), `popups/task-detail.tsx` (`TaskDetailDrill` — the read-only task-notes leaf consumed by the Tasks popup drill AND by the Tracks-popup `drill → task-detail` chain; future task-list popups under feat_more_cards_umbrella plug in unchanged), `use-popup-filter.tsx` (shared `/` filter state-machine: pure `popupFilterReducer` + `usePopupFilter` hook + `applyFilter<T>(items, query, blobOf)` + `<FilterPrompt>`. Every list popup wires the hook in ~5 LOC and gets the full UX — incremental edit, Enter commit, Esc cancel, status-bar mode flip, no-matches fallback — for free; new card popups under feat_more_cards_umbrella MUST consume it rather than re-implement), `use-status-filter.tsx` (shared task-status toggle hook + `<StatusFilterStrip>` for task-list popups; default all-on, popup-local, mnemonic o/i/c/r/d toggles OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED, no persistence), `use-notes-drill.ts` (shared notes-drill memo — returns the `renderNotes(...)` body string for the focused task only when the popup is in drill mode; per task review_tui_task_popups_duplicated_template the byte-identical useMemo block deduped from all five task-list popups (Tasks/ready, In-progress, Blocked, Recent, All-tasks) so the next task-list popup is a one-line drop-in and the SQL+tick semantics stay in lockstep), `tab-strip.tsx` (`<TabStrip>` — multi-workstream tab switcher rendered above the cards when `<App>` is launched with N≥2 workstreams; bold/cyan + `▸ ` marker for the active tab, dim names + ` · ` separators for the rest, plus a `(Tab / Shift-Tab)` affordance hint; renders nothing for N=1 so the single-ws frame is byte-identical to the pre-multi-ws build; pure presentational — the active index lives in `<App>`, `Tab`/`Shift-Tab` keys come through `dispatchGlobalKey`'s `nextTab`/`prevTab` actions). **The ONLY place ink/react are imported** — enforced by ROADMAP pledge. |
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
| New schema migration| Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts`; mirror the new shape in `CURRENT_SCHEMA`. Three of the four post-v5 bumps were script-free: v5 → v6 was purely additive (the existing CREATE-TABLE-IF-NOT-EXISTS pass picked up the new `archive_*` tables), v6 → v7 was a destructive-but-idempotent in-place migration (a `DROP TABLE IF EXISTS approvals` block in `applySchema`), and v7 → v8 is additive (`machine_identity`, `workstream_sync`, plus the `openDb` seed for `machine_identity`). Reach for a one-shot migration script only when the change can't be expressed that way (the v4 → v5 surrogate-PK substrate switch was the canonical example; restore from git history if you need to see the shape). The loud-fail hook in `openDb` rejects pre-current DBs with `SchemaTooOldError` (exit code 4) and a migration instruction. |
| Snapshot hook       | Add `await captureSnapshot(db, 'verb-name', workstream)` at the top of any new destructive verb (one-liner; GC + restore behaviour automatic) |
| Cross-machine sync  | `machine_identity` gives each state directory a durable uuid; `workstream_sync.last_known_peer_seqs` records per-workstream peer progress. `mu db import` compares source `latestSeq`, local `latestSeq`, and the last-seen peer seq to classify the five cases: `IDENTICAL` / `FAST_FORWARD` / `LOCAL_AHEAD` / `CONFLICT` / `IMPORT`. Conflicts are sharp: refuse by default, or `--force-source` after parking the whole local workstream into a divergence sidecar for later `mu db replay`. |

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
  const taskId = tryResolveTaskId(db, wsId, localId);
  if (taskId === null) throw new TaskNotFoundError(localId);
  const agentId = resolveCurrentAgentId(db, wsId);
  return claimTaskById(db, taskId, agentId, opts);
}

// INTERNAL: takes surrogate ids; never re-resolves
function claimTaskById(db, taskId, agentId, opts): ClaimResult { ... }
```

Why exactly once at the boundary: no double-resolution; no
mid-function ambiguity (once surrogate ids exist, internal helpers
don't need to thread workstream context — the FKs make scope
implicit); one place to do error mapping (`WorkstreamNotFoundError`
originates at resolve-time inside `src/db.ts`; `TaskNotFoundError` /
`AgentNotFoundError` are raised by SDK callers wrapping the
`tryResolve*` null-return so the typed class — and the CLI's
exit-code 3 mapping — stays consistent regardless of which leg of
the resolve missed).

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
| `src/vcs.ts` + `src/workspace.ts`  | `*.integration.test.ts` files use real git in `os.tmpdir()`; jj/sl tests feature-detect (skip if binary missing) |
| `src/cli.ts` / verb integration    | `*.integration.test.ts` files; real tmux server, unique session per test        |
| Fast unit/dev-loop tier            | `npm run test:fast`; excludes `*.integration.test.ts` / `*.smoke.test.ts`, uses mocked tmux/VCS and per-test temp DBs |
| Stress / flake audit               | `npm run test:stress`; repeats the full suite with per-run logs/timeouts and can run parallel full-suite waves (`MU_TEST_STRESS_MODE=parallel`) to simulate multiple mu agents testing concurrently |
| End-to-end                         | `test/acceptance.integration.test.ts` — the canonical 10-task / 3-agent demo   |

Historical flake audit summary: the closed
`bug_test_suite_flakes_audit_and_remediate` task found no separate
product seam. The durable lessons are: treat pass-alone/fail-under-load
cases as concurrency bugs first; use retrying temp-dir cleanup for VCS
fixtures whose subprocesses keep files alive briefly; drive wait/reaper
integration tests from poll-loop seams instead of fixed timers; and wait
for stable Ink output instead of sleeping a fixed number of ms.

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
[ROADMAP.md § Anti-feature pledges](ROADMAP.md#anti-feature-pledges).
