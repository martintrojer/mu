# VISION: A persistent crew of agents

> Terminology used in this doc is canonical. See
> [VOCABULARY.md](VOCABULARY.md) for definitions of *workstream*,
> *agent*, *task DAG*, *crew*, *track*, *claim*, *free*, *workspace*,
> and the rest.

## What This Is

mu is a small, durable **control plane** for a persistent crew of AI
agents in tmux panes. Agents have names, roles, and status; they
live across sessions; they work on a built-in task graph with VCS
workspace isolation; humans and other agents drive them through one
CLI. State lives in one SQLite file; everything in mu is a typed
verb over that state or a reconciled view of reality.

A user with mu installed can:

```bash
mu agent spawn worker-1   --tab Backend --workspace
mu agent spawn reviewer-1 --tab Review  --workspace --role read-only
mu task add --title "Build auth" --impact 80 --effort-days 3
mu task claim build_auth --for worker-1 --evidence "have implementation plan"
mu agent send worker-1 "Implement build_auth per the description"
mu state                                # canonical state card
mu log --tail                           # subscribe to every state change
```

That's the whole product. Everything else is in service of making
those few lines work, recover from failure, and scale to dozens of
agents and hundreds of tasks.

---

## Why It Exists

Existing tools force a choice:

- **Pi-subagents** is great for one-shot focused delegation but the
  children it spawns are short-lived, pi-only, and not driveable from
  outside their parent pi session.
- **Tmux-orchestration tools** spawn agents in panes but leave
  coordination to chat transcripts or filesystem conventions.
- **Task trackers** (GitHub Issues, Linear, even tg) model the work but
  don't run the agents.
- **Bigger orchestration platforms** provide the coordination
  state but have accumulated breadth that costs more in
  lifecycle/maintenance/model-entropy than they pay for. See
  [§ What looking at a prior multi-agent runtime taught us](#what-looking-at-a-prior-multi-agent-runtime-taught-us)
  below.

mu unifies the first three without becoming the fourth: persistent
pi agents, a structured work graph, per-agent VCS isolation, one
CLI, one SQLite file. The cost of "what should this agent do next?"
drops from "ask the LLM and hope" to:

```bash
mu task next            # top ready task by ROI
mu state                # full picture as a JSON state card
```

---

## Design Principles

### 1. The CLI is the product

The pi extension is a UX skin. Everything mu does must work from a
shell with no pi anywhere. If a feature requires the extension to
function, it doesn't ship.

### 2. One DB is canonical

All state lives in `~/.local/state/mu/mu.db`. SQLite WAL. Multiple processes share
it safely. The DB is the source of truth; in-memory state is a cache.
The extension and the CLI both go through the same DB; they never
diverge.

### 3. Reality wins reconciliation

`mu agent list` queries tmux, prunes ghosts, adopts orphans. The DB records
what we last observed, not what we wish were true. If worker-1's pane
crashed, the next `mu agent list` notices and updates the registry.

### 4. Agents are dumb workers; the task graph is the brain

The **task DAG is the central organizing primitive**, not a sidecar
feature. Tasks have mandatory `impact` and `effort_days`; edges are
`blocks` relationships; `ready`/`blocked`/`goals` are SQL views; the
parallel-track detector runs union-find with automatic diamond-merge
so two agents never collide on a shared dependency.

This means "what should this agent do next?" and "can we parallelize?"
are deterministic queries against the graph, not LLM judgment calls.
The LLM decides *what to type to the agent*; the graph decides *which
agent gets which task*.

### 5. One workstream per tmux session

A mu workstream is a tmux session. All its agents are panes/windows
inside that session. `tmux a -t mu-<workstream>` shows the whole crew
live. Multiple workstreams on one machine are multiple isolated tmux
sessions, partitioned in the DB by `session_id`. Detach and reattach
as you would any tmux session — the crew survives.

### 6. Pi-only, by current scope

Mu's status detection (`busy` / `needs_input` / `idle` / `done`) is
pi-only. The `--cli <name>` flag accepts other strings, but no other
CLI ships with detection support today, so a non-pi pane will always
show `needs_input`. In practice mu is a pi orchestrator.

The `--cli` and `MU_<UPPER_CLI>_COMMAND` surface stays useful for one
thing: swapping the pi binary. If your install ships pi under a
different binary name, set `MU_PI_COMMAND=<name>` once and every
spawn picks it up. Multi-word commands work too:
`MU_PI_COMMAND="pi-alt --some-flag"`.

Multi-CLI support (claude / codex with real status detection) is a
future possibility but not currently planned. If it earns its way
back per the [ROADMAP](ROADMAP.md) criteria, the substrate is ready
(spawn already accepts arbitrary commands; the schema's `cli` column
is TEXT). Until then, treat "mu is a pi orchestrator" as the honest
positioning.

### 7. TypeScript on Node — deliberate, not a compromise

Mu is TypeScript on Node, with a small set of well-established
npm deps (`commander`, `better-sqlite3`, `cli-table3`, `picocolors`,
`execa`). No native code we maintain, no build matrix. Anyone
reading `package.json` should recognize every name.

This was an early framing as "boring," but in practice the choice
earns its keep on four specific axes — not just inertia:

- **Type system value is real.** The `AgentNotFoundError` /
  `TaskNotFoundError` / `TaskNotInWorkstreamError` / `CycleError`
  hierarchy maps directly to exit codes via `handle()`. The
  `assertXInWorkstream` helper family stays type-safe across
  three namespaces. `noUncheckedIndexedAccess` has prevented
  several real bugs in iteration. The same code in Go would lose
  the discriminated unions; in Python the type checker is too
  weak; in Rust the LOC cost would be 2–3×.
- **JSON-first surface fits TS like a glove.** `emitJson(value)`
  is one line. Every read verb's `--json` output is
  `JSON.stringify(value)` straight from a typed shape. Compare to
  `serde_json` derive-macro friction in Rust or `json.dumps`
  with no type guard in Python.
- **`better-sqlite3` is genuinely best-in-class.** Synchronous
  request/response API matches the CLI invocation model
  perfectly. WAL handling correct out of the box.
  `db.transaction()` wrapper is exactly the right shape.
  Equivalent in Rust (rusqlite) or Go (mattn/go-sqlite3) is more
  verbose to use.
- **Iteration speed.** ~50 typed verbs / 8 tables / 449 tests in
  ~6,000 LOC src+tests, with multiple substantive changes per
  day during active work. That cadence in a Rust codebase of
  equivalent surface area would be 2–3× slower at minimum.

**Where it's weak: cold start.** Node's V8 init is ~30–50ms even
after tsup bundles. Rust would be ~5ms; Go ~10–15ms. This would
matter if mu were called in tight loops at the heart of agent
scripts — but it's not, by design. Pillar 4 ("async coordination
via the activity log") explicitly steers operators away from
polling loops toward `mu log --tail` subscriptions. **The
weakness is sidestepped by the architecture.** If that ever
stops being true (mu becomes a polling tool, distribution goes
broadly public with "no toolchain required" as a feature, or
sub-5ms startup becomes load-bearing), Rust is the natural port
target; until then, TS+Node is actively the right choice, not a
compromise.

**Native dep:** `better-sqlite3` requires prebuilds or a C++
toolchain. Prebuilds cover darwin-arm64/x64, linux-x64/arm64,
win32-x64 — every dev workstation we care about. Acceptable.

### 8. Schema-first; typed verbs over read views; SQL as escape hatch

The product surface is:

- **Read views** (the `ready` / `blocked` / `goals` SQL views; `mu
  state` as the curated state card) for inspection.
- **Typed verbs** that map cleanly to resource transitions for action
  (`task add`, `task claim`, `task close`, `agent spawn`, `workspace
  create`, `approve grant`, ...).
- **`--json` on every read verb** so scripts pipe through `jq`
  instead of parsing tables.
- **`mu sql`** as the explicit escape hatch underneath.

There is no DSL, no plugin system, no workflow engine, no
`defineOperation` registry generating verbs from declarations. The
commander wiring in `src/cli.ts` is the single source of truth for
the verb surface. Adding a new verb is one SDK function plus one
commander block.

### 9. Observed vs claimed

When a verb mutates state, the audit trail records what the caller
said it relied on. `mu task close design --evidence "tests pass:
npm test exit 0"` lands in the event log as
`task status design (IN_PROGRESS → CLOSED) evidence="..."`. The verb
still trusts the caller — mu doesn't run tests for you — but the
grounding for every state change is searchable in `mu log --kind
event`. First inch of a discipline that earns more enforcement when
real-world friction asks for it.

### 10. Get out of the model's way

Mu coordinates agents; it does not reason about them. Specifically,
mu does not own:

- **Model selection.** No tier abstraction (no `mini/modest/big`),
  no provider matrix, no vendor-name mapping. Pi already speaks
  `--model sonnet:high` and `--provider openai`. The day mu invents
  its own tier names is the day mu owns a vendor matrix that goes
  stale every quarter — that's the "adjacent product identities"
  trap an internal critique flagged, and we're not falling into it.
- **Effort / thinking levels.** Pi has
  `--thinking off|minimal|low|medium|high|xhigh`. Mu doesn't wrap
  it, doesn't normalise it, doesn't second-guess it. Pass-through
  via `--command` or the `MU_<UPPER_CLI>_COMMAND` env var, full stop.
- **Prompt engineering.** Mu has no system-prompt templating, no
  role injection beyond the agent name and `--role`, no "agent
  template" registry. The system prompt is whatever you put in the
  spawn command and the first message you send.
- **Tool routing decisions.** Pi (and any other CLI you spawn) owns
  tool allowlists, MCP servers, extensions. Mu doesn't proxy or
  inspect them.
- **Output interpretation.** Mu reads pane contents to detect
  `busy / needs_input / idle / done` (a 4-state classification).
  It does not parse model output for facts, claims, or tool calls.
  The `--evidence` payload is whatever the agent says it is; mu
  records it without interpretation.

The full mechanism is one function: `--cli <key>` uppercases the
key and looks up `$MU_<KEY>_COMMAND`. That's mu's entire vendor
surface. The operator pattern when you want different models per
role is just convention on top:

```bash
export MU_PI_MINI_COMMAND="pi --model haiku:off"   # → --cli pi_mini
export MU_PI_BIG_COMMAND="pi --model opus:high"    # → --cli pi_big

mu agent spawn worker-1   --cli pi_mini
mu agent spawn reviewer-1 --cli pi_big
```

Your shell rc owns the mapping. The names `pi_mini` / `pi_big` are
operator convention — mu doesn't know about "tiers," it just looks
up whatever env var the uppercased key produces. Swap the whole
matrix in one line; per-machine, per-workstream, per project —
wherever you set the env. The substrate stays small; the
orchestrator stays in charge.

This is the zen of mu: every layer doing its job, no layer
speaking for another.

---

## What It Enables

- **Persistent crews in one place** — Spawn worker-1/worker-2/reviewer-1
  once, send them work all day. `tmux a -t mu-<workstream>` shows
  the whole crew in one session: each agent in its own pane, all
  observable at a glance, all detachable.
- **Multi-pi crews in one session** — several pi workers and a
  read-only pi reviewer in the same workstream, each in its own
  pane, each independently observable via `tmux attach`.
- **Graph-driven coordination** — The task DAG answers "what's ready?",
  "what blocks what?", "what can be parallelized?" with SQL queries
  and union-find, not LLM guesses. Notes per task accumulate durable
  context that outlives any single agent or session.
- **Deterministic parallelization** — Diamond patterns (shared
  prerequisites) get merged automatically so two agents never collide
  on a shared dependency. The orchestrator follows the algorithm; it
  doesn't have to be smart enough to spot the trap.
- **VCS workspace isolation** — Each agent gets its own jj workspace,
  sl clone, git worktree, or `cp -a` snapshot, auto-detected.
  `mu agent spawn --workspace` creates and mounts; `mu agent close`
  auto-frees. Two parallel agents in the same project never trample
  each other's working tree.
- **Async coordination via `mu log`** — Every state-changing verb
  auto-emits a `kind='event'` row. Subscribers `mu log --tail`
  instead of polling. Real-time wakeups without a daemon.
- **Human-in-the-loop approvals** — `mu approve add/wait` lets agent
  scripts gate destructive actions on human sign-off. `wait` exits
  0 (granted) / 4 (denied) / 5 (timeout) for clean shell control flow.
- **Audit trail with grounding** — `--evidence` on lifecycle verbs
  records what the caller observed. Searchable via `mu log --kind
  event`.
- **Crash recovery** — Reconciliation prunes ghost agents; the reaper
  reverts their IN_PROGRESS tasks to OPEN with an explanatory note;
  no manual cleanup.
- **Human-driveable** — Anything mu can do, you can do from a shell.
  Debug, recover, script, cron.

---

## What It Is NOT

- **Not an orchestrator.** mu provides primitives. The orchestration
  *policy* (when to spawn, what to assign, when to free) is yours —
  expressed as bash scripts, jq pipelines over `--json` output, or
  driven by an LLM through the bundled skill. There is no JS DSL,
  no workflow engine, no `mu run script.ts`. (See
  [§ What looking at a prior multi-agent runtime taught us](#what-looking-at-a-prior-multi-agent-runtime-taught-us).)
- **Not a build tool.** mu doesn't compile, test, or deploy your code.
  It runs agents that do those things.
- **Not a chat protocol.** Agents communicate through the work graph
  (notes, claim, status) and the `agent_logs` activity channel.
- **Not a replacement for pi-subagents.** Different problem (persistent
  crew vs one-shot focused delegation). Install both; they share the
  agent-frontmatter format.
- **Not a hosted service.** Local-first SQLite. Zero ops, no accounts.
  Your machine is the deployment.
- **Not a verifier.** The verbs trust the caller. `task close
  --evidence "tests pass"` records the claim; mu doesn't run the
  tests. Verification is the caller's job. (mu may grow optional
  verifying-runners later if friction surfaces; today it's an
  audit-trail discipline, not enforcement.)
- **Not undoable.** No snapshots, no `mu undo`. `mu workstream
  destroy --yes` is irreversible. Recovery is restoring `mu.db` from
  a backup. Snapshots are deferred past 1.0 — the SQL escape hatch
  + FK CASCADE behaviour cover most repair scenarios.

---

## Key Constraints

1. **Tmux required.** The substrate is tmux panes. No tmux, no agents.
   `mu doctor` checks for it on every run that touches the agent layer.

2. **Local-only persistence.** SQLite file at `~/.local/state/mu/mu.db`.
   No cross-machine state in v1; layer something like syncthing on top
   if you want it.

3. **Pi-only.** Status detection (and de-facto the entire product)
   targets pi. `--cli pi` is the meaningful default; `--cli` accepts
   other strings as a key for the `MU_<UPPER_CLI>_COMMAND` env var
   resolver but no other CLI has a detector. We optimize for
   false-negative-then-poll over false-positive-then-act.

4. **Send is fire-and-forget.** `mu agent send` delivers to the pane;
   no acknowledgment. Orchestrators poll status or subscribe to
   `mu log --tail` for confirmation. This is by design — the
   alternative requires a protocol every CLI would have to speak.

5. **Recursion is opt-in.** Default `maxSubagentDepth: 0`. Children
   get the `mu` binary on PATH but the bundled skill explicitly says
   "you are not the orchestrator." Hierarchical orchestration is
   intentional, not accidental.

6. **Subscriptions are polling-based.** `mu log --tail` and
   `mu approve wait` poll SQLite once per second. SQLite handles the
   concurrency; latency is bounded by the poll interval. Real
   subscription mechanisms (SQLite hooks, fs.watch) are a future ask
   if anyone hits the latency cliff.

---

## What looking at a prior multi-agent runtime taught us

We ran a five-role council critique against a prior
internal multi-agent runtime mu's author worked on — mu's design
ancestor. The council converged on a sharp central claim:

> [The runtime] is not justified as a better general coding harness.
> [The runtime] is justified only when it becomes a durable
> coordination/control plane for work that outgrows a thin harness
> plus manually managed tmux.

And a sharper recommendation for what such a control plane should
look like:

> A minimal defensible core would be: durable sessions/transcripts;
> agent registry; task records / task graph; workspace and checkout
> ownership/leases; event log; wakeups/timers; human approvals/input;
> typed control API; read-only views/state cards; recovery/orphan
> detection.
>
> Everything else — chat, docs, IDE assist, incident-triage,
> mobile-agent, end-to-end workflows, memory policy, rich
> dashboards, workflow DSLs — should be optional layers that prove
> they strengthen the supervision loop.

This is independent validation of the shape mu had landed on. Almost
every item in the council's minimal core ships in mu today (9 of 10);
almost every item the council criticised the prior runtime for is
something mu explicitly does not have.

### The council's criticisms → mu's design choices

| Council critique of the prior runtime                         | mu's stance                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "Sprawling product identities (TUI + web + Thrift + plugin host + workflow engine + chat + docs + memory + ...)" | One CLI, one SQLite file, no plugins, no web UI, no Thrift, no chat/docs integrations. |
| "Workflow DSL is mostly liability"                            | Rejected outright. No `mu run`/`eval`/`repl`. `--json` + bash + jq cover the scripting story. |
| "defineOperation/verb-registry adds entropy without consumers" | Rejected. The commander wiring in `src/cli.ts` is the verb surface; one place. |
| "Plugin sprawl with hidden state and lifecycle bugs"          | No plugins. Adding behaviour is a typed verb in `src/cli.ts`.              |
| "CLI verbs as a primary model surface vs. typed mutations"    | mu's verbs *are* the typed mutations. CLI is a thin wrapper over a typed SDK with idempotency, validation, exit-code-mapped errors. |
| "Raw SQL as the only inspection surface is too low-level"     | `mu state` is the canonical state card. `--json` everywhere. `mu sql` is the escape hatch beneath, not the cockpit. |
| "Distinguish observed from claimed state"                     | `--evidence` on lifecycle verbs (first inch). The verb still trusts the caller; the audit trail records grounding. |
| "Approval primitives belong in the core"                      | `mu approve add/list/grant/deny/wait` shipped. wait exits 0/4/5 for shell control flow. |
| "Reads must distinguish provenance (process telemetry vs agent self-report)" | event `source` field attributes events to actor (claiming agent / decider / 'system'). |
| "State must be authoritative and recoverable, not just durable" | Reconciliation runs on read paths; reaper recovers stuck IN_PROGRESS automatically. |

### What this validates

Three things the council's analysis lets us state with more
confidence than "we just had a hunch":

1. **The anti-feature pledges are load-bearing.** No DSL, no plugins,
   no daemon, no config file, no web UI, no remote sync. Each one is
   a failure mode the prior runtime exhibited that mu chose not to inherit.

2. **"Pi+tmux is the benchmark" is the right comparison.** mu only
   earns its complexity above the threshold where coordination
   itself is the work — multiple agents, multiple checkouts, delayed
   wakeups, recovery, approvals. Below that, a thin harness with
   manual tmux is more transparent.

3. **Schema-first + typed verbs + state cards is the right model UX
   shape.** Not because we read a paper that said so, but because
   independent reasoning from operators, engineers, architects, and
   model-UX specialists converges on it.

### What this still flags as gaps

The council's critique cuts mu too in places. The honest list:

- **Wakeups are polling-based.** `mu log --tail` polls every 1s.
  Real subscriptions (SQLite update hooks) are deferred.
- **`--evidence` is grounding, not verification.** mu doesn't run the
  tests. A future `--verify-by` mode that runs a command and records
  its exit could deepen this; not built yet.
- **No idempotency keys on mutations.** Most ops are idempotent by
  happenstance; not declared as part of the API contract.
- **No dry-run on most mutations.** Only `workstream destroy` has it.
- **No capability model.** The `role` field is stored on agent rows
  but unused. No "reviewer-1 cannot delete tasks" enforcement.

Each is a known gap with a clear shape. None has friction-driven
promotion yet.
