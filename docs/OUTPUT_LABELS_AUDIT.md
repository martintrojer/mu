# Output labels audit — human columns and `--json` keys after schema v5

> Phase 1 deliverable for `output_id_vs_name_audit` (mufeedback).
> HEAD = `6528269`. Audit only — no renames in this commit.
> Implementation lands in three follow-up tasks listed at the bottom.

---

## TL;DR

Schema v5 split the operator-facing identifier (a per-workstream-unique
TEXT name) from the surrogate INTEGER PK that lives in the DB and
never escapes to the operator. The CLI surface still calls the
operator-facing identifier **"id"** in column headers and **"localId"**
in JSON (in the `tasks` row shape), and uses the bare unqualified
field `workstream` for what is conceptually a foreign-name reference.
This audit picks one convention and applies it everywhere; the
implementation is split into three follow-up tasks.

**Convention pick (single rule, applied uniformly):**

- **`name`** — the entity's own per-scope name. ALWAYS singular `name`
  (drop `localId`, `slug`, `workstream` (when self-referencing),
  `agent` (when self-referencing)).
- **`<entityType>Name`** — a reference to another entity by its name.
  Always the full `workstreamName` / `ownerName` / `agentName` form,
  never bare `workstream` / `owner` / `agent`.
- **Surrogate INTEGER ids** — NEVER appear in `--json` and NEVER appear
  in CLI column headers. They are internal to the SQLite schema.
- **Composite scope-name pairs** — when needed (cross-workstream
  queries like `mu task owned-by` returning rows from many
  workstreams), include `workstreamName` alongside `name` so the
  consumer can disambiguate.

**Three follow-up tasks** (filed at end of this doc):

1. `output_labels_human_rename` — cli-table3 column header rename only
   (~30 LOC). Visible-but-not-breaking.
2. `output_json_keys_rename_v5` — `--json` key rename per the table
   below (~150 LOC + many test rewrites). **BREAKING for any
   external `jq` script.** Migration recipes shipped in CHANGELOG.
3. `verb_arg_qualified_workstream_name` — Phase 3, parse-at-entry
   helper for `<workstream>/<name>` qualified refs (~50 LOC + tests).
   Orthogonal to the rename; can ship before or after.

---

## The drift in one screen

| layer            | example today                               | post-rename                                          |
| ---------------- | ------------------------------------------- | ---------------------------------------------------- |
| Table column     | `id`        in `mu task list`               | `name`                                               |
| Table column     | `agent`     in `mu workspace list`          | `agent` (unchanged — already a name in human view)   |
| Table column     | `slug`      in `mu approve list`            | `name`                                               |
| JSON key         | `localId`   in `mu task show --json`        | `name`                                               |
| JSON key         | `workstream` (everywhere)                   | `workstreamName`                                     |
| JSON key         | `owner`     in tasks                        | `ownerName` (`null` allowed)                         |
| JSON key         | `agent`     in workspaces                   | `agentName`                                          |
| JSON key         | `slug`      in approvals                    | `name`                                               |
| Help text        | `<id>` everywhere                           | `<name>`                                             |
| SKILL.md         | "task `<id>`" / "agent `<name>`"            | "task `<name>`" / "agent `<name>`"                   |

The **SKILL.md inconsistency** ("task `<id>`" vs "agent `<name>`") is
the most telling: agents and tasks are literally the same shape in v5
(per-workstream-unique TEXT identifier), but the documentation still
uses the v4 word for one of them.

---

## Per-verb decision matrix (human + JSON together)

Method: for every verb that produces a row of an entity (read verbs)
or accepts an entity argument (write verbs), enumerate the current
human column header / arg label and the current JSON key, then state
the recommendation under the convention above.

Legend:

- **CHG** = rename in this audit's follow-up tasks.
- **OK**  = already correct under the convention.
- **N/A** = verb produces no entity-shaped output (e.g. `mu agent
  send` returns `{ sentBytes }` only).

### tasks namespace (`mu task ...`)

| verb                          | current human label            | current JSON key(s)                                   | recommendation                                                                 |
| ----------------------------- | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `task add [id]`               | `<id>` arg, `id` col           | `localId`, `workstream`, `owner` (in returned task)   | CHG: `<name>` arg + `name` col; JSON: `name`, `workstreamName`, `ownerName`    |
| `task list`                   | `id`, `workstream`, `owner` cols | array of task rows: `localId`, `workstream`, `owner` | CHG: `name`, `workstream`, `owner` cols; JSON: `name`, `workstreamName`, `ownerName` |
| `task next` / `ready` / `blocked` / `goals` / `owned-by` / `search` / `my-tasks` / `my-next` | same as `task list` | same as `task list` | CHG: same as `task list`                                                       |
| `task show <id>`              | `<id>` arg, `id` row label     | `task: { localId, workstream, owner, ... }`, `blockers: [localId, ...]`, `dependents`, `notes`, `lastClaimActor` | CHG: `<name>` arg; JSON: `task: { name, workstreamName, ownerName, ... }`, `blockers: [name, ...]` |
| `task tree <id>`              | `<id>` arg                     | `{ task: TaskRow, children: [...] }`                  | CHG: `<name>` arg; child `task` rows get the rename                            |
| `task notes <id>`             | `<id>` arg                     | array of `TaskNoteRow`: `{ id, taskId, author, content, createdAt }` | CHG: `<name>` arg; JSON: drop `id` (autoincrement = internal), drop `taskId` (caller already knows), keep `{ author, content, createdAt }`, ADD `seq` if oldest-first ordering needs an explicit cursor |
| `task note <id> <text>`       | `<id>` arg, `--author <name>`  | `{ task: localId, note: TaskNoteRow, nextSteps }`     | CHG: `<name>` arg; JSON: `{ taskName, note: { author, content, createdAt }, nextSteps }` |
| `task close <id>`             | `<id>` arg                     | `{ task: localId, ...result, nextSteps }`             | CHG: `<name>` arg; JSON: `{ taskName, ...result, nextSteps }`                  |
| `task open` / `reject` / `defer` / `release` | same as `close`     | same as `close`                                       | CHG: same as `close`                                                           |
| `task claim <id>`             | `<id>` arg, `--for <agent>`    | `{ owner, actor, status, previousStatus, ..., nextSteps }` | CHG: `<name>` arg; JSON: rename `owner` → `ownerName`, `actor` → `actorName` |
| `task block <blocked>`        | `<blocked>` arg, `--by <id>`   | `{ blocked, blocker, ..., nextSteps }`                | CHG: `<blocked-name>`, `--by <name>`; JSON: `{ blockedName, blockerName, ... }` |
| `task unblock <blocked>`      | same as `block`                | same as `block`                                       | CHG: same as `block`                                                           |
| `task delete <id>`            | `<id>` arg                     | `{ task: localId, ...result, nextSteps }`             | CHG: `<name>` arg; JSON: `{ taskName, ... }`                                   |
| `task update <id>`            | `<id>` arg                     | `{ task: localId, ..., nextSteps }`                   | CHG: `<name>` arg; JSON: `{ taskName, ... }`                                   |
| `task reparent <id>`          | `<id>` arg, `--blocked-by <ids>` | `{ task: localId, blockers, ..., nextSteps }`       | CHG: `<name>` arg, `--blocked-by <names>`; JSON: `{ taskName, blockerNames, ... }` |
| `task wait <ids...>`          | `<ids>` args                   | (status code only)                                    | CHG: `<names...>` args                                                         |

### agents namespace (`mu agent ...`)

| verb                       | current human label                  | current JSON key(s)                                    | recommendation                                                                |
| -------------------------- | ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `agent spawn <name>`       | `<name>` arg ✓                       | `{ agent: AgentRow, workspace, resolvedCommand, ... }` (AgentRow.workstream, ...) | OK arg; CHG: `agent.workstream` → `agent.workstreamName`                     |
| `agent send <name> <text>` | `<name>` arg ✓                       | `{ agent: name, sentBytes, nextSteps }`                | OK arg; CHG: `agent` field → `agentName` (it IS just the name string)         |
| `agent read <name>`        | `<name>` arg ✓                       | `{ agent: name, lines, scrollback, scrollbackLines }`  | OK arg; CHG: `agent` field → `agentName`                                      |
| `agent list`               | `name`, `cli`, `status`, `window`, `role` cols ✓ | `{ workstream, agents: [AgentRow], orphans }`        | OK cols; CHG: top-level `workstream` → `workstreamName`; agent rows: `workstream` → `workstreamName` |
| `agent show <name>`        | `<name>` arg ✓                       | `{ agent: AgentRow, scrollback, scrollbackLines }`     | OK arg; CHG: agent row gets `workstreamName`                                  |
| `agent close <name>`       | `<name>` arg ✓                       | `{ agent: name, ..., nextSteps }`                      | OK arg; CHG: `agent` field → `agentName`                                      |
| `agent free <name>`        | same                                 | same                                                   | OK arg; CHG: `agent` field → `agentName`                                      |
| `agent attach <name>`      | same                                 | (prints attach command)                                | OK                                                                            |
| `adopt <pane-or-title>`    | `<pane-or-title>` ✓                  | `{ agent: AgentRow, ..., nextSteps }`                  | OK arg; CHG: agent row gets `workstreamName`                                  |
| `whoami`                   | (no arg)                             | `{ agent: AgentRow, ownedTasks: [TaskRow] }`           | CHG: agent row + each TaskRow get the rename                                  |
| `my-tasks`, `my-next`      | (no arg)                             | array of TaskRow                                       | CHG: TaskRow rename                                                           |

### workspace namespace (`mu workspace ...`)

| verb                       | current human label                            | current JSON key(s)                            | recommendation                                                          |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `workspace create <agent>` | `<agent>` arg                                  | `{ workspace: WorkspaceRow, nextSteps }`       | CHG: `<agent-name>`; WorkspaceRow: `agent` → `agentName`, `workstream` → `workstreamName` |
| `workspace list`           | `agent`, `workstream`, `backend`, `path`, `parent_ref`, `behind`, `created` cols | array of WorkspaceRow | OK human cols (already names in human view); CHG JSON: `agent` → `agentName`, `workstream` → `workstreamName` |
| `workspace free <agent>`   | `<agent>` arg                                  | `{ agent, ...freeResult }`                     | CHG: `<agent-name>`; JSON: `agent` → `agentName`                        |
| `workspace path <agent>`   | `<agent>` arg                                  | `{ agent, path, backend }`                     | CHG: `<agent-name>`; JSON: `agent` → `agentName`                        |
| `workspace orphans`        | (no arg)                                       | `{ workstream, orphans, nextSteps }`           | CHG: `workstream` → `workstreamName`                                    |

### approve namespace (`mu approve ...`)

| verb                       | current human label                                | current JSON key(s)                              | recommendation                                                  |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `approve add`              | (no arg; --slug optional)                          | ApprovalRow: `{ slug, workstream, reason, requestedBy, status, decidedBy, decidedAt, createdAt }` | CHG: JSON: `slug` → `name`, `workstream` → `workstreamName` |
| `approve list`             | `slug`, `workstream`, `status`, `requested_by`, `decided_by`, `reason`, `created` cols | array of ApprovalRow | CHG: rename `slug` col → `name`; JSON: same rename as `add` |
| `approve grant <slug>`     | `<slug>` arg                                       | ApprovalRow                                      | CHG: `<name>` arg; JSON rename                                  |
| `approve deny <slug>`      | same                                               | ApprovalRow                                      | CHG: same                                                       |
| `approve wait <slug>`      | same                                               | ApprovalRow                                      | CHG: same                                                       |

### workstream namespace (`mu workstream ...`)

| verb                  | current human label                            | current JSON key(s)                                                   | recommendation                                                        |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `workstream init <name>` | `<name>` arg ✓                              | `{ workstream: name, ... }`                                           | OK arg; CHG: top-level `workstream` field → `workstreamName`          |
| `workstream list`     | `name`, `tmux`, `agents`, `tasks`, `edges`, `notes` cols | array of WorkstreamSummary: `{ workstream, tmuxSession, tmuxAlive, agents, tasks, notes, edges, workspaces, registered }` | OK cols; CHG JSON: `workstream` → `name`; `agents`/`tasks`/`notes`/`edges`/`workspaces` → `agentCount`/`taskCount`/... (the integer-count semantics need the suffix; today the bare `agents` reads like an array of agent rows, which it isn't) |
| `workstream destroy`  | (no arg, -w resolves)                          | `{ workstream, destroyed, ..., summary, snapshotId? }`                | CHG: `workstream` → `workstreamName`                                  |
| `workstream export`   | (no arg)                                       | `{ workstream, outDir, written, deletedPreserved, manifest }`         | CHG: `workstream` → `workstreamName`                                  |

### log namespace (`mu log ...`)

| verb         | current human label                            | current JSON key(s)                                | recommendation                                                  |
| ------------ | ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `log [text]` | (read or write, --tail / --since / --source / --kind / --as) | array of LogRow: `{ seq, workstream, source, kind, payload, createdAt }` | CHG JSON: `workstream` → `workstreamName`. `seq` keeps its name (it IS the operator-facing cursor for `--since SEQ`). |

### snapshot namespace (`mu snapshot ...` and `mu undo`)

| verb                  | current human label                            | current JSON key(s)                                       | recommendation                                                         |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `snapshot list`       | `id`, `label`, `workstream`, `created_at`, `size` cols | array of `SnapshotRow & { sizeBytes }`            | KEEP `id` (snapshot ids ARE operator-facing — `mu undo --to <id>`); CHG: `workstream` → `workstreamName`. Snapshot ids are the one place the operator IS asked to type a number, by design. |
| `snapshot show <id>`  | `<id>` arg                                     | `SnapshotRow & { sizeBytes }`                             | KEEP `<id>` arg + JSON `id`; CHG: `workstream` → `workstreamName`      |
| `undo [--to <id>]`    | `--to <id>`                                    | `{ restored, snapshot: SnapshotRow, restoredTo, schemaVersion, reconcile, nextSteps }` | KEEP `--to <id>` (snapshot ids); CHG inside snapshot: `workstream` → `workstreamName` |

### state / hud / sql / doctor / whoami

| verb        | current human label    | current JSON key(s)                                                                        | recommendation                                                              |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `state`     | (composite render)     | `{ workstream, agents, orphans, tracks, ready, blocked, in_progress, recent_closed, ... }` | CHG: top-level `workstream` → `workstreamName`; rename child rows transitively (agents, tasks) |
| `hud`       | (composite render)     | `{ workstream, summary, agents, orphans, tracks, ready, inProgress, recent }`              | CHG: top-level `workstream` → `workstreamName`; child rows inherit rename   |
| `sql`       | (passthrough)          | (raw row shape — caller's SELECT decides)                                                  | N/A. `mu sql` is the escape hatch; column names are SQL-level and untouched. |
| `doctor`    | (composite render)     | `{ environment, db, workstream: { current }, state: { workstream, ..., reconcile } }`      | CHG: `workstream.current` → `workstream.currentName`; nested `state.workstream` → `state.workstreamName` |
| `whoami`    | (resolved agent + tasks) | `{ agent, ownedTasks }`                                                                  | CHG: agent + ownedTasks rows inherit their rename                           |

---

## JSON keys cleanup table (from note #409 addendum)

The wholesale rename, no compat. This is the canonical source for
`output_json_keys_rename_v5`.

```
TaskRow       v4-shape: { localId, workstream, title, status, impact,
                          effortDays, owner, createdAt, updatedAt }
              v5-clean: { name,    workstreamName, title, status, impact,
                          effortDays, ownerName | null, createdAt, updatedAt }
                          ^^^^                ^^^^         ^^^^^^^^^

TaskNoteRow   v4-shape: { id, taskId, author, content, createdAt }
              v5-clean: { author, content, createdAt }
                          ^drop id (autoincrement = internal)
                          ^drop taskId (caller already knows which task)

AgentRow      v4-shape: { name, workstream, cli, paneId, status, role,
                          tab, createdAt, updatedAt }
              v5-clean: { name, workstreamName, cli, paneId, status, role,
                          tab, createdAt, updatedAt }
                                ^^^^^^^^^^^^^

WorkspaceRow  v4-shape: { agent, workstream, backend, path, parentRef,
                          createdAt, commitsBehindMain? }
              v5-clean: { agentName, workstreamName, backend, path, parentRef,
                          createdAt, commitsBehindMain? }
                          ^^^^^^^^^  ^^^^^^^^^^^^^

ApprovalRow   v4-shape: { slug, workstream, reason, requestedBy, status,
                          decidedBy, decidedAt, createdAt }
              v5-clean: { name, workstreamName, reason, requestedBy, status,
                          decidedBy, decidedAt, createdAt }
                          ^^^^  ^^^^^^^^^^^^^

WorkstreamSummary
              v4-shape: { workstream, tmuxSession, tmuxAlive, agents, tasks,
                          notes, edges, workspaces, registered }
              v5-clean: { name, tmuxSession, tmuxAlive, agentCount, taskCount,
                          noteCount, edgeCount, workspaceCount, registered }
                          ^^^^                  ^^^^^^^^^^  ^^^^^^^^^  ...
                          (the bare integer counts gain a *Count suffix —
                          today `agents: 3` looks like a typo'd array)

LogRow        v4-shape: { seq, workstream, source, kind, payload, createdAt }
              v5-clean: { seq, workstreamName, source, kind, payload, createdAt }
                                ^^^^^^^^^^^^^
                          (seq stays — it IS the operator-facing cursor for
                          `--since SEQ` and never goes away)

SnapshotRow   v4-shape: { id, workstream, label, dbPath, schemaVersion, createdAt }
              v5-clean: { id, workstreamName, label, dbPath, schemaVersion, createdAt }
                          ^id stays (snapshot id IS operator-facing in `mu undo --to <id>`)
                          ^^^^^^^^^^^^^^

Top-level wrapper objects (composite verbs): every bare `workstream:
"name"` becomes `workstreamName: "name"` for symmetry.
```

### Why no `id` rename for snapshots

Snapshot ids are the one entity where mu DOES expose the surrogate to
the operator on purpose: `mu undo --to <id>`, `mu snapshot show <id>`.
Snapshots have no human-meaningful name (the `label` is descriptive
prose, not a stable identifier). Keep `id`. Same logic protects
`LogRow.seq` (the cursor for `--since SEQ`) and `TaskNoteRow.id` is
the one we DROP because callers reach notes via `mu task notes <task>`
not via the autoincrement.

---

## Breaking changes — what lands in CHANGELOG `[Unreleased]` / Breaking

The implementation tasks (Phase 2 + Phase 3) will introduce the
following breaking changes. Captured here so the audit doc itself
serves as the migration plan.

### From `output_json_keys_rename_v5` (Phase 2)

> **`--json` shape rewritten end-to-end (post-v5 cleanup).** Every
> entity row emitted via `--json` underwent a wholesale key rename
> to align with the v5 schema's name-vs-surrogate-id split. No
> compat layer; no `--json-shape v4` flag. mu is pre-1.0 with no
> external `jq`-script consumer base, and v5 is the right moment to
> burn the v4 nostalgia. Per `output_id_vs_name_audit` /
> [docs/OUTPUT_LABELS_AUDIT.md](docs/OUTPUT_LABELS_AUDIT.md). Rename
> table:
>
> - **TaskRow:** `localId` → `name`; `workstream` → `workstreamName`;
>   `owner` → `ownerName`.
> - **TaskNoteRow:** drop `id` and `taskId` (both internal);
>   shape becomes `{ author, content, createdAt }`.
> - **AgentRow:** `workstream` → `workstreamName`.
> - **WorkspaceRow:** `agent` → `agentName`; `workstream` →
>   `workstreamName`.
> - **ApprovalRow:** `slug` → `name`; `workstream` → `workstreamName`.
> - **WorkstreamSummary:** `workstream` → `name`; bare counts
>   `agents` / `tasks` / `notes` / `edges` / `workspaces` →
>   `agentCount` / `taskCount` / `noteCount` / `edgeCount` /
>   `workspaceCount`.
> - **LogRow:** `workstream` → `workstreamName`.
> - **SnapshotRow:** `workstream` → `workstreamName`. `id` stays
>   (snapshot ids ARE operator-facing in `mu undo --to <id>`).
> - **Top-level wrapper objects** (composite verbs `state`, `hud`,
>   `doctor`, `workspace orphans`, etc.): every bare `workstream:
>   "name"` field becomes `workstreamName: "name"`.
>
> **Migration recipes (jq):**
>
> ```bash
> # tasks
> jq '.localId'                  →   jq '.name'
> jq '.[] | .localId'            →   jq '.[] | .name'
> jq '.[] | .workstream'         →   jq '.[] | .workstreamName'
> jq 'select(.owner == "foo")'   →   jq 'select(.ownerName == "foo")'
>
> # workstreams
> jq '.[] | .workstream'         →   jq '.[] | .name'
> jq '.[] | .agents'             →   jq '.[] | .agentCount'
>
> # workspaces
> jq '.[] | .agent'              →   jq '.[] | .agentName'
>
> # approvals
> jq '.slug'                     →   jq '.name'
>
> # logs
> jq '.[] | .workstream'         →   jq '.[] | .workstreamName'
> ```

### From `output_labels_human_rename` (Phase 2 — non-breaking subset)

> **CLI table column headers renamed (`output_labels_human_rename`).**
> Cosmetic alignment with the v5 mental model. Affects:
> `mu task list / next / ready / blocked / goals / owned-by /
> search / my-tasks / my-next` — column header `id` renamed to
> `name`. `mu approve list` — column header `slug` renamed to
> `name`. JSON keys are unchanged by this commit (the JSON rename
> is a separate, breaking commit; see `output_json_keys_rename_v5`).
> Help text in `--help` output still uses `<id>` / `<slug>` until
> the qualified-ref work in `verb_arg_qualified_workstream_name`
> normalises every entity-arg to `<name>` simultaneously.

### From `verb_arg_qualified_workstream_name` (Phase 3)

> **CLI accepts `<workstream>/<name>` qualified entity refs
> (`verb_arg_qualified_workstream_name`).** Every verb that takes
> a task / agent / approval name now accepts EITHER a bare name
> (resolved via the current workstream context, today's behaviour)
> OR a qualified `<workstream>/<name>` string that resolves
> directly without `-w`. Exit code unchanged when the qualified
> form references a missing workstream (`WorkstreamNotFoundError` →
> exit 3, same map as today). Cross-workstream peeks like `mu task
> show roadmap-v0-2/snap_dogfood` no longer require `MU_SESSION` /
> `-w` rebinding. Implementation: a tiny parse-at-CLI-entry helper
> in `src/cli.ts`. Surrogate INTEGER ids remain inaccessible from
> the CLI surface (anti-feature pledge).

---

## What this audit explicitly does NOT do

- Does not rename anything in this commit. Every rename ships in one
  of the three follow-up tasks.
- Does not expose surrogate INTEGER ids on the CLI or in `--json`.
  Snapshot `id` and Log `seq` stay because they were ALWAYS
  operator-facing (the v5 schema didn't change them); they aren't
  surrogate-PK leaks.
- Does not add a `--json-shape v4` compat flag, dual-emit `localId`
  + `name`, or a `_meta` rename hint block. Anti-feature pledges
  (per ROADMAP.md "Anti-feature pledges").
- Does not fuzzy-match (`mu task show des*`). Two name forms only:
  bare and qualified.
- Does not touch `mu sql` output. `mu sql` is the escape hatch;
  column names there are whatever the user's SELECT clause produces.

---

## Sequencing recommendation

1. **`output_labels_human_rename`** first (smallest, non-breaking,
   highest signal-to-noise; ships the visible polish).
2. **`output_json_keys_rename_v5`** next (medium-large; breaks any
   external `jq` script but ships the deeper convention; CHANGELOG
   migration recipes are the user-facing artifact).
3. **`verb_arg_qualified_workstream_name`** can ship before, after,
   or interleaved with the rename — orthogonal substrate. Probably
   ships last so the help text it touches uses the renamed `<name>`
   convention from step 1 already.

Total estimated effort across the three: **~1.7d** (per note #409
revised estimate). Each phase is its own task; they ship independently.

---

## Why this is worth doing

1. The post-v5 mental model is "operators talk in names, mu resolves
   to surrogate ids internally". The CLI surface should match.
2. Cross-workstream operations (`mu task show roadmap-v0-2/<name>`
   from inside a different mu session) is real friction we hit this
   session — required `MU_SESSION` rebinding just to peek.
3. AGENTS.md / SKILL.md inconsistency ("task `<id>`" vs "agent
   `<name>`") goes away.
4. The deferred `nit_no_task_move_verb` becomes free once qualified
   refs land (`mu task move <wsA>/<name> --to <wsB>`).
5. mu is pre-1.0; the moment to clean the JSON shape is now, before a
   third-party `jq`-script base accumulates.
