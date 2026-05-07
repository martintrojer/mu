# Plan — design rationale for unbuilt features

> **For what shipped, see [CHANGELOG.md](../CHANGELOG.md).**
> **For what's next with promotion criteria, see [ROADMAP.md](ROADMAP.md).**
>
> This document is the design rationale for features still on the
> roadmap. It captures the "why" so future implementation doesn't
> have to re-derive decisions. Sections describing already-shipped
> features have been moved to canonical docs:
>
> - Vision / pillars → [VISION.md](VISION.md)
> - Architecture / data flow → [ARCHITECTURE.md](ARCHITECTURE.md)
> - Vocabulary / naming → [VOCABULARY.md](VOCABULARY.md)
> - Tmux protocol → `src/tmux.ts` (canonical implementation)
> - Reconciliation → `src/reconcile.ts` (canonical implementation)


Terminology (*workstream*, *agent*, *task DAG*, *track*, *claim*,
*free*, *workspace*, *substrate*, ...) is canonical — see
[VOCABULARY.md](VOCABULARY.md). If anything here uses a term not
defined there, fix this doc.

---

## 1. Positioning

Why mu exists in a world that already has pi-subagents and prior
internal multi-agent runtimes.

### vs `pi-subagents`

`pi-subagents` is excellent at **focused, one-shot delegation**: send
a specialist a task, get a result back, synthesize. Its substrate is
`pi --resume` subprocesses + result-file watchers; children are pi
sessions; recursion is blocked by safety policy.

`mu` is for **persistent crews of pi agents** that you keep talking
to and that you can attach to with `tmux a` to watch live. Different
substrate (tmux panes), different identity model (named, persistent,
reassignable), different coordination model (peers sharing a SQLite
registry + task graph), drivable from
outside pi.

The two are **complementary**. A pi session can install both. They
share the agent-frontmatter format so an agent file written for one
mostly works in the other.

### vs prior internal runtimes

Mu's architectural inspiration is a prior internal multi-agent
runtime (Rust; tightly coupled to a deep stack of internal deps
like a custom VFS, an internal RPC layer, and a JS-plugin host).
Mu adopts the *patterns* — the agent-trait shape, the task-graph
crate, the checkout-management surface, the per-CLI status
detection — without inheriting any of those dependencies or the
parent-child orchestration assumptions.

---

## 2. Three rules that keep the layered design honest

The pi extension is the only future caller currently anticipated
(the JS DSL is rejected; see [§ 8](#8-rejected-ideas) and
[ROADMAP.md "Explicitly rejected"](ROADMAP.md#explicitly-rejected-wont-ship-without-a-strong-new-argument)).
When / if the extension lands these stay non-negotiable:

1. **The DB is canonical.** All state in `<state-dir>/mu.db`.
   Extension reads/writes it through the same modules the CLI uses.
   No extension-only state.
2. **Every operation works from the CLI.** No tool registered in the
   extension has logic that doesn't exist in the CLI. The extension
   is a typed/integrated facade.
3. **The skill teaches the CLI.** Pi sessions without the extension
   still get a working mu by following [the bundled
   skill](../skills/mu/SKILL.md).

If those three rules hold, mu stays driveable from a shell forever
and the extension stays thin.

---

## 3. Deferred schema additions

The 0.1.0 schema (workstreams, agents, tasks, task_edges,
task_notes, vcs_workspaces, agent_logs, approvals + ready/blocked/
goals views; documented in [CHANGELOG.md](../CHANGELOG.md)) is the
foundation. Future tables all depend on it.

### `agent_logs` — broadcast channel (shipped)

```sql
CREATE TABLE agent_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workstream  TEXT NOT NULL REFERENCES workstreams(name) ON DELETE CASCADE,
    from_agent  TEXT NOT NULL,
    to_agent    TEXT,                              -- NULL = broadcast
    re          INTEGER REFERENCES agent_logs(id), -- correlation
    kind        TEXT NOT NULL DEFAULT 'message',   -- message|question|
                                                   --   discovery|blocker|
                                                   --   complete|heartbeat
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_agent_logs_to ON agent_logs (to_agent, id);
CREATE INDEX idx_agent_logs_workstream ON agent_logs (workstream, id);
```

Cursor-based reads (`mu log --since <seq>`) plus a blocking tail
(`mu log --tail`) for live streaming. Pi-extension wakeups subscribe
to `--tail`. **NOT for operational tracing** — that goes to a
separate file log (NDJSON in `<state-dir>/logs/`) so we don't
pollute the LLM-visible message channel with mu's internals.

### `vcs_workspaces` — per-agent VCS isolation (shipped)

```sql
CREATE TABLE vcs_workspaces (
    id                       TEXT PRIMARY KEY,
    vcs                      TEXT NOT NULL,        -- jj|sapling|git|none
    repo_root                TEXT NOT NULL,
    workspace_path           TEXT NOT NULL,
    branch_or_workspace_name TEXT,
    base_commit              TEXT,
    synthetic_paths          TEXT NOT NULL DEFAULT '[]',  -- JSON array
    created_at               TEXT NOT NULL
);
```

`agents` gets a nullable `workspace_id TEXT REFERENCES
vcs_workspaces(id) ON DELETE SET NULL`.

### `snapshots` — undo/redo (deferred)

```sql
CREATE TABLE snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,            -- operation name + args
    db_path     TEXT NOT NULL,            -- file path under <state-dir>/snapshots/
    created_at  TEXT NOT NULL
);
```

Auto-snapshot before every mutation; `mu undo` pops the latest, `mu
redo` re-applies. Snapshot files live under
`<state-dir>/snapshots/<workstream>/<ts>.sql`.

### `task_artifacts` — generalized "this task produced X" (deferred)

```sql
CREATE TABLE task_artifacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(local_id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,            -- pr|file|url|commit|image
    ref         TEXT NOT NULL,
    label       TEXT,
    created_at  TEXT NOT NULL
);
```

`mu task artifact add <task> --kind pr <url>`. Surfaces in `mu task
show` and a future `tasks_v` enriched view.

---

## 4. ~~The DSL: JavaScript via `vm`~~ — cancelled

This section preserves design rationale for why mu does NOT have
a JS DSL. The DSL was considered as the answer to "scriptable
orchestration" and dropped once `--json` on every read verb closed
that gap without a sandbox.

An internal critique sharpened the case against:

> "DSLs are bad when they are a second CLI language. Most custom
> verbs should collapse into inspectable resources plus typed
> actions."

and:

> "A workflow DSL that becomes 'programming the runtime' is a
> liability. The kernel can provide workflow substrate without
> owning workflow language."

What ships instead:

- **`--json` on every read verb** — pipes through `jq` for query/
  filter/projection without a sandbox.
- **Typed verbs that already are the SDK** — every CLI verb is a
  thin wrapper over a typed function in `src/*.ts`. In-process
  callers (the future pi extension) import the SDK directly; no
  parallel typed surface to maintain.
- **bash composition** — `for x in worker-1 worker-2; do mu agent
  spawn $x --workspace; done` covers the loop story without a
  workflow engine.

### What replaced the individual DSL features

| Original DSL feature                          | Shipped substitute                                      |
| --------------------------------------------- | ------------------------------------------------------- |
| `mu run script.ts` (transactional script)     | `bash + jq + --json`; SDK in-proc for typed callers     |
| `mu eval`                                     | `mu sql` for raw queries; `bash -c` for actions         |
| `mu repl`                                     | `node` + `import("mu-agent")` for in-proc exploration   |
| `mu.create / spawn / claim / send / ...`      | `mu task add / agent spawn / task claim / agent send`   |
| `mu.ready()` / `mu.parallelTracks()`          | `mu task ready --json` / bare `mu --json` / `mu state --json` |
| Forward refs via deferred string IDs          | Add tasks in topological order, or use `mu task block` after-the-fact |
| Atomic transactions wrapping a script         | Per-verb transactions in the SDK; idempotent verbs      |
| `mu.step()` replay cache                      | Not built; if needed, build on top of `agent_logs` event seq |

Original API content (entry points, the `mu` global with ~20
functions, sandbox properties, `mu.step()` replay cache) is
deliberately removed from this doc. See git history (commit
`c16d1cb` and earlier) if you ever need to resurrect details.
## 5. ~~VCS abstraction~~ — shipped

`VcsBackend` trait, four impls. Auto-detect by walking up from `cwd`
and stopping at the first marker found, in this order:

| Order | Marker     | Backend  | Why first?                                       |
| ----- | ---------- | -------- | ------------------------------------------------ |
| 1     | `.jj/`     | jj       | jj-on-git is common; jj's workspaces strictly better than git's worktrees |
| 2     | `.sl/`     | sapling  | sl-on-git is common at certain orgs              |
| 3     | `.hg/`     | hg → sl  | Aliased to sapling                               |
| 4     | `.git/`    | git      | Falls through to git only when nothing else      |
| 5     | (none)     | none     | `cp -a` fallback with loud warning               |

```typescript
interface VcsBackend {
  name: "git" | "sapling" | "jj" | "none";
  detect(cwd: string): string | null;
  requiresCleanWorkingCopy(): boolean;   // git: yes, sl/jj: no
  createWorkspace(opts: CreateOpts): Promise<WorkspaceHandle>;
  removeWorkspace(handle: WorkspaceHandle): Promise<void>;
  diff(handle: WorkspaceHandle): Promise<{ patch: string; stat: DiffStat }>;
  freeWorkspace(opts: FreeOpts): Promise<FreeResult>;
}

interface FreeResult {                     // granular per-step result
  dirtyCount: number;
  committed: boolean;
  submitted: boolean;
  commit?: string;
  diff?: string;
  commitError?: string;                    // independent of submitError
  submitError?: string;
}
```

### Concrete impls

| VCS     | Create                                                          | Remove                                  | Clean tree |
| ------- | --------------------------------------------------------------- | --------------------------------------- | ---------- |
| jj      | `jj workspace add --name <name> <path>`                         | `jj workspace forget <name>`            | no         |
| sapling | `sl worktree add <path> --config worktree.enabled=true`         | `sl worktree remove <path>`             | no         |
| git     | `git worktree add <path> -b mu-<runId>-<idx> HEAD`              | `git worktree remove --force` + `git branch -D` | yes |
| none    | `cp -a <repoRoot> <path>`                                       | `rm -rf <path>`                         | n/a        |

### Setup-hook protocol

Cribbed verbatim from pi-subagents' `worktreeSetupHook`. JSON in /
JSON out, with `vcs` field added so hooks can adapt:

```json
// stdin
{
  "version": 1,
  "vcs": "jj",
  "repoRoot": "/home/me/code/repo",
  "workspacePath": "/tmp/mu-workspace-abc-0",
  "agentCwd": "/tmp/mu-workspace-abc-0/services/auth",
  "branch": "mu-abc-0",
  "index": 0,
  "runId": "abc",
  "baseCommit": "deadbeef",
  "agent": "worker-1"
}

// stdout
{
  "syntheticPaths": ["node_modules", "build/", ".env"]
}
```

### Submit guard (steal from `summon`)

`timeout -k 5s {N}s sh -c 'exec jf submit --draft </dev/null'` to
prevent hanging on TTY prompts. Independent
`commitError`/`submitError` fields so the UI can surface "committed
but not submitted" cleanly.

---

## 6. Per-CLI status detection beyond pi — not currently planned

0.1.0 ships `detectPiStatus()` for pi only (in `src/detect.ts`).
The original plan was to turn this into a `Detector` registry
keyed by CLI name (~50 LOC per CLI), but the multi-CLI pretense
was dropped — mu is a pi orchestrator. The `--cli <name>` flag
stays in the code as a binary-resolver mechanism (so
`MU_PI_COMMAND=pi-alt` works) but the docs no longer claim other
CLIs are supported. The pattern table below remains as a sketch
for the day mu re-earns multi-CLI support via real friction reports.

Patterns ported from a prior internal multi-agent runtime's per-CLI detector:

| CLI      | Busy patterns                              | Permission patterns                                       |
| -------- | ------------------------------------------ | --------------------------------------------------------- |
| Claude   | `to interrupt`, `\(.*[↑↓].*tokens\)`       | `Allow once`, `Allow for this session`, `Esc to cancel`   |
| Codex    | `esc to interrupt)`, `to cancel`           | `enter to confirm`, `enter to submit \| esc to cancel`    |
| Pi       | (well-known mu-defined marker)             | (well-known mu-defined marker) — shipped                  |

### Critical subtleties to keep

- **Tail-window extraction**: take last ~100 lines, strip trailing
  blanks, then take last ~20. Prevents stale scrollback
  false-positives. Already implemented for pi in `src/detect.ts`;
  the registry version factors this out.
- **Permission detection uses a narrower window than busy
  detection** — prevents already-answered prompts triggering
  re-detection.
- **Permission patterns override busy** — if a permission prompt is
  visible, agent is `NeedsPermission`, not `Busy`.

---

## 7. Operational lessons we are stealing

Each of these is a real failure mode pi-subagents or a prior
internal multi-agent runtime has already fixed. Lifting them lets
us avoid the same bug-discovery curve.

### From pi-subagents (`src/runs/shared/`)

| File                       | Lesson                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `frontmatter.ts`           | Agent-frontmatter parser: 28 lines, handles CRLF, quoted values, kebab-case. Port verbatim. |
| `long-running-guard.ts`    | Mutating-bash detection via regex + unquoted-redirection scanner. Don't trust tool names; scan command bodies. |
| `long-running-guard.ts`    | Mutating-failure burst detection: rolling window, consecutive vs same-path failures, escalation threshold. |
| `completion-guard.ts`      | Expected-mutation detection from task prose, not agent role. Strips framework-injected lines before checking. |
| `model-fallback.ts`        | Curated regex list of retryable failures (rate limit, 429, quota, 502/503/504). Don't waste a fallback on auth errors. |
| `model-fallback.ts`        | `splitThinkingSuffix` always splits on **last** colon — preserves `provider/model:high`. |
| `single-output.ts`         | Three cases for output files: agent wrote it, agent didn't, file unreadable. `captureSingleOutputSnapshot` before run to disambiguate. |
| `worktree.ts`              | `node_modules` symlinking + tracking as synthetic-path. Generic across VCS. |
| `worktree.ts`              | Per-task `cwd:` conflict detection. Best-effort rollback on hook failure. |
| `result-watcher.ts`        | `fs.watch` with mandatory polling fallback on `EMFILE`/`ENOSPC`. `unref()` timers. Coalescer for rapid rename events. |
| `pi-args.ts`               | Long tasks → temp file + `@path` argv. System prompt via `mode: 0o600` temp file. Identity env vars passed down. |
| `extension/doctor.ts`      | `lineFromCheck(label, fn)` wrapper turns thrown errors into `failed — <text>` lines so one broken probe doesn't break the report. |

### From a prior internal multi-agent runtime

| Topic                                           | Lesson                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| shell-escape                                    | `shell_escape` via single-quote wrapping.                    |
| granular workspace-free results                 | A `WorkspaceFreeResult` with independent `committed`/`submitted`/`commitError`/`submitError`. |
| submit guard                                    | `timeout -k 5s {N}s sh -c 'exec jf submit --draft </dev/null'` to prevent hanging on TTY prompts. |
| per-CLI detector                                | Per-CLI Detector trait + pattern registry. Tail-window + narrow-window distinction. (deferred; pi only today.) |
| lifecycle state machine                         | Side-effect-free lifecycle state machine: `(state, event) → outcome`. Single point for tracing. Distinguishes manual `Free` from inferred idle. |
| read-list reconciliation                        | "Reality wins": every `list()` queries the substrate, prunes ghosts, adopts orphans. **Implemented (`src/reconcile.ts`).** |
| parallel-tracks                                 | Parallel-tracks union-find with diamond-merge. **Implemented (`src/tracks.ts`).** |
| built-in graph views                            | Built-in views: `ready`, `blocked`, `goals`. **Implemented.** |
| pane-title-as-identity                          | Pane-title-as-identity for the claim protocol. **Implemented.** |
| lisp DSL (rejected for mu, ideas not adopted)   | Atomic transactions are per-verb in the SDK; idempotent re-imports work via `INSERT OR IGNORE` + idempotent verbs; forward-ref checking handled at task-add time. JS DSL also rejected (see § 4). |
| notes model                                     | Append-only, FILES/DECISION/VERIFIED conventions. **Implemented.** |

---

## 8. Rejected ideas

Each rejected option, with the reason, so we don't relitigate later.

### Rejected: build mu as a pure pi extension (no CLI)

Why it's tempting: simpler distribution, one install, full access to
pi's `ExtensionAPI` for HUD and events.

Why we rejected:

- Children spawned by mu can't drive mu without re-loading the
  extension
- Humans can't `mu agent list` from a shell to debug
- Recursion requires special plumbing
- Couples mu to pi's release cycle and extension API
- Throws away the "any process can drive this" property

### Rejected: build mu as a library that pi imports (no standalone CLI)

Why it's tempting: zero subprocess overhead.

Why we rejected:

- Multiple pi instances would each load the library and fight over
  the DB
- A standalone CLI on `$PATH` is the cleanest "shared resource" model
- The library/CLI split is well-trodden — every good tool ships
  both, and the CLI is canonical

### Rejected: two binaries, `mu-agents` and `mu-tasks`

Why it's tempting: cleaner separation of concerns.

Why we rejected:

- Agent ↔ task integration (claim, owner field, agent_logs about
  tasks) needs them in one transactional surface
- One install, one mental model, one `mu doctor`
- A prior internal precedent of separating task-graph and
  agent-runtime crates created awkward join logic; mu collapsing
  them is a feature

### Rejected: any orchestration DSL (Lisp like tg, JS-via-vm we initially planned, anything else)

Why it's tempting: atomicity-as-syntax (parens), forward refs as a
parser feature, LLMs reliably emit structured code.

Why we rejected (twice):

- **First-pass rejection (Lisp)**: we have a JS engine by
  definition; inventing a syntax was unjustified.
- **Second-pass rejection (JS-via-vm)**: the gap a DSL fills is
  "compose multiple verbs into one transactional script." `--json`
  on every read verb plus typed verbs that accept evidence arguments
  cover that without a sandbox, codegen, `.d.ts` shipping, or a
  parallel typed surface to maintain.
- **Independent corroboration from an internal critique**:
  five orthogonal reviewers (architect, engineer, model-UX,
  thin-harness advocate, operator) all flagged DSL/workflow
  language as the worst maintenance liability of the prior
  internal runtime. "A workflow DSL that becomes 'programming
  the runtime' is a liability."
- The `vm` sandbox would have to be maintained against Node's
  security model forever; a non-trivial commitment for a feature
  with no proven friction.
- bash composition over `mu --json | jq` covers what real users do.

### Rejected: `TaskSurface` adapter abstraction with multiple backends (tg, GitHub Issues, Linear, ...)

Why it's tempting: composability, "bring your own work tracker."

Why we rejected:

- mu without a built-in task graph is just a fancier agent runner
  — the killer features (parallel tracks, claim, ROI
  prioritization) require a graph
- Adapter complexity for systems most users don't have
- Round-tripping inverts the model: mu's task graph is local and
  authoritative

### Rejected: cross-machine state sync

Local-first SQLite. Layer something like syncthing on top if you
want it. Multi-machine sync would force a server, conflict
resolution, identity, auth — every one of those breaks the "zero
ops" pledge.

### Rejected: HTTP API on top of the SQLite registry

mu is a CLI; if you need RPC, write it. The schema is small and
stable enough.

### Rejected: a "hosted" mu

Zero ops, no accounts. Your machine is the deployment.

### Rejected: plugin system / `defineOperation()` registry / web UI / Thrift / chat & docs integrations / memory system / workflow engine

Not "rejected one at a time" — rejected as a class. An internal
critique established that the prior internal runtime's accumulation
of these adjacent product identities was its central design
failure: "hidden state, lifecycle bugs, unclear ownership of
truth, and high model-facing tool entropy."

mu's anti-feature pledges (no plugin runtime, no codegen, no
daemon, no web UI, no chat integration, no memory system, no
workflow engine) are specifically the accumulations of that prior
internal runtime that mu chose not to inherit. Each one is
provable as the absence of a subsystem mu was tempted to copy.

The pi extension is the one anticipated future caller; even that
is required to be a thin facade over the same SDK the CLI uses
(see [§ 2](#2-three-rules-that-keep-the-layered-design-honest)).

---

## 9. Open questions

These were live during initial design and remain partly unresolved.
Listed so we don't pretend they're settled.

- **`agents.cli` as TEXT vs enum.** Went with TEXT (originally for
  heterogeneous-CLI forward-compat). Today the only meaningful
  value is `pi`. We're keeping it TEXT — if multi-CLI re-earns its
  way back, the column doesn't need a schema migration.
- **Composite `(workstream, local_id)` PK on tasks.** Currently
  `local_id` is global PK. Two workstreams can't both have a
  `design` task. Recorded as a deferred normalization in
  [ROADMAP.md](ROADMAP.md#schema-normalization-deferred-from-the-initial-audit).
- **Capability tags on operations.** The `defineOperation()`
  registry that would have carried these is rejected. The role
  flag on agents is stored but unenforced. The internal critique
  flagged "capability-gated mutations" as part of the minimal core;
  for now mu's only authorization surface is "the agent ran the
  verb." Earn capability enforcement when an agent actually does
  damage.
- **Per-workstream config.** Resisted (the anti-feature pledge).
  "This workstream uses one pi binary, that one uses another" is
  a real gap that env vars don't solve cleanly. Revisit when the
  second user hits it.
- **Subscription-based wakeups.** `mu log --tail` and `mu approve
  wait` poll SQLite once per second. Real subscriptions (SQLite
  update hooks via better-sqlite3, or fs.watch on the WAL) would
  drop latency at the cost of more machinery. Not worth it until
  someone hits the cliff.

---

## 10. Documents to write

Meta-docs the project still needs:

- **CONTRIBUTING.md** — once external PRs land. Contains the LOC
  caps, the lint rules, the "no traits with zero implementors"
  rule, the test-first conventions.
- **MIGRATIONS.md** — when the schema gains a `schema_version`
  table and the first non-additive migration ships.
