# Architecture

mu is one SQLite file, a crew of agents in tmux panes, a task DAG,
and one append-only op log everything else is derived from. It is
layered: callers on top, a shared TypeScript core in the middle,
SQLite + tmux + VCS substrates at the base. The CLI verbs and the
programmatic SDK are thin facades over the same core modules.

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
│  │ agents/  │  │  tasks/  │  │   vcs/   │  │  ops log/    │   │
│  │ tmux     │  │ schema   │  │ jj       │  │  capture     │   │
│  │ detect   │  │ queries  │  │ sapling  │  │  apply/sync  │   │
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
- **archive** — an archive is one marker op pinning a point in the log;
  restore replays up to it.
- **sync** — a machine appends its own ops to a JSONL segment in a
  shared folder and applies each peer's from a watermark.

**Ops are semantic partial updates.** An UPDATE op carries only the
columns that actually changed. That is what makes per-field merge
free: two machines editing different fields of one task both keep
their edit, with no extra bookkeeping. A full-row payload would
silently regress this to row-level last-writer-wins.

**The cost, plainly:** one mechanism means one capture bug breaks
history, undo, archive and sync at once, silently. That is why
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

This is deterministic: the graph algorithm decides, not the LLM.

### Claim protocol via tmux pane title

`mu task claim <task>` reads the current pane's **pane title** (set on
spawn via `select-pane -T <agent-name>`) and atomically:

1. Sets `tasks.owner = <agent_name>`
2. Flips `tasks.status = IN_PROGRESS`
3. Emits a `task.claim` op carrying the resolved `actor`

Reads via `tmux display-message -p '#{pane_title}'`, **not** `#W`
(window name). Window names come from the `tab:` frontmatter and may
group multiple agents in one window.

Two agents can't claim the same task — atomic CAS in SQLite. The
agent doesn't have to know its own name.

### Scoped subtree views

`mu task tree <id>` and task queries show the portion of the graph
reachable from a task. Subtree scoping is a `WHERE` clause, which is
what makes recursive delegation work: a sub-orchestrator inspects its
slice without an LLM inferring the scope.

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
- **`mu agent list`** is scoped to one workstream — the current one by
  default; `mu agent list -w <workstream>` for another
- **`session_id`** is the partition key on the `agents` table
- **`mu doctor`** warns about cross-session pollution (orphan panes,
  ghost rows, agents whose tmux session no longer exists)

### Window vs pane

By default each agent gets its own **tmux window** (what most
terminals call a "tab"), named after the agent's `tab:` value —
default, the agent name. Agents sharing a `tab:` value share a window
with multiple panes.

Claim/identity depends on the **pane title**, not the window name:
every agent pane gets `select-pane -T <name>` on spawn regardless of
how panes are grouped. The canonical tmux protocol is in the comment
block at the top of `src/tmux.ts`.

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

- **Reality wins**: tmux is the source of truth for what panes exist.
  The DB records what we last *observed*. Reconciliation closes the
  gap on every `mu agent list`.
- **Pi-only status detection** (`src/detect.ts`): `busy` /
  `needs_input` / `idle` / `done` via a known pi marker. Other CLIs
  fall back to a Braille-spinner heuristic.
- **No silent adoption**: orphans are reported, never claimed.
- **`mu doctor` calls the same routine** and reports counts.

---

## Modules (actual src/ layout)

Mostly-flat `src/`: root `.ts` modules plus cohesive subclusters
(`src/agents/`, `src/tasks/`, and `src/cli/` wrappers with their own
`src/cli/tasks/` and `src/cli/tui/` sub-clusters). Cluster files
import from neighbours and root substrate modules, never from the hub
they're re-exported through.

| Module                | Responsibility                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `src/db.ts`           | SQLite (better-sqlite3) connection, WAL mode, **schema v9** (10 tables + 3 views), default paths, `resolveWorkstreamId` (the SDK boundary's first leg). Calls `installCapture` on every non-readonly open to build the capture triggers and the `_op_ctx` temp tables. Owns the syncability constants — `SYNCED_ENTITIES`, `PORTABLE_TABLES`, `MACHINE_LOCAL_TABLES`; `test/entities.test.ts` fails if a new table is in neither list. `openDb` refuses a pre-v9 DB with `SchemaTooOldError` (exit 4); there is no migration ladder. |
| `src/hlc.ts`          | The **HLC** (VOCABULARY § HLC): `(wall_ms, counter, machine_id)` serialized as the lexicographically sortable TEXT `<wall_ms:15>.<counter:6>.<machine_id>`, so bytewise `ORDER BY hlc` IS causal order. `nextHlc` mints via one atomic `UPDATE … RETURNING` on `machine_identity` (a parallel fan-out of short-lived mu processes must not interleave a read-modify-write); `receiveHlc` advances the local clock past an ingested peer op under `BEGIN IMMEDIATE`; plus `compareHlc` / `parseHlc` / `formatHlc`. Clock state persists in `machine_identity.last_wall` / `.last_counter` — every invocation is a fresh process. A backwards clock jump costs ordering precision, never correctness. |
| `src/capture.ts`      | **Op capture.** Builds the triggers that record every INSERT/UPDATE/DELETE on a `PORTABLE_TABLES` table as an op in the SAME transaction as the mutation. Four details worth knowing: (1) they are **TEMP triggers**, reinstalled per connection, because SQLite refuses to let a main-schema trigger reference the temp `_op_ctx` ('cannot reference objects in database temp'); (2) UPDATE payloads carry **only changed columns** (`NEW.x IS NOT OLD.x` per column — `IS NOT`, so NULL transitions survive), which is what makes per-field merge free; (3) DELETE keys are captured INLINE and parents stash their natural key in `_op_dying` first, because FK CASCADE fires child triggers AFTER the parent row is gone; (4) the HLC is minted in SQL, mirroring `nextHlc`, since a trigger cannot call into JS. |
| `src/apply.ts`        | **The apply path** — capture's counterpart: given one op, local or from a peer, make the portable tables reflect it. Merge rules: note/message = grow-only set (insert-if-absent, never in conflict); task/workstream = **per-field LWW by HLC**, not row-level; edge = LWW-element-set (add/remove each carry an HLC). Non-synced entities throw `OpEntityNotSyncedError`. Provenance is derived from `ops`, not stored in a side table that could disagree with the log (~10µs per key). Tombstones are ordinary ops: `op='del'` carries an HLC, so out-of-order arrival is a comparison and resurrection falls out. Runs inside `withCaptureSuppressed` (the echo guard); sync, for the same per-connection reason `withOpContext` is. **Never `json_patch`**: RFC 7396 reads a null member as delete-the-key, dropping every set-to-NULL. Also owns `reprojectDeferredOps` (below). |
| `src/archives.ts`     | **Archives as markers.** An archive is one op (`entity='marker'`, `intent='archive.add'`, key `<label>/<workstream>`) pinning a point in the log. `addArchiveMarker` / `listArchives` / `getArchive` / `markerFor`, plus `pinnedHlcs()`, which states the compaction invariant in code: **nothing may discard ops at or below a pinned marker's HLC.** Labels are global, matched against `/^[a-z][a-z0-9_-]{0,63}$/`. No `remove`: markers are append-only ops, so un-pinning would mean rewriting history. |
| `src/archives/restore.ts` | Replays a workstream's ops up to its marker under a NEW name. Re-keys every natural-key shape (`ws`, `ws/t1`, `ws/t1#3`, and BOTH sides of `ws/a->ws/b`) and rewrites the workstream put's `name`, or the replay resurrects the original. **Records then applies, under the SAME hlc**: `applyOp` does not write to `ops`, so applying alone leaves live rows the log cannot explain (`mu doctor --deep` drift), and recording under a *fresher* hlc is worse — `applyOp`'s provenance queries exclude the op's own hlc, so the just-written row outranks the op and every field loses to an insert default. |
| `src/archives/export.ts`  | `mu archive export`. Replays to the marker in a scratch workstream inside a transaction, builds an `ExportSource`, then throws a sentinel to force a ROLLBACK — materialising leaves no rows and no ops. `src/exporting.ts` renders the same bucket layout as `mu workstream export`; not a second renderer. Re-labels each task row to the archived workstream, or `renderTaskMarkdown` (which reads `task.workstreamName` per row) leaks the scratch name into every file. |
| `src/undo.ts`         | **Undo as inverse ops.** `mu undo <group>` emits inverse ops for one `group_id`: granular, and composable — the undo is itself an ordinary op in its own group, so it syncs and is itself undoable (that is all of "redo"). Inverses come from PROVENANCE, not a flag: a put created the row iff no op for that key precedes it, and a field's prior value is the newest earlier op naming it — computed through the same helper `src/apply.ts` uses, since a second implementation of "what was this field before" would drift and drift here means undo restoring wrong values. Mutates the tables inside a `withOpContext` scope and lets the triggers record the result, so undo cannot be the one write path capture misses. Refuses a group SUPERSEDED by later work (exit 4, naming the conflict); `--force` overrides. |
| `src/cli/undo.ts`     | The `mu undo [group]` verb: bare form lists recent undoable groups (`-n` to widen), a group id (any unique prefix) previews the inverse, `--yes` applies. Holds the supersede warning's human phrasing and the `--json` shape. |
| `src/parked.ts`       | Read-only "presumed parked on another machine" heuristic behind `mu workstream list`'s `parked` column and the TUI tab strip's dim marker. **Effectively dormant**: it keys on the workstream's latest op being `workstream.export`, which rarely happens. Keyed on an INTENT rather than a payload prefix so it cannot silently mis-fire. The honest signal is peer **watermarks**; re-grounding it on those is a roadmap item. |
| `src/project-root.ts` | `detectProjectRoot` — the launch-cwd ladder the bare-`mu` TUI uses to guess which workstream to focus. Pure filesystem walk; no DB. |
| `src/rebuild.ts`      | **Rebuild** — disaster recovery: `rebuildInto(source, {targetPath})` replays the whole ops log in HLC order into a NEW DB file. Always a new file, never in place, so a failure can never leave the operator with no database. Projects through `applyOp` rather than reimplementing the merge rules, so rebuild and sync ingest cannot disagree. **Rebuild is not ingest**: ingest filters to `SYNCED_ENTITIES`, but local recovery must replay everything the log knows — log-only entities (`event` / `broadcast`) that `applyOp` rejects are copied verbatim, or `mu log` comes back empty. Carries `machine_identity` across (id, hostname, AND the HLC clock): a fresh `openDb` would seed a new uuid, making the rebuilt DB a different peer, and a reset clock would mint HLCs below every replayed op. Returns a `RebuildReport` and prints nothing, so drift detection can rebuild into a temp DB and diff. |
| `src/cli/rebuild.ts`  | The `mu rebuild <file>` verb: thin wrapper over `rebuildInto` holding all human output — projected/copied breakdown, the preserved `machine_id`, `--json`, and a `Next:` block whose FIRST step is the `mv` swap. Also warns (yellow, with a re-spawn hint) what a rebuild cannot reconstruct: `agents` and `vcs_workspaces` have no capture triggers, and their `pane_id` / absolute paths would be lies anyway. Never silent — otherwise a blank `mu agent list` looks like a bug. |
| `src/drift.ts`        | **Drift detection** — what makes the one-log design safe (see § The ops log). Two tiers, split by measurement: `checkDrift` (`mu doctor --deep`) rebuilds the log into a temp DB via `rebuildInto` and diffs field-by-field, reporting table + key + field + both values — ~0.6ms/op, 2.3s on a 1000-task/3452-op DB, too slow to run reflexively; `checkCheapDriftInvariant` asserts every live row has ≥1 op naming its key — ~3ms on the same DB, so it is the default. The cheap tier is provably BLIND to an uncaptured UPDATE (the key still has ops), so its output points at `--deep` rather than implying proof. Diff identity is the NATURAL key; `owner_id` is excluded because it never syncs (apply strips it, so a rebuild always has NULL owners) and would report drift on every claimed task. `driftRemediation` warns AGAINST rebuilding reflexively: if capture missed a mutation, the live rows hold real work. |
| `src/segments.ts`     | **Segments** — the transport: how ops leave and enter a machine. `flushSegment` appends this machine's not-yet-flushed ops to `<MU_SYNC_DIR>/<machine_id>.jsonl`; `ingestSegment` reads a peer segment from its **watermark** and feeds each op to `applyOp` via the shared `applyIncomingOp` tail (advance clock, apply, record — shared with `src/sync.ts`'s DB reader so the two cannot drift). **Single-writer-per-file** is load-bearing: a machine appends only to its own segment and read-onlys every other, so no file is ever contended and Syncthing / rsync / scp / git / a USB stick are all adequate transport. A segment is derived and regenerable, which licenses plain files and means NO fsync on append (a lost tail costs one re-flush). Four robustness layers, stopping at the first bad record and advancing the watermark only that far: `JSON.parse` (torn write, the dominant failure), crc32 per line (bit rot), monotonic hlc (reorder / duplicate / mid-file truncation), a `.manifest` sidecar (truncation exactly on a line boundary, where every remaining line is individually valid). **Filtering matters**: only `SYNCED_ENTITIES` are flushed, so agent/workspace ops carrying pane ids and absolute paths never leave the machine, and only THIS machine's ops are flushed so peers never echo each other's history. Peer discovery is implicit — every non-self `*.jsonl`, including Syncthing conflict copies. |
| `src/sync.ts`         | **The sync seam** — the operator-facing half: `peerStatuses` (who, watermark, how far behind, last seen, stale), the ambient hook (`ambientIngest` / `ambientFlush` / `ambientSyncPass`), `ingestFromDb` (a different reader — a peer's `ops` table via SQLite instead of a JSONL segment, for an sshfs mount or a copied file), and `repairPeer` (reset a watermark, re-read from zero). Two invariants. (1) **Never fails a command**: every ambient entry point is total — a truncated segment, a garbage segment, a sync dir that is a file, a vanished directory all warn on stderr and return, because `mu task add` must work when a folder mu does not control misbehaves. (2) **Transport stays the operator's**: mu reads and writes files and shells out to nothing; `transportNextSteps` prints a copy-pasteable rsync line for a stale peer. Peers are known by `machine_id` prefix only — `machine_identity.hostname` is machine-local and never ships, and rendering a hostname would need a membership file. |
| `src/cli/sync.ts`     | The `mu sync` verb. Its bare form is a PEER STATUS REPORT — the flush/ingest happens on every invocation anyway. Two flags: `--from <path>` (the alternate reader) and `--repair <peer>` (watermark reset; any unique machine-id prefix, ambiguity is exit 4 never a guess). A one-off directory needs no flag: `MU_SYNC_DIR=/mnt/usb mu state`. Opts OUT of the ambient hook and runs the pass itself so the numbers are honest — with the hook first, the report would print 'ingested 0' right after ingesting. The bare form exists for scripting: `rsync ... && mu sync`. |
| `src/cli/db.ts`       | `mu db backup <file>` — one file you can scp, via a single `VACUUM INTO`. Not an SDK module (no policy to share with a second caller), and it never overwrites: the reason to run it is the pre-migration copy `SchemaTooOldError` tells you to take, which you must not clobber on a retry. |
| `src/file-lock.ts`    | Cross-process advisory lock via atomic `fs.mkdir`; `src/agents/spawn-lock.ts` delegates to it with a session-keyed wrapper. Used by flush so two concurrent local `mu` processes cannot interleave partial lines in one segment. Best-effort: a non-contention failure runs the body UNLOCKED rather than failing the command — the lock narrows a race, it is not the correctness gate (that is single-writer-per-file plus `UNIQUE (machine_id, hlc)` on ingest). |
| `src/fleet-hazards.ts`| **Mixed-fleet hazards** — three cheap environment checks in the default doctor. (a) `MU_DB_PATH` inside `MU_SYNC_DIR` → **fail**: the footgun of the design — a live WAL DB is three files whose mutual consistency is its durability, and a file-syncer will corrupt it. mu ships append-only segments so the DB never travels. (b) DB on a network mount → **warn** (not fail: a single machine on NFS often works), detected via `statfsSync` magic numbers from linux/magic.h; off Linux `f_type` is an unstable driver index, so the probe returns `unknown` and the check says 'not classifiable' rather than claiming health. (c) Two workstream names differing only by case → **warn**: they coexist on ext4 but collide on APFS/NTFS, and a workstream name IS a tmux session name, so a Mac joining the fleet sees one session where Linux sees two. All three no-op when `MU_SYNC_DIR` is unset. |
| `src/op-context.ts`   | The **op context** seam: `withOpContext(db, {intent, actor, group}, fn)` sets `_op_ctx` for the enclosing scope and restores it in a `finally`, so a throw cannot leak a stale intent onto later ops. One assignment per public SDK function, not one per mutation. Nested scopes inherit the outer group by default — that is what makes a cascade close write N ops under ONE `group_id` for `mu undo` — with `group: "new"` to force a fresh group and `intentIfUnset` for shared internals (`setTaskStatus`) that must yield their label to the outer verb. `withCaptureSuppressed(db, fn)` sets `applying=1`, the echo-loop guard the ingest path runs inside. Sync-only: the temp table is per-connection, so two concurrent async scopes would clobber each other. |
| `src/tmux.ts`         | Single tmux executor wrapper, send protocol (bracketed-paste), pane validation            |
| `src/detect.ts`       | Pi-only status detector (`busy` / `needs_input` / `idle` / `done`)                        |
| `src/reconcile.ts`    | Ghost prune + status detect + orphan surface; "reality wins"                              |
| `src/agents.ts`       | Hub: CRUD + send / read / list / close / free + liveness + reaper. Re-exports `src/agents/*` (spawn, adopt, errors); pane-title composition (`composeAgentTitle`) lives here. |
| `src/agents/*.ts`     | Agent-lifecycle internals: `spawn.ts` (spawnAgent + resolveCliCommand / awaitSpawnLiveness / pane create-or-reuse / prestage / rollback), `spawn-lock.ts` (per-tmux-session advisory lock around the topology+finalize critical section, so a parallel fan-out can't race `new-session` into rolled-back losers), `wait.ts` (`waitForAgents`: block until agents go busy → any other state; status read via a caller-supplied hook so the SDK stays tmux-free), `adopt.ts`, `kick.ts` (signal the foreground pgid of an agent pane's TTY — escape hatch for wedged tool subprocesses), `errors.ts`. |
| `src/dag.ts`          | Shared DAG read/render helpers: `loadFullDag(db, workstream)` for whole-workstream root+edge forests and pure `renderForest` / `renderTaskTree` ASCII rendering reused by `mu task tree` and the TUI DAG popup. |
| `src/tasks.ts`        | Task SDK hub: re-exports the concrete task-graph cluster so external imports keep using `./tasks.js`; no implementation logic. |
| `src/tasks/*.ts`      | Cohesive cluster of task-graph internals: `core.ts` (row-shape mapping, surrogate-id resolution, `touchTask`), `id.ts` (task-id validation + title slug helpers), `queries.ts` (get/list/ready/blocked/goals/notes/owned/search reads), `edit.ts` (add task/note, update, delete), `edges.ts` (edge reads, cycle check, block/unblock/reparent), `status.ts` (TaskStatus enum + helpers — single source of truth), `sort.ts` (shared task sort keys/comparators for CLI + TUI), `claim.ts` (claim/release + `resolveActorIdentity`, atomic CAS), `lifecycle.ts` (setTaskStatus / closeTask / openTask / rejectTask / deferTask + cascade), `wait.ts` (waitForTasks: block until tasks reach a target status), `errors.ts` (typed task error classes — `TaskAlreadyOwnedError`, `CycleError`, …). Cluster files import neighbours/root substrate modules directly, never the `src/tasks.ts` hub. |
| `src/tracks.ts`       | Parallel-tracks union-find with diamond merge                                             |
| `src/staleness.ts`    | Shared workspace staleness threshold (`WORKSPACE_STALE_THRESHOLD = 10`) and pure `isWorkspaceStale` predicate consumed by static state, the TUI Workspaces card, and dispatch-time warn/refuse checks. |
| `src/workstream.ts`   | ensureWorkstream / list / summarize / destroy / export (thin wrapper around the bucket renderer) |
| `src/exporting.ts`    | Bucket renderer for `mu workstream export`: per-task markdown + `manifest.json` (`bucketVersion: 2`); idempotent via per-file sha256; deleted-task preservation banner. Buckets are read-only artifacts for humans / git / docs, not a round-trip substrate. |
| `src/logs.ts`         | Typed READER over `ops`, plus the one WRITE path triggers cannot cover. `listLogs` / `latestSeq` read every op (no entity filter) and hide parent-row *touch* ops (payload only `updated_at`) via one shared predicate — the two must use the same predicate or `--tail` skips rows. `appendLog` writes operator-authored prose (`mu log write`). `emitEvent(db, ws, intent, payload)` records changes that mutate no portable table — `agent.*`, `workspace.*`, `agent.stall` (mutates nothing), `workstream.export` (writes files) — under a required typed `LocalIntent`. Claim attribution is `ops.actor`, not prose. Rendering lives in `src/log-render.ts`. |
| `src/log-render.ts`   | **The ONE op → prose formatter.** `renderOp` maps an op's `intent` (+ natural `key` + named payload fields) to `{verb, subject, detail}`; `renderOpLine` flattens it; `opSubject` resolves the `mu task show` / `mu agent show` target; `parseOpKey` splits `demo/t1#3` / `demo/a->demo/b`. Pure and colour-free, so `src/cli/format.ts` (picocolors) and `src/cli/tui/**` (ink) share one phrasing. Exhaustive over a closed intent union: a missing case is a COMPILE error. **Never string-matches a payload to decide what an op is.** Unknown intents (from a newer peer) degrade legibly rather than throwing, so a rendering gap cannot block sync. |
| `src/vcs.ts`          | VCS SDK hub: re-exports the concrete `src/vcs/` cluster so external imports keep using `./vcs.js`; no implementation logic. |
| `src/vcs/*.ts`        | Cohesive cluster of VCS backends: `types.ts` (`VcsBackend` interface, result shapes, typed workspace errors, show-output cap), `helpers.ts` (exec/probe/run/show/commit-summary parsing helpers), `git.ts`, `jj.ts`, `sl.ts`, and `none.ts` (one concrete backend per file), `index.ts` (detection precedence dispatcher: `jj root` → `sl root` → `git rev-parse --show-toplevel` → none; `backendByName`). Backend methods cover `commitsBehind(workspacePath, ref)` for staleness (no auto-fetch; pure observation), `recentCommits(projectRoot, limit)` + `showCommit(projectRoot, sha)` for the TUI Commits card/popup, and `isClean(workspacePath)` for `closeAgent`'s clean-workspace auto-free path. Cluster files import neighbours/root substrate modules directly, never the `src/vcs.ts` hub. |
| `src/workspace.ts`    | Workspace SDK hub: re-exports the concrete `src/workspace/` cluster so external imports keep using `./workspace.js`; no implementation logic. |
| `src/workspace/*.ts`  | Cohesive cluster for per-agent VCS workspaces (registry layer on top of `vcs.ts`): `core.ts` (row shapes, path helpers, typed workspace errors), `crud.ts` (create/get/list/free/refresh/commits/clean checks), `decorate.ts` (staleness + dirty decoration), `orphans.ts` (per-workstream and all-workstream orphan-dir detection), `recreate.ts` (free+create between-wave verb). Cluster files import neighbours/root substrate modules directly, never the `src/workspace.ts` hub. |
| `src/output.ts`       | NextStep type + `printNextSteps` + `errorNextSteps` plumbing for self-documenting output |
| `src/shell-quote.ts`  | Shared POSIX single-quote helper (`shellQuote`) for interpolating tokens into copy-pasteable `/bin/sh` next-step hints. |
| `src/state.ts`        | SDK seam for `mu state`. `loadWorkstreamSnapshotFast` is the pure-SQL tier behind the TUI's 1s tick (tracks, task slices, workspace rows, orphans, recent events; subprocess fields empty); `loadWorkstreamSnapshotSlow` is the subprocess tier (tmux `view`, workspace dirty flags, recent commits/backend, Doctor summary); `mergeSnapshotFastSlow` overlays the last slow result on each fast one; `loadWorkstreamSnapshot` composes both for static callers. Opt-in flags: `withDirty`, `withDoctor`, `withRecentCommits`, `withAllTasks`. Plus pure helpers `agentStatusHistogram` / `summarizeOwnedTasks` / `roiBucket`. |
| `src/doctor-summary.ts` | TUI-friendly slice of `mu doctor`'s checks. `loadDoctorSummary(db, snapshot)` returns `{ checks, problemCount }` using only synchronous pragmas, COUNT-shape SELECTs and snapshot-derived counts — cheap enough for the poll loop behind the Doctor card. `loadDoctorChecks` returns the full array (OK + warn + fail) for the popup. Also the per-check remediation helpers `yankCommandForCheck` and `remediationParagraph`, kept next to `DoctorCheck` so adding a check is one touchpoint. `src/cli/doctor.ts` keeps its own renderer; this is the dashboard's data seam. |
| `src/cli.ts`          | commander entry; `buildProgram()` (re-exports `format`/`handle` symbols for back-compat with existing import sites). |
| `src/cli/*.ts`        | One file per verb-namespace; thin wrappers over the SDK; `--json` on every read verb. `workstream.ts`, `agents.ts`, `tasks.ts`, `workspace.ts`, `archive.ts`, `log.ts`, `undo.ts`, `sync.ts`, `rebuild.ts`, `sql.ts`, `doctor.ts`, `staleness.ts` (shared warn formatter), `state.ts` (static state card + explicit `--tui` dispatch; bare-`mu` TTY routing lives in `src/cli.ts`, which owns the root argv/TTY seam), `tui-launch-focus.ts` (the pure initial-tab focus ladder). Two non-verb cluster-mates: `format.ts` (table renderers, status colourers, `truncate`/`relTime`) and `handle.ts` (typed-error → exit-code map + the `handle()` wrapper). Imports flow cluster → root, never back. |
| `src/cli/tui/*.tsx`   | The interactive ink-based TUI, lazy-imported by `src/cli/state.ts` so non-TUI verbs never pay the ink/react cost. **The only place ink/react are imported** — a ROADMAP pledge. Per-file roles are in [§ TUI architecture](#tui-architecture). |
| `src/cli/tasks/*.ts`  | Sub-cluster of the `mu task` namespace; the hub re-exports only what outside callers import (`wireTaskCommands`, `cmdMyNext`/`cmdMyTasks`, `unescapeNoteText`). One file per concern: `queries.ts` (list/next/owned-by, and the helpers backing `mu me tasks` / `mu me next`), `lifecycle.ts` (close/open/reject/defer + cascade preview), `edit.ts` (add/show/notes/note/update), `edges.ts` (block/unblock/reparent/delete), `claim.ts` (claim/release/wait), `tree.ts`, `wire.ts` (Commander glue). |
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
| New typed verb      | Add an SDK function in the relevant `src/*.ts`; add a `cmd<Verb>` to the matching `src/cli/<namespace>.ts` (or create a new namespace if the verb doesn't fit existing ones); wire one commander block in `src/cli.ts`'s `buildProgram()` (use `handle()` for the exit-code map; route through `printNextSteps` for self-documenting output) |
| New schema migration| Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts`; mirror the new shape in `CURRENT_SCHEMA`. In-place bumps work when the change is additive (CREATE-TABLE-IF-NOT-EXISTS picks it up) or destructive-but-idempotent (a version-gated `DROP TABLE IF EXISTS`). Anything else is a clean break: `openDb` rejects an older DB with `SchemaTooOldError` (exit 4) and a sidecar importer under `scripts/` carries data across by hand, against a copy, READ-ONLY on the source. Such an importer must synthesize **ops, not rows** — the tables are a projection of the log, so a direct INSERT is invisible to sync and reported as drift. Recipe: [scripts/README.md](../scripts/README.md). |
| New syncable field  | Add the column to a portable table, extend the capture trigger's changed-column comparison, confirm the apply path writes it. The UPDATE trigger MUST emit only columns that actually changed — a full-row payload silently regresses field-level merge to row-level LWW. |
| Cross-machine sync  | `machine_identity` gives each state directory a durable uuid and persists the HLC counter across processes. Every invocation **flushes** local ops to `<MU_SYNC_DIR>/<machine_id>.jsonl` and **ingests** each peer segment from its `sync_peers.last_applied_seq` watermark — no daemon, no network code, no membership config. `UNIQUE (machine_id, hlc)` makes ingest idempotent, so the universal repair is re-reading a segment from zero. |

## The ambient sync hook

Sync is **ambient, not a daemon**: no watcher, no background process,
no polling loop outliving a command. It happens because you already
run `mu` constantly.

**The seam is `handle()`** (`src/cli/handle.ts`), the one place every
verb passes through, and the only seam that is already async —
`syncPass` is async (it takes the file lock) while most verb bodies
are synchronous better-sqlite3 code. One `await` before `fn(db)` and
one after covers all ~63 verbs; no verb learns that sync exists.

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
whose parent task is genuinely gone and keys carrying a newer `del`,
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
| `src/capture.ts` + `src/op-context.ts` | Real SQLite in temp dir, no tmux. Op payloads hold ONLY changed columns — asserted by key COUNT, since a whole-row dump passes a contains-check. Plus echo suppression, cascade grouping, FK-CASCADE tombstone keys, and the null-intent fail-safe row |
| `src/apply.ts`                     | Real SQLite in temp dir, INJECTED HLCs (offset from a fixed future base so peer ops beat the real-clock HLCs the fixtures capture), no sleeps. Field-level convergence in BOTH orders with both edits surviving, same-field LWW determinism, all four put/del orderings, resurrection, grow-only note idempotence, edge add/remove, the set-to-NULL trap (with a test pinning `json_patch`'s destructive behaviour so nobody reintroduces it), owner_id stripping, echo suppression by op count, segment-replay idempotence |
| `src/rebuild.ts`                   | `test/rebuild.test.ts` asserts the round trip row-BY-ROW for every portable table — a count-only check passes on a garbage rebuild — plus idempotence, tombstones/resurrection surviving replay, ops byte-identical to the source (proving capture stayed suppressed), log-only entities copied not projected, machine_id + HLC clock carried across. `test/cli-rebuild.integration.test.ts` covers the verb: `--json`, swap command as the first `Next:` step, the NOT-rebuilt warning, exit 4 on an existing target or the source path |
| `src/drift.ts` + `src/fleet-hazards.ts` | `test/drift.test.ts` plants drift the way a real capture bug would (`withCaptureSuppressed` then a direct mutation) and asserts the check names table/key/field. Equal weight on FALSE POSITIVES: clean after cascade delete, resurrection, captured set-to-NULL, no-op update, claimed task. `test/fleet-hazards.test.ts` builds (a) and (c) from real temp dirs / case-colliding inserts; (b) tests `classifyFsType` against SYNTHETIC magic numbers, since a suite cannot mount NFS. `test/cli-doctor-drift.integration.test.ts`: exit 5, `--json` emitted BEFORE the failure, shallow quiet on an uncaptured UPDATE while `--deep` catches it |
| `src/segments.ts`                  | `test/segments.test.ts` uses TWO temp DBs and one shared dir — the real deployment shape. Round trip; the money test (two machines edit different fields of one task, exchange, both edits survive) plus three-way; idempotence (ingest 3×, re-read from zero); each robustness layer; machine-local ops never reaching a file; peer ops never re-flushed; Syncthing conflict-copy ingest; watermark persistence; clock advance; MU_SYNC_DIR-unset no-ops. Convergence fixtures share ONE creation op via a helper: two machines independently running `task add` for the same id makes the later creation legitimately win every field — correct LWW over an unrealistic history, and a real past flake |
| `src/sync.ts` + `src/cli/sync.ts`  | `test/sync.test.ts` (fast) covers decision logic in-process: staleness arithmetic, `behind` as segment-lines-not-yet-applied, peer-prefix resolution including refusing an ambiguous prefix, the MU_SYNC_DIR-unset path asserting no file appears and no op is invented, the never-throw contract against four breakages (truncated segment / garbage segment / sync dir that is a FILE / vanished directory), hook ORDER, and `--from <peer.db>` idempotence + readonly source. `test/cli-sync.integration.test.ts` re-checks it THROUGH THE VERB with two temp DBs and one shared dir: two-machine round trip, divergent-field convergence, a bare `mu task list` ingesting (the no-hands claim), implicit third-peer discovery, `mu sql` NOT ingesting asserted as an unchanged ops COUNT with a control proving another verb does, a corrupt segment not failing an unrelated command, `--repair` from zero without duplicate ops, the rsync `Next:` step |
| the whole sync path, as a SESSION | `test/sync-session.integration.test.ts` simulates days of laptop↔devserver work on one workstream: 8 rounds, two machines, no coordination beyond the shared folder, interleaved adds, cross-machine edges, notes both ways, close-here/reopen-there, delete-vs-concurrent-edit in BOTH hlc orders, claim/release, an archive marker restored on the other machine, an undo propagating. Exists because the single-round tests cannot express "an op arrives before the op it depends on" — the case that found the `reprojectDeferredOps` bug. End-state assertions: byte-identical portable content on both DBs (surrogate ids and `owner_id` excluded — converged machines are SUPPOSED to disagree about ownership), no `mu doctor --deep` drift on either, `mu rebuild` of either reproducing the same state, `--repair` from zero changing nothing, ops not growing superlinearly, and a quiet round adding exactly zero ops (the sharpest echo-loop detector). The ordering case RENAMES segments to pin ingest order — otherwise it passes at random (measured 5-of-8 before the fix) |
| `src/hlc.ts`                       | Real SQLite in temp dir + an INJECTED clock (the `now` parameter — no sleeps): backwards jumps, stalled milliseconds, zero-padding sort order, close/reopen durability, N-connection concurrent minting |
| `src/vcs.ts` + `src/workspace.ts`  | `*.integration.test.ts` files use real git in `os.tmpdir()`; jj/sl tests feature-detect (skip if binary missing) |
| `src/cli.ts` / verb integration    | `*.integration.test.ts` files; real tmux server, unique session per test        |
| Fast unit/dev-loop tier            | `npm run test:fast`; excludes `*.integration.test.ts` / `*.smoke.test.ts`, uses mocked tmux/VCS and per-test temp DBs |
| Stress / flake audit               | `npm run test:stress`; repeats the full suite with per-run logs/timeouts and can run parallel full-suite waves (`MU_TEST_STRESS_MODE=parallel`) to simulate multiple mu agents testing concurrently |
| End-to-end                         | `test/acceptance.integration.test.ts` — the canonical 10-task / 3-agent demo   |

Flake lessons worth keeping: treat pass-alone/fail-under-load cases as
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
