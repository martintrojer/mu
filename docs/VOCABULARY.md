# Vocabulary

Canonical terms for mu. **Use these exact words in code, docs, error
messages, and the LLM-facing skill.** When two words could mean the
same thing, the one in this doc wins. If another doc uses a term not
defined here, fix the doc. If you need a new term, add it here first.

---

## TL;DR — canonical terms

| Use this              | For…                                                                     | Don't use                                          |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| **workstream**        | The unit of organization. One workstream = one **mux session** = one DB partition | "project", "session" (ambiguous), "context"      |
| **multiplexer** / **mux** | The terminal substrate that owns panes. Two supported: **tmux** and **herdr**. "mux" is the short form used in code (`src/mux/`, `MU_MUX`); "multiplexer" is the prose form. Exactly one is active per mu invocation, chosen by **mux detection** — mu never drives two at once. | "terminal", "emulator", "backend" (alone — say **mux backend**) |
| **mux backend**       | An implementation of the `MuxBackend` interface (`src/mux/tmux.ts`, `src/mux/herdr.ts`). Owns everything backend-specific: session/window/pane topology, the send protocol, scrollback capture, **pane id** validation, and **actor** identity fallback. Sibling of **VCS backend**; same `src/vcs/` shape. | "driver", "provider", "adapter"                  |
| **mux session**       | The mux-level container holding one workstream's panes. On tmux it is a **tmux session** named `mu-<workstream>`; on herdr it is a herdr *workspace* labelled `mu-<workstream>`. Use the generic term in cross-backend prose and the specific term when the backend matters. | "mux workspace" (collides with mu's VCS **workspace**), "session" alone |
| **mux detection**     | The ladder that picks the active **mux backend**: `MU_MUX` override → `HERDR_ENV=1` → `$TMUX` → whichever binary is on `PATH` (tmux wins a tie as the incumbent) → `NoMultiplexerError`. `HERDR_ENV` outranks `$TMUX` because it is the narrower signal: only a herdr-managed pane sets it, and herdr may itself be running inside tmux. | "auto-detect" (vague), "probe"                   |
| **scratch workstream**| The reserved workstream named `scratch` for off-the-cuff agent use — spin up a helper you'll keep talking to without crew/DAG ceremony. Explicit `-w scratch` (no implicit fallback); auto-created on first spawn; `mu workstream init scratch` is rejected (loud). Agents in it are still **agents**, NOT pi-subagents. Task-less is fine; the DAG stays opt-in. | "throwaway ws", "temp workstream", "subagent" |
| **tmux session**      | The literal tmux session a workstream lives in — the tmux flavour of a **mux session** | "session" alone (ambiguous)                        |
| **window**            | The mid-level grouping inside a **mux session** (tmux window / herdr tab); identified by `window_name` | "tab" (except as the frontmatter field name)       |
| **pane**              | One shell view inside a **window**; identified by **pane id**            | "terminal", "shell"                          |
| **pane id**           | The mux's stable handle for a **pane**. Shape is backend-specific — tmux `%15`, herdr `w1:p1` — so validation lives on the **mux backend**, never as a global regex. Stable for the pane's lifetime; never reused after close. Distinct from a tmux pane *index* (`0`, `1`, …), which is volatile and must never be stored. | "pane number", "pane index"                       |
| **pane title**        | The string identifying which **agent** occupies a pane. **Equals the agent's name.** Set via `select-pane -T` on tmux, and via `herdr pane rename` (the pane *label*) on herdr. A fallback for **actor** identity — `$MU_AGENT_NAME` is consulted first. | "pane name"                          |
| **window name**       | The **window**'s name. **Equals the agent's `tab:` value** (groups one or more agents). | "tab name" (in code; `tab:` only in frontmatter) |
| **agent**             | A named worker running in a pane; identity = `$MU_AGENT_NAME`, falling back to **pane title**; row in `agents` table | "subagent" (reserved for pi-subagents), "worker" (only the specific role) |
| **worker**            | An **agent** in its role-as-task-claimer. Synonym for the registered side of identity — a row in `agents`, owns tasks via the FK. | (when ambiguous, prefer **agent**)                 |
| **actor**             | The party that *caused* a state change. May or may not be a registered worker. Recorded in `ops.actor` for every op. The orchestrator running mu from a top-level shell is an actor but not a worker. | "caller", "author" (only on notes)            |
| **crew**              | *Informal* collective noun for the agents in a workstream                | (no API surface; prose only)                       |
| **task**              | A node in the DAG. Has mandatory `impact` and `effort_days`. Status one of `OPEN`, `IN_PROGRESS`, `CLOSED` (see **task status** below). | "issue", "ticket", "item"                          |
| **task status**       | One of 3 states. **OPEN** = ready to be claimed; **IN_PROGRESS** = claimed and active; **CLOSED** = finished and the only state that satisfies a `--blocked-by` edge. Record postponed or won't-do rationale in a **note**, then close the task. | "state"                                            |
| **task DAG** / **graph** | The directed acyclic graph of tasks. | "task list", "todo", "tree" (it's a DAG, not a tree) |
| **edge**              | A `blocks` relationship between two tasks. The single edge type. `A blocks B` = A must close before B can start. | "dependency" (use only in prose)                   |
| **track**             | An independent subtree of the DAG identified by parallel-track detection | "branch", "lane"                                   |
| **diamond merge**     | When two tracks share a prerequisite, parallel-track detection collapses them into one track to prevent two agents from colliding on the shared dependency. | "join", "converge"                                 |
| **ready**             | An OPEN task with no unresolved blockers. Exposed as the `ready` SQL view. | "unblocked", "available"                           |
| **goals**             | Tasks with no outgoing blocks-edges (graph endpoints). Exposed as the `goals` SQL view. | "leaves", "targets"                               |
| **sort key**          | Argument to `mu task list / next / ready --sort <key>`. One of `roi` (impact / effort_days, default for `next` / `ready`), `recency` (`updated_at` DESC — "what did I touch most recently"), `age` (`created_at` ASC — "what's gone stale"), `id` (`local_id` ASC, default for `task list`). The two time-based keys also render an `updated`/`created` relative-time column in the table view. | "order by", "sort by"                              |
| **subtree** / **scope** | The set of tasks reachable from a root via blocks-edges                | "subgraph" (only for technical descriptions)       |
| **note**              | An append-only piece of context attached to a task                       | "comment" (reserved for VCS), "log" (reserved for the **ops log**) |
| **log entry**         | A rendered **op**, as shown by `mu log`. Not a distinct table — the ops log is the only log. Prose comes from the op's **intent** via ONE formatter (`src/log-render.ts`), shared by `mu log`, `mu state`, and the TUI. Rows with no intent (operator writes / a **log ledger**) are shown verbatim. One hidden exception: a parent-row *touch* (payload is only `updated_at`) is a real op but not a log line. | "message" (overloaded), "event" (overloaded)       |
| **kind**              | The operator-chosen channel tag on a **log entry** — `mu log --kind <tag>` sets it on write and filters to it on read. Stored as the op's `entity`. A different axis from **intent**: **kind** is what the *operator* labels a hand-written line, **intent** is what *mu* records about a state change. Captured ops get their entity from the table they mutate (`task`, `note`, `edge`, `workstream`), and machine-local ops use `agent` / `workspace`; `message` is the default for a bare `mu log "text"`. | "category", "type" (overloaded) |
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
| **workspace**         | A VCS-isolated checkout (jj workspace / sl worktree / git worktree / cp). **In mu, "workspace" is always the VCS sense** — never the mux sense. herdr calls its session-level container a "workspace" too; in mu docs and code that is a **mux session**. | "branch" (it has one but isn't one), "checkout" (only for `none` backend), the herdr sense |
| **ghost**             | An `agents` row whose `pane_id` no longer exists in the **mux**. Pruned by **reconcile**, which runs in `mu agent list` and `mu doctor`. | "dead agent" (a dead agent may still have a pane), "stale row" |
| **reaper**            | The part of reconcile that releases a **ghost**'s tasks: `IN_PROGRESS → OPEN`, owner cleared. Makes `mu task wait` exit 6. | "garbage collector", "janitor" |
| **workspace orphan**  | A directory under `<state-dir>/workspaces/<workstream>/` with no row in `vcs_workspaces`. Blocks subsequent `--workspace` spawns. Surfaced by `mu workspace orphans -w X` and `mu state -w X`. | "stray dir", "leftover workspace"                  |
| **stale workspace**   | A workspace whose `parent_ref` is N commits behind the project's default branch HEAD (per the workspace's local refs cache). Rendered as a color-coded `behind` column (green ≤2, yellow 3–9, red ≥10) in `mu workspace list` and `mu state`; ≥10 triggers a one-line warn in `mu state`, `mu task claim --for`, and `mu agent send` (or refusal on the two dispatch verbs with `--strict-staleness`). Pure observation — mu never auto-fetches. | "out of date", "drifting"                          |
| **refresh**           | `mu workspace refresh <agent>` — rebase the agent's workspace onto a fresh base (default = backend's tracked main; `--from <ref>` overrides) WITHOUT touching the agent or pane. Refuses on dirty WC; surfaces conflicts as exit 5 with a resolve-in-place hint. The `none` backend errors (no VCS to rebase). | "recycle", "reset" (overloaded)                     |
| **recreate**          | `mu workspace recreate <agent>` — free + create the agent's workspace in one shot. The between-wave "prep this worker for the next dispatch" verb. Reuses the previous backend unless `--backend` overrides; bases on current main unless `--from <ref>` overrides. Refuses on dirty WC the same way `free` does; `--force` discards the dirty edits (lossy). Sibling of **refresh**: refresh PRESERVES the worker's commits (rebases them onto fresh main); recreate THROWS THEM AWAY. | "recycle", "reset" (overloaded), "free+create" (only in commit messages) |
| **backend**           | Implementation of `MuxBackend` or `VcsBackend`. Always qualify which (**mux backend** / **VCS backend**) when both are in scope. | "driver", "provider"                               |
| **detector**          | Per-CLI pattern matcher for busy/permission/ready, used when the **mux backend** cannot report status itself. On tmux that is always (`detectPiStatus` in `src/detect.ts`, covering vanilla pi + any TUI wrapper using Braille spinner glyphs); on herdr the mux classifies panes natively across its known agent kinds, so the detector is bypassed. The seam is the optional `MuxBackend.paneStatus?()`: absent means "ask the detector". herdr's states map `working` → `busy`, `blocked` → `needs_permission`, and `idle` / `done` / `unknown` → `needs_input` — `unknown` never becomes `free`, since herdr documents that it does not prove completion, and no detector of either kind may mint `free`. Other CLIs spawned via `--cli <other>` may misclassify on tmux; trust scrollback over the emoji. | "matcher", "parser"                                |
| **op**                | The atomic unit of change: one row in the `ops` table, written by a trigger inside the same transaction as the mutation it records. Carries `(hlc, machine_id, group_id, actor, intent, entity, key, op, payload)`. A **semantic partial update** — the payload holds only the columns that actually changed, which is what makes per-field merge free. | "event", "delta", "change" (all overloaded)         |
| **ops log**           | The `ops` table: the single append-only record of every change, and the substrate **sync**, **undo**, and history are all queries or replays over. Canonical and ACID because it lives in `mu.db` alongside the tables it records. | "event log", "journal", "WAL" (reserved by SQLite)  |
| **intent**            | The semantic label on an **op** (`task.close`, `task.reparent`, `agent.spawn`). Set once per public SDK function via **op context**, not per mutation. `mu log` renders prose from it through one formatter. | "verb" (overloaded by CLI verbs), "action"          |
| **group**             | A set of ops sharing a `group_id` — one user-visible action. A cascade close writes N ops in one group, so `mu undo <group>` reverts them as a unit. Ids are uuids, so every verb that takes one (`mu undo <group>`, `mu log --group`) accepts any unique PREFIX via the shared `groupIdFromPrefix` — the affordance git gives for shas. An ambiguous prefix is a conflict (exit 4), never a guess. | "transaction" (reserved by SQLite), "batch"        |
| **op context**        | The per-connection `_op_ctx` temp table holding `(group_id, actor, intent, applying)` for the current transaction. Triggers read it to stamp ops; `applying=1` suppresses capture while ingesting a peer's ops (echo-loop guard). Set through the scoped `withOpContext(db, {...}, fn)` / `withCaptureSuppressed(db, fn)` helpers in `src/op-context.ts`, never by writing the table directly — the scoping is what guarantees a throw cannot leak a stale intent onto later ops. Two sibling temp tables support it: `_op_clock` (holds "now" for one trigger firing so the HLC advance reads a single consistent value) and `_op_dying` (natural keys of rows mid-DELETE, so FK-cascaded children can still resolve a key after their parent row is gone). | "ambient context", "thread local"                   |
| **apply** | Verb: land one **op** into the portable tables, honouring the **merge rules**. `applyOp` / `applyOps` in `src/apply.ts`. Always runs capture-suppressed (`applying=1`), so applying never mints a new op — that is the echo guard. Idempotent: applying the same op twice changes nothing, which is what makes `mu sync --repair` merely "re-read that peer's **segment** from zero". Distinct from **ingest**, which is the sync-side loop that reads a segment and calls apply per op. | "merge" (that's the rule set), "import", "replay" (replay is undo) |
| **merge rules** | The per-entity conflict policy the **apply** path implements. note/message = **grow-only set**; task/workstream = **per-field LWW**; edge = **LWW-element-set**; machine-local entities are rejected. One rule per entity, chosen so that convergence needs no coordination between machines. | "conflict resolution" (implies prompting a human), "CRDT" (only loosely true) |
| **per-field LWW** | Last-writer-wins applied PER FIELD, not per row: each field of a task independently keeps the value written by the newest **HLC** that touched THAT field. Free, because ops are **semantic partial updates**. Row-level LWW is explicitly rejected — with agent crews on two machines, a crew closing a task while the operator edits its impact is concurrent by construction, and row-level would silently discard one edit. | "row LWW", "column versioning" (implies version vectors we don't need) |
| **grow-only set** | An entity that is only ever inserted, never updated: **notes** and log messages. Two machines therefore cannot disagree about a note's content, so there is nothing to resolve — apply is insert-if-absent. Identity is `(task, author, content)`, since a note's surrogate id is assigned per machine and cannot identify it across machines. | "append-only log" (that's the ops log), "set" |
| **LWW-element-set** | The rule for **edges**: set membership where both the add and the remove carry an **HLC**, so a remove and a later re-add converge in either arrival order. An edge has no fields worth merging — it is present or absent. | "add-wins set", "2P-set" (a 2P-set can't re-add) |
| **tombstone** | An `op='del'` row. There is NO tombstone table: a tombstone is an ordinary op carrying an **HLC**, so out-of-order arrival is just "compare HLCs", the same comparison the update path makes. A late **put** older than a seen tombstone loses; a tombstone older than a seen put loses. | "deletion marker", "grave" |
| **resurrection** | A **put** with an HLC NEWER than a seen **tombstone** for the same key, which legitimately recreates the row. Distinguishable from a stale put (older than the tombstone, and must lose) because **provenance** outlives the row: ops are never deleted when a table row is. | "undelete" (that's `mu undo`), "revive" |
| **provenance** | Which **HLC** last wrote a given field of a given key — what **per-field LWW** compares against. DERIVED from the **ops log** by query, never stored in a side table: `ops` already records which fields each HLC touched, so a side table would be a denormalisation that can disagree with the log with no procedure to decide which side is right. Costs zero extra storage and survives row deletion for free, which is what makes **resurrection** work. | "version vector", "clock table", "field metadata" |
| **inverse op** | The op that reverts another: `del` for a **put** that created a row, a `put` restoring prior field values for a put that changed them, a `put` restoring the row for a `del`. Written through the normal capture path, so it carries a fresh **HLC** and is an ordinary op — which is why an undo syncs and is itself undoable. | "rollback", "revert commit", "compensating transaction" |
| **superseded** | Of a **group**: a later group has written the same field(s) since, so emitting **inverse ops** would discard that newer work. `mu undo` refuses (exit 4) and names the conflict rather than clobbering or silently skipping; `--force` overrides. Detected PER FIELD, so a later edit to a different field of the same row does not block the undo. | "stale", "conflicted" (conflict is the exit-code label) |
| **drift** | Divergence between the **ops log** and the live tables. Means capture missed a mutation or **apply** is lossy — always a BUG, never operator error, and never transient. Detected by `mu doctor` (shallow: every live row must have at least one op naming its key) and `mu doctor --deep` (full rebuild + field-level diff). Exits 5. Remediation is NOT 'rebuild': if capture missed the mutation, the live tables hold work the log never saw. | "inconsistency", "corruption" (corruption is the SQLite file being damaged, which is different) |
| **shallow / deep check** | The two drift tiers. Shallow is ~3ms and runs in every `mu doctor`; deep rebuilds the whole log (~0.6ms per op) and runs only under `--deep`. Shallow is a smoke alarm, not a proof — it cannot see an uncaptured UPDATE because the row's key still has ops. | "quick/full scan", "fsck" |
| **mixed fleet** | More than one machine sharing state, where the machines differ in OS or filesystem semantics. The three hazards mu checks for: the DB living inside the sync dir, the DB on a network mount, and workstream names that differ only by case (fine on ext4, colliding on APFS/NTFS). | "cluster" (implies coordination mu does not have), "multi-device" |
| **portable**          | Of a table or entity: syncable across machines. Portable = `workstreams`, `tasks`, `task_edges`, `task_notes`. **Machine-local** = `agents` (holds `pane_id`), `vcs_workspaces` (absolute paths differ across macOS/Linux), `machine_identity`, `schema_version`, `sync_peers` (local watermarks), and `ops` itself — the ops table is never wholesale-copied; individual op *rows* ship, filtered by synced entity and carried by **segments**. Machine-local ops are still recorded (so `mu log` shows them) but never leave the machine. Declared as code in `src/db.ts`: `PORTABLE_TABLES` / `MACHINE_LOCAL_TABLES` / `SYNCED_ENTITIES`, guarded so the two table lists must partition `EXPECTED_TABLES`. | "shared", "global"                                  |
| **HLC**               | Hybrid logical clock: `(wall_ms, counter, machine_id)` serialized to a sortable TEXT. The ordering key for every op. Monotonic — never regresses — so a laptop waking with a skewed clock cannot resurrect stale edits. Persisted in `machine_identity` because every mu invocation is a fresh process. | "timestamp", "version" (both imply wall clock)      |
| **machine_id**        | Per-state-directory uuid seeded on first `openDb` and stored in `machine_identity`. Identifies one mu DB as a **peer** and names its **segment**; users do not configure it. | "device id", "host id"                              |
| **segment**           | An append-only JSONL file at `<sync-dir>/<machine_id>.jsonl` holding one machine's ops. **Single-writer-per-file**: a machine appends only to its own and read-onlys every other, so no file is ever contended and any file-mover (Syncthing, rsync, scp, git, USB) is adequate transport. Derived and regenerable from the `ops` table, so losing one costs a re-flush. | "replica", "shard", "stream"                        |
| **peer**              | Another machine, discovered implicitly as a `<machine_id>.jsonl` **segment** in the sync dir. There is no membership list to configure or keep consistent — dropping a segment in the folder joins the cluster. Referred to by `machine_id`, or any unique PREFIX of one (the affordance git gives for shas); an ambiguous prefix is a conflict, never a guess. NOT by hostname: `machine_identity.hostname` is machine-local and never ships, so a hostname display would need the membership file `MU_SYNC_PEERS` was rejected for being. A peer is **stale** when its segment file has not moved in 24h — a display threshold, not an env var. | "node", "replica", "remote"                         |
| **watermark**         | Per-peer integer in `sync_peers.last_applied_seq`: how far into that peer's **segment** we have applied, counted in LINES of that segment (not the peer's `ops.seq`, which is a local-only cursor on their machine and means nothing here). One integer suffices because segments are append-only and ordered. Advanced only as far as the last GOOD record, so damage is re-read rather than skipped. | "offset", "cursor" (cursor is reserved by `mu log`) |
| **flush** / **ingest** | The two halves of sync. Flush appends local ops to my own **segment**; ingest reads each peer segment from its **watermark** and applies. Both run ambiently on every mu invocation when `MU_SYNC_DIR` is set — there is no daemon. | "push"/"pull" (imply mu moves files; it does not)   |
| **reprojection**      | The pass that lands **ops** which could not be applied when they arrived because the row they hang off was not here yet — an `edge` or `note` whose task came from a DIFFERENT **peer**'s **segment**. Runs once after every **ingest** pass (never per peer: an edge in one segment may name a task in another, so only the union suffices) and asks the **ops log** which of them are resolvable NOW, rather than keeping a retry queue that could disagree with the log and would not survive a short-lived mu process. Excludes ops whose parent is gone and keys with a newer `del`, so it never resurrects a deleted edge. `reprojectDeferredOps` in `src/apply.ts`. | "retry queue", "pending ops", "deferred apply"      |
| **qualified ref**     | An entity-arg form `<workstream>/<name>` that targets a specific workstream's task / agent / workspace without `-w`. Bare `<name>` still resolves via the standard chain (`-w` / `$MU_SESSION` / current tmux session). Mixing a qualified ref with a non-matching `-w` is rejected (`UsageError`). When a bare name appears AND no workstream resolves AND ≥2 workstreams contain that name, mu raises `NameAmbiguousError` (exit 4) listing every candidate as a qualified-form one-paste fix. | "fully-qualified id" (in prose), "prefixed name"   |
| **doctor**            | The diagnostic command + report                                          | "health check", "diagnose"                         |
| **CLI**               | The `mu` command-line binary                                             | "tool" (overloaded), "binary" (only when relevant) |
| **extension**         | The pi extension shipped in the same package                             | "plugin"                                           |
| **skill**             | The bundled SKILL.md that teaches the LLM                                | "system prompt", "instruction"                     |
| **DB** / **registry** | `~/.local/state/mu/mu.db` and its tables                                             | "store", "database" (full word OK in prose)        |
| **substrate**         | An external system mu depends on (tmux, herdr, jj, sl, git, sqlite)      | "dependency" (means npm dep), "service"            |
| **operation**         | A canonical mu verb (e.g. `mu task add`). Each verb is a thin CLI wrapper over a typed function in `src/*.ts` — the SDK and the CLI share one surface. | "command" (overloaded), "action"             |
| **reconcile**         | Verb: re-derive registry rows from substrate reality (the **mux**). Always runs in `mu agent list` and `mu doctor`. | "sync", "refresh"                              |
| **adopt**             | Verb (`mu agent adopt`): register an existing pane as a managed **agent**. The inverse of `mu agent list`'s 'orphan' state. Pane must be in the workstream's **mux session**. | "import", "absorb"                       |
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
  ┌───────────────────────────────────────────────────────────────────┐
  │  mux session: mu-auth-refactor    (tmux session / herdr workspace) │
  │  ───────────                                                      │
  │                                                                   │
  │  ┌──────────────────────────┐  ┌──────────────────────────────┐   │
  │  │  window: Backend         │  │  window: Review              │   │
  │  │  ─────                   │  │  ─────                       │   │
  │  │  ┌──────────┐  ┌────────┐│  │  ┌────────────────────────┐  │   │
  │  │  │ worker-1 │  │worker-2││  │  │  reviewer-1            │  │   │
  │  │  │ pane     │  │ pane   ││  │  │  pane                  │  │   │
  │  │  │ (pi)     │  │ (pi)   ││  │  │  (pi, role=read-only)  │  │   │
  │  │  │ agent    │  │ agent  ││  │  │  agent                 │  │   │
  │  │  └──────────┘  └────────┘│  │  └────────────────────────┘  │   │
  │  └──────────────────────────┘  └──────────────────────────────┘   │
  │                                                                   │
  │  the crew = { worker-1, worker-2, reviewer-1 }   (informal)       │
  └───────────────────────────────────────────────────────────────────┘

  partitioned by session_id in ~/.local/state/mu/mu.db
```

**Identity convention:** the agent's name == `$MU_AGENT_NAME`, injected
into the pane's environment on spawn. It also == the **pane title**,
which is the fallback when the env var is absent. The window name comes
from the `tab:` frontmatter field and may group multiple agents in one
window.

This makes the claim protocol zero-config: an agent runs
`mu task claim foo` and mu resolves the **actor** by reading
`$MU_AGENT_NAME`, falling back to asking the **mux backend** for the
current pane's title. Env-first is backend-independent and more
reliable than scraping; the fallback exists because **adopted** panes
predate the env injection and carry only a title.

When the fallback runs on tmux, **read pane title (`#{pane_title}`), not
window name (`#W`)** — they differ when several agents share a
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
| `free`            | ✓    | Available; retained for persisted/runtime status compatibility |
| `managed`         | 🤝   | Under external orchestration; mu observes only      |
| `unreachable`     | ❓   | Transport down, status uncertain                    |
| `terminated`      | ✕    | Process gone, awaiting reaping                      |

**Source of truth:** the substrate — the **mux backend**, plus the
**detector** when that backend cannot classify panes itself. The DB is
a cache; `mu agent list` reconciles on every call.

### Agent lifecycle verbs

| Verb                  | Effect                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| `mu task release feature_a`| Clears the task owner for `feature_a`. The agent who claimed it is unaffected.  |
| `mu agent close alice`      | Terminates alice's pane and removes from registry. Destructive.             |
| `mu agent kick alice`       | Signals (default SIGINT) the foreground process group of alice's pane TTY. For wedged tool subprocesses (`find /`, busy-wait); the wrapping CLI itself is untouched. Refuses when the foreground IS the wrapping CLI. |
| `mu agent wait alice bob --first` | Blocks until an agent finishes (busy → any other state). The task-less counterpart to `mu task wait` for scratch/off-the-cuff helpers that own no task. `--any`/`--first` fire on the first; default all. Exit 0 met, 5 timeout, 6 a watched pane died. |
| *(none)*              | There is no detach verb. Use tmux detach to leave a workstream attached session without killing panes. |

### Verbs that move tasks through the lifecycle

| Verb                                  | Effect                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `mu task add <id> ...`                | Creates a new OPEN task. `--note <text>` appends an initial note in the same transaction; `--note-author <name>` overrides the note author. |
| `mu task close/open <id>`             | Lifecycle transition                                 |
| `mu task claim <task> [--for <agent>]`     | Atomic: sets `owner`, flips status to `IN_PROGRESS`   |
| `mu task release <task>`              | Clears `owner`. Auto-flips `IN_PROGRESS` → `OPEN` (so the task re-enters the ready set); `CLOSED` is preserved. `--reopen` forces `OPEN` from `CLOSED`. |
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
| "session"        | Pi has its own "session"; tmux has "session"; herdr has a third (server-level); ambiguous alone | "workstream" (mu's unit), "mux session" (cross-backend), or "tmux session" (literal) |
| "workspace" (mux sense) | mu already uses "workspace" for a VCS-isolated checkout. herdr's session-level container is also called a workspace, and letting both senses in would make `mu workspace list` ambiguous | "mux session"; say "herdr workspace" only when describing herdr's own CLI |
| "project"        | Means a `.pi/` project root; conflict with mu's organizational unit | "workstream"                                       |
| "context"        | Overloaded (LLM context, project context, fork context)          | Be specific: "task context", "forked context", etc.  |
| "tab"            | Tmux has windows, not tabs (herdr does call them tabs). Pi-subagents and dg use "tab" as a frontmatter field; we keep that field for compatibility but use "window" everywhere else | "window" (in prose); only `tab:` in frontmatter      |
| "thread"         | OS threads + chat threads + git threads; bad word                | Be specific                                          |
| "message"        | Overloaded (LLM message, log message, send-keys input)           | "log entry" (for the **ops log**), "send" (for input to a pane) |
| "config"         | Already means the global mu config; don't reuse                  | Specific: "settings", "frontmatter", "options"       |
| "manager"        | Vague; everything could be a manager                             | The specific noun (e.g., "the registry", "the eval engine") |
| "service"        | Implies long-running daemon; mu has none                         | Be specific                                          |
| "plugin"         | Pi has extensions, not plugins                                   | "extension"                                          |
| "instance"       | Vague; could be agent / workstream / process                     | The specific thing                                   |
| "broker"         | Implies pub-sub middleware; we don't have one                    | "log entry" or be specific                           |
| "checkpoint"     | Implies recoverable savepoints in the work                       | "group" (undo unit)  |
| "snapshot"       | mu has no whole-DB savepoints                                    | "backup" for a whole-DB copy      |
| "agent type"     | "Type" implies a class hierarchy; mu has no class system | "agent role" (scout/reviewer/etc.)                   |
| "agent definition" / "agent template" / "agent role doc" | mu has no template/definition concept. Spawn flags + the orchestrator's prompt are the only "definition" | Just describe the spawn invocation directly |
| "worker"         | "worker" is the name of one specific built-in agent              | "agent" (general); "the worker" only when referring to that specific agent |
| "claimer"        | Awkward; we have "owner" already                                 | "owner"                                              |

---

## Operations reference

The complete verb list lives in two places, both authoritative:

- **`mu --help`** and **`mu <verb> --help`** — the canonical CLI
  reference. If anything below disagrees with `--help`, trust
  `--help`.
- **[skills/mu/SKILL.md](../skills/mu/SKILL.md)** — the LLM-facing
  one-pager: `## CLI overview` covers the gotchas per namespace.

For worked examples, see [USAGE_GUIDE.md](USAGE_GUIDE.md). Rows below
exist to keep names canonical, not to replace `--help`.

| Operation | Canonical meaning |
| --------- | ----------------- |
| `mu sync` | Report **peer** status (**watermark** + staleness). **Flush** and **ingest** happen on this and every other mu invocation when `MU_SYNC_DIR` is set, so the bare form is a status card whose sync is incidental — it exists mainly so `rsync ... && mu sync` reads correctly. |
| `mu sync --from <path>` | Ingest from a peer's `mu.db` directly (a different reader: SQLite `ops` table rather than a JSONL **segment**). For an sshfs mount or a copied file. |
| `mu sync --repair <peer>` | Reset a **watermark** to re-read that peer's **segment** from zero. The universal repair, safe because ingest is idempotent via `UNIQUE (machine_id, hlc)`. Takes a `machine_id` or any unique prefix. |
| `mu undo <group>` | Emit inverse ops for one **group**. Granular (touches only that action's rows), composable, and itself an op — so it syncs and is itself undoable. |
| `mu rebuild <file>` | Materialize a fresh DB by replaying the **ops log** in HLC order. The disaster-recovery path; prints the swap command rather than overwriting in place. Replays EVERYTHING the log knows, including machine-local ops — a rebuild is local recovery, not **ingest**, so it does not filter to synced entities. Carries `machine_identity` (and its HLC clock) across, so the rebuilt DB is the SAME peer. `agents` / `vcs_workspaces` are NOT rebuilt — they have no capture triggers so leave no ops, and `pane_id` / absolute paths would be lies after recovery; the summary reports the loss and says to re-spawn. |
| `mu db backup <file>` | `VACUUM INTO` copy of the whole DB. The "one file I can scp" convenience; real DR is **segments** + `mu rebuild`. |

A one-off directory needs no flag — `MU_SYNC_DIR=/mnt/usb mu state`
ingests from a USB stick using the existing env-var idiom.

---

## Naming conventions

### Flag vs positional

> **The primary entity a verb acts on is POSITIONAL. Everything
> else — scoping, modifiers, payload — is a flag.**

`mu task close <id>`, `mu agent send <name> <text>`,
`mu workstream init <name>`. The
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

The two are not the same thing:

| Input | Kind | Treatment | Why |
| --- | --- | --- | --- |
| `--status "OPEN,"` | **empty** (`""` before trimming) | dropped → `[OPEN]` | A trailing/double comma is a structural artifact of typing a list. |
| `--blocked-by ""` | **empty** | dropped → `[]` | `mu task reparent --blocked-by ''` documents this as the clear-all-blockers sentinel. |
| `--status " "` | **blank** (non-empty before trimming, empty after) | `UsageError`, exit 2 | Nobody means "filter by the space character". It is a typo or a quoting accident. |
| `--status "OPEN, "` | **blank** | `UsageError`, exit 2 | Widening to *no filter at all* and exiting 0 would be a silent wrong answer. |

The rule is enforced once, in `parseCsvFlag` (`src/cli.ts`), so every
list flag agrees — `--status`, `--by`, `--blocked-by`, `-w`. Each
call site passes its own flag name so the error names the flag the
operator actually typed.

A blank single-value `-w ' '` is rejected in `resolveWorkstream` for
the same reason; otherwise it resolves to a workstream literally
named `" "`.

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

Anthropomorphic (or status-loaded) names confuse the model when
reading commands ("alice claims design" sounds like a person;
"worker-1 claims design" is obviously a generic worker taking a
task). Role-based names also make `mu agent list` and tmux's window
list legible at a glance.

The roles align with pi-subagents' role taxonomy:

  `worker`     long-lived implementer; the default
  `reviewer`   reads diffs/code; usually `--role read-only`
  `scout`      fast recon; one-shot, returns context
  `oracle`     second opinion before action
  `auditor`    long-lived watcher; `--role read-only`
  `planner`    designs implementation plans

If you have multiple agents in the same role, suffix with `-1`,
`-2`, ... (`worker-1`, `worker-2`).

This is a convention, not enforcement: mu's regex accepts any
`[a-z][a-z0-9_-]{0,31}` string. Test fixtures may use `alice`/`bob`;
don't propagate that to user-facing examples or real workstreams.

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
| `MU_MUX`          | Force the **mux backend**, bypassing **mux detection**. Load-bearing: every verb reaches its multiplexer through `activeMux()`, so an unknown value fails the invocation rather than silently running on tmux. | wins over all detection |
| `MU_SYNC_DIR`     | Shared folder holding one **segment** per machine. Unset = sync off, zero cost. The WHOLE cluster configuration; there is no peer list. | n/a |

### Env vars passed to spawned children

| Name                         | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| `MU_SESSION_ID`              | Workstream identifier                                |
| `MU_AGENT_NAME`              | This agent's name                                    |
| `MU_PARENT_PANE`             | **Pane id** of the spawning process (backend-specific shape) |
| `MU_DB_PATH` / `MU_STATE_DIR` | Inherited from parent unless overridden            |
| `XDG_STATE_HOME`             | Inherited; mu uses `<XDG_STATE_HOME>/mu` by default  |
| `MU_SEND_DELAY_MS`           | Delay between bracketed paste and Enter (default `500`) |
| `MU_SEND_READINESS_MS`       | Budget for `mu agent send` to wait out a pane's modal / re-init before pasting, and to re-confirm the Enter landed (default `15000`; `0` restores fire-and-forget). A busy-but-working pane is not waited on. |
| `MU_TMUX_SOCKET`             | Override tmux socket (`-L <name>`); default uses `$TMUX`. tmux **mux backend** only — ignored under herdr, which reaches its server over a unix socket it manages itself. |
| `MU_HERDR_SESSION`           | Drive a NAMED herdr server (`--session <name>`, its own socket) instead of the user's default one. The herdr analogue of `MU_TMUX_SOCKET`, and the isolation seam any herdr integration test must use so the suite can never observe — or destroy — real panes. herdr **mux backend** only. |
| `MU_<UPPER_CLI>_COMMAND`     | Override the executable launched for `--cli <cli>` (e.g. `MU_PI_COMMAND=pi-alt` makes `--cli pi` exec `pi-alt`; hyphens in the cli key become underscores in the env var name, so `--cli pi-meta` reads `MU_PI_META_COMMAND`). Accepts multi-word strings (`MU_PI_COMMAND="pi-alt --some-flag"`); tmux exec's via a shell. Reconcile also treats the resolved binary as agent-worthy when surfacing orphan panes. When this env var supplies the override (and `--command` did not), the spawn-success line surfaces the env-var name (`Spawned worker-1 (pi-meta via $MU_PI_META_COMMAND)`) so stale aliases are visible without `mu agent show`. |
| `MU_SPAWN_LIVENESS_MS`       | **tmux-tier knob** (herdr's `agent start` blocks until the agent is ready, so there is nothing to poll for). After spawn, wait this many ms then verify the pane is still alive AND scan the tail of its scrollback for known startup-error patterns (provider auth failures — `No API key found for X`, `401 Unauthorized`, … — plus shell-level `command not found` / `No such file or directory` when the spawned binary vanished post-pre-flight). Default 1500. Set to 0 to disable (useful in CI). On detected death the DB row is rolled back and `AgentDiedOnSpawnError` is thrown with the captured scrollback; on a startup-error match (pane alive but parked at an error prompt) the row is rolled back and `AgentSpawnStartupError` is thrown with the matched line + remediation hints. The complementary pre-flight check (PATH lookup of `--cli`'s resolved binary BEFORE any side effect) is not env-tunable; on miss it throws `AgentSpawnCliNotFoundError` with no orphan workspace / pane / row. |

These mirror pi-subagents' `PI_SUBAGENT_*` env vars in spirit but live
in a separate namespace so the two can coexist in one pi session.

---

## Type of "session"

Because "session" is overloaded, here are the four senses we encounter
and the disambiguated terms:

| Generic word | mu term used in docs/code             | What it actually is                              |
| ------------ | ------------------------------------- | ------------------------------------------------ |
| session      | **workstream**                        | mu's unit of organization                        |
| session      | **mux session**                       | The backend-agnostic container for a workstream's panes |
| session      | **tmux session**                      | The tmux process group `mu-<workstream>`         |
| session      | **herdr session**                     | herdr's *server*-level unit (one socket). NOT a **mux session** — mu maps a workstream to a herdr *workspace*, one level down. |
| session      | **pi session**                        | The thing pi calls a session (its conversation)  |
| session      | **agent session** (avoid in code)     | Colloquial for "an agent's run/lifetime"; prefer "lifetime" or "the work alice has done" |

When writing code, say `workstream_id` not `session_id` in any new
column or variable name. The `agents.session_id` column keeps its
name for schema stability; document it as "workstream id".
