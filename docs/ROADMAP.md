# Roadmap

The single forward-looking doc. If a feature isn't here, it isn't
planned.

For canonical terms see [VOCABULARY.md](VOCABULARY.md). For
load-bearing pillars see [VISION.md](VISION.md). For module
layout see [ARCHITECTURE.md](ARCHITECTURE.md). Shipped history
lives in [CHANGELOG.md](../CHANGELOG.md).

---

## Promotion criteria

A roadmap item earns implementation when **all three** are true:

1. **Proven friction.** A real user hits the missing feature in a
   real workflow at least twice. Imagined polish doesn't count.
2. **No pillar refactor.** Fits the current substrate without
   bending any pillar in [VISION.md](VISION.md).
3. **Bounded scope.** Fits in <300 LOC or has a clear smaller
   subset that does.

**Exceptions.** Data-loss footguns (silent destruction of user
artifacts) ship on the *first* occurrence. Polish — bug fixes,
ergonomic tweaks, error-message wording, doc tightening — doesn't
need promotion at all; just ship clean (typecheck + lint + tests +
build).

---

## Anti-feature pledges

We will NOT, until each one earns its way back via the criteria
above:

- **Config file.** All config is CLI flags or env vars.
- **Daemon / watcher / background process** beyond what tmux and
  SQLite give us.
- **Anticipatory abstractions** with zero current consumer (the
  cautionary tale: a `RunContext` trait with no implementor).
- **Wrappers around wrappers** (cautionary tale:
  `TextStream`/`TextState`/`StreamResult`).
- **Codegen, embedded JS engine, macros, decorators** beyond
  TypeScript itself. No workflow DSL.
- **Template/definition system for agent roles.** Spawn flags +
  the orchestrator's first message ARE the definition.
- **Render layers beyond `cli-table3` + `picocolors`**, except
  `ink` confined to `src/cli/tui/`. No second TUI stack alongside
  `ink` — if `ink` ever stops paying off, *replace* it; don't
  stack stacks.
- **Bundle pi.** It's a peer dep.
- **Plugin runtime, web UI, RPC, chat/docs integrations, memory
  system, workflow engine.** Rejected as a class — these are
  exactly the accumulations a prior internal multi-agent runtime
  collected, and not inheriting them is the point.

---

## Shipped

### Multi-machine sync (db export/import + archive restore) — shipped in v0.5.0

Shipped in v0.5.0. The design note remains here as the historical
promotion record and to make the local-first boundary explicit.

Problem: one user wants to move a workstream between two machines
(laptop ↔ devserver) over multi-day stretches without losing the task
DAG, notes, archives, or activity log. Task owners are intentionally
machine-local and are not imported. The hard operating rule
is **no concurrent edits to the same workstream on two machines**;
other workstreams may continue locally on either machine. The current
markdown bucket round-trip is intentionally human-readable but too
lossy for this job (no full event log, drift on re-import), and raw
SQLite copying has no machine identity or drift guard.

Sketch: make the safe, explicit DB-file handoff a typed CLI surface,
not a daemon. `mu db export <file>` writes a SQLite copy plus a tiny
manifest (source machine id, per-workstream latest log seq, mu version,
schema version). `mu db import <file>` compares that manifest against
local `machine_identity` / `workstream_sync` rows, defaults to a
dry-run preview, then applies only when the caller passes `--apply`.
Fast-forward cases import cleanly. Divergence refuses by default;
`--force-source` replaces the whole workstream from the source file,
but first parks the losing local state under
`<state-dir>/divergence/<ws>-<ts>.db` so nothing is silently lost.
`mu db replay` is the later manual recovery verb for inspecting or
re-applying parked sidecar state; it is not automatic merge.

Directional verb map (target state):

| direction                                | verb                            |
| ---------------------------------------- | ------------------------------- |
| workstream → archive                     | `mu archive add` (existing)     |
| archive → workstream                     | `mu archive restore` (shipped v0.5.0) |
| workstream → bucket markdown (read-only) | `mu workstream export` (existing) |
| archive → bucket markdown (read-only)    | `mu archive export` (existing)  |
| db → file (whole-machine sync)           | `mu db export` (shipped v0.5.0) |
| file → db (whole-machine sync)           | `mu db import` (shipped v0.5.0) |

`mu archive restore <label> --as <new-ws> [--source <orig-ws>]`
restores directly from the `archived_*` tables into a new workstream,
losslessly and without a markdown bucket round-trip. It refuses if
`--as` collides and auto-snapshots before writing. With those typed
surfaces shipped, `mu workstream import` was removed; bucket exports
remain read-only artifacts for humans and git, not the load-bearing
DB round-trip path.

Schema call-out: this is schema **v8**. Add `machine_identity` (one
row, generated once per state directory) and `workstream_sync`
(per-workstream last-seen peer sequence map). Do not require identical
`workstreams.id` values across machines; import is keyed by
workstream name and rewires local task/edge ids inside the target DB.
A clean-machine import is just the "source workstream not local"
branch.

Promotion criteria:

1. **Proven friction.** At least two real workflows hit the laptop ↔
   devserver handoff problem or the lossy bucket-import workaround.
2. **No pillar refactor.** Fits the existing SQLite + typed-verb +
   snapshot substrate; no tmux, VCS, or task-DAG redesign.
3. **Bounded scope.** At least one useful subset fits in <300 LOC
   (`mu archive restore` or `mu db export` + manifest), and the rest
   decomposes into small typed verbs.

Anti-feature alignment: no daemon, watcher, live sync, remote backend,
config file, conflict UI, or row-level merge. The user owns transport
(`scp`, `rsync`, removable disk, etc.). Machine identity is generated
and stored in SQLite, not configured. Conflict handling is sharp and
whole-workstream: refuse, or `--force-source` after parking the loser
sidecar. This narrows the old "cross-machine sync" rejection to mean
live/automatic synchronization; explicit file export/import earned
promotion without violating the local-first pillar.

---

## Possible — small additions with an obvious shape

These have a clear design but haven't yet hit promotion criterion
1 (friction in ≥2 real workflows). They earn implementation when
real use surfaces them.

### Per-CLI status detection (claude, codex, …)

mu is a pi orchestrator today. v0.2's Braille-spinner fallback
catches every TUI wrapper using standard spinner glyphs
(U+2800–U+28FF), so pi-meta + solo + many vanilla TUIs (claude,
codex) work without a per-CLI detector.

For patterns the spinner fallback misses (permission prompts,
specific busy markers), a per-CLI `Detector` registry keyed by
CLI name (~50 LOC per CLI) is the obvious shape. Promote when a
real specific-prompt-misclassification surfaces.

Pattern sketch:

| CLI    | Busy patterns                          | Permission patterns                                       |
| ------ | -------------------------------------- | --------------------------------------------------------- |
| Claude | `to interrupt`, `\(.*[↑↓].*tokens\)`   | `Allow once`, `Allow for this session`, `Esc to cancel`   |
| Codex  | `esc to interrupt)`, `to cancel`       | `enter to confirm`, `enter to submit \| esc to cancel`    |
| Pi     | (well-known mu-defined marker)         | (well-known mu-defined marker) — shipped                  |

Critical subtleties any new detector must keep:

- **Tail-window extraction**: take last ~100 lines, strip trailing
  blanks, then take last ~20. Already implemented for pi in
  `src/detect.ts`; the registry version factors it out.
- **Permission detection uses a narrower window than busy
  detection** to prevent already-answered prompts re-triggering.
- **Permission overrides busy** — if a permission prompt is
  visible, agent is `NeedsPermission`, not `Busy`.

### Subscription-based wakeups

`mu log --tail` polls SQLite once per second. SQLite update hooks
(via better-sqlite3) or `fs.watch` on the WAL would drop latency
at the cost of more machinery. Promote when someone hits the
cliff.

---

## Open questions

Live during initial design and still partly unresolved. Listed so
we don't pretend they're settled.

- **Capability tags on operations.** mu's only authorization
  surface today is "the agent ran the verb." Promote capability
  enforcement when an agent actually does damage.
- **Per-workstream config.** Resisted (anti-feature pledge). "This
  workstream uses one pi binary, that one uses another" is a real
  gap env vars don't solve cleanly. Revisit when a second user
  hits it.

---

## Pi extension and the three rules

If/when a pi extension lands (typed `mu_*` tools, HUD widget,
wakeups) bundled in this same npm package, three rules stay
non-negotiable:

1. **The DB is canonical.** All state in `<state-dir>/mu.db`.
   Extension reads/writes through the same modules the CLI uses.
   No extension-only state.
2. **Every operation works from the CLI.** No tool registered in
   the extension has logic that doesn't exist in the CLI.
3. **The skill teaches the CLI.** Pi sessions without the
   extension still get a working mu by following
   [skills/mu/SKILL.md](../skills/mu/SKILL.md).

If those three rules hold, mu stays driveable from a shell forever
and the extension stays thin.

---

## Explicitly rejected (one-liners)

Listed so we don't rediscover them. See git history for the full
reasoning per item.

- **JS / Lisp DSL** (`mu run` / `mu eval` / `mu repl`) — bash +
  jq + `--json` covers the gap. A workflow DSL is a maintenance
  liability.
- **`defineOperation()` registry framework** — no consumer left
  after the DSL was rejected.
- **Markdown agent-definition discovery** — spawn flags + first
  message already are the definition.
- **mu as a pi extension only (no CLI)** — children couldn't drive
  mu; humans couldn't debug from a shell.
- **mu as a library only (no CLI)** — multiple processes would
  fight over the DB.
- **Two binaries (`mu-agents` + `mu-tasks`)** — agent ↔ task
  integration needs one transactional surface.
- **`TaskSurface` adapter abstraction** — the built-in graph IS
  the killer feature.
- **Live cross-machine state sync** — local-first SQLite. Explicit
  DB-file export/import shipped in v0.5.0, but no watcher, daemon,
  remote backend, or live row merge.
- **HTTP API on top of SQLite** — write your own RPC if you need
  one.
- **A "hosted" mu** — your machine is the deployment.
- **Anthropomorphic agent names (`alice`, `bob`)** — use
  role-based names (`worker-1`, `reviewer-1`).
