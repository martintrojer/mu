# Roadmap

What's coming after [0.1.0](../CHANGELOG.md). Each item lives at
a tentative target and carries its own **promotion criteria** —
the bar it has to clear before we actually build it.

This file is the **single forward-looking doc**. If a feature isn't
listed here, it isn't planned. If it's listed but unbuilt, see its
promotion criteria for what would move it.

For the design rationale behind individual deferred items, see
[PLAN.md](PLAN.md). For canonical terms, see
[VOCABULARY.md](VOCABULARY.md). For pillars that must not bend, see
[VISION.md](VISION.md).

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
  (see [PLAN.md §2](PLAN.md#2-three-rules-that-keep-the-layered-design-honest)).
- Add a plugin runtime, a web UI, an RPC layer, a chat or docs
  integration, a memory system, or a workflow engine. (These are
  the kinds of accumulated subsystems the council critique flagged
  as costing more than they pay for. mu has none and intends to
  keep it that way.)

---

## Next — small additions that have an obvious shape

These have a clear design but haven't yet hit criterion 1 (proven
friction in ≥2 real workflows). They earn implementation when real
use surfaces them.

### Pi extension (typed `mu_*` tools, HUD widget, wakeups)

LLM-facing UX that wraps the same core operations the CLI uses.
Bundled in the same npm package; pi is a peer dep. Pillar non-
negotiable: the extension is a thin facade over the same SDK the
CLI uses.

**Source:** [PLAN.md §5](PLAN.md#5-architecture).

### `mu adopt <pane-id> [--name <agent>]`

Reconciliation already surfaces orphan panes. The `adopt` verb
formally registers one of those panes as a managed agent. Earns
when orphans become a real annoyance.

### Heterogeneous CLI status detection (claude, codex, ...)

mu is a pi orchestrator. The substrate is ready (the `cli` column
is TEXT; `MU_<UPPER_CLI>_COMMAND` resolution works for any string)
so multi-CLI can re-earn its way back if real friction surfaces.
A `Detector` registry keyed by CLI name is the obvious shape.

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

### `mu undo` / `mu redo` / `mu snapshot list`

Pop the latest snapshot; replay-on-demand for redo. List shows
timestamps + the operation that triggered each snapshot.

**Source:** [PLAN.md §6](PLAN.md#6-data-model).

---

## Stretch

Items that meet criterion 2 (no pillar bend) and 3 (small) but
haven't yet hit criterion 1 (proven friction). Stays parked until
real use surfaces them.

| Item | Source |
| --- | --- |
| `task_artifacts` table — generalised "this task produced X" (PRs, files, URLs, commits) | [PLAN.md §6](PLAN.md#6-data-model) |
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

## Explicitly rejected (won't ship without a strong new argument)

These were considered and turned down, with the reason. Listed so we
don't rediscover the same ideas every quarter.

- **JavaScript DSL (`mu run` / `mu eval` / `mu repl`).** The "I
  want to compose multiple verbs into one transactional script"
  gap is closed by `--json` on every read verb plus typed verbs
  that accept evidence arguments. The DSL would have introduced: a
  `vm` sandbox to maintain, a parallel typed surface that mirrors
  the CLI, a `defineOperation` registry feeding `.d.ts` codegen,
  and a direct violation of the "no JS engine, no codegen"
  anti-pledge. Re-earn requires repeated friction reports of "I
  keep writing the same bash" that bash + jq + `--json` couldn't
  fix.
- **`defineOperation()` registry framework.** Only consumer was
  the DSL's autocomplete. With the DSL rejected, no consumer
  remains.
- **Markdown agent-definition discovery.** Spawn already accepts
  `--cli` / `--command` / `--workspace` / `--role` directly; an
  orchestrator's first message + spawn flags ARE the agent's
  "definition." Earn back if real friction surfaces ("I'm
  copy-pasting the same role doc into five spawn invocations every
  day, twice a week").
- **Sync to GitHub Issues / Linear / Asana.** mu's task graph is
  local and authoritative; round-tripping to a remote tracker
  inverts the model. If wanted: a separate companion package, not
  core.
- **Cross-machine state sync.** Local-first SQLite. Layer something
  like syncthing on top if you want it.
- **HTTP API on top of the SQLite registry.** mu is a CLI; if you
  need RPC, write it. The schema is small and stable enough.
- **A "hosted" mu.** Zero ops, no accounts. Your machine is the
  deployment.
- **Anthropomorphic builtin agent names** (`alice`, `bob`). Use
  role-based names (`worker-1`, `reviewer-1`). See
  [VOCABULARY.md §"Naming conventions"](VOCABULARY.md#agent-names-prefer-role-n-not-human-names).

---

## How to use this roadmap

If you're starting work on an item:

1. **Confirm it still meets the three promotion criteria.** Note
   the second real-use occurrence; cite the friction.
2. **Open a focused PR per item.** One typed verb per commit, one
   schema change per commit.
3. **Update [VOCABULARY.md](VOCABULARY.md) first** if you introduce
   a new concept or rename an existing one.
4. **Keep [PLAN.md](PLAN.md) in sync** — when an item ships, delete
   its design-rationale section from PLAN.md (it lives in code now).
5. **Add a [CHANGELOG.md](../CHANGELOG.md) entry** under the
   upcoming version.

If you're considering adding a new entry to this file:

- Read AGENTS.md §"What NOT to do" first.
- Provide a concrete promotion-criteria assessment.
- Match the format of existing entries.
