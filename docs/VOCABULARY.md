# Vocabulary

Canonical terms for mu. **Use these exact words in code, docs, error
messages, and the LLM-facing skill.** When two words could mean the
same thing, the one in this doc wins.

This document is the source of truth. If another doc uses a term not
defined here, fix the doc. If you need a new term, add it here first.

---

## TL;DR — canonical terms

| Use this              | For…                                                                     | Don't use                                          |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| **workstream**        | The unit of organization. One workstream = one tmux session = one DB partition | "project", "session" (ambiguous), "context"      |
| **scratch workstream**| The reserved workstream named `scratch` for off-the-cuff agent use — spin up a helper you'll keep talking to without crew/DAG ceremony. Explicit `-w scratch` (no implicit fallback); auto-created on first spawn; `mu workstream init scratch` is rejected (loud). Agents in it are still **agents**, NOT pi-subagents. Task-less is fine; the DAG stays opt-in. A strict expansion of mu's driveable/observable/durable value into low-ceremony territory, **not** a pi-subagents replacement. | "throwaway ws", "temp workstream", "subagent" |
| **tmux session**      | The literal tmux session a workstream lives in                           | "session" alone (ambiguous)                        |
| **window**            | A tmux window (tmux's tabs); identified by `window_name`                 | "tab" (except as the frontmatter field name)       |
| **pane**              | A tmux pane (one shell view inside a window); identified by **stable pane id** like `%15` | "terminal", "shell"                          |
| **pane title**        | The string set on a pane via `select-pane -T`. **Equals the agent's name.** Read by the claim protocol. | "pane name"                          |
| **window name**       | The tmux window's name. **Equals the agent's `tab:` value** (groups one or more agents). | "tab name" (in code; `tab:` only in frontmatter) |
| **agent**             | A named worker running in a pane; identity = pane title; row in `agents` table | "subagent" (reserved for pi-subagents), "worker" (only the specific role) |
| **worker**            | An **agent** in its role-as-task-claimer. Synonym for the registered side of identity — a row in `agents`, owns tasks via the FK. | (when ambiguous, prefer **agent**)                 |
| **actor**             | The party that *caused* a state change. May or may not be a registered worker. Recorded in `ops.actor` for every op. The orchestrator running mu from a top-level shell is an actor but not a worker. | "caller", "author" (only on notes)            |
| **crew**              | *Informal* collective noun for the agents in a workstream                | (no API surface; prose only)                       |
| **task**              | A node in the DAG. Has mandatory `impact` and `effort_days`. Status one of `OPEN`, `IN_PROGRESS`, `CLOSED`, `REJECTED`, `DEFERRED` (see **task status** below). | "issue", "ticket", "item"                          |
| **task status**       | One of 5 states. **OPEN** = ready to be claimed; **IN_PROGRESS** = claimed and active; **CLOSED** = work completed (the only state that satisfies a `--blocked-by` edge); **REJECTED** = terminal 'won't do' (out of scope, duplicate, wontfix); **DEFERRED** = parked, may revisit. REJECTED and DEFERRED both still BLOCK downstream by design — only CLOSED unblocks. | "state"                                            |
| **reject**            | Verb: stamp a task `REJECTED`. Refuses if open dependents would be stranded; pass `--cascade` to apply to the whole sub-tree. | "wontfix", "close as wontfix"                      |
| **defer**             | Verb: stamp a task `DEFERRED`. Same stranded-dependent guard as reject. Reopen with `mu task open`. | "park", "snooze", "backlog"                        |
| **task DAG** / **graph** | The directed acyclic graph of tasks. Cloned from a prior internal task-graph crate. | "task list", "todo", "tree" (it's a DAG, not a tree) |
| **edge**              | A `blocks` relationship between two tasks. The single edge type. `A blocks B` = A must close before B can start. | "dependency" (use only in prose)                   |
| **track**             | An independent subtree of the DAG identified by parallel-track detection | "branch", "lane"                                   |
| **diamond merge**     | When two tracks share a prerequisite, parallel-track detection collapses them into one track to prevent two agents from colliding on the shared dependency. | "join", "converge"                                 |
| **ready**             | An OPEN task with no unresolved blockers. Exposed as the `ready` SQL view. | "unblocked", "available"                           |
| **goals**             | Tasks with no outgoing blocks-edges (graph endpoints). Exposed as the `goals` SQL view. | "leaves", "targets"                               |
| **sort key**          | Argument to `mu task list / next / ready --sort <key>`. One of `roi` (impact / effort_days, default for `next` / `ready`), `recency` (`updated_at` DESC — "what did I touch most recently"), `age` (`created_at` ASC — "what's gone stale"), `id` (`local_id` ASC, default for `task list`). The two time-based keys also render an `updated`/`created` relative-time column in the table view. | "order by", "sort by"                              |
| **subtree** / **scope** | The set of tasks reachable from a root via blocks-edges                | "subgraph" (only for technical descriptions)       |
| **note**              | An append-only piece of context attached to a task                       | "comment" (reserved for VCS), "log" (reserved for the **ops log**) |
| **log entry**         | A rendered **op**, as shown by `mu log`. Not a distinct table — the ops log is the only log. | "message" (overloaded), "event" (overloaded)       |
| **kind**              | The free-form `--kind <tag>` on a **log entry** (default `message` on write). Read-side `mu log --kind <tag>` filters to that tag. Reserved well-known values: `event` (lifecycle events mu emits) and `message` (default). Operators may coin their own kinds to use the log as a typed sub-channel. | "category", "type" (overloaded) |
| **log ledger**        | A doc-only *convention* (not a feature): use a custom `--kind` tag as a durable, append-only dedupe/memory ledger for a watcher loop. Each tick records last-seen external state (`mu log --kind pr-state 'pr=N sha=.. ci=..'`); the next tick reconstructs it with `mu log --kind pr-state -n 1 --json`. State lives in SQLite, so it survives `/loop` or `/watch` death and context compaction — no in-session bookkeeping. | "state file", "dedupe cache" |
| **claim**             | Verb: set `tasks.owner` to an agent. Atomic CAS.                         | "assign" (use only in prose), "lock"               |
| **owner**             | The **worker** name in `tasks.owner`. Set by claim. NULL when the task is unowned OR was claimed via `--self` (anonymous, attributed via `ops.actor` instead). Owners are **machine-local** — they reference `agents`, so ownership never syncs. | "claimer", "assignee"                              |
| **anonymous claim**   | A claim made via `--self` where the **actor** isn't a registered **worker**. `tasks.owner` stays NULL; the actor is recorded in `ops.actor` for the auto-emitted `task.claim` op. The orchestrator-doing-direct-work pattern. | "self-claim" (in code; "anonymous claim" in prose), "unowned claim" |
| **release**           | Verb: clear `tasks.owner`                                                | "unclaim", "unassign"                              |
| **free**              | Verb: mark an agent's `status = 'free'` (idle, available)                | "park", "idle" (verb)                              |
| **status**            | Persisted enum on `agents` (busy/needs_input/free/...)                   | "state" (use only "lifecycle state")               |
| **lifecycle state**   | A position in the agent state machine                                    | "state" alone, "phase"                             |
| **role**              | `full-access` or `read-only` capability flag                             | "permission" (avoid), "tier"                       |
| **persistent**        | Agent that stays alive across tasks                                      | "long-lived" (only in prose)                       |
| **one-shot**          | Agent that exists for a single task and then terminates                  | "ephemeral", "transient"                           |
| **workspace**         | A VCS-isolated checkout (jj workspace / sl worktree / git worktree / cp) | "branch" (it has one but isn't one), "checkout" (only for `none` backend) |
| **workspace orphan**  | A directory under `<state-dir>/workspaces/<workstream>/` with no row in `vcs_workspaces`. Blocks subsequent `--workspace` spawns. Surfaced by `mu workspace orphans -w X` and `mu state -w X`. | "stray dir", "leftover workspace"                  |
| **stale workspace**   | A workspace whose `parent_ref` is N commits behind the project's default branch HEAD (per the workspace's local refs cache). Rendered as a color-coded `behind` column (green ≤2, yellow 3–9, red ≥10) in `mu workspace list` and `mu state`; ≥10 triggers a one-line warn in `mu state`, `mu task claim --for`, and `mu agent send` (or refusal on the two dispatch verbs with `--strict-staleness`). Pure observation — mu never auto-fetches. | "out of date", "drifting"                          |
| **refresh**           | `mu workspace refresh <agent>` — rebase the agent's workspace onto a fresh base (default = backend's tracked main; `--from <ref>` overrides) WITHOUT touching the agent or pane. Refuses on dirty WC; surfaces conflicts as exit 5 with a resolve-in-place hint. The `none` backend errors (no VCS to rebase). | "recycle", "reset" (overloaded)                     |
| **recreate**          | `mu workspace recreate <agent>` — free + create the agent's workspace in one shot. The between-wave "prep this worker for the next dispatch" verb. Reuses the previous backend unless `--backend` overrides; bases on current main unless `--from <ref>` overrides. Refuses on dirty WC the same way `free` does; `--force` discards the dirty edits (lossy). Sibling of **refresh**: refresh PRESERVES the worker's commits (rebases them onto fresh main); recreate THROWS THEM AWAY. | "recycle", "reset" (overloaded), "free+create" (only in commit messages) |
| **backend**           | Implementation of `AgentBackend` or `VcsBackend`                         | "driver", "provider"                               |
| **detector**          | Per-CLI pattern matcher for busy/permission/ready. Today mu has one (`detectPiStatus` in `src/detect.ts`); covers vanilla pi + any TUI wrapper that uses Braille spinner glyphs. Other CLIs spawned via `--cli <other>` may misclassify; trust scrollback over the emoji. | "matcher", "parser"                                |
| **op**                | The atomic unit of change: one row in the `ops` table, written by a trigger inside the same transaction as the mutation it records. Carries `(hlc, machine_id, group_id, actor, intent, entity, key, op, payload)`. A **semantic partial update** — the payload holds only the columns that actually changed, which is what makes per-field merge free. | "event", "delta", "change" (all overloaded)         |
| **ops log**           | The `ops` table: the single append-only record of every change, and the substrate **sync**, **undo**, **archive**, and history are all queries or replays over. Canonical and ACID because it lives in `mu.db` alongside the tables it records. Replaces v1's four separate mechanisms (`agent_logs`, snapshots, `workstream_sync`, `archived_*`). | "event log", "journal", "WAL" (reserved by SQLite)  |
| **intent**            | The semantic label on an **op** (`task.close`, `task.reparent`, `agent.spawn`). Set once per public SDK function via **op context**, not per mutation. Human-grade: `mu log` renders prose from it through one formatter, replacing v1's brittle prose prefix-matching. | "verb" (overloaded by CLI verbs), "action"          |
| **group**             | A set of ops sharing a `group_id` — one user-visible action. A cascade close writes N ops in one group, so `mu undo <group>` reverts them as a unit. | "transaction" (reserved by SQLite), "batch"        |
| **op context**        | The per-connection `_op_ctx` temp table holding `(group_id, actor, intent, applying)` for the current transaction. Triggers read it to stamp ops; `applying=1` suppresses capture while ingesting a peer's ops (echo-loop guard). Set through the scoped `withOpContext(db, {...}, fn)` / `withCaptureSuppressed(db, fn)` helpers in `src/op-context.ts`, never by writing the table directly — the scoping is what guarantees a throw cannot leak a stale intent onto later ops. Two sibling temp tables support it: `_op_clock` (holds "now" for one trigger firing so the HLC advance reads a single consistent value) and `_op_dying` (natural keys of rows mid-DELETE, so FK-cascaded children can still resolve a key after their parent row is gone). | "ambient context", "thread local"                   |
| **apply** | Verb: land one **op** into the portable tables, honouring the **merge rules**. `applyOp` / `applyOps` in `src/apply.ts`. Always runs capture-suppressed (`applying=1`), so applying never mints a new op — that is the echo guard. Idempotent: applying the same op twice changes nothing, which is what makes `mu sync --repair` merely "re-read that peer's **segment** from zero". Distinct from **ingest**, which is the sync-side loop that reads a segment and calls apply per op. | "merge" (that's the rule set), "import", "replay" (replay is undo/archive) |
| **merge rules** | The per-entity conflict policy the **apply** path implements. note/message = **grow-only set**; task/workstream = **per-field LWW**; edge = **LWW-element-set**; machine-local entities are rejected. One rule per entity, chosen so that convergence needs no coordination between machines. | "conflict resolution" (implies prompting a human), "CRDT" (only loosely true) |
| **per-field LWW** | Last-writer-wins applied PER FIELD, not per row: each field of a task independently keeps the value written by the newest **HLC** that touched THAT field. Free, because ops are **semantic partial updates**. Row-level LWW is explicitly rejected — with agent crews on two machines, a crew closing a task while the operator edits its impact is concurrent by construction, and row-level would silently discard one edit. | "row LWW", "column versioning" (implies version vectors we don't need) |
| **grow-only set** | An entity that is only ever inserted, never updated: **notes** and log messages. Two machines therefore cannot disagree about a note's content, so there is nothing to resolve — apply is insert-if-absent. Identity is `(task, author, content)`, since a note's surrogate id is assigned per machine and cannot identify it across machines. | "append-only log" (that's the ops log), "set" |
| **LWW-element-set** | The rule for **edges**: set membership where both the add and the remove carry an **HLC**, so a remove and a later re-add converge in either arrival order. An edge has no fields worth merging — it is present or absent. | "add-wins set", "2P-set" (a 2P-set can't re-add) |
| **tombstone** | An `op='del'` row. There is NO tombstone table: a tombstone is an ordinary op carrying an **HLC**, so out-of-order arrival is just "compare HLCs", the same comparison the update path makes. A late **put** older than a seen tombstone loses; a tombstone older than a seen put loses. | "deletion marker", "grave" |
| **resurrection** | A **put** with an HLC NEWER than a seen **tombstone** for the same key, which legitimately recreates the row. Distinguishable from a stale put (older than the tombstone, and must lose) because **provenance** outlives the row: ops are never deleted when a table row is. | "undelete" (that's `mu undo`), "revive" |
| **provenance** | Which **HLC** last wrote a given field of a given key — what **per-field LWW** compares against. DERIVED from the **ops log** by query, never stored in a side table: `ops` already records which fields each HLC touched, so a side table would be a denormalisation that can disagree with the log with no procedure to decide which side is right. Costs zero extra storage and survives row deletion for free, which is what makes **resurrection** work. | "version vector", "clock table", "field metadata" |
| **portable**          | Of a table or entity: syncable across machines. Portable = `workstreams`, `tasks`, `task_edges`, `task_notes`. **Machine-local** = `agents` (holds `pane_id`), `vcs_workspaces` (absolute paths differ across macOS/Linux), `machine_identity`, `schema_version`, `sync_peers` (local watermarks), and `ops` itself — the ops table is never wholesale-copied; individual op *rows* ship, filtered by synced entity and carried by **segments**. Machine-local ops are still recorded (so `mu log` shows them) but never leave the machine. Declared as code in `src/db.ts`: `PORTABLE_TABLES` / `MACHINE_LOCAL_TABLES` / `SYNCED_ENTITIES`, guarded so the two table lists must partition `EXPECTED_TABLES`. | "shared", "global"                                  |
| **HLC**               | Hybrid logical clock: `(wall_ms, counter, machine_id)` serialized to a sortable TEXT. The ordering key for every op. Monotonic — never regresses — so a laptop waking with a skewed clock cannot resurrect stale edits. Persisted in `machine_identity` because every mu invocation is a fresh process. | "timestamp", "version" (both imply wall clock)      |
| **machine_id**        | Per-state-directory uuid seeded on first `openDb` and stored in `machine_identity`. Identifies one mu DB as a **peer** and names its **segment**; users do not configure it. | "device id", "host id"                              |
| **segment**           | An append-only JSONL file at `<sync-dir>/<machine_id>.jsonl` holding one machine's ops. **Single-writer-per-file**: a machine appends only to its own and read-onlys every other, so no file is ever contended and any file-mover (Syncthing, rsync, scp, git, USB) is adequate transport. Derived and regenerable from the `ops` table, so losing one costs a re-flush. | "replica", "shard", "stream"                        |
| **peer**              | Another machine, discovered implicitly as a `<machine_id>.jsonl` **segment** in the sync dir. There is no membership list to configure or keep consistent — dropping a segment in the folder joins the cluster. | "node", "replica", "remote"                         |
| **watermark**         | Per-peer integer in `sync_peers.last_applied_seq`: how far into that peer's **segment** we have applied. One integer suffices because segments are append-only and ordered. | "offset", "cursor" (cursor is reserved by `mu log`) |
| **flush** / **ingest** | The two halves of sync. Flush appends local ops to my own **segment**; ingest reads each peer segment from its **watermark** and applies. Both run ambiently on every mu invocation when `MU_SYNC_DIR` is set — there is no daemon. | "push"/"pull" (imply mu moves files; it does not)   |
| **marker**            | An op that pins a point in the **ops log** under an operator-chosen label — the whole implementation of an **archive**. Load-bearing invariant: compaction must never discard ops below a pinned marker. | "tag", "checkpoint", "bookmark"                     |
| **export**            | A directory of plain markdown files produced by `mu workstream export` (one `.md` per task + `INDEX.md` + `README.md` + `manifest.json`). Survives `mu workstream destroy` (auto-run pre-destroy to `<state-dir>/exports/<ws>-<ts>/` unless `--no-export`). Idempotent: re-export against the same dir rewrites only changed files; deleted tasks are preserved with a banner. Markdown-only by design — no HTML/PDF, no embedded VCS. Read-only artifacts for humans / git / docs; the lossless movement paths are **sync** and `mu archive restore`. | "dump", "snapshot" (retired term)  |
| **import**            | Avoid as a generic noun. Cross-machine movement is **sync** (ambient, via **segments**); un-archive is `mu archive restore`. | "rehydrate", "restore" (restore has specific meanings) |
| **archive**           | An operator-named label pinning one or more **markers** in the **ops log**. Cross-workstream and additive: one label may accumulate markers from many workstreams. Outlives every source workstream, because destroying a workstream writes tombstone ops rather than erasing history. `mu archive restore` replays that workstream's ops up to the marker's HLC under a new name — strictly more faithful than v1's column-subset copy. | "backup", "vault"                                 |
| **archive label**     | The operator-facing TEXT name of an **archive** — the label carried by its **markers**. Globally unique across the machine (NOT per-workstream — archives outlive workstreams). Shape: `/^[a-z][a-z0-9_-]{0,63}$/` (wider than workstream names because labels often encode workstream + date + purpose, e.g. `auth-2026-q1`). | "archive name" (in code; `label` only)             |
| **qualified ref**     | An entity-arg form `<workstream>/<name>` that targets a specific workstream's task / agent / workspace without `-w`. Bare `<name>` still resolves via the standard chain (`-w` / `$MU_SESSION` / current tmux session). Mixing a qualified ref with a non-matching `-w` is rejected (`UsageError`). When a bare name appears AND no workstream resolves AND ≥2 workstreams contain that name, mu raises `NameAmbiguousError` (exit 4) listing every candidate as a qualified-form one-paste fix. | "fully-qualified id" (in prose), "prefixed name"   |
| **doctor**            | The diagnostic command + report                                          | "health check", "diagnose"                         |
| **CLI**               | The `mu` command-line binary                                             | "tool" (overloaded), "binary" (only when relevant) |
| **extension**         | The pi extension shipped in the same package                             | "plugin"                                           |
| **skill**             | The bundled SKILL.md that teaches the LLM                                | "system prompt", "instruction"                     |
| **DB** / **registry** | `~/.local/state/mu/mu.db` and its tables                                             | "store", "database" (full word OK in prose)        |
| **substrate**         | An external system mu depends on (tmux, jj, sl, git, sqlite)             | "dependency" (means npm dep), "service"            |
| **operation**         | A canonical mu verb (e.g. `mu task add`). Each verb is a thin CLI wrapper over a typed function in `src/*.ts` — the SDK and the CLI share one surface. | "command" (overloaded), "action"             |
| **reconcile**         | Verb: re-derive registry rows from substrate reality (tmux). Always runs in `mu agent list` and `mu doctor`. | "sync", "refresh"                              |
| **adopt**             | Verb (`mu agent adopt`): register an existing tmux pane as a managed **agent**. The inverse of `mu agent list`'s 'orphan' state. Pane must be in the workstream's tmux session. | "import", "absorb"                       |
| **pi-subagents**      | A different package by Nico Bailon for in-pi focused delegation. Mu and pi-subagents are complementary, not competing. | conflating with mu                                 |
| **TUI**               | The interactive ink-based dashboard launched by bare `mu` in a TTY or explicitly by `mu state --tui`. Lives in `src/cli/tui/`. Read-only against SQLite (yanks, never executes). | "GUI", "interactive mode"                         |
| **dashboard**         | The TUI's main screen — the grid of cards above the status bar. | "home screen", "main view"                         |
| **card**              | A glanceable summary tile on the dashboard, identified by its toggle digit (0-9). Wrapped in a TitledBox. | "panel", "section" (overloaded)                    |
| **popup**             | A fullscreen drill-down opened with `Shift+0`-`Shift+9` or a keybind-only shortcut such as `g` for DAG; single-popup invariant. Closed with `Esc`/`q`. | "modal", "dialog", "detail view"                   |
| **TitledBox**         | The `<TitledBox>` component (`src/cli/tui/titled-box.tsx`) that renders a rounded border with the section header inset into the top border line. The visual primitive used by every card / popup / help overlay. | "header box", "box" (alone)                       |
| **tick**              | The TUI's periodic data refresh (default 1s; `+/-/=` adjusts). Owned by a single `setInterval` in `<App>`. | "poll", "refresh" (verb sense), "frame"            |
| **yank**              | Copy the canonical `mu` command for the focused row to the clipboard. Bound to `y` in every popup. | "copy", "export command"                           |
| **footer**            | The persistent bottom line on the dashboard showing the last yank. Cleared with `c`. | "status line" (reserved for status bar), "toast"   |
| **toast**             | Transient in-popup message (e.g. "tick floor 100ms" when `+` hits floor). | "notification", "banner"                           |
| **act-intent**        | The conceptual action a `y` keypress would trigger. **Never executed by the TUI** — the user runs the yanked command in their shell. The R1 read-only contract: model drives the CLI. | "command intent", "action proposal"                |
| **help overlay**      | The `?` / `F1` modal showing the global + per-popup keymap. Same TitledBox family as cards/popups. | "keys", "cheat sheet"                              |
| **glanceable**        | Design property of cards: readable at a glance, no cursor, no row interaction. The contract is "never exhaustive" — long lists clip with `+M more` hint pointing at the popup. | "compact", "summary" (use the noun form for the data, the adjective for the property) |
| **drill-down**        | Design property of popups: full-screen, focused, scrollable, filterable. The exhaustive view a card promises in its `+M more` hint. | "detail view", "expansion"                         |

---

## The topology, with terms labeled

```
  workstream  (one mu instance, one DB partition)
  ──────────
  ┌─────────────────────────────────────────────────────────────────┐
  │  tmux session: mu-auth-refactor                                  │
  │  ───────────                                                     │
  │                                                                  │
  │  ┌──────────────────────────┐  ┌──────────────────────────────┐ │
  │  │  window: Backend         │  │  window: Review              │ │
  │  │  ─────                    │  │  ─────                        │ │
  │  │  ┌──────────┐  ┌────────┐│  │  ┌────────────────────────┐  │ │
  │  │  │ worker-1 │  │worker-2││  │  │  reviewer-1            │  │ │
  │  │  │ pane     │  │ pane   ││  │  │  pane                  │  │ │
  │  │  │ (pi)     │  │ (pi)   ││  │  │  (pi, role=read-only)  │  │ │
  │  │  │ agent    │  │ agent  ││  │  │  agent                 │  │ │
  │  │  └──────────┘  └────────┘│  │  └────────────────────────┘  │ │
  │  └──────────────────────────┘  └──────────────────────────────┘ │
  │                                                                  │
  │  the crew = { worker-1, worker-2, reviewer-1 }   (informal)     │
  └─────────────────────────────────────────────────────────────────┘

  partitioned by session_id in ~/.local/state/mu/mu.db
```

**Identity convention:** the agent's name == the tmux **pane title**
(set by `select-pane -T <name>` on spawn). The window name comes from
the `tab:` frontmatter field and may group multiple agents in one
window.

This is what makes the claim protocol zero-config: an agent runs
`mu task claim foo` and mu reads `tmux display-message -p '#{pane_title}'`
to know who's claiming. **Read pane title (`#{pane_title}`), not
window name (`#W`)** — they are different when several agents share a
window.

---

## Status, lifecycle, and the verbs that touch them

### Agent status enum (persisted in `agents.status`)

| Value             | Icon | Meaning                                             |
| ----------------- | ---- | --------------------------------------------------- |
| `spawning`        | ⏳   | Pane created, agent process booting                 |
| `busy`            | ⚙️    | Actively working (detector saw busy marker)         |
| `needs_input`     | 💤   | Idle prompt visible, waiting for input              |
| `needs_permission`| 🔐   | Permission prompt visible (e.g., "Allow once")      |
| `free`            | ✓    | Marked available by user (`mu agent free`)                |
| `managed`         | 🤝   | Under external orchestration; mu observes only      |
| `unreachable`     | ❓   | Transport down, status uncertain                    |
| `terminated`      | ✕    | Process gone, awaiting reaping                      |

**Source of truth:** the substrate (tmux + detector). The DB is a
cache; `mu agent list` reconciles on every call.

### The four "stop talking to this agent" verbs — keep them straight

| Verb                  | Effect                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| `mu agent free alice`       | Sets `alice.status = 'free'`. Agent stays alive. Means "I'm done with you for now; you're available."  |
| `mu task release feature_a`| Clears the task owner for `feature_a`. The agent who claimed it is unaffected.  |
| `mu agent close alice`      | Terminates alice's pane and removes from registry. Destructive.             |
| `mu agent kick alice`       | Signals (default SIGINT) the foreground process group of alice's pane TTY. For wedged tool subprocesses (`find /`, busy-wait); the wrapping CLI itself is untouched. Refuses when the foreground IS the wrapping CLI. |
| `mu agent ensure alice`     | Idempotent spawn-or-reuse. Missing agent spawns with spawn flags (`--workspace`, `--role`, `--cli`, `--cwd`, `--tab`, workspace backend/from/project-root); existing idle/free agent reuses and exits 0. Existing busy/spawning/needs_permission agent reuses by default with `busy: true`; `--idle-only` turns that case into a typed conflict (exit 4) for watcher concurrency locks. |
| `mu agent wait alice bob --first` | Blocks until an agent finishes (busy → any other state). The task-less counterpart to `mu task wait` for scratch/off-the-cuff helpers that own no task. `--any`/`--first` fire on the first; default all. Exit 0 met, 5 timeout, 6 a watched pane died. |
| `mu agent poll`             | Non-blocking, read-only snapshot of every agent in the workstream (the dual of `mu agent wait`): per-agent `{name,status,idleMs,lastActivitySeq,workspaceBehind,dead}`. For a `/watch` loop or orchestrator tick to diff against the previous tick. Does NOT reconcile, capture scrollback, or fetch from a VCS remote. |
| `mu agent reap-idle`        | One-line graveyard cleanup: sweep the workstream and close finished, idle, SAFE helpers (the scratch `fixer-N` pile-up). Closes agents whose status is `needs_input`/`needs_permission`/`free` and that have been idle `>= --idle-for` (default `MU_IDLE_THRESHOLD_MS`, 300s). Skips any with a dirty workspace (uncommitted changes / commits since fork) so work is never lost unexpectedly — pass `--discard-dirty` to override (lossy). `--dry-run` previews. JSON returns `{items,count}` where `count` is the number CLOSED and each item carries `action: "closed"|"skipped"` + a skip `reason`. |
| *(none)*              | There is no detach verb. Use tmux detach to leave a workstream attached session without killing panes. |

**Don't conflate `free` and `release`.** Free is about the *agent*;
release is about the *task*.

### Verbs that move tasks through the lifecycle

| Verb                                  | Effect                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `mu task add <id> ...`                | Creates a new OPEN task. `--note <text>` appends an initial note in the same transaction; `--note-author <name>` overrides the note author. |
| `mu task close/open/reject/defer <id>` | Lifecycle transition                                 |
| `mu task claim <task> [--for <agent>]`     | Atomic: sets `owner`, flips status to `IN_PROGRESS`   |
| `mu task release <task>`              | Clears `owner`. Auto-flips `IN_PROGRESS` → `OPEN` (so the task re-enters the ready set); other statuses preserved. `--reopen` forces `OPEN` from `CLOSED`/`REJECTED`/`DEFERRED` |
| `mu task note <task> "..."`           | Appends to `task_notes`. Never edits prior notes.     |
| `mu task notes <task> [--tail N \| --since <iso> \| --since-claim]` | List notes (oldest first). `--tail N` (alias `--last N`) prints last N; `--since <iso>` filters by `created_at`; `--since-claim` auto-resolves to the most recent `task claim` event timestamp. `--since` and `--since-claim` are mutually exclusive. |

---

## Mode of address — who is "you" in each surface?

When the docs/code say "you", it must be unambiguous which actor.

| Surface              | "you" means                                          |
| -------------------- | ---------------------------------------------------- |
| README.md            | The human user installing/running mu                 |
| VISION.md            | The human user                                       |
| ARCHITECTURE.md      | A developer working on mu's source                   |
| AGENTS.md (root)     | An AI coding agent working on this repo              |
| ROADMAP.md           | A developer implementing one of the listed items     |
| **SKILL.md**         | **The LLM running inside an agent's pane**           |
| Agent prompt bodies  | The LLM running as that specific agent               |
| `mu doctor` output   | The human user running the diagnostic                |
| Error messages       | The caller (CLI user, script, or pi tool invocation) |

Avoid second-person across these surfaces unless the audience is
unambiguous.

---

## Reserved / avoided terms

These words show up in adjacent ecosystems and would confuse mu users.
Don't use them in mu code or docs:

| Avoided word     | Why                                                              | Use instead                                          |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| "subagent"       | Pi-subagents owns this term in our ecosystem                     | "agent" (mu's unit) or quote `pi-subagents` explicitly |
| "session"        | Pi has its own "session"; tmux has "session"; ambiguous alone    | "workstream" (mu's unit) or "tmux session" (literal) |
| "project"        | Means a `.pi/` project root; conflict with mu's organizational unit | "workstream"                                       |
| "context"        | Overloaded (LLM context, project context, fork context)          | Be specific: "task context", "forked context", etc.  |
| "tab"            | Tmux has windows, not tabs. Pi-subagents and dg use "tab" as a frontmatter field; we keep that field for compatibility but use "window" everywhere else | "window" (in prose); only `tab:` in frontmatter      |
| "thread"         | OS threads + chat threads + git threads; bad word                | Be specific                                          |
| "message"        | Overloaded (LLM message, log message, send-keys input)           | "log entry" (for the **ops log**), "send" (for input to a pane) |
| "config"         | Already means the global mu config; don't reuse                  | Specific: "settings", "frontmatter", "options"       |
| "manager"        | Vague; everything could be a manager                             | The specific noun (e.g., "the registry", "the eval engine") |
| "service"        | Implies long-running daemon; mu has none                         | Be specific                                          |
| "plugin"         | Pi has extensions, not plugins                                   | "extension"                                          |
| "instance"       | Vague; could be agent / workstream / process                     | The specific thing                                   |
| "broker"         | Implies pub-sub middleware; we don't have one                    | "log entry" or be specific                           |
| "checkpoint"     | Implies recoverable savepoints in the work                       | "marker" (pins the ops log), "group" (undo unit)  |
| "snapshot"       | Retired in 2.0 along with the `snapshots` table and whole-DB file swaps | "marker", "backup" (for `mu db backup`)     |
| "agent type"     | "Type" implies a class hierarchy; mu has no class system | "agent role" (scout/reviewer/etc.)                   |
| "agent definition" / "agent template" / "agent role doc" | mu has no template/definition concept. Spawn flags + the orchestrator's prompt are the only "definition" | Just describe the spawn invocation directly |
| "worker"         | "worker" is the name of one specific built-in agent              | "agent" (general); "the worker" only when referring to that specific agent |
| "claimer"        | Awkward; we have "owner" already                                 | "owner"                                              |

---

## Operations reference

The complete verb list lives in two places, both authoritative:

- **`mu --help`** and **`mu <verb> --help`** — the canonical CLI
  reference. If anything below ever disagrees with `--help`, trust
  `--help`.
- **[skills/mu/SKILL.md](../skills/mu/SKILL.md) § "CLI — complete
  verb list"** — the LLM-facing one-pager with every verb, its
  arguments, and a one-line description.

For worked examples of each verb, see
[USAGE_GUIDE.md](USAGE_GUIDE.md).

This document is a *vocabulary* doc; it doesn't try to be a verb
reference too. Rows here exist to keep names canonical, not to replace
`--help`.

| Operation | Canonical meaning |
| --------- | ----------------- |
| `mu sync` | Report **peer** status (**watermark** + staleness). **Flush** and **ingest** happen on this and every other mu invocation when `MU_SYNC_DIR` is set, so the bare form is a status card whose sync is incidental — it exists mainly so `rsync ... && mu sync` reads correctly. |
| `mu sync --from <path>` | Ingest from a peer's `mu.db` directly (a different reader: SQLite `ops` table rather than a JSONL **segment**). For an sshfs mount or a copied file. |
| `mu sync --repair <peer>` | Reset a **watermark** to re-read that peer's **segment** from zero. The universal repair, safe because ingest is idempotent via `UNIQUE (machine_id, hlc)`. |
| `mu undo <group>` | Emit inverse ops for one **group**. Granular (touches only that action's rows), composable, and itself an op — so it syncs and is itself undoable. |
| `mu rebuild <file>` | Materialize a fresh DB by replaying the **ops log** in HLC order. The disaster-recovery path; prints the swap command rather than overwriting in place. |
| `mu archive restore <label> --as <new-ws> [--source <orig-ws>]` | Replay a workstream's ops up to the label's **marker** into a fresh workstream. |
| `mu db backup <file>` | `VACUUM INTO` copy of the whole DB. The "one file I can scp" convenience; real DR is **segments** + `mu rebuild`. |

Removed in 2.0: `mu db export` / `mu db import` / `mu db replay`
(replaced by ambient **sync**), `mu snapshot list` / `show` / `prune`
(replaced by the **ops log**), `mu archive create` / `remove` /
`delete` (labels are created by first use; **markers** are
append-only), and `mu peers` (folded into bare `mu sync`).
A one-off directory needs no flag — `MU_SYNC_DIR=/mnt/usb mu state`
ingests from a USB stick using the existing env-var idiom.

---

## Naming conventions

### Flag vs positional

> **The primary entity a verb acts on is POSITIONAL. Everything
> else — scoping, modifiers, payload — is a flag.**

`mu task close <id>`, `mu agent send <name> <text>`,
`mu archive show <label>`, `mu workstream init <name>`. The
workstream is a *scope* for most verbs, hence `-w`; but under the
`mu workstream` namespace the workstream IS the primary entity, so
`destroy` and `export` accept it positionally as an alias for `-w`
(`init` always did). Passing both and having them disagree is a
usage error (exit 2), never a silent pick-one.

When a payload is supplied positionally by one verb and as a flag by
a sibling (`mu task add --note` vs `mu task note <id> <text>`), the
other shape is accepted as an ADDITIVE alias (`mu task note <id>
--text "..."`) so muscle memory from one verb carries to the next.
Removing an existing shape is a breaking change; adding an alias is
not.

### Empty vs blank flag fragments

> **In a list flag, an EMPTY fragment is dropped; a BLANK
> (whitespace-only) fragment is a usage error (exit 2).**

The two are not the same thing, and conflating them caused
`bug_whitespace_status_fragment`:

| Input | Kind | Treatment | Why |
| --- | --- | --- | --- |
| `--status "OPEN,"` | **empty** (`""` before trimming) | dropped → `[OPEN]` | A trailing/double comma is a structural artifact of typing a list. |
| `--blocked-by ""` | **empty** | dropped → `[]` | `mu task reparent --blocked-by ''` documents this as the clear-all-blockers sentinel. |
| `--status " "` | **blank** (non-empty before trimming, empty after) | `UsageError`, exit 2 | Nobody means "filter by the space character". It is a typo or a quoting accident. |
| `--status "OPEN, "` | **blank** | `UsageError`, exit 2 | Previously widened to *no filter at all* and exited 0 — a silent wrong answer. |

The rule is enforced once, in `parseCsvFlag` (`src/cli.ts`), so every
list flag agrees — `--status`, `--by`, `--blocked-by`, `-w`. Each
call site passes its own flag name so the error names the flag the
operator actually typed. Deciding per-call-site is what let
flag-vs-positional drift in the first place.

A blank single-value `-w ' '` is rejected in `resolveWorkstream` for
the same reason: it never reaches `parseCsvFlag`, and before the fix
it resolved to a workstream literally named `" "`.

Whether zero surviving fragments is legal is then a per-verb
question, decided *after* this rule: `--by ''` needs at least one
blocker (exit 2), while `reparent --blocked-by ''` means "clear
them all".

Corollary for multi-value flags: the same CONCEPT gets the same
parsing in every verb that names it. `--blocked-by` and `--by` are
both blocker lists, so both accept repeat / comma / mixed form via
the one canonical `parseCsvFlag` helper.

### IDs

- **Agent name**: lowercase, `[a-z][a-z0-9_-]*`, ≤32 chars. Used as
  tmux window name verbatim. Unique within a workstream.
- **Task local_id**: same shape and rules. Unique within the DB.
- **Workstream name**: same shape; tmux session is `mu-<name>`.
  The name `scratch` is **reserved**: it can only be auto-created on
  first spawn (`mu agent spawn <name> -w scratch`); `mu workstream
  init scratch` is rejected loud. The `mu-` prefix is likewise
  reserved (no double-prefix).
- **Tab name (frontmatter `tab:`)**: human-friendly,
  `[A-Za-z][A-Za-z0-9 _-]*`, ≤32 chars. Used as tmux window name when
  multiple agents share the window.

### Agent names: prefer `<role>-<n>`, not human names

Agents are workers with **roles**, not people. Pick names that
describe the role, with a numeric suffix when there are multiples:

  Good:  `worker-1`, `worker-2`, `reviewer-1`, `scout-1`, `auditor-1`,
         `oracle-1`, `planner-1`

  Avoid: `alice`, `bob`, `carol`, `revv`, `mallory`, `peon`, ...

Why: anthropomorphic (or status-loaded) names confuse the model
when reading commands ("alice claims design" sounds like a person;
"worker-1 claims design" is obviously a generic worker taking a
task). Role-based names also make `mu agent list` and tmux's window
list legible at a glance — you can see "three workers and a
reviewer" instead of decoding name salad.

The roles align with pi-subagents' role taxonomy:

  `worker`     long-lived implementer; the default
  `reviewer`   reads diffs/code; usually `--role read-only`
  `scout`      fast recon; one-shot, returns context
  `oracle`     second opinion before action
  `auditor`    long-lived watcher; `--role read-only`
  `planner`    designs implementation plans

If you have multiple agents in the same role, suffix with `-1`,
`-2`, ... (`worker-1`, `worker-2`).

This is a convention, not enforcement. mu's regex accepts any
`[a-z][a-z0-9_-]{0,31}` string. Test fixtures often use `alice`/`bob`
as placeholder names — that's fine for tests; just don't propagate
it to user-facing examples or actual workstreams.

### File paths

XDG-Base-Directory-Spec compliant. The state directory resolves as:

  `MU_STATE_DIR` > `$XDG_STATE_HOME/mu` > `~/.local/state/mu`

- `<state-dir>/mu.db` — the canonical SQLite database (shared across
  all workstreams; partitioned by `workstream` columns)
- `<state-dir>/workstreams/<workstream>/` — per-workstream artifact
  directory (created lazily); reserved for tracing logs / forensic
  pane captures.
- `<state-dir>/workspaces/<workstream>/<agent>/` — per-agent VCS
  workspace (created by `mu agent spawn --workspace` or
  `mu workspace create`). Orphan dirs (no row in `vcs_workspaces`)
  surfaced by `mu workspace orphans -w <workstream>` and
  `mu state -w <workstream>`.
- `<sync-dir>/<machine_id>.jsonl` — one **segment** per machine,
  where `<sync-dir>` is `MU_SYNC_DIR` (unset = sync off, zero cost).
  **Single-writer-per-file**: this machine appends only to its own
  and read-onlys every other, so no file is ever contended and any
  file-mover works as transport. Derived from the `ops` table and
  therefore regenerable — no fsync needed, and a torn transfer costs
  one skipped line rather than the file.
- `<sync-dir>/<machine_id>.manifest` — `{count, last_hlc, sha256}`
  for whole-segment verification.
- **Never** place `MU_DB_PATH` inside `MU_SYNC_DIR`. Syncing a live
  SQLite file (and its `-wal`/`-shm` sidecars) corrupts it. `mu doctor`
  checks for this.
- mu does NOT consult any agent-template directory. If pi-subagents
  is installed, its `~/.pi/agent/agents/` and `.pi/agents/` paths
  are pi-subagents' concern — not mu's.

### Env vars (mu state location)

| Name              | Effect                                                       | Precedence |
| ----------------- | ------------------------------------------------------------ | ---------- |
| `MU_DB_PATH`      | Override the SQLite file path directly                       | wins over all |
| `MU_STATE_DIR`    | Override the state directory                                 | beats `XDG_STATE_HOME` |
| `XDG_STATE_HOME`  | Standard XDG base-directory state path; `mu/` appended      | default fallback chain |
| `MU_SESSION`      | Override active workstream name (when not auto-detectable)   | n/a |

### Env vars passed to spawned children

| Name                         | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| `MU_SESSION_ID`              | Workstream identifier                                |
| `MU_AGENT_NAME`              | This agent's name                                    |
| `MU_PARENT_PANE`             | Tmux pane ID of the spawning process                 |
| `MU_DB_PATH` / `MU_STATE_DIR` | Inherited from parent unless overridden            |
| `XDG_STATE_HOME`             | Inherited; mu uses `<XDG_STATE_HOME>/mu` by default  |
| `MU_SEND_DELAY_MS`           | Delay between bracketed paste and Enter (default `500`) |
| `MU_SEND_READINESS_MS`       | Budget for `mu agent send` to wait out a pane's modal / re-init before pasting, and to re-confirm the Enter landed (default `15000`; `0` restores fire-and-forget). A busy-but-working pane is not waited on. |
| `MU_TMUX_SOCKET`             | Override tmux socket (`-L <name>`); default uses `$TMUX` |
| `MU_<UPPER_CLI>_COMMAND`     | Override the executable launched for `--cli <cli>` (e.g. `MU_PI_COMMAND=pi-alt` makes `--cli pi` exec `pi-alt`; hyphens in the cli key become underscores in the env var name, so `--cli pi-meta` reads `MU_PI_META_COMMAND`). Accepts multi-word strings (`MU_PI_COMMAND="pi-alt --some-flag"`); tmux exec's via a shell. Reconcile also treats the resolved binary as agent-worthy when surfacing orphan panes. When this env var supplies the override (and `--command` did not), the spawn-success line surfaces the env-var name (`Spawned worker-1 (pi-meta via $MU_PI_META_COMMAND)`) so stale aliases are visible without `mu agent show`. |
| `MU_SPAWN_LIVENESS_MS`       | After spawn, wait this many ms then verify the pane is still alive AND scan the tail of its scrollback for known startup-error patterns (provider auth failures — `No API key found for X`, `401 Unauthorized`, … — plus shell-level `command not found` / `No such file or directory` when the spawned binary vanished post-pre-flight). Default 1500. Set to 0 to disable (useful in CI). On detected death the DB row is rolled back and `AgentDiedOnSpawnError` is thrown with the captured scrollback; on a startup-error match (pane alive but parked at an error prompt) the row is rolled back and `AgentSpawnStartupError` is thrown with the matched line + remediation hints. The complementary pre-flight check (PATH lookup of `--cli`'s resolved binary BEFORE any side effect) is not env-tunable; on miss it throws `AgentSpawnCliNotFoundError` with no orphan workspace / pane / row. |

These mirror pi-subagents' `PI_SUBAGENT_*` env vars in spirit but live
in a separate namespace so the two can coexist in one pi session.

---

## Type of "session"

Because "session" is overloaded, here are the four senses we encounter
and the disambiguated terms:

| Generic word | mu term used in docs/code             | What it actually is                              |
| ------------ | ------------------------------------- | ------------------------------------------------ |
| session      | **workstream**                        | mu's unit of organization                        |
| session      | **tmux session**                      | The tmux process group `mu-<workstream>`         |
| session      | **pi session**                        | The thing pi calls a session (its conversation)  |
| session      | **agent session** (avoid in code)     | Colloquial for "an agent's run/lifetime"; prefer "lifetime" or "the work alice has done" |

When writing code, say `workstream_id` not `session_id` in any new
column or variable name. The existing `agents.session_id` column name
is grandfathered for SQL-schema-stability reasons but should be
documented as "workstream id" in column comments.

<!-- The alphabetical glossary that used to live here was removed:
     it duplicated the canonical-terms table at the top of this file,
     drifted out of sync, and carried entries for rejected features
     (capability, agent-frontmatter `persistent: false`, the JS DSL,
     the operation-registry idea). The table is the single source.
     For deeper background, follow the links the table rows carry. -->
