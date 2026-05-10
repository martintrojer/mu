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
| **tmux session**      | The literal tmux session a workstream lives in                           | "session" alone (ambiguous)                        |
| **window**            | A tmux window (tmux's tabs); identified by `window_name`                 | "tab" (except as the frontmatter field name)       |
| **pane**              | A tmux pane (one shell view inside a window); identified by **stable pane id** like `%15` | "terminal", "shell"                          |
| **pane title**        | The string set on a pane via `select-pane -T`. **Equals the agent's name.** Read by the claim protocol. | "pane name"                          |
| **window name**       | The tmux window's name. **Equals the agent's `tab:` value** (groups one or more agents). | "tab name" (in code; `tab:` only in frontmatter) |
| **agent**             | A named worker running in a pane; identity = pane title; row in `agents` table | "subagent" (reserved for pi-subagents), "worker" (only the specific role) |
| **worker**            | An **agent** in its role-as-task-claimer. Synonym for the registered side of identity — a row in `agents`, owns tasks via the FK. | (when ambiguous, prefer **agent**)                 |
| **actor**             | The party that *caused* a state change. May or may not be a registered worker. Recorded in `agent_logs.source` for every event. The orchestrator running mu from a top-level shell is an actor but not a worker. | "caller", "author" (only on notes)            |
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
| **note**              | An append-only piece of context attached to a task                       | "comment" (reserved for VCS), "log" (reserved for `agent_logs`) |
| **log entry**         | A row in `agent_logs` (broadcast channel)                                | "message" (overloaded), "event" (overloaded)       |
| **claim**             | Verb: set `tasks.owner` to an agent. Atomic CAS.                         | "assign" (use only in prose), "lock"               |
| **owner**             | The **worker** name in `tasks.owner`. Set by claim. NULL when the task is unowned OR was claimed via `--self` (anonymous, attributed via `agent_logs.source` instead). | "claimer", "assignee"                              |
| **anonymous claim**   | A claim made via `--self` where the **actor** isn't a registered **worker**. `tasks.owner` stays NULL; the actor is recorded in `agent_logs.source` for the auto-emitted `task claim` event. The orchestrator-doing-direct-work pattern. | "self-claim" (in code; "anonymous claim" in prose), "unowned claim" |
| **release**           | Verb: clear `tasks.owner`                                                | "unclaim", "unassign"                              |
| **free**              | Verb: mark an agent's `status = 'free'` (idle, available)                | "park", "idle" (verb)                              |
| **status**            | Persisted enum on `agents` (busy/needs_input/free/...)                   | "state" (use only "lifecycle state")               |
| **lifecycle state**   | A position in the agent state machine                                    | "state" alone, "phase"                             |
| **role**              | `full-access` or `read-only` capability flag                             | "permission" (avoid), "tier"                       |
| **persistent**        | Agent that stays alive across tasks                                      | "long-lived" (only in prose)                       |
| **one-shot**          | Agent that exists for a single task and then terminates                  | "ephemeral", "transient"                           |
| **workspace**         | A VCS-isolated checkout (jj workspace / sl worktree / git worktree / cp) | "branch" (it has one but isn't one), "checkout" (only for `none` backend) |
| **workspace orphan**  | A directory under `<state-dir>/workspaces/<workstream>/` with no row in `vcs_workspaces`. Blocks subsequent `--workspace` spawns. Surfaced by `mu workspace orphans -w X` and `mu state -w X`. | "stray dir", "leftover workspace"                  |
| **stale workspace**   | A workspace whose `parent_ref` is N commits behind the project's default branch HEAD (per the workspace's local refs cache). Rendered as a color-coded `behind` column (green ≤2, yellow 3–9, red ≥10) in `mu workspace list` and `mu state`; ≥10 triggers a one-line warn in `mu state`. Pure observation — mu never auto-fetches. | "out of date", "drifting"                          |
| **backend**           | Implementation of `AgentBackend` or `VcsBackend`                         | "driver", "provider"                               |
| **detector**          | Per-CLI pattern matcher for busy/permission/ready. Today mu has one (`detectPiStatus` in `src/detect.ts`); covers vanilla pi + any TUI wrapper that uses Braille spinner glyphs. Other CLIs spawned via `--cli <other>` may misclassify; trust scrollback over the emoji. | "matcher", "parser"                                |
| **snapshot**          | A whole-DB backup (`<state-dir>/snapshots/<id>.db`) auto-captured before each destructive verb (workstream destroy, agent close, task close/reject/defer/release/delete, workspace free). Indexed by the `snapshots` table; restore via `mu undo`. | "checkpoint", "backup"                             |
| **export**            | A directory of plain markdown files produced by `mu workstream export` (one `.md` per task + `INDEX.md` + `README.md` + `manifest.json`). Survives `mu workstream destroy` (auto-run pre-destroy to `<state-dir>/exports/<ws>-<ts>/` unless `--no-export`). Idempotent: re-export against the same dir rewrites only changed files; deleted tasks are preserved with a banner. Markdown-only by design — no HTML/PDF, no embedded VCS. The inverse is **import** (markdown only; never `.db`). | "dump", "snapshot" (snapshot is the binary `.db`)  |
| **import**            | The inverse of **export**: `mu workstream import <bucket-dir>` walks a v0.3 bucket directory and rebuilds every source-ws subdir as live tasks + edges + notes in the DB. Markdown-only by design (cross-machine `.db` is `mu undo` + snapshots). Per-source-ws transactional; refuses to merge silently into an existing workstream (use `--workstream <name>` for single-source rename, or destroy the existing one first). Owners reset to NULL on import (agents aren't restored); the original owner name survives in the markdown frontmatter. | "rehydrate", "restore" (restore = `mu undo`)       |
| **archive**           | An operator-named bucket of preserved task graphs (rows in `archives` + `archived_tasks` + `archived_edges` + `archived_notes` + `archived_events`). Cross-workstream and additive: one archive may accumulate snapshots from many workstreams under the same label. Outlives every source workstream; `archived_tasks.source_workstream` is intentionally TEXT (not an FK) so destroyed-workstream attribution survives. Distinct from a **snapshot** (binary whole-DB backup for `mu undo`) and an **export** (markdown files on disk). | "backup", "vault"                                 |
| **archived task**     | A row in `archived_tasks`: a snapshot of a `tasks` row at archive time. Pins `status`, `impact`, `effort_days`, `owner_name`, and the original `created_at`/`updated_at` for retrospect ordering. The `(archive_id, source_workstream, original_local_id)` composite UNIQUE makes `mu archive add` idempotent at the (archive, workstream) granularity. | "closed task" (status-orthogonal)                  |
| **archive label**     | The operator-facing TEXT name of an **archive**. Globally unique across the machine (NOT per-workstream — archives outlive workstreams). Shape: `/^[a-z][a-z0-9_-]{0,63}$/` (wider than workstream names because labels often encode workstream + date + purpose, e.g. `auth-2026-q1`). | "archive name" (in code; `label` only)             |
| **qualified ref**     | An entity-arg form `<workstream>/<name>` that targets a specific workstream's task / agent / workspace without `-w`. Bare `<name>` still resolves via the standard chain (`-w` / `$MU_SESSION` / current tmux session). Mixing a qualified ref with a non-matching `-w` is rejected (`UsageError`). When a bare name appears AND no workstream resolves AND ≥2 workstreams contain that name, mu raises `NameAmbiguousError` (exit 4) listing every candidate as a qualified-form one-paste fix. | "fully-qualified id" (in prose), "prefixed name"   |
| **doctor**            | The diagnostic command + report                                          | "health check", "diagnose"                         |
| **CLI**               | The `mu` command-line binary                                             | "tool" (overloaded), "binary" (only when relevant) |
| **extension**         | The pi extension shipped in the same package                             | "plugin"                                           |
| **skill**             | The bundled SKILL.md that teaches the LLM                                | "system prompt", "instruction"                     |
| **DB** / **registry** | `~/.local/state/mu/mu.db` and its tables                                             | "store", "database" (full word OK in prose)        |
| **substrate**         | An external system mu depends on (tmux, jj, sl, git, sqlite)             | "dependency" (means npm dep), "service"            |
| **operation**         | A canonical mu verb (e.g. `mu task add`). Each verb is a thin CLI wrapper over a typed function in `src/*.ts` — the SDK and the CLI share one surface. | "command" (overloaded), "action"             |
| **reconcile**         | Verb: re-derive registry rows from substrate reality (tmux). Always runs in `mu agent list` and `mu doctor`. | "sync", "refresh"                              |
| **adopt**             | Verb: register an existing tmux pane as a managed **agent**. The inverse of `mu agent list`'s 'orphan' state. Pane must be in the workstream's tmux session. | "import", "absorb"                       |
| **pi-subagents**      | A different package by Nico Bailon for in-pi focused delegation. Mu and pi-subagents are complementary, not competing. | conflating with mu                                 |

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
| `mu release feature_a`| Clears `tasks.owner` for `feature_a`. The agent who claimed it is unaffected.  |
| `mu agent close alice`      | Terminates alice's pane and removes from registry. Destructive.             |
| `mu detach alice`     | (Future) Tmux-detaches alice's pane without killing the process. Not in v1. |

**Don't conflate `free` and `release`.** Free is about the *agent*;
release is about the *task*.

### Verbs that move tasks through the lifecycle

| Verb                                  | Effect                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `mu task add <id> ...`                | Creates a new OPEN task                               |
| `mu task update <id> --status closed` | Lifecycle transition                                  |
| `mu task claim <task> [--for <agent>]`     | Atomic: sets `owner`, flips status to `IN_PROGRESS`   |
| `mu release <task>`                   | Clears `owner`. Status unchanged (still IN_PROGRESS unless updated separately) |
| `mu task note <task> "..."`           | Appends to `task_notes`. Never edits prior notes.     |

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
| "message"        | Overloaded (LLM message, log message, send-keys input)           | "log entry" (for `agent_logs`), "send" (for input to a pane) |
| "config"         | Already means the global mu config; don't reuse                  | Specific: "settings", "frontmatter", "options"       |
| "manager"        | Vague; everything could be a manager                             | The specific noun (e.g., "the registry", "the eval engine") |
| "service"        | Implies long-running daemon; mu has none                         | Be specific                                          |
| "plugin"         | Pi has extensions, not plugins                                   | "extension"                                          |
| "instance"       | Vague; could be agent / workstream / process                     | The specific thing                                   |
| "broker"         | Implies pub-sub middleware; we don't have one                    | "log entry" or be specific                           |
| "checkpoint"     | Implies recoverable savepoints in the work; we have snapshots, which back up the DB | "snapshot"                                       |
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
reference too.

---

## Naming conventions

### IDs

- **Agent name**: lowercase, `[a-z][a-z0-9_-]*`, ≤32 chars. Used as
  tmux window name verbatim. Unique within a workstream.
- **Task local_id**: same shape and rules. Unique within the DB.
- **Workstream name**: same shape; tmux session is `mu-<name>`.
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
- `<state-dir>/snapshots/<id>.db` — whole-DB snapshots auto-captured
  before destructive verbs (schema v5). Indexed by the `snapshots`
  table; restore via `mu undo` (inspect via `mu snapshot list` /
  `mu snapshot show <id>`). Default colocation: snapshots live
  next to the live DB, so per-test isolation works without env
  gymnastics.
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
| `MU_TMUX_SOCKET`             | Override tmux socket (`-L <name>`); default uses `$TMUX` |
| `MU_<UPPER_CLI>_COMMAND`     | Override the executable launched for `--cli <cli>` (e.g. `MU_PI_COMMAND=pi-alt` makes `--cli pi` exec `pi-alt`). Accepts multi-word strings (`MU_PI_COMMAND="pi-alt --some-flag"`); tmux exec's via a shell. Reconcile also treats the resolved binary as agent-worthy when surfacing orphan panes. |
| `MU_SPAWN_LIVENESS_MS`       | After spawn, wait this many ms then verify the pane is still alive. Default 1500. Set to 0 to disable (useful in CI). On detected death, the DB row is rolled back and `AgentDiedOnSpawnError` is thrown with the captured scrollback. |

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
     the `defineOperation` registry). The table is the single source.
     For deeper background, follow the links the table rows carry. -->
