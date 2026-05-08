# mu

**A small, opinionated control plane for a crew of AI coding agents
working in parallel.** One tmux session, a typed task DAG, isolated
VCS workspaces per agent, an audit log, human-in-the-loop
approvals — and a hard refusal to grow into another bloated agent
framework.

```bash
mu workstream init auth-refactor
mu task add --title "Design auth"  --impact 80 --effort-days 2
mu task add --title "Build auth"   --impact 80 --effort-days 5 --blocks design_auth
mu task add --title "Review auth"  --impact 60 --effort-days 1 --blocks build_auth

mu agent spawn worker-1   --workspace
mu agent spawn reviewer-1 --workspace --role read-only
mu agent send worker-1 "Pick up the next ready task and design the auth module."

tmux a -t mu-auth-refactor    # watch the whole crew live
mu                            # mission control: ready tasks, parallel tracks, agent status
mu log --tail                 # subscribe to every state change
```

That's the whole pitch. The crew is real (tmux panes you can
attach to), the work graph is real (SQLite + a parallel-tracks
algorithm with diamond-merge), the workspaces are real (jj
workspace / sl share / git worktree), and **mu does not get in
your model's way**.

---

## What mu is — three claims

### 1. Parallelism that doesn't trip over itself

Most "multi-agent" tools punt on the hard part: when two agents
work on the same project, they corrupt each other's files,
duplicate each other's work, or quietly race on shared state. mu
solves this in two complementary ways:

- **Per-agent VCS workspaces.** `mu agent spawn --workspace`
  auto-detects jj/sl/git and gives each agent its own working
  copy. Build artifacts, test outputs, edits — fully isolated.
  Auto-freed on close. (Falls back to `cp -a` snapshots for
  non-VCS dirs.)
- **A real task DAG with parallel-track detection.** Tasks have
  mandatory `impact` and `effort_days`; edges are `blocks`
  relationships. mu runs union-find with **automatic
  diamond-merge** so two agents are *never* assigned tasks that
  share a prerequisite. The orchestrator follows the algorithm; it
  doesn't have to be smart enough to spot the trap.

```
  Independent (2 tracks):       Diamond (1 merged track):

    goal_a    goal_b              goal_a   goal_b     ← Spawn 2 agents
       |         |                   \      /
    task_a    task_b                  shared          ← Spawn 1 (merging
       |         |                      |               prevents collision)
    leaf_a    leaf_b                  leaf
```

`mu task next` answers "what should this agent do next?" as a
deterministic SQL query, not an LLM judgement call.

### 2. Get out of the model's way

mu coordinates agents; it does not reason about them. Specifically,
mu owns **none** of:

- Model selection, tier abstraction, or vendor matrices.
- "Thinking effort" / chain-of-thought knobs.
- System-prompt templating or role injection.
- Tool routing, MCP registries, allowlists.
- Output interpretation beyond a 4-state status detector
  (`busy / needs_input / idle / done`).

Pi (the agent CLI mu spawns) already has those abstractions. mu's
full "vendor knowledge" is one mechanism: `--cli <key>` uppercases
the key and looks up `$MU_<KEY>_COMMAND`. That's it. Define
whatever names suit you in your shell rc:

```bash
export MU_PI_COMMAND="pi --model sonnet:medium"   # default for --cli pi
export MU_PI_BIG_COMMAND="pi --model opus:high"   # → --cli pi_big
mu agent spawn reviewer-1 --cli pi_big
```

Your shell rc owns the mapping. Swap your whole stack in one line.
Mu doesn't go stale every time a new model ships.

### 3. A deliberate refusal to over-engineer

mu is a CLI. **One CLI.** No daemon, no config file, no plugin
runtime, no DSL, no codegen, no web UI, no chat integration, no
memory system, no workflow engine, no remote sync, no hosted
service. State lives in **one SQLite file**. All ~50 verbs are
typed; every read verb supports `--json`; the `mu sql` escape
hatch is right there when you need to query the registry directly.

These aren't accidents — they're **anti-feature pledges**. Each
one names a specific failure mode mu chose not to inherit from a
prior multi-agent runtime that grew exactly those subsystems and
collapsed under the maintenance debt. (See [docs/VISION.md
§ What looking at a prior multi-agent runtime taught us](docs/VISION.md#what-looking-at-a-prior-multi-agent-runtime-taught-us)
and [docs/ROADMAP.md § Anti-feature pledges](docs/ROADMAP.md#anti-feature-pledges-still-in-force-reinforced-by-an-internal-critique).)

If a feature isn't on [docs/ROADMAP.md](docs/ROADMAP.md), it's
not coming. If it's listed as rejected, it stays rejected unless
real friction (≥2 real workflows hit the gap) earns it back.

---

## What mu is NOT

To be useful, a sales pitch has to be honest about scope:

- **Not a build tool.** mu doesn't compile, test, or deploy
  anything. It runs agents that do those things.
- **Not a chat protocol.** Agents communicate through the work
  graph (notes, claim, status) and the activity log — never
  agent-to-agent messaging.
- **Not a verifier.** `task close --evidence "tests pass"`
  records the claim; mu doesn't run the tests.
- **Not a replacement for [pi-subagents](https://github.com/nicobailon/pi-subagents).**
  Different problem (persistent crew vs one-shot focused
  delegation). Install both; they share the agent-frontmatter
  format.
- **Not a hosted service.** Local-first SQLite. Zero ops, no
  accounts. Your machine is the deployment.
- **DB-undoable, not tmux-undoable.** Every destructive verb
  (`mu task delete`, `mu workstream destroy --yes`, the task
  lifecycle verbs, `mu agent close`, `mu workspace free`,
  `mu approve grant/deny`) auto-captures a whole-DB snapshot
  first. `mu undo --yes` restores the DB; `mu snapshot list`
  inspects available snapshots. The tmux side effects (panes
  killed, workspace dirs freed) are NOT replayed.

---

## When mu earns its overhead

From running mu against multi-day investigations:

**Use mu for** —
- Multi-phase work (benchmark + profile + fix + review + parity).
- Tasks worth gating with review (the DAG enforces
  `implement → review → address → ship`).
- Parallel read-only/audit work alongside heavier tasks (one
  worker profiling, one scout auditing in parallel).
- Implementation + reviewer/tester splits with isolated
  workspaces.
- Anything where "what was decided and why" needs to outlive a
  single agent's scrollback.

**Don't use mu for** —
- Tiny direct edits (5-minute one-file changes).
- Quick local inspection / one-off commands.
- Single-context work where no durable coordination is needed.

For a large investigation, the net is a clear win: durable project
memory, explicit dependencies, safe worktree isolation,
parallelizable independent tracks, clear handoffs, review gates,
auditable evidence. For a one-off edit, it's pure ceremony. The
orchestrator's first decision is whether to reach for mu at all.

---

## What ships in 0.2.0

**~60 typed verbs across 7 namespaces, plus `mu`, `mu state`, `mu
hud`, `mu sql`, `mu doctor`, `mu adopt`.** Every verb supports
`--json`. State lives in
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db` (schema v4).

| Area | Verbs |
| --- | --- |
| **workstream** (3) | `init` (repairs missing `_mu` window), `list`, `destroy` (cleans workspaces + auto-snapshots) |
| **agent** (8) | `spawn` (`--workspace`, preflight prints backend + projectRoot), `send`, `read`, `show`, `list`, `close` (refuses if workspace; `--discard-workspace` to opt in), `free`, `attach` |
| **task** (24) | `add` (id auto-derived from title; `--blocked-by`), `list`, `show`, `notes`, `note` (`--author`), `tree`, `next`, `ready`, `blocked`, `goals`, `owned-by`, `search`, `claim` (`--for` / `--self`; `--evidence`), `release`, `close`, `open`, `reject` (`--cascade --yes`), `defer` (`--cascade --yes`), `block`, `unblock`, `update`, `delete`, `reparent`, `wait` (exit 0/3/5) |
| **workspace** (5) | `create`, `list`, `free` (`--commit`), `path`, `orphans` (dirs on disk with no DB row) |
| **log** (1, overloaded) | write, read, `--tail` subscription; auto-emits on every state change |
| **approve** (5) | `add`, `list`, `grant`, `deny`, `wait` (exit 0/4/5 = granted/denied/timeout) |
| **self-id** (3) | `whoami`, `my-tasks`, `my-next` (resolves agent via `$TMUX_PANE`) |
| **utilities** (5) | bare `mu` (quick mission control), `mu state`, `mu hud` (dynamic table layout; fills the terminal/pane height × width; `--json` for scripts), `mu sql` (multi-statement; `--confirm-rows`), `mu doctor`, `mu adopt` (register an existing pane) |

Five task lifecycle states: `OPEN`, `IN_PROGRESS`, `CLOSED`,
`REJECTED` (terminal won't-do; still blocks downstream),
`DEFERRED` (parked; still blocks). `--cascade` on reject/defer is
dry-run by default; `--yes` commits.

Plus: per-agent VCS workspaces (jj/sl/git/none) with orphan
detection, activity log with `--tail` subscription, canonical
state card (`mu state`), human-in-the-loop approvals
(`mu approve`), `--evidence` on every lifecycle verb,
self-documenting output (`Next:` hints + structured
`errorNextSteps`), crash recovery (ghost reaper), schema
migrations (v1→v2→v3→v4), **whole-DB snapshots auto-captured
before destructive verbs** (substrate for `mu undo` /
`mu snapshot {list,show}`),
pi/pi-meta/wrapper-agnostic status detection (Braille spinner
fallback covers every TUI runtime), pane-border + composed
pane-title carrying mu's interpreted state.

A full per-commit changelog lives in [CHANGELOG.md](CHANGELOG.md).

---

## vs `pi-subagents`

|                          | [`pi-subagents`](https://github.com/nicobailon/pi-subagents) | `mu` |
| ------------------------ | ------------------------------------------------------------ | ---- |
| Best for                 | "Send this focused task to a specialist, return a result"    | "Stand up a crew of agents I can keep talking to and watch live" |
| Lifetime                 | one-shot per task                                            | long-lived by default |
| Substrate                | `pi` subprocess + result files                               | tmux panes running pi sessions |
| Observability            | streams into the pi conversation, async widget               | `tmux attach` and watch live |
| Recursion                | blocked by safety policy                                     | opt-in (just spawn nested) |
| Coordination             | parent → child, with synthesis                               | peer agents sharing a SQLite registry + activity log |
| Built-in task graph      | no                                                           | yes: `ready`/`blocked`/`goals` views, parallel-tracks union-find with diamond-merge |
| Drivable from outside pi | no (extension-only)                                          | yes (`mu` is a real CLI) |
| Parallel safety          | git worktrees + synthesis                                    | jj/sl/git workspaces + **deterministic parallel-track detection** |

**Rule of thumb:**
- "Run three reviewers on this diff and tell me what to fix" →
  **pi-subagents**.
- "Spin up a long-lived implementer in pane 1, a read-only auditor
  in pane 2, keep them around all day" → **mu**.
- "I want to step out and `tmux attach` to watch what worker-1 is
  doing" → **mu**.
- "The work is graph-shaped; multiple agents need to coordinate
  through dependencies and shared blockers" → **mu**.

The two play well together. A pi session can install both.

---

## Install

mu is **not on npm yet** — install from a local checkout.

```bash
git clone https://github.com/martintrojer/mu
cd mu
npm install -g .         # `prepare` script auto-builds; `mu` lands on $PATH
mu --version             # → 0.1.0

# Install the bundled skill so pi loads it automatically.
# Pi looks for skills at `~/.agents/skills/<name>/SKILL.md`
# (cross-tool global) and `~/.pi/agent/skills/<name>/SKILL.md`
# (pi-specific). Either works.
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/mu" ~/.agents/skills/mu
# This resolves to ~/.agents/skills/mu/SKILL.md — exactly the
# layout pi expects. `git pull` keeps it in sync.
```

(If you'd rather copy than link, `cp -r skills/mu
~/.agents/skills/` works — same final layout, but you'll need
to re-copy after every update.)

The skill teaches pi (or any loader supporting the
[Agent Skills standard](https://agentskills.io)) the in-pane
working loop, the approve-before-destructive pattern, and the
subscribe-vs-poll pattern.

**Requirements:**
- Node ≥ 20
- tmux ≥ 3.0 (`mu doctor` checks)
- pi (the agent CLI mu orchestrates)
- For `--workspace`: jj, sl, or git on PATH (or `--backend none`
  for any directory)

**Update:** `git pull && npm install -g .` from the checkout.

**Other install patterns** (alias-to-dist for fastest dev
iteration, install-from-arbitrary-path) are in
[docs/USAGE_GUIDE.md § 1 Setup](docs/USAGE_GUIDE.md#1-setup).

---

## Quick start

```bash
# Make sure you're inside tmux.
tmux

# Initialize the workstream (creates tmux session mu-auth-refactor)
mu workstream init auth-refactor

# Plan the work as a DAG. IDs auto-derive from titles.
mu task add --title "Design auth module" --impact 80 --effort-days 2
mu task add --title "Build auth"         --impact 80 --effort-days 5 --blocks design_auth_module
mu task add --title "Review auth"        --impact 60 --effort-days 1 --blocks build_auth

# Spawn a crew with isolated workspaces.
mu agent spawn worker-1   --workspace
mu agent spawn reviewer-1 --workspace --role read-only

# Mission control: parallel tracks, ready tasks, agent status.
mu

# Inside an agent's pane, the agent claims and closes tasks
# without ever knowing its own name (mu reads $TMUX_PANE).
mu task claim design_auth_module
mu task note  design_auth_module "DECISION: JWT, 24h expiry, refresh via cookie"
mu task close design_auth_module --evidence "design doc reviewed by reviewer-1"

# Subscribe to events instead of polling.
mu log --tail

# Observe live.
tmux a -t mu-auth-refactor                # whole crew, all panes
mu agent read worker-1 -n 50              # tail just one

# Cleanup (auto-frees workspaces).
mu agent close worker-1 && mu agent close reviewer-1
mu workstream destroy --yes
```

Full tour: [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md).

---

## Status

**0.1.0 — initial public release.**

~50 typed verbs across 6 namespaces; ~5,800 LOC TypeScript src +
tests; 451 tests across unit + real-tmux + real-git/jj/sl
integration. Closes 9 of 10 council-recommended pillars for a
minimal multi-agent control plane (the 10th — subscription-based
wakeups — is on the roadmap; today, `mu log --tail` polls SQLite
once per second).

See [CHANGELOG.md](CHANGELOG.md) for the release entry and
[docs/ROADMAP.md](docs/ROADMAP.md) for what's next + explicitly
rejected ideas.

---

## Documentation

The two files in the repo root — `README.md` (this file, for human
users) and `AGENTS.md` (for AI coding agents working on the repo)
— are entry points. Everything else lives in [`docs/`](docs/):

- **[docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)** — practical,
  copy-pasteable tour of every verb. **Start here.**
- **[CHANGELOG.md](CHANGELOG.md)** — release notes.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's next + the
  anti-feature pledges + explicitly-rejected ideas.
- **[docs/VISION.md](docs/VISION.md)** — design principles, the
  "what looking at a prior runtime taught us" retrospective.
- **[docs/VOCABULARY.md](docs/VOCABULARY.md)** — canonical terms;
  source of truth for every word in code, docs, error messages.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module map,
  reconciliation algorithm, layered design.
- **[skills/mu/SKILL.md](skills/mu/SKILL.md)** — what an LLM
  running inside an agent pane sees: the in-pane working loop,
  approve-before-destructive pattern, subscribe-vs-poll pattern.

---

## Inspirations

- **[pi-subagents](https://github.com/nicobailon/pi-subagents)** by
  Nico Bailon — the pi-native delegation pattern. mu reuses its
  frontmatter format and borrows operational machinery (worktrees,
  mutation guards, model fallback, doctor).
- **A prior internal multi-agent runtime** (Rust). The "tmux as
  universal substrate + per-CLI status detection + reality-wins
  reconciliation + parallel-track union-find with diamond-merge"
  patterns originated there. Mu adopts the patterns; not the deps.
- **An internal critique of that prior runtime** — sharpened the
  case for the anti-feature pledges and motivated several of the
  verbs in this release (state cards, approvals,
  observed-vs-claimed evidence on lifecycle verbs).

## License

MIT.
