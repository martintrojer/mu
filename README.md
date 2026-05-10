# mu

**A small, opinionated control plane for a crew of AI coding agents
working in parallel.** One tmux session, a typed task DAG, isolated
VCS workspaces per agent, an audit log — and a hard refusal to
grow into another bloated agent framework.

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

The crew is real (tmux panes you can attach to), the work graph is
real (SQLite + a parallel-tracks algorithm with diamond-merge), the
workspaces are real (jj workspace / sl share / git worktree), and
**mu does not get in your model's way.**

---

## What mu is

- **Parallelism that doesn't trip over itself.** Per-agent VCS
  workspaces (jj/sl/git auto-detected; `cp -a` for non-VCS); a real
  task DAG with **deterministic parallel-track detection +
  diamond-merge** so two agents are never assigned tasks that share
  a prerequisite.
- **Get out of the model's way.** Mu coordinates agents; it does
  not reason about them. No model selection, no thinking-effort
  knobs, no system-prompt templating, no tool routing. `--cli <key>`
  uppercases to `$MU_<KEY>_COMMAND` — your shell rc owns the
  mapping. Swap your whole stack in one line.
- **A deliberate refusal to over-engineer.** One CLI. One SQLite
  file. ~60 typed verbs. No daemon, no config file, no plugin
  runtime, no DSL, no codegen, no web UI, no chat integration, no
  hosted service. Each missing piece is an
  **[anti-feature pledge](docs/ROADMAP.md#anti-feature-pledges-still-in-force-reinforced-by-an-internal-critique)**,
  not an oversight.

## What mu is NOT

- **Not a build tool.** mu doesn't compile, test, or deploy
  anything.
- **Not a chat protocol.** Agents communicate via the work graph
  and the activity log, never agent-to-agent messaging.
- **Not a verifier.** `task close --evidence "tests pass"` records
  the claim; mu doesn't run the tests.
- **Not a replacement for [pi-subagents](https://github.com/nicobailon/pi-subagents).**
  Different problem (persistent crew vs one-shot focused
  delegation). Install both.
- **Not a hosted service.** Local-first SQLite.
- **DB-undoable, not tmux-undoable.** Every destructive verb
  auto-captures a whole-DB snapshot first; `mu undo --yes` restores
  the DB. Killed panes and freed workspace dirs are NOT replayed.

---

## When mu earns its overhead

**Use mu for** — multi-phase investigations; tasks worth gating
with review; parallel read-only/audit work alongside a heavier
task; implementation + reviewer splits with isolated workspaces;
anything where "what was decided and why" needs to outlive a
single agent's scrollback.

**Don't use mu for** — tiny direct edits; quick local inspection;
single-context work where no durable coordination is needed. The
orchestrator's first decision is whether to reach for mu at all.

---

## Install

mu is **not on npm yet** — install from a local checkout.

```bash
git clone https://github.com/martintrojer/mu
cd mu
npm install -g .         # `prepare` script auto-builds; `mu` lands on $PATH
mu --version

# Install the bundled skill so pi loads it automatically.
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/mu" ~/.agents/skills/mu
```

(`cp -r skills/mu ~/.agents/skills/` works too; `git pull` keeps
the symlink in sync.)

**Requirements:**
- Node 20, 22, or 23 (LTS recommended; see `.nvmrc`). Node 24+ is
  currently blocked by a `better-sqlite3` native-build incompatibility.
- tmux ≥ 3.0 (`mu doctor` checks)
- pi (the agent CLI mu orchestrates)
- For `--workspace`: jj, sl, or git on PATH (or `--backend none`)

**Update:** `git pull && npm install -g .`. Other install patterns
(alias-to-dist for fastest dev iteration) are in
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

# Cleanup (auto-snapshots + auto-exports the conversation first).
mu workstream destroy --yes
```

Full tour: [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md).

---

## vs `pi-subagents`

|                          | [`pi-subagents`](https://github.com/nicobailon/pi-subagents) | `mu` |
| ------------------------ | -------------------------------------------------------- | ---- |
| Best for                 | "Send this focused task to a specialist, return a result" | "Stand up a crew of agents I can keep talking to and watch live" |
| Lifetime                 | one-shot per task                                        | long-lived by default |
| Substrate                | `pi` subprocess + result files                           | tmux panes running pi sessions |
| Built-in task graph      | no                                                       | yes: parallel-tracks union-find with diamond-merge |
| Drivable from outside pi | no (extension-only)                                      | yes (`mu` is a real CLI) |

The two play well together. A pi session can install both.

---

## Documentation

- **[docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)** — practical tour
  of every verb. **Start here.**
- **[skills/mu/SKILL.md](skills/mu/SKILL.md)** — what an LLM
  running inside an agent pane sees: the in-pane working loop,
  subscribe-vs-poll pattern.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module map,
  reconciliation algorithm, schema seam (surrogate INTEGER PKs +
  the SDK boundary discipline).
- **[docs/VOCABULARY.md](docs/VOCABULARY.md)** — canonical terms;
  source of truth for every word in code, docs, error messages.
- **[docs/VISION.md](docs/VISION.md)** — the load-bearing pillars
  + the prior-runtime retrospective.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's next + the
  anti-feature pledges + explicitly-rejected ideas.
- **[CHANGELOG.md](CHANGELOG.md)** — release notes.

## License

MIT.
