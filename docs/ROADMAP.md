# Roadmap

What's coming after [0.1.0](../CHANGELOG.md), with full design
rationale per item. This is the **single forward-looking doc**: if
a feature isn't listed here, it isn't planned. If it's listed but
unbuilt, see its promotion criteria for what would move it.

For canonical terms, see [VOCABULARY.md](VOCABULARY.md). For
pillars that must not bend, see [VISION.md](VISION.md). For module
layout and data flow, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Promotion criteria (the only bar)

A roadmap item earns implementation when **all three** are true:

1. **Proven friction.** A real user (us, internal users, early
   adopters) hits the missing feature in a real workflow at least
   twice. "Imagined polish" doesn't count.
2. **No pillar refactor.** The addition fits the current substrate
   without bending any of the load-bearing pillars (see
   [VISION.md](VISION.md)).
3. **Bounded scope.** The addition fits in **<300 LOC** or has a
   clear smaller subset that does.

If an item drops below the bar (no longer has criterion 1 met after
real use), it moves to the bottom or is removed. We don't keep
phantom plans alive.

**Exception: data-loss footguns.** A change that fixes a default
that silently destroys user artifacts (uncommitted output, scratch
logs, benchmark results, etc.) ships on the **first** occurrence,
not the second. The cost of waiting for criterion 1 is "lose more
stuff"; that's the wrong cost to optimise. Document the friction
in the commit message instead.

**Polish doesn't count as promotion.** Bug fixes, ergonomic
improvements, error-message wording, doc tightening, and similar
"the existing thing works better" changes don't need promotion
criteria — they just need to be small and to ship clean (typecheck
+ lint + tests + build). Polish is the dividend the project earns
by refusing the things on this roadmap. Don't wait for occurrence
#2 to fix a typo, tighten an error message, or truncate a runaway
table column.

---

## Anti-feature pledges (still in force; reinforced by an internal critique)

We will NOT, until each one earns its way back via the criteria
above. Each pledge is a specific accumulation a prior internal
multi-agent runtime made and mu chose not to inherit; an internal
critique made the case sharply (TL;DR: that runtime's breadth had
hidden state, lifecycle bugs, unclear ownership of truth, and high
model-facing tool entropy).

- Add a configuration file. All config is CLI flags or env vars.
- Add a daemon, watcher, or background process beyond what tmux /
  SQLite give us.
- Add abstractions that exist for "future flexibility" with no
  current consumer (a prior internal LLM-runtime's `RunContext`
  trait was the cautionary tale).
- Add wrappers around wrappers (stream-of-streams wrappers we've
  seen before — `TextStream`/`TextState`/`StreamResult` shapes —
  are the cautionary tale).
- Generate code, embed a JS engine, or use any macro/decorator
  pattern beyond TypeScript itself. (Council: "A workflow DSL that
  becomes 'programming the runtime' is a liability.")
- Ship a template/definition system for agent roles. Spawn flags +
  the orchestrator's first message are the only "definition."
- Add a render layer beyond `cli-table3` + `picocolors`.
- Bundle pi. The pi extension is the only anticipated future
  caller; even that is required to be a thin facade over the SDK
  (see [§ Pi extension and the three rules](#pi-extension-and-the-three-rules)
  below).
- Add a plugin runtime, a web UI, an RPC layer, a chat or docs
  integration, a memory system, or a workflow engine. (These are
  the kinds of accumulated subsystems the council critique flagged
  as costing more than they pay for. mu has none and intends to
  keep it that way.)

---

## Possible — small additions with an obvious shape

These have a clear design but haven't yet hit criterion 1 (proven
friction in ≥2 real workflows). They earn implementation when real
use surfaces them.

The section heading is deliberately "Possible," not "Next." "Next"
implies it's coming. "Possible" doesn't. Items below ship if and
when they earn it.

### Pi extension and the three rules

The pi extension is the first "polish" tier — LLM-facing UX
(typed `mu_*` tools, HUD widget, wakeups) that wraps the same core
operations the CLI already exposes. Bundled in the same npm
package; pi is a peer dep.

The pi extension is **the only anticipated future caller**. When /
if it lands, three rules stay non-negotiable:

1. **The DB is canonical.** All state in `<state-dir>/mu.db`.
   Extension reads/writes it through the same modules the CLI uses.
   No extension-only state.
2. **Every operation works from the CLI.** No tool registered in
   the extension has logic that doesn't exist in the CLI. The
   extension is a typed/integrated facade.
3. **The skill teaches the CLI.** Pi sessions without the extension
   still get a working mu by following [the bundled
   skill](../skills/mu/SKILL.md).

If those three rules hold, mu stays driveable from a shell forever
and the extension stays thin.

### `mu adopt <pane-id> [--name <agent>]`

Reconciliation already surfaces orphan panes. The `adopt` verb
formally registers one of those panes as a managed agent. Earns
when orphans become a real annoyance.

### Heterogeneous CLI status detection (claude, codex, ...)

mu is a pi orchestrator today. The substrate is ready (the `cli`
column is TEXT; `MU_<UPPER_CLI>_COMMAND` resolution works for any
string) so multi-CLI can re-earn its way back if real friction
surfaces. A `Detector` registry keyed by CLI name (~50 LOC per
CLI) is the obvious shape.

Pattern sketch (ported from a prior internal multi-agent runtime's
per-CLI detector — kept here for whoever picks it up):

| CLI      | Busy patterns                              | Permission patterns                                       |
| -------- | ------------------------------------------ | --------------------------------------------------------- |
| Claude   | `to interrupt`, `\(.*[↑↓].*tokens\)`       | `Allow once`, `Allow for this session`, `Esc to cancel`   |
| Codex    | `esc to interrupt)`, `to cancel`           | `enter to confirm`, `enter to submit \| esc to cancel`    |
| Pi       | (well-known mu-defined marker)             | (well-known mu-defined marker) — shipped                  |

Critical subtleties any new detector must keep:

- **Tail-window extraction**: take last ~100 lines, strip trailing
  blanks, then take last ~20. Prevents stale scrollback
  false-positives. Already implemented for pi in `src/detect.ts`;
  the registry version factors this out.
- **Permission detection uses a narrower window than busy
  detection** — prevents already-answered prompts triggering
  re-detection.
- **Permission patterns override busy** — if a permission prompt
  is visible, agent is `NeedsPermission`, not `Busy`.

### `tasks_v` enriched view

```sql
CREATE VIEW tasks_v AS
SELECT t.*,
       GROUP_CONCAT(n.content, char(10) || '---' || char(10)) AS notes,
       COUNT(n.id) AS note_count,
       MAX(n.created_at) AS last_note_at
FROM tasks t
LEFT JOIN task_notes n ON n.task_id = t.local_id
GROUP BY t.local_id;
```

Earns when `mu sql` queries against tasks + notes start getting
verbose for a second consumer.

---

## Snapshots + undo

Theme: every destructive action becomes recoverable.

### `snapshots` table + auto-snapshot before mutation

Before each write op, dump the affected subtree to
`<state-dir>/snapshots/<workstream>/<ts>.sql`. Append a row to the
table.

```sql
CREATE TABLE snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,            -- operation name + args
    db_path     TEXT NOT NULL,            -- file path under <state-dir>/snapshots/
    created_at  TEXT NOT NULL
);
```

### `mu undo` / `mu redo` / `mu snapshot list`

Pop the latest snapshot; replay-on-demand for redo. List shows
timestamps + the operation that triggered each snapshot.

---

## Stretch

Items that meet criterion 2 (no pillar bend) and 3 (small) but
haven't yet hit criterion 1 (proven friction). Stays parked until
real use surfaces them.

### `task_artifacts` — generalized "this task produced X"

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

`mu task artifact add <task> --kind pr <url>`. Surfaces in `mu
task show` and a future `tasks_v` enriched view.

### Other parked items

| Item | Source / origin |
| --- | --- |
| Approval / policy rules engine — `Allow / Deny / Ask` per pattern-matched action; v2: `~/.local/state/mu/policy.json` | prior-art pattern (approvals) |
| `CancelScope` for long-running ops — Ctrl-C handling that cooperatively cancels in-flight tmux/exec calls | prior-art pattern (workflows) |
| `mu.step()` replay cache for `mu run` — re-running a partially-failed script skips already-completed steps | prior-art pattern (workflows; `SqliteWorkflowStore` shape) |
| `init_tracing(config)` + RAII guard — NDJSON to `<state-dir>/logs/`, MINUTELY rotation, last 100 files | prior-art pattern (tracing) |
| Subscription-based wakeups — `mu log --tail` and `mu approve wait` poll SQLite once per second; SQLite update hooks (via better-sqlite3) or fs.watch on the WAL would drop latency. | internal critique gap |

### Schema normalization (deferred from the initial audit)

| Item | Why not now |
| --- | --- |
| `tasks.id INTEGER PK + (workstream, local_id) UNIQUE` — split user-facing identity from row identity so two workstreams can both have a `design` task | The friction (cross-workstream task-id collisions) hasn't been reported. Touches every query. |
| Composite `(workstream, local_id) PK` without the synthetic id — simpler middle option | Same as above. |

---

## Explicitly rejected

These were considered and turned down, with the reason. Listed so
we don't rediscover the same ideas every quarter.

### JavaScript DSL (`mu run` / `mu eval` / `mu repl`)

Why it's tempting: atomicity-as-syntax, forward refs as a parser
feature, LLMs reliably emit structured code.

Why we rejected (twice — first as a Lisp like the prior runtime
used, then as JS-via-`vm`):

- The gap a DSL fills is "compose multiple verbs into one
  transactional script." `--json` on every read verb plus typed
  verbs that accept evidence arguments cover that without a
  sandbox, codegen, `.d.ts` shipping, or a parallel typed surface
  to maintain.
- **Independent corroboration from an internal critique**: five
  orthogonal reviewers (architect, engineer, model-UX,
  thin-harness advocate, operator) all flagged DSL/workflow
  language as the worst maintenance liability of the prior
  internal runtime. "A workflow DSL that becomes 'programming
  the runtime' is a liability."
- The `vm` sandbox would have to be maintained against Node's
  security model forever; a non-trivial commitment for a feature
  with no proven friction.
- bash composition over `mu --json | jq` covers what real users
  do.

What the DSL would have provided, and what ships instead:

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

Re-earn requires repeated friction reports of "I keep writing the
same bash" that bash + jq + `--json` couldn't fix.

### `defineOperation()` registry framework

The only consumer that motivated this was the JS DSL's `.d.ts`
autocomplete. With the DSL rejected, no consumer remains. The pi
extension, if/when it ships, can share types directly via
`src/index.ts` SDK exports without a registry layer. Classic case
of an abstraction with one anticipated consumer.

### Markdown agent-definition discovery

Spawn already accepts `--cli` / `--command` / `--workspace` /
`--role` directly; an orchestrator's first message + spawn flags
ARE the agent's "definition." The `agents/` directory and a
`docs/AGENT_FORMAT.md` were considered and dropped.

Earn back if real friction surfaces ("I'm copy-pasting the same
role doc into five spawn invocations every day, twice a week").

### Build mu as a pure pi extension (no CLI)

Why it's tempting: simpler distribution, one install, full access
to pi's `ExtensionAPI` for HUD and events.

Why rejected:

- Children spawned by mu can't drive mu without re-loading the
  extension.
- Humans can't `mu agent list` from a shell to debug.
- Recursion requires special plumbing.
- Couples mu to pi's release cycle and extension API.
- Throws away the "any process can drive this" property.

### Build mu as a library that pi imports (no standalone CLI)

Why it's tempting: zero subprocess overhead.

Why rejected:

- Multiple pi instances would each load the library and fight over
  the DB.
- A standalone CLI on `$PATH` is the cleanest "shared resource"
  model.
- The library/CLI split is well-trodden — every good tool ships
  both, and the CLI is canonical.

### Two binaries: `mu-agents` and `mu-tasks`

Why it's tempting: cleaner separation of concerns.

Why rejected:

- Agent ↔ task integration (claim, owner field, agent_logs about
  tasks) needs them in one transactional surface.
- One install, one mental model, one `mu doctor`.
- A prior internal precedent of separating task-graph and
  agent-runtime crates created awkward join logic; mu collapsing
  them is a feature.

### `TaskSurface` adapter abstraction with multiple backends

Sync to GitHub Issues / Linear / Asana. Why it's tempting:
composability, "bring your own work tracker."

Why rejected:

- mu without a built-in task graph is just a fancier agent runner
  — the killer features (parallel tracks, claim, ROI
  prioritization) require a graph.
- Adapter complexity for systems most users don't have.
- Round-tripping inverts the model: mu's task graph is local and
  authoritative.
- If wanted: a separate companion package, not core.

### Cross-machine state sync

Local-first SQLite. Layer something like syncthing on top if you
want it. Multi-machine sync would force a server, conflict
resolution, identity, auth — every one of those breaks the "zero
ops" pledge.

### HTTP API on top of the SQLite registry

mu is a CLI; if you need RPC, write it. The schema is small and
stable enough.

### A "hosted" mu

Zero ops, no accounts. Your machine is the deployment.

### Plugin system / web UI / RPC / chat & docs integrations / memory system / workflow engine

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

### Anthropomorphic builtin agent names (`alice`, `bob`)

Use role-based names (`worker-1`, `reviewer-1`). See
[VOCABULARY.md §"Naming conventions"](VOCABULARY.md#agent-names-prefer-role-n-not-human-names).

---

## Open questions

These were live during initial design and remain partly unresolved.
Listed so we don't pretend they're settled.

- **`agents.cli` as TEXT vs enum.** Went with TEXT (originally for
  heterogeneous-CLI forward-compat). Today the only meaningful
  value is `pi`. We're keeping it TEXT — if multi-CLI re-earns its
  way back, the column doesn't need a schema migration.
- **Composite `(workstream, local_id)` PK on tasks.** Currently
  `local_id` is global PK. Two workstreams can't both have a
  `design` task. Recorded as a deferred normalization above.
- **Capability tags on operations.** The `defineOperation()`
  registry that would have carried these is rejected. The role
  flag on agents is stored but unenforced. The internal critique
  flagged "capability-gated mutations" as part of the minimal
  core; for now mu's only authorization surface is "the agent ran
  the verb." Earn capability enforcement when an agent actually
  does damage.
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

## Operational lessons we're stealing (reference for implementers)

Each of these is a real failure mode pi-subagents or a prior
internal multi-agent runtime has already fixed. Listed here so
when one of the items above is picked up, the implementer doesn't
have to rediscover the lesson.

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
| lisp DSL (rejected for mu, ideas not adopted)   | Atomic transactions are per-verb in the SDK; idempotent re-imports work via `INSERT OR IGNORE` + idempotent verbs; forward-ref checking handled at task-add time. JS DSL also rejected (above). |
| notes model                                     | Append-only, FILES/DECISION/VERIFIED conventions. **Implemented.** |

---

## Documents still to write

Meta-docs the project will need eventually:

- **CONTRIBUTING.md** — once external PRs land. Contains the LOC
  caps, the lint rules, the "no traits with zero implementors"
  rule, the test-first conventions.
- **MIGRATIONS.md** — when the schema gains a `schema_version`
  table and the first non-additive migration ships.

---

## How to use this roadmap

If you're starting work on an item:

1. **Confirm it still meets the three promotion criteria.** Note
   the second real-use occurrence; cite the friction.
2. **Open a focused PR per item.** One typed verb per commit, one
   schema change per commit.
3. **Update [VOCABULARY.md](VOCABULARY.md) first** if you introduce
   a new concept or rename an existing one.
4. **Add a [CHANGELOG.md](../CHANGELOG.md) entry** under the
   upcoming version.

If you're considering adding a new entry to this file:

- Read AGENTS.md §"What NOT to do" first.
- Provide a concrete promotion-criteria assessment.
- Match the format of existing entries.
