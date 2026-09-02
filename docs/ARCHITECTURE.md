# Architecture

mu is one SQLite file, a crew of agents in multiplexer panes, a task
DAG, and one append-only op log everything else is derived from. It is
layered: callers on top, a shared TypeScript core in the middle,
SQLite + mux + VCS substrates at the base. The CLI verbs and the
programmatic SDK are thin facades over the same core modules.

- For canonical terms (*workstream*, *agent*, *task DAG*, *track*,
  *claim*, *free*, *workspace*, *substrate*, ...) see
  [VOCABULARY.md](VOCABULARY.md). It is the source of truth.
- For design rationale, rejected alternatives, and what's on the
  roadmap, see [ROADMAP.md](ROADMAP.md).
- For principles, see [VISION.md](VISION.md).

```
┌─────────────────────────────────────────────────────────────────┐
│  Callers                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  Pi      │  │  Bash +  │  │  Pi sub-     │  │ mu log      │  │
│  │  shell   │  │  jq      │  │  agent       │  │ --tail subs │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  └──────┬──────┘  │
│       │             │               │                 │         │
└───────┼─────────────┼───────────────┼─────────────────┼─────────┘
        │  in-proc    │ subprocess    │ subprocess      │ in-proc
        ▼             ▼               ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  mu core (shared TS modules)                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ agents/  │  │  tasks/  │  │   vcs/   │  │  ops log/       │  │
│  │ mux/     │  │ schema   │  │ jj       │  │  capture        │  │
│  │ tmux     │  │ queries  │  │ sapling  │  │  apply/sync     │  │
│  │ herdr    │  │ tracks   │  │ git      │  │  doctor         │  │
│  │ detect   │  │ claim    │  │ none     │  │                 │  │
│  │ state    │  │          │  │          │  │                 │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬────────┘  │
└───────┼─────────────┼─────────────┼─────────────────┼───────────┘
        ▼             ▼             ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Substrates                                                     │
│  SQLite (~/.local/state/mu/mu.db) · tmux/herdr panes · jj/sl/git│
└─────────────────────────────────────────────────────────────────┘
```

## The ops log (read this first)

Everything below rests on one append-only table. Read this section
before the rest of the file.

**Capture is a trigger, not a call site.** Every INSERT / UPDATE /
DELETE on a portable table (`workstreams`, `tasks`, `task_edges`,
`task_notes`) is recorded as an **op** by a SQLite trigger, in the
SAME transaction as the mutation. No SDK function decides to record
history, so no call site can forget to, and the log cannot drift from
the data — not even on power loss.

**The log is the record; the tables are the materialized view.**
Reads hit the tables, as ordinary indexed SQL. This is not
event-sourcing-on-read: nothing replays the log to answer a query.
The log is what the tables are *derived from* and what they can be
rebuilt from.

```
  mu task close t3
     │
     ▼
  UPDATE tasks SET status=... ──┬──► tables   (what reads see)
                                └──► ops     (what everything else reads)
                          one transaction
```

**Four features are queries or replays over that one log:**

- **history** — `mu log` is a typed reader over `ops`.
- **undo** — `mu undo <group>` emits the inverse ops for one group.
- **sync** — a machine appends its own ops to a JSONL segment in a
  shared folder and applies each peer's from a watermark.

**Ops are semantic partial updates.** An UPDATE op carries only the
columns that actually changed. That is what makes per-field merge
free: two machines editing different fields of one task both keep
their edit, with no extra bookkeeping. A full-row payload would
silently regress this to row-level last-writer-wins.

**The cost, plainly:** one mechanism means one capture bug breaks
history, undo and sync at once, silently. That is why
`mu doctor --deep` rebuilds the log into a temp DB and diffs it
field-by-field against the live tables, and why the cheap tier
(every live row has at least one op naming it) runs by default.

Ordering across machines comes from the **HLC** on every op — a
hybrid logical clock serialized so that bytewise `ORDER BY hlc` is
causal order. Machine-local tables (`agents`, `vcs_workspaces`) have
no capture triggers: their contents are pane ids and absolute paths,
which mean nothing on another machine. Their changes are recorded as
log-only events via `emitEvent`.

Per-module detail is in [§ Modules](#modules-actual-src-layout).

---

## The task DAG

mu's coordination model is a **directed acyclic graph of tasks**. It
is the central organizing primitive, not a sidecar feature: without
it mu is just an agent runner.

### Model

- **Tasks** are nodes with mandatory `impact (1-100)` and `effort_days`.
  `ROI = impact / effort` drives prioritization.
- **One edge type**: `blocks`. `A → B` means A must close before B can
  start. Multiple edge types create ambiguity that defeats the purpose.
- **Status lifecycle**: `OPEN → IN_PROGRESS → CLOSED`. Postponed or
  won't-do rationale belongs in notes; `CLOSED` alone satisfies blockers.
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

### Parallel-track detection

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

The graph algorithm decides, not the LLM.

### Claim protocol via ambient identity

`mu task claim <task>` resolves who is claiming, then atomically:

1. Sets `tasks.owner = <agent_name>`
2. Flips `tasks.status = IN_PROGRESS`
3. Emits a `task.claim` op carrying the resolved `actor`

Identity resolution is a two-rung ladder:

1. **`$MU_AGENT_NAME`** — injected into the pane's environment at
   spawn. Backend-independent, and more reliable than scraping even on
   tmux.
2. **`backend.currentAgentName()`** — the mux backend's fallback. On
   tmux that is `display-message -p '#{pane_title}'`; on herdr the
   agent name is registered with the mux and looked up by pane id.

The fallback earns its place because **adopted** panes
(`mu agent adopt`) predate the env injection and carry only a title.
Because it lives behind `MuxBackend`, the call site has no idea which
multiplexer it is running under.

When the tmux fallback runs, it reads pane title, **not** `#W` (window
name). Window names come from the `tab:` frontmatter and may group
multiple agents in one window.

Two agents can't claim the same task — atomic CAS in SQLite. The
agent doesn't have to know its own name.

### Scoped subtree views

`mu task tree <id>` and task queries show the portion of the graph
reachable from a task. Subtree scoping is a `WHERE` clause, which is
what makes recursive delegation work: a sub-orchestrator inspects its
slice without an LLM inferring the scope.

---

## Mux session topology

mu organizes agents into **one mux session per workstream**. One mu
workstream = one mux session = one `session_id` partition in
`~/.local/state/mu/mu.db`. Multiple workstreams on one machine coexist as
independent mux sessions, fully isolated.

A **mux session** is a tmux session on the tmux backend and a herdr
*workspace* on the herdr backend (herdr's own "session" is
server-level — one socket — and is the wrong granularity). The
three-level shape is identical either way:

| mu term          | tmux         | herdr             |
| ---------------- | ------------ | ----------------- |
| **mux session**  | session      | workspace         |
| **window**       | window       | tab               |
| **pane**         | pane (`%15`) | pane (`w1:p1`)    |

The diagram below uses the tmux spelling.

```
  tmux session: mu-auth-refactor              (one mu workstream)
  ┌───────────────────────────────────────────────────────────┐
  │  Window: Backend             Window: Review               │
  │  ┌──────────┐ ┌──────────┐   ┌────────────────────────┐   │
  │  │ worker-1 │ │ worker-2 │   │ reviewer-1             │   │
  │  │ (pi)     │ │ (pi)     │   │ (pi, role=read-only)   │   │
  │  └──────────┘ └──────────┘   └────────────────────────┘   │
  │                                                           │
  │  Window: mu-orchestrator                                  │
  │  ┌────────────────────────────────────────────────────┐   │
  │  │  pi (you, with mu extension loaded)                │   │
  │  └────────────────────────────────────────────────────┘   │
  └───────────────────────────────────────────────────────────┘

  tmux session: mu-migration-2024q4           (different workstream)
  ┌───────────────────────────────────────────────────────────┐
  │  ...different agents, different graph, no overlap         │
  └───────────────────────────────────────────────────────────┘
```

### Concretely

- **First `mu agent spawn` creates the tmux session** if you're not already
  in one. Default name `mu-<auto>`. Override with `mu workstream init <name>` or
  `MU_SESSION=<name>`.
- **Subsequent operations** in the same shell (or any child shell with
  `MU_SESSION_ID` set) target the same session.
- **`tmux attach -t mu-<workstream>`** → attach to the whole
  workstream's mux session (herdr: `herdr workspace focus <id>`)
- **`mu agent list`** is scoped to one workstream — the current one by
  default; `mu agent list -w <workstream>` for another
- **`session_id`** is the partition key on the `agents` table
- **`mu doctor`** warns about cross-session pollution (orphan panes,
  ghost rows, agents whose mux session no longer exists)

### The `activeMux()` seam

Every call site reaches its multiplexer through
`(await activeMux()).<method>()`. Nothing outside `src/mux/` names a
backend, and `MU_MUX` is therefore load-bearing: an unknown value
fails the invocation rather than quietly running on tmux.

Call sites are classified, and the classification is the seam's real
content. With a second backend in play, "no reachable multiplexer"
stops being a broken-box edge case and becomes routine, so each site
has to have already decided what it means:

| | Behaviour on `NoMultiplexerError` | Examples |
| --- | --- | --- |
| **Load-bearing** | propagate; `handle()` maps it to exit 5 | spawn, send, read, kill, adopt, kick, reconcile, session create/destroy |
| **Best-effort** | `try`/`catch`, degrade | actor identity, pane titles, pane borders, workstream listings, liveness polls, TUI attach |

`resolveWorkerIdentity()` in `src/tasks/claim.ts` is the canonical
best-effort shape. `reconcile()` is pointedly load-bearing: treating
an unreachable mux as "zero panes exist" would prune every registered
agent as a ghost and reap its in-progress tasks.

Three things that look like caller concerns belong to the backend,
because each would otherwise hardcode a tmux string in a place a herdr
user can see: `attachHint()` / `attachCommands()` (the printed recipe
and the TUI's executed argv), `healthCheck()` (version + ambient env
facts as DATA — `mu doctor` owns rendering), and
`paneNotFoundNextSteps()` (borrowed by `PaneNotFoundError` from the
backend that raised it).

`src/tmux.ts` survives as a re-export for genuinely tmux-only
concerns: the `MU_TMUX_SOCKET` test-isolation seam and the shared
`sleep` / `setSleepForTests` poll seam.

### The spawn seam: create-and-run vs create-then-start

Backends disagree on something structural: tmux creates a pane **and**
runs a command in one atomic call, while herdr has no create-and-run
form at all. Its creation verbs always start a plain shell, and `agent
start` requires an already-existing pane at its interactive prompt.

That difference is expressed as a **capability**, not a name check:

| | tmux | herdr |
| --- | --- | --- |
| `NewWindowOptions.command` etc. | carries the command | **refused** if non-empty |
| `startAgentInPane()` | not implemented | implemented |
| liveness / readiness wait | mu polls scrollback | the mux blocks until ready |

`spawnAgent` branches on `mux.startAgentInPane !== undefined`. When it
is absent (tmux) the command rides along on the creation verb and the
path is exactly what it always was. When present, mu creates the pane
bare, then calls `startAgentInPane` — and **skips**
`awaitSpawnLiveness` / `awaitSpawnReadiness`, because such a backend
returns only once it has itself detected the agent and judged it ready
for input, which is strictly stronger than what scrollback polling can
prove. `MU_SPAWN_LIVENESS_MS` / `MU_SPAWN_READINESS_MS` are therefore
tmux-tier knobs.

The creation verbs **refuse** a non-empty command on a backend that
cannot honour it rather than dropping it silently: a dropped command
leaves an empty shell mu believes hosts an agent, which is the worst
available failure mode. Both the refusal and every step-2 failure route
through `rollbackSpawn`, so no path records an agent row for a pane with
nothing running in it.

Both the pane-creation call and the agent start sit **outside** the
per-session spawn lock's slow half, so a parallel fan-out still
parallelises.

### Window vs pane

By default each agent gets its own **window** (a tmux window, a herdr
tab — what most terminals call a "tab"), named after the agent's
`tab:` value; default, the agent name. Agents sharing a `tab:` value
share a window with multiple panes.

Claim/identity depends on the agent's name, not the window name:
every agent pane gets `$MU_AGENT_NAME` in its environment on spawn,
plus a **pane title** as fallback, regardless of how panes are
grouped. The canonical tmux protocol is in the comment block at the
top of `src/mux/tmux.ts`.

### Why one session per workstream

- **Visual co-location.** `tmux a -t mu-auth-refactor` shows the whole
  crew at once.
- **Isolation.** Kill the tmux session = kill the workstream. No
  leaked panes.
- **Detach and reattach freely.** The crew survives a closed laptop.
- **The claim protocol falls out.** Pane title = agent name =
  ownership identity, with no configuration.
- **Multiple workstreams coexist.** `session_id` partitioning keeps
  the auth-refactor crew out of the migration crew.

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
- **`mu state`** is the static state card; `mu state --tui` is the
  explicit TUI selector. The split is stdout-is-TTY plus the opt-out
  env var, not a second command namespace.

The TUI import stays dynamic (`await import("./cli/tui/index.js")`).
No module outside `src/cli/tui/` may statically import ink/react, or
the static CLI bundle pulls the TUI graph into help/version/json
paths.

---

## TUI architecture

The TUI is a 10-card live-updating dashboard on `ink`. It is
**read-only** and lives entirely under `src/cli/tui/` — CLI verbs
remain the canonical mutation API. The TUI yanks `mu` commands; the
operator runs them.

### Cluster shape

`src/cli/tui/` is the only place ink/react are imported.

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
├── use-status-filter.tsx       # task-status toggles (o/i/c) for task-list popups
├── use-notes-drill.ts          # shared notes-drill memo (5 task popups consume it)
├── use-popup-action-queue.ts   # consume mouse PopupAction queue once per render
├── cards/                      # 10 dashboard glance cards (one slot each)
│   ├── _placeholder.tsx        # shared loading/empty body wrapper
│   └── {agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx
└── popups/                     # fullscreen drill-down popups
    ├── {agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx
    ├── dag.tsx                 # keybind-only on `g`: full task DAG forest
    ├── all-tasks.tsx           # keybind-only on `t`: sortable / filterable list of every task
    ├── task-list-popup.tsx     # shared TaskListPopup scaffold (ready/inprogress/recent/blocked config-only)
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
`mergeSnapshotFastSlow`, so cards never flicker through a loading
state. `r` / `F5` triggers both intervals immediately. A tab switch
clears the slow cache and eager-fetches, so cards are fresh within
1s. The pure `snapshotKey` / `snapshotKeyString` guard returns the
SAME `data` reference across no-op ticks so React's diffing
short-circuits.

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
(`string-width`) and closes open SGR state on both the early-return
and end-of-loop paths, so coloured fragments without a trailing
`\x1b[0m` can't bleed into adjacent ink chrome. Drill bodies are
space-padded to exact box width, or ink's `wrap="truncate"` ANSI
miscount eats the right-border glyph.

### Read-only invariant + the `tuicr` escape

Every popup row exposes one canonical `mu` command via `y`. `yank.ts`
probes for a clipboard backend (pbcopy / wl-copy / xclip / xsel /
clip.exe) and falls back to OSC-52 over stderr if none is found.
The command goes to the clipboard; the operator runs it.

The one escape is `t` inside any `git show` drill: `tuicr.ts` writes
`ALT_SCREEN_EXIT` + the mouse-mode disable bytes, exec's
`tuicr -r <sha>` in the project root / workspace cwd as a foreground
subprocess, then restores both on exit. A handoff, not an in-process
mutation.

The read-only pledge is in `docs/ROADMAP.md`'s anti-feature list; a
TUI gesture that wants to mutate state needs a roadmap entry first.

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

`useDrillKeymap` owns the scroll state, takes an optional `resetKey`
(identity change resets scroll; a tick-driven body refresh preserves
it) and an optional `onScrollChange` (the DAG popup's focused-root
tracking), and shares ANSI-aware wrapped body metadata so the
scroll-clamp math and the painter can't desync.

Subprocess-backed drills (Workspaces git-show, Agents scrollback,
Commits show) use `popups/show-loader.ts`, which preserves the prior
body during a refetch — no blank flash on the slow tick.

### Test seam

See `test/README.md`. The seam is `test/_ink-render.ts`'s
`createInkInputStream` + `createInkCaptureStream` + `simulateInput` +
`latestRenderedFrame`: mount a popup or `<App>` into a CaptureStream,
drive keystrokes, assert against the visible frame and spy callbacks.
Source-greps are for narrow structural guards only (App ↔ keys ↔
layout wiring; slot ↔ keymap glue), never behaviour.

---

## CLI / SDK surface

Every user-visible operation is a typed SDK function plus a thin
Commander wrapper. `src/cli.ts` and the verb-namespace files under
`src/cli/` are the canonical verb surface — no generated registry, no
DSL, no separate operation schema. Programmatic callers import the
same SDK functions from `src/index.ts`; agents and scripts compose
CLI verbs with `--json`.

The boundary rule: external surfaces accept operator-facing names
(workstream, task id, agent name); internal helpers resolve those to
surrogate INTEGER ids once and then stay on ids. See
[§ Surrogate-PK + SDK-boundary discipline](#surrogate-pk--sdk-boundary-discipline).

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
   the user runs `mu agent adopt %15 [--name X]` to claim them.

`src/reconcile.ts` is the only implementation. Key properties:

- **Reality wins**: the mux is the source of truth for what panes
  exist. The DB records what we last *observed*. Reconciliation closes
  the gap on every `mu agent list`.
- **Status detection is backend-dependent**, expressed as the optional
  `MuxBackend.paneStatus?()`. A backend that omits it (tmux) means "ask
  the detector": `src/detect.ts` scrapes scrollback (`busy` /
  `needs_input` / `needs_permission` via a known pi marker, with a
  Braille-spinner fallback for other CLIs). A backend that implements it
  (herdr) classifies panes natively across every agent kind it
  recognises, and mu takes its word — `src/detect.ts` is bypassed
  entirely on that backend. herdr's `working` → `busy`, `blocked` →
  `needs_permission`, `idle` / `done` / `unknown` → `needs_input`.
  `unknown` must never become `free`: herdr documents that it does not
  prove completion, and no detector of either kind may mint `free`.
- **No silent adoption**: orphans are reported, never claimed.
- **`mu doctor` calls the same routine** and reports counts.

---

## Modules (actual src/ layout)

Mostly-flat `src/`: root `.ts` modules plus cohesive subclusters
(`src/agents/`, `src/tasks/`, `src/mux/`, and `src/cli/` wrappers with
their own `src/cli/tasks/` and `src/cli/tui/` sub-clusters). Cluster
files import from neighbours and root substrate modules, never from
the hub they're re-exported through. `src/tasks.ts`, `src/vcs.ts`,
`src/mux.ts` and `src/workspace.ts` are pure re-export hubs, kept so
external imports keep working; they hold no logic and are not listed
separately below.

| Module                | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/db.ts`           | Connection (better-sqlite3, WAL), **schema v10** (10 tables + 3 views), `resolveWorkstreamId`. Installs capture on every writable open. Owns `SYNCED_ENTITIES` / `PORTABLE_TABLES` / `MACHINE_LOCAL_TABLES`. Refuses a pre-v10 DB (exit 4). |
| `src/hlc.ts`          | The **HLC** (VOCABULARY § HLC), serialized as sortable TEXT `<wall_ms:15>.<counter:6>.<machine_id>`. `nextHlc` / `receiveHlc` / `compareHlc` / `parseHlc` / `formatHlc`. Clock state lives in `machine_identity`. |
| `src/capture.ts`      | **Op capture**: builds the triggers that record every write to a portable table as an op in the same transaction. |
| `src/apply.ts`        | **The apply path** — capture's counterpart: given one op, local or from a peer, make the tables reflect it. Also owns `reprojectDeferredOps` ([§ ambient sync hook](#the-ambient-sync-hook)). |
| `src/undo.ts` + `src/cli/undo.ts` | **Undo as inverse ops**: inverses for one `group_id`, derived from log provenance, refusing a superseded group (exit 4; `--force` overrides). Bare form lists undoable groups (`-n` widens), a prefix previews, `--yes` applies. |
| `src/project-root.ts` | `detectProjectRoot` — the launch-cwd ladder bare `mu` uses to guess which workstream to focus. Pure filesystem walk; no DB. |
| `src/rebuild.ts` + `src/cli/rebuild.ts` | **Rebuild** — disaster recovery: `rebuildInto` replays the whole log into a NEW DB file via `applyOp`. The verb renders the report: counts, `--json`, an `mv`-swap `Next:` step, a warning that `agents` / `vcs_workspaces` are not reconstructible. |
| `src/legacy-ops.ts` | Permanent compatibility classifier for historical log-only intents whose entity looks projectable. Rebuild copies them without projection; segment flush never emits them. |
| `src/drift.ts`        | **Drift detection**, two tiers: `checkDrift` (`mu doctor --deep`) rebuilds into a temp DB and diffs field-by-field; `checkCheapDriftInvariant` (the default) asserts every live row has ≥1 op naming its key. Plus `driftRemediation`. |
| `src/segments.ts`     | **Segments** — the transport. `flushSegment` appends this machine's unflushed ops to `<MU_SYNC_DIR>/<machine_id>.jsonl`; `ingestSegment` reads a peer segment from its watermark into `applyOp`. Peer discovery is implicit: every non-self `*.jsonl`. |
| `src/sync.ts` + `src/cli/sync.ts` | **The sync seam**: `peerStatuses`, the ambient hook (`ambientIngest` / `ambientFlush` / `ambientSyncPass`), `ingestFromDb`, `repairPeer`. The verb is a peer status report; `--from <path>`, `--repair <peer>` (unique prefix, ambiguity is exit 4). |
| `src/cli/db.ts`       | `mu db backup <file>` — one scp-able file via `VACUUM INTO`. Never overwrites: it is the pre-migration copy `SchemaTooOldError` tells you to take. |
| `src/file-lock.ts`    | Cross-process advisory lock via atomic `fs.mkdir`; `src/agents/spawn-lock.ts` wraps it per tmux session. Flush takes it so two local `mu` processes cannot interleave partial lines. Best-effort: a non-contention failure runs the body unlocked. |
| `src/fleet-hazards.ts`| **Mixed-fleet hazards** — three environment checks in the default doctor: `MU_DB_PATH` inside `MU_SYNC_DIR` (fail), DB on a network mount (warn), two workstream names differing only by case (warn). All no-op when `MU_SYNC_DIR` is unset. |
| `src/disk-recon.ts`   | **Disk↔DB reconciliation** — the only module that reads the STATE DIR and compares it to the DB, in both directions: a `vcs_workspaces` row whose path is gone (`ws-rows`), a dir with no row (`ws-dirs`, reusing `listAllOrphanWorkspaces`), plus residue nothing references (`ws-empty` / `db-copies` / `exports` / `locks`). Emits `FleetHazard` so doctor's renderer, `--json` and the TUI card need no new shape. Default tier is `readdir` + `stat` at depth 2 (~1ms); `measureWorkspaceUsage` recurses for bytes and is `--disk` only, because its cost scales with the checkouts. **Report-only by construction** — every finding carries its cleanup command and the module runs none of them. |
| `src/op-context.ts`   | The **op context** seam: `withOpContext(db, {intent, actor, group}, fn)` labels every op in a scope, restored in a `finally`. Nested scopes inherit the group, which puts a cascade under one `mu undo`. `withCaptureSuppressed` is the echo guard. |
| `src/mux.ts`          | **Mux backend hub** — re-exports `src/mux/*`, same shape as `src/vcs.ts`. The public `MuxBackend` surface every call site imports. |
| `src/mux/*.ts`        | **Multiplexer backends**: `types.ts` (the `MuxBackend` interface + `MuxError` / `PaneNotFoundError`), `detect.ts` (`MU_MUX` → `HERDR_ENV` → `$TMUX` → `PATH` ladder + test seam), `tmux.ts`, `herdr.ts`. The backend owns topology, the send protocol, capture, **pane id** validation (tmux `%15` vs herdr `w1:p1`), the identity fallback, and optionally native pane status (`paneStatus?()`) and agent start (`startAgentInPane?()`) — so no global pane-id regex and no per-call-site branching. The send protocol is where the two diverge most: tmux needs a six-step paste/Enter dance to survive a modal swallowing the Enter, while herdr's `agent prompt --wait` is one atomic call. |
| `src/tmux.ts`         | Re-export of the tmux backend, kept for genuinely tmux-only concerns: the `MU_TMUX_SOCKET` test seam and the shared `sleep` / `setSleepForTests` poll seam. Everything else imports `src/mux.ts` and goes through `activeMux()`. |
| `src/detect.ts`       | Pi status detector (`busy` / `needs_input` / `needs_permission`) + Braille-spinner fallback. Used when the mux cannot classify panes itself — i.e. always on tmux, never on herdr. |
| `src/reconcile.ts`    | Ghost prune + status detect + orphan surface; "reality wins"                              |
| `src/agents.ts`       | Hub: CRUD + send / read / list / close + liveness + reaper. Re-exports `src/agents/*`; pane-title composition (`composeAgentTitle`) lives here. |
| `src/agents/*.ts`     | Agent-lifecycle internals: `spawn.ts` (spawn, CLI resolution, liveness wait *or* backend `startAgentInPane`, pane create-or-reuse, rollback), `spawn-lock.ts` (per-session lock around topology+finalize), `wait.ts`, `adopt.ts`, `kick.ts` (signal a wedged pane's pgid), `errors.ts`. |
| `src/dag.ts`          | Shared DAG read/render helpers: `loadFullDag` plus pure `renderForest` / `renderTaskTree`, reused by `mu task tree` and the TUI DAG popup. |
| `src/tasks/*.ts`      | Task-graph internals: `core.ts` (row shapes, id resolution), `id.ts`, `queries.ts` (reads), `edit.ts` (+ delete cascade preview), `edges.ts` (+ cycle check), `status.ts` (TaskStatus), `sort.ts`, `claim.ts` (atomic CAS), `lifecycle.ts` (close/open), `wait.ts`, `errors.ts`. |
| `src/tracks.ts`       | Parallel-tracks union-find with diamond merge                                             |
| `src/staleness.ts`    | `WORKSPACE_STALE_THRESHOLD = 10` and the pure `isWorkspaceStale` predicate, shared by static state, the TUI Workspaces card, and dispatch-time checks. |
| `src/workstream.ts`   | ensureWorkstream / list / summarize / destroy |
| `src/logs.ts`         | Typed READER over `ops` (`listLogs` / `latestSeq`), plus the write paths triggers cannot cover: `appendLog` (operator prose) and `emitEvent` (changes mutating no portable table — `agent.*`, `workspace.*`), under a typed `LocalIntent`. |
| `src/log-render.ts`   | **The ONE op → prose formatter.** `renderOp` maps an intent (+ key + payload fields) to `{verb, subject, detail}`; plus `renderOpLine`, `opSubject`, `parseOpKey`. Pure and colour-free, so CLI and TUI share one phrasing. |
| `src/vcs/*.ts`        | One backend per file (`git.ts`, `jj.ts`, `sl.ts`, `none.ts`) plus `types.ts` (the `VcsBackend` interface), `helpers.ts`, and `index.ts` (detection precedence `jj` → `sl` → `git` → none; `backendByName`). |
| `src/workspace/*.ts`  | Per-agent VCS workspaces, a registry on top of `vcs.ts`: `core.ts` (row shapes, paths, errors), `crud.ts`, `decorate.ts` (staleness + dirty), `orphans.ts`. |
| `src/output.ts`       | NextStep type + `printNextSteps` + `errorNextSteps` plumbing for self-documenting output |
| `src/shell-quote.ts`  | `shellQuote` — POSIX single-quoting for tokens interpolated into copy-pasteable next-step hints. |
| `src/state.ts`        | SDK seam for `mu state`: `loadWorkstreamSnapshotFast` (pure SQL, TUI 1s tick), `loadWorkstreamSnapshotSlow` (subprocesses), `mergeSnapshotFastSlow`, `loadWorkstreamSnapshot`. Opt-in: `withDirty`, `withDoctor`, `withRecentCommits`, `withAllTasks`. |
| `src/doctor-summary.ts` | The dashboard's doctor seam: `loadDoctorSummary` (pragmas and COUNT-shape selects only — cheap enough for the poll loop), `loadDoctorChecks` for the popup, plus `yankCommandForCheck` / `remediationParagraph`. |
| `src/cli.ts`          | commander entry; `buildProgram()` (re-exports `format`/`handle` symbols for back-compat with existing import sites). |
| `src/cli/*.ts`        | One file per verb-namespace; thin wrappers over the SDK; `--json` on every read verb. Two non-verb cluster-mates: `format.ts` (table renderers, status colourers) and `handle.ts` (typed-error → exit-code map). |
| `src/cli/tui/*.tsx`   | The interactive ink TUI, lazy-imported by `src/cli/state.ts`. **The only place ink/react are imported** — a ROADMAP pledge. Per-file roles: [§ TUI architecture](#tui-architecture). |
| `src/cli/tasks/*.ts`  | Sub-cluster of the `mu task` namespace: `queries.ts` (list/next/owned-by + `mu me tasks` / `mu me next`), `lifecycle.ts` (close/open), `edit.ts`, `edges.ts` (+ delete cascade preview), `claim.ts`, `tree.ts`, `wire.ts` (Commander glue). |
| `src/index.ts`        | SDK entrypoint (re-exports)                                                               |
| `skills/mu/SKILL.md`  | Bundled skill teaching the LLM the model + verb list + jq pipelines                       |

### What the rows above leave out

- **Capture triggers are TEMP triggers**, reinstalled per connection —
  SQLite refuses a main-schema trigger referencing the temp `_op_ctx`.
  Hence two oddities: DELETE keys are captured inline, with the parent
  stashing its natural key in `_op_dying` first (FK CASCADE fires child
  triggers after the parent is gone), and the HLC is minted in SQL,
  because a trigger cannot call into JS.
- **Merge is per entity**: notes and messages are grow-only sets, tasks
  and workstreams merge per field by HLC, edges are an LWW-element-set.
  A tombstone is an ordinary op carrying an HLC, so out-of-order
  arrival is a comparison and resurrection falls out. Never
  `json_patch` — RFC 7396 reads a null member as delete-the-key.
- **Note tombstones are the one SELF-DESCRIBING tombstone.** Every
  other `del` carries `'{}'`, because its key plus the puts before it
  describe the row. A note's key embeds its rowid
  (`<ws>/<task>#<id>`), which is NOT stable — a rebuild or
  reprojection reassigns it, leaving the puts under the old key and a
  later `del` under the new one. Undo folds the puts for a key to
  reconstruct a tombstoned row, so such a note folded to nothing and
  was silently never restored (drift-641). The `task_notes` delete
  trigger therefore records `OLD.*`, and `planUndo` falls back to the
  tombstone's payload when the fold is empty. This is also why
  `src/drift.ts` matches notes on the task-key PREFIX rather than the
  exact key.
- **Undo and restore write through the tables**, so neither can be the
  write path capture misses. `restore` records then applies under the
  SAME HLC: `applyOp` excludes an op's own HLC from provenance, so a
  fresher one makes the row outrank the op and lose every field to an
  insert default.
- **Segments are single-writer per file** — a machine appends only to
  its own, so nothing is contended and any folder-syncer is adequate
  transport. Regenerable, so no fsync. Four layers stop at the first
  bad record and advance the watermark only that far: `JSON.parse`
  (torn write), crc32 per line (bit rot), monotonic HLC (reorder,
  duplicate, truncation), a `.manifest` sidecar (truncation exactly on
  a line boundary). Only `SYNCED_ENTITIES` and only THIS machine's ops
  are flushed, so pane ids and absolute paths never leave and peers
  never echo each other's history.
- **Sync never fails a command**: a truncated segment, a garbage
  segment, a sync dir that is a file, a vanished directory all warn on
  stderr and return.
- **Rebuild is not ingest**: ingest filters to `SYNCED_ENTITIES`, but
  local recovery replays everything, so log-only entities are copied
  verbatim or `mu log` comes back empty. `machine_identity` carries
  across whole — id, hostname, HLC clock — or the rebuilt DB is a
  different peer minting HLCs below every replayed op. Drift diffs by
  natural key and excludes `owner_id`: a rebuild always has NULL
  owners.

Why segments and not Litestream / cr-sqlite / a peer list, and why the
DB must never sit in `MU_SYNC_DIR`:
[ROADMAP § Rejected sync substrates](ROADMAP.md#rejected-sync-substrates).

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
6. **Records ops** — automatically, per [§ The ops log](#the-ops-log-read-this-first);
   machine-local changes go through `emitEvent`. `mu log --tail`
   subscribers see the new ops on the next 1-second poll.
7. **Commits or rolls back** — exception propagates after rollback
   so the caller sees the real error and the typed error class
   maps to a specific exit code in `handle()`.

## Key seams

The extension points. A new impl of each is small.

| Seam                | Add a new impl by...                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VcsBackend`        | Implementing `detect / createWorkspace / freeWorkspace / isClean / commitsBehind / rebaseTo / commitsSinceBase / recentCommits / showCommit` (~80–150 LOC; jj/sl/git/none are working examples)        |
| Per-CLI `Detector`  | Adding patterns to `detectPiStatus` (vanilla pi `to interrupt)`; pi-meta + every TUI wrapper covered by Braille spinner glyph fallback `[\u2800-\u28FF]`)                  |
| New typed verb      | An SDK function in the relevant `src/*.ts`; a `cmd<Verb>` in the matching `src/cli/<namespace>.ts`; one commander block in `buildProgram()`, wrapped in `handle()` and routed through `printNextSteps` |
| New schema migration| Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts` and mirror the shape in `CURRENT_SCHEMA`. Keep startup migration-free; extend the retained fresh-target sidecar only when an old released schema needs a bridge. Recipe: [scripts/README.md](../scripts/README.md) |
| New syncable field  | Add the column to a portable table, extend the capture trigger's changed-column comparison, confirm the apply path writes it. The UPDATE trigger MUST emit only changed columns — a full-row payload silently regresses field merge to row-level LWW |
| Cross-machine sync  | Nothing: every invocation already flushes local ops and ingests each peer segment from its watermark. No daemon, no network code, no membership config |

An importer must synthesize **ops, not rows**: the tables are a
projection of the log, so a direct INSERT is invisible to sync and
reported as drift.

## The ambient sync hook

Sync is **ambient, not a daemon**: no watcher, no background process,
no polling loop outliving a command. It happens because you already
run `mu` constantly.

**The seam is `handle()`** (`src/cli/handle.ts`), the one place every
verb passes through, and the only seam that is already async —
`syncPass` is async (it takes the file lock) while most verb bodies
are synchronous better-sqlite3 code. One `await` before `fn(db)` and
one after covers all ~60 verbs; no verb learns that sync exists.

**Order matters**: ingest BEFORE the body, so the verb reads the
freshest state transport has delivered; flush AFTER, so this
invocation's ops reach the segment now rather than next invocation.
Flush also runs on the ERROR path — a verb may have committed ops
before throwing, and those ops are already canonical, so withholding
them would make this machine's history depend on the exit code.

Four carve-outs:

| Surface | Behaviour | Why |
| ------- | --------- | --- |
| `MU_SYNC_DIR` unset | One `if` on one env var. No promise, no filesystem touch. | The single-machine case must pay nothing. Measured indistinguishable from baseline; ~3ms with one peer. |
| `mu sql` | Opts out (`handle(..., { ambientSync: false })`). | It is the verb whose result an operator diffs against their own expectation; an ambient ingest changing a row count mid-inspection reads as a mu bug. |
| `mu sync` | Opts out and runs the pass itself. | Otherwise the report prints 'ingested 0' right after ingesting. |
| The TUI | On the SLOW tick (10s, `SLOW_TICK_MS`) only, guarded so N tabs run one pass per beat, `quiet: true`. | The fast tick can be wound down to 100ms — 10 passes/second on a shared folder. Quiet because the TUI owns the alternate screen; sync problems surface via the Doctor card. |

### Out-of-order arrival: `reprojectDeferredOps`

An `edge` or `note` put whose task has not been ingested yet skips as
`absent` — correctly. But ingest advances the watermark past it
anyway, so without a second pass it never lands: a permanent silent
divergence, and a coin flip per fleet, since peers are discovered by
`localeCompare` over random-UUID filenames.

`reprojectDeferredOps` re-queries the log for note/edge puts that are
resolvable NOW but unprojected. No retry queue — that would be a
second source of truth, and it would not survive a short-lived mu
process when the parent often arrives days later. It excludes ops
whose parent task is gone and keys carrying a newer `del`,
so a deleted edge is never resurrected and an orphan is not retried
forever. On a healthy DB it is two indexed queries returning zero
rows. Called once per ingest pass, never per peer: an edge in one
segment may name a task in another.

## Surrogate-PK + SDK-boundary discipline

A substrate-wide invariant; every entity table follows it.

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
The TEXT name is an operator-facing attribute — searchable,
displayable, cheap to rename. The surrogate id is the identity.

**TEXT-by-design exceptions:** the
workstream's own `name` (it IS a tmux session name; globally
unique), `task_notes.author` / `ops.actor` (free-text actor
labels — `"orchestrator"`, `"user"`, `"system"`), `ops.entity`
(open enum — future entities need no migration), `agents.cli`
(adding a new CLI must not require a schema change), and every
column of `ops` (the ops log is FK-free by design and addresses
rows by their NATURAL key, so an op outlives the row — and the
workstream — it records).

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

Resolving exactly once at the boundary buys three things: no
double-resolution; no mid-function ambiguity (with surrogate ids in
hand, internal helpers need no workstream context — the FKs make
scope implicit); and one place for error mapping
(`WorkstreamNotFoundError` originates at resolve-time in
`src/db.ts`; `TaskNotFoundError` / `AgentNotFoundError` are raised by
SDK callers wrapping the `tryResolve*` null-return, so the typed
class and its exit-code 3 mapping hold whichever leg missed).

**`--json` output preserves operator-facing names.** Surrogate ids
never leak into `--json`, error payloads, log lines, or markdown
exports. Promoting them to the public shape would re-introduce a
global namespace by the back door (anti-feature pledge).

## State of truth

- **`~/.local/state/mu/mu.db` is canonical.** Everything else is a
  cache, including tmux pane titles (mu re-pushes them via
  `composeAgentTitle` after every state change).
- **Reads are cheap** via SQLite views (`ready`, `blocked`, `goals`).
- **Writes go through the typed SDK functions** (`src/agents.ts`,
  `src/tasks.ts`, …) which validate, transact, and reconcile. Op
  capture is not their job — the triggers handle it.
- **Workstream scoping is mandatory at the CLI boundary.** TEXT names
  (`tasks.local_id`, `agents.name`) are per-workstream unique — the
  same name may legitimately exist in two workstreams. Every public
  SDK function taking such a name also takes (or threads) the
  workstream; internal SQL filters by `(workstream_id, name)`. Test
  fixtures and `mu sql` read paths may omit it and fall back to
  first-match-by-name. The schema enforces it structurally
  (per-workstream UNIQUE on name + INTEGER FKs).
- **The ops log is the insurance and it IS version history** — see
  [§ The ops log](#the-ops-log-read-this-first). `mu undo <group>`
  reverts one action; `mu rebuild <file>` replays the whole log into
  a fresh DB.
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
| `src/logs.ts`                      | Real SQLite; cursor semantics, AUTOINCREMENT durability, ops-outlive-workstream |
| `src/capture.ts` + `src/op-context.ts` | Real SQLite, no tmux: payloads hold ONLY changed columns (asserted by key COUNT), echo suppression, cascade grouping, FK-CASCADE tombstone keys, the null-intent fail-safe |
| `src/apply.ts`                     | Real SQLite, INJECTED HLCs, no sleeps: field-level convergence in both orders, same-field LWW determinism, all four put/del orderings, resurrection, grow-only notes, edge add/remove, the set-to-NULL trap, `owner_id` stripping, replay idempotence |
| `src/rebuild.ts`                   | Round trip asserted row-BY-ROW per portable table (a count-only check passes on a garbage rebuild), plus idempotence, tombstones, byte-identical ops, log-only entities copied, `machine_id` + clock carried. `cli-rebuild.integration` covers the verb |
| `src/drift.ts` + `src/fleet-hazards.ts` | Drift planted the way a capture bug would (`withCaptureSuppressed` + direct mutation), with equal weight on FALSE positives (cascade delete, resurrection, set-to-NULL, no-op update, claimed task). `classifyFsType` against synthetic magic numbers |
| `src/disk-recon.ts` | Per-test `MU_STATE_DIR` temp dir with the on-disk shape built by hand — the disagreements it detects cannot be produced through the normal verbs, since those keep disk and DB in step. Both directions covered (row without dir, dir without row), plus the live-WAL-triple exclusion and `stranded` marking |
| `src/segments.ts`                  | TWO temp DBs and one shared dir — the real deployment shape. Round trip; two machines editing different fields both surviving; idempotence; each robustness layer; machine-local ops never reaching a file; Syncthing conflict copies |
| `src/sync.ts` + `src/cli/sync.ts`  | Fast tier covers decision logic in-process (staleness arithmetic, peer-prefix ambiguity, MU_SYNC_DIR unset, the never-throw contract against four breakages, hook order). `cli-sync.integration` re-checks it THROUGH THE VERB with two DBs and one dir |
| the whole sync path, as a SESSION  | `sync-session.integration` simulates days of laptop↔devserver work: 8 rounds, two machines, no coordination beyond the folder. Asserts byte-identical portable content, no `--deep` drift, and a quiet round adding exactly zero ops |
| `src/hlc.ts`                       | Real SQLite + an INJECTED clock (no sleeps): backwards jumps, stalled milliseconds, sort order, durability, concurrent minting |
| `src/vcs.ts` + `src/workspace.ts`  | `*.integration.test.ts` files use real git in `os.tmpdir()`; jj/sl tests feature-detect (skip if binary missing) |
| `src/cli.ts` / verb integration    | `*.integration.test.ts` files; real tmux server, unique session per test        |
| Fast unit/dev-loop tier            | `npm run test:fast`; excludes `*.integration.test.ts` / `*.smoke.test.ts`, uses mocked tmux/VCS and per-test temp DBs |
| Stress / flake audit               | `npm run test:stress`; repeats the full suite with per-run logs/timeouts, optionally in parallel waves (`MU_TEST_STRESS_MODE=parallel`) |
| End-to-end                         | `test/acceptance.integration.test.ts` — the canonical 10-task / 3-agent demo   |

Two fixture traps: a convergence fixture must share ONE creation op
(two independent `task add`s for the same id make the later creation
legitimately win every field), and an ordering-sensitive test must
RENAME segments to pin ingest order, since peers are discovered by
`localeCompare` over random-UUID filenames.

Flake lessons: treat pass-alone/fail-under-load cases as
concurrency bugs first; use retrying temp-dir cleanup for VCS fixtures
whose subprocesses keep files alive briefly; drive wait/reaper
integration tests from poll-loop seams, not fixed timers; wait for
stable Ink output instead of sleeping.

## Distribution

Single npm package `mu` (see `package.json`):

- `dist/cli.js` — CLI entry, executable (`bin: { mu: ./dist/cli.js }`; shebang preserved by `tsup`)
- `dist/index.js` + `dist/index.d.ts` — programmatic API + types for SDK callers
- `skills/mu/SKILL.md` — bundled skill (the only non-`dist` asset shipped)

`tsup` bundles two entries (`index`, `cli`) from `src/`. No runtime
build step on the user's machine. There is no pi-extension entry — pi
is a peer dep — and no bundled `agents/*.md` or `prompts/*.md`:
per-role agent guidance lives in the user's project repo.

The dependency list lives in `package.json`; the rule for adding
new ones is the anti-feature pledge in
[ROADMAP.md § Anti-feature pledges](ROADMAP.md#anti-feature-pledges).
