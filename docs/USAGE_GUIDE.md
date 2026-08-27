# mu — Usage Guide

A practical, copy-pasteable tour of mu. Terms are canonical — see
[VOCABULARY.md](VOCABULARY.md); the canonical verb list is
`mu --help`, with the gotchas in `## CLI overview` of
[skills/mu/SKILL.md](../skills/mu/SKILL.md).

> **Status:** 1.0 (pre-release). Typed verbs span 7 namespaces
> (`workstream`, `agent`, `task`, `workspace`, `log`, `me`, `db`) plus
> bare top-level verbs (`state`, `doctor`, `sql`, `undo`, `sync`,
> `rebuild`). Every verb accepts `--json`. Schema v9. See
> [CHANGELOG.md](../CHANGELOG.md).

**In a hurry? Start at [§ 0. Common scenarios](#0-common-scenarios).**

*If anything below disagrees with `mu --help`, trust `mu --help`.*

---

## Table of contents

0. [Common scenarios (start here)](#0-common-scenarios)
1. [Setup](#1-setup)
2. [Get oriented (`mu doctor`)](#2-get-oriented)
3. [Create a workstream (`mu workstream init`)](#3-create-a-workstream)
4. [Plan some work as a DAG (`mu task add`)](#4-plan-some-work-as-a-dag)
5. [See the graph (dashboard + state API)](#5-see-the-graph-dashboard--state-api)
5b. [The TUI dashboard (interactive)](#5b-the-tui-dashboard-interactive)
6. [Spawn a crew (`mu agent spawn`)](#6-spawn-a-crew)
7. [Watch the crew live (`tmux attach`)](#7-watch-the-crew-live)
8. [Send work to an agent (`mu agent send`)](#8-send-work-to-an-agent)
9. [Read what an agent did (`mu agent read`)](#9-read-what-an-agent-did)
10. [The claim protocol from inside a pane (`mu task claim`)](#10-the-claim-protocol--from-inside-an-agents-pane)
11. [Drop notes (durable context) (`mu task note`)](#11-drop-notes-durable-context)
12. [Close out a task](#12-close-out-a-task)
13. [The SQL escape hatch (`mu sql`)](#13-the-sql-escape-hatch-is-your-friend)
14. [Recovery scenarios](#14-recovery-scenarios)
15. [Cleanup](#15-cleanup)
15.6. [Multi-machine sync](#156-multi-machine-sync)
16. [One-shot demo script](#16-one-shot-demo-script)
17. [Mental model in three sentences](#mental-model-in-three-sentences)
18. [What's NOT in mu](#whats-not-in-mu-and-how-to-work-around-it)
19. [Where to go from here](#where-to-go-from-here)
20. [Multiplexer backends (tmux and herdr)](#20-multiplexer-backends-tmux-and-herdr)

---

## 0. Common scenarios

Six worked paths, every command run live. Output is verbatim (colour
stripped). Set `MU_DB_PATH=/tmp/mu-play.db` first if you want to try
them without touching your real registry.

### 0.1 First 5 minutes

Init a workstream, plan two tasks with a dependency, see what's ready.

```bash
mu workstream init auth
mu task add design -w auth --title "Design auth module" --impact 80 --effort-days 2
mu task add build  -w auth --title "Build auth module"  --impact 80 --effort-days 5 --blocked-by design
mu task next -w auth
mu task tree build -w auth
```

```
Created workstream auth (tmux session mu-auth)
Next:
  Attach the tmux session : tmux a -t mu-auth
  Plan tasks              : mu task add -w auth --title "..." --impact 50 --effort-days 1
  Spawn an agent          : mu agent spawn <name> -w auth
  See state               : mu state -w auth

Added task design (workstream=auth, impact=80, effort=2)

Added task build (workstream=auth, impact=80, effort=5)
  blocked by: design

┌────────┬────────┬────────────────────┬────────┬────────┬──────┬───────┐
│ name   │ status │ title              │ impact │ effort │ ROI  │ owner │
├────────┼────────┼────────────────────┼────────┼────────┼──────┼───────┤
│ design │ OPEN   │ Design auth module │ 80     │ 2      │ 40.0 │ —     │
└────────┴────────┴────────────────────┴────────┴────────┴──────┴───────┘

Tree of build  (blockers below; --down for dependents)
build  OPEN  Build auth module
└── design  OPEN  Design auth module
```

`build` is absent from `mu task next` because `design` blocks it.
Close `design` and `build` becomes ready. Details: [§ 3](#3-create-a-workstream),
[§ 4](#4-plan-some-work-as-a-dag).

### 0.2 The dispatch loop: spawn, claim, send, wait, close

```bash
mu agent spawn worker-1 -w auth --cli sh    # --cli pi for a real agent
mu task claim design -w auth --for worker-1
mu agent send worker-1 -w auth 'Design the auth module, then: mu task close design --evidence "..."'
mu task wait design -w auth --timeout 60    # blocks until CLOSED
mu agent close worker-1 -w auth
```

```
Spawned worker-1 (sh) in window worker-1 of mu-auth, pane %88

Claimed design for worker-1 (OPEN → IN_PROGRESS)
Next:
  Drop a note (single-quote to defer shell expansion) : mu task note design 'FILES: ...\nDECISION: ...' -w auth
  Close with grounding                                : mu task close design --evidence "..." -w auth
  Release if blocked                                  : mu task release design -w auth

sent 23 bytes to worker-1

all-of 1 reached CLOSED in 4094ms
  ✓ design (CLOSED)

Closed worker-1
```

Exit codes from `mu task wait`: `0` met, `5` timeout, `6` the owning
pane died, `7` stalled (with `--on-stall exit`). See
[§ Wait exit codes](#wait-exit-codes-mu-task-wait).

`mu agent send` verifies delivery. If it prints `warning: ... was NOT
submitted`, the text is sitting unsubmitted in the pane — the agent has
not seen it. That is the failure mode `exit 0` used to hide; check
before you wait on the task.

### 0.3 Laptop ↔ devserver

Same `MU_SYNC_DIR` on both machines. No export step, no import step, no
sync verb in the loop.

```bash
# both machines, in your shell rc
export MU_SYNC_DIR=$HOME/Sync/mu

# laptop
mu workstream init app
mu task add auth_fix -w app -t "Fix the auth redirect" -i 80 -e 2

# devserver — the ordinary command already ingested it
mu task list -w app
mu task close auth_fix -w app --evidence "shipped in #412"

# laptop
mu task show auth_fix -w app
```

```
┌──────────┬────────┬───────────────────────┬────────┬────────┬──────┬───────┐
│ name     │ status │ title                 │ impact │ effort │ ROI  │ owner │
├──────────┼────────┼───────────────────────┼────────┼────────┼──────┼───────┤
│ auth_fix │ OPEN   │ Fix the auth redirect │ 80     │ 2      │ 40.0 │ —     │
└──────────┴────────┴───────────────────────┴────────┴────────┴──────┴───────┘

Closed auth_fix (OPEN → CLOSED)
  evidence: shipped in #412

auth_fix  —  Fix the auth redirect
  workstream : app
  status     : CLOSED
  ...
Notes (1)
  2026-08-02T05:49:15.361Z  worker-2
    CLOSE: shipped in #412
```

**Both machines edit at once.** Merges are per-FIELD, so different
fields of the same task both survive:

```bash
# laptop                                # devserver
mu task update t1 -w app --impact 95    mu task close t1 -w app
```

```
# both machines, after both have synced:
t1  —  Concurrent demo
  status     : CLOSED
  impact     : 95
```

Same field on both machines: the newer HLC wins, silently. Peer status
is `mu sync`; a torn transfer is `mu sync --repair <peer-prefix>`. Full
section: [§ 15.6](#156-multi-machine-sync).

### 0.4 I made a mistake

Every user-visible action is one **group** of ops. Find it, preview,
apply.

```bash
mu task update build -w auth --impact 5     # oops
mu undo                                     # what can I undo?
mu undo 6380dd3d                            # preview (dry run)
mu undo 6380dd3d --yes                      # apply
```

```
mu undo — most recent undoable action:
  6380dd3d  task.update — 1 op

recent groups (newest first):
  * 6380dd3d  task.update — 1 op
    1abb5038  task.add — 2 ops
    4f93f1df  task.add — 1 op
    70af8fb8  workstream.init — 1 op

mu undo 6380dd3d — would revert task.update
  restore task auth/build impact=80 updated_at=2026-08-02T05:49:34.545Z

(dry-run; rerun with --yes to apply)

Undid 6380dd3d (task.update)
  task auth/build impact=80 updated_at=2026-08-02T05:49:34.545Z
  1 row change(s), recorded as group 3814ed17
  This undo is itself undoable: mu undo 3814ed17 --yes
```

The undo is itself a group — `mu undo 3814ed17 --yes` is redo. Any
unique prefix of a group id works. Undo reverts ROWS: killed panes and
freed workspace dirs do not come back. See
[§ Undoing one action](#undoing-one-action-mu-undo).

### 0.5 Something looks wrong

```bash
mu doctor           # exit 0 healthy, 5 on drift
mu doctor --deep    # full rebuild + field diff; slower
```

```
mu doctor

environment
  tmux             : ok (tmux 3.7b)
  $TMUX            : set
  $TMUX_PANE       : %21
  $MU_SESSION      : auth

db
  path             : /tmp/mu-play.db
  schema           : ok (10 tables)
  schema_version   : 9
  journal_mode     : wal
  foreign_keys     : on

workstream
  current          : auth

state (workstream=auth)
  agents           : 0
  tasks            : 2 (ready 1, blocked 1, in-progress 0)
  ops rows         : 1
  ghosts           : none
  orphan panes     : 0

fleet
  db-vs-sync       : ok MU_SYNC_DIR not set (no sync configured)
  db-filesystem    : ok DB is on local (0x1021994)
  name-case        : ok no case-colliding workstream names

ops log
  drift (shallow)  : ok every live row has ops (1ms) — run `mu doctor --deep` for the full rebuild diff
```

**On drift**, `--deep` names the exact table, key and field:

```
ops log
  drift            : FAIL 1 divergence(s) (16ms)
      tasks auth/build.title: live=TAMPERED log=Build auth module
```

Do not rebuild reflexively — which side is right depends on the cause.
In order:

```bash
mu db backup /tmp/mu-drift-evidence.db      # 1. preserve the evidence
mu rebuild /tmp/mu-rebuilt.db               # 2. materialize what the log believes
MU_DB_PATH=/tmp/mu-rebuilt.db mu sql "SELECT local_id, title FROM tasks"   # 3. compare
```

Then report it: drift is a capture/apply bug, and the named
table/key/field is the reproduction. See
[§ What to do when drift is reported](#what-to-do-when-drift-is-reported).

### 0.6 Upgrading from mu 0.4.x

`mu` refuses to open a pre-v9 DB (`SchemaTooOldError`, exit 4) and
leaves the file alone. A sidecar, `scripts/migrate-to-1.0.ts`, imports
a pre-1.0 DB into a fresh v9 one; you run it once, by hand, against a
copy. Workstreams, tasks, edges and notes come across; agents,
workspaces and ownership do not.

Full recipe and flags: [scripts/README.md](../scripts/README.md).
Summary here: [§ 15.7](#157-coming-from-mu-04x).

---

## 1. Setup

From npm (the common path):

```bash
npm install -g @martintrojer/mu
mu --version             # → the current version
```

Update later via `npm install -g @martintrojer/mu@latest`.

From a local checkout (when hacking on mu itself):

```bash
npm install -g .         # `prepare` script auto-builds; `mu` lands on $PATH
mu --version             # → the current version (see package.json)
```

To update the source-installed copy: pull from upstream, then
`npm install -g .` from inside the checkout. The `prepare` script
rebuilds before linking the new dist/.

### Install the bundled skill

Mu ships a skill at `skills/mu/SKILL.md` that teaches the LLM running
inside an agent pane how to use mu. The canonical install path is the
[skills CLI](https://github.com/vercel-labs/skills), which auto-detects
every supported agent (pi, claude-code, codex, opencode, cursor, ...)
and installs into the right per-agent location:

```bash
npx skills add martintrojer/mu          # interactive: pick scope + agents
npx skills add martintrojer/mu -g -y    # global, no prompts (pi: ~/.pi/agent/skills/mu/)
npx skills update mu                    # later, to refresh
```

Hacking on the skill itself? Point the skills CLI at your checkout so
edits flow straight through:

```bash
npx skills add ./skills/mu              # local-path source format (symlinks)
```

Without the skills CLI, the skill is just a directory with a
`SKILL.md` — symlink or copy it into the agent's skills dir. For pi:
`~/.pi/agent/skills/mu/` (global) or `.pi/skills/mu/` (per-project).
The cross-tool `~/.agents/skills/mu/` is picked up by pi and several
others:

```bash
# From an npm-global install
mkdir -p ~/.agents/skills
ln -sf "$(npm root -g)/@martintrojer/mu/skills/mu" ~/.agents/skills/mu

# Or from a checkout
ln -sf "$PWD/skills/mu" ~/.agents/skills/mu
```

### For mu hackers: alias to the build output

Fastest iteration when hacking on mu itself:

```bash
npm install              # deps only
npm run build            # produces dist/
alias mu="node $PWD/dist/cli.js"
```

See [README.md § Install](../README.md#install) for the full set of
install patterns.

mu requires a terminal multiplexer. tmux ≥ 3.0 is the complete
backend and what the rest of this guide assumes; herdr is supported
for topology but not yet for spawn/send/read (see
[§ 20](#20-multiplexer-backends-tmux-and-herdr)). Make sure you're
inside a session before proceeding:

```bash
tmux       # if you're not already in one
```

---

## 2. Get oriented

For a human at a terminal, bare `mu` is the home base: it launches the
read-only TUI with every workstream on the machine loaded as tabs.
Initial tab focus ladder: `$MU_SESSION` naming a loaded workstream →
current tmux session named `mu-<workstream>` → cwd inside a registered
workspace → cwd at the VCS-derived project root of any loaded
workstream (newest activity wins ties) → tab 0. With no workstream yet
it prints help plus the start command:

```bash
mu
# Get started: mu workstream init <name>
```

For scripts, agents, CI, and pipes, bare `mu` does NOT enter the TUI:
when stdout is not a TTY it prints `mu --help`. Use explicit typed
verbs and `--json` for the API surface:

```bash
mu state -w <workstream> --json
MU_NO_TUI=1 mu             # force the non-TTY/help path even in a terminal
```

Run `mu doctor` to check tmux + DB health — full annotated output in
[§ 0.5 Something looks wrong](#05-something-looks-wrong). Two families
of checks are the ones to know.

**Mixed-fleet hazards** (the `fleet` section) — cheap, and every one is
something you can fix before it costs you data:

| Row | Means |
| --- | --- |
| `db-vs-sync` | **FAIL** if `MU_DB_PATH` is inside `MU_SYNC_DIR`. Never do this: a live WAL-mode SQLite DB is three files (`mu.db`, `-wal`, `-shm`) whose mutual consistency IS its durability, and a file-syncer copying them out of order — or resurrecting a peer's stale `-wal` — silently corrupts the database. mu syncs append-only per-machine **segments** so the DB file never has to travel. |
| `db-filesystem` | **WARN** if the DB is on NFS/SMB/sshfs. WAL needs working advisory locks and a shared-memory file; network mounts provide neither reliably. Symptom is `database is locked` with no contention, or corruption with it. |
| `name-case` | **WARN** if two workstream names differ only by case. They coexist on Linux but collide on macOS (APFS) and Windows, and a workstream name IS a tmux session name and seeds workspace paths — so a Mac joining the fleet sees one session where Linux sees two. |

**Ops-log drift** (the `ops log` section) — is the projection still
faithful to the log? Undo, sync and history are all
projections of the ops log, so a capture bug breaks all four at once,
silently. Two tiers:

```bash
mu doctor           # shallow: every live row must have >=1 op. ~3ms.
mu doctor --deep    # full rebuild + field-level diff. ~0.6ms per op.
```

The default is shallow so `mu doctor` stays reflexive; the deep check
rebuilds the whole log (~2.3s on a 1000-task DB). Shallow catches an
uncaptured INSERT or DELETE and is blind to an uncaptured UPDATE (the
row's key still has ops). Run `--deep` when you suspect something, in
CI, or before a release. Either tier exits **5** on drift.

### What to do when drift is reported

Drift names the exact table, key and field, e.g.:

```
  drift            : FAIL 2 divergence(s) (12ms)
      tasks demo/a.title: live=TAMPERED log=A
      tasks demo/a.impact: live=7 log=60
```

**Do not rebuild reflexively.** Drift means the log and the tables
disagree, and which side is right depends on the cause:

- If **capture** missed a mutation, the LIVE tables hold real work the
  log never recorded — rebuilding would discard it.
- If **apply** is lossy, the log is authoritative and a rebuild fixes it.

So, in order:

```bash
mu db backup /tmp/mu-drift-evidence.db   # 1. preserve the evidence FIRST
mu rebuild /tmp/mu-rebuilt.db            # 2. materialize what the log believes
# 3. compare the named keys in both files and decide which side is correct:
MU_DB_PATH=/tmp/mu-rebuilt.db mu sql "SELECT local_id, title, impact FROM tasks"
```

Then report it. Drift is a capture/apply **bug**, not operator error, and
the named table/key/field is the reproduction.

### Undoing one action (`mu undo`)

Undo emits **inverse ops** for one **group** (one user-visible action).

```bash
mu undo                      # what would I undo? lists recent groups + ids
mu undo 1a2a94eb             # preview the inverse (dry run)
mu undo 1a2a94eb --yes       # apply it
```

Three properties:

- **Granular.** Only the rows that action touched. A cascade close wrote
  N task ops under one group, so undoing it reopens exactly those N.
- **Itself an op.** The undo lands in its own group, so it syncs to peers
  and is **itself undoable** — that is redo:
  `mu undo <the-undo-group> --yes`.
- **Refuses to clobber newer work.** If a later action changed the same
  fields, undo exits 4 and names the conflict:

  ```
    WARNING: this group has been SUPERSEDED by later work.
      demo/a: impact was changed since by e04df0d5 (task.update)
    Undoing would DISCARD that newer work. Pass --force with --yes to do it anyway.
  ```

  `--force` is the override, and it says what it destroys.

Rows only: undo does not resurrect killed tmux panes or freed workspace
directories. For whole-DB recovery from the log, use `mu rebuild <file>`.

Get the full command list:

```bash
mu --help
```

Every verb's `--help` is exhaustive (flags, defaults,
interactions). Every successful invocation also prints a dim
`Next:` block of suggested follow-up commands at the bottom —
you never have to leave the terminal to learn what to do next.

Every verb accepts `--json` for machine-readable output. Errors
in `--json` mode emit a `{ error, message, nextSteps, exitCode }`
record to stderr; the `nextSteps` array carries resolutions you can
`eval` directly.

### CLI conventions: validation errors

Every operator-error path — missing required option, unknown option,
unknown subcommand, missing positional, type-coercion failure, mutex
flags, range checks — produces a uniform surface:

- **Human path**: red `error: <msg>` on stderr, then the failing
  subcommand's `--help` block (same text as `mu <verb> --help`),
  then exit **2**.
- **`--json` path**: a structured envelope on stderr:

  ```json
  {
    "error": "UsageError",
    "message": "--self and --for are mutually exclusive",
    "nextSteps": [],
    "exitCode": 2,
    "usage": {
      "command": "mu task claim",
      "synopsis": "mu task claim [options] <id>",
      "description": "...",
      "args":    [{"name": "id", "required": true, "variadic": false, "description": ""}],
      "options": [{"flags": "--self", "description": "...", "mandatory": false, "valueRequired": false}, ...]
    }
  }
  ```

  `usage.options[].mandatory` is `true` when the operator MUST pass
  the option (`.requiredOption()` in commander terms). `valueRequired`
  is `true` when the option's argument can't be omitted if the flag
  IS passed (`<value>` form vs bare flag). The two are independent.

Exit 2 is the consistent code for the whole operator-error class —
commander mistakes and handler-thrown `UsageError`s alike. Other
classes keep their own codes (3 = not found, 4 = conflict, 5 =
substrate, 6 = reaper, 7 = stall).

### CLI conventions: `--json` collection envelope

Collection-read verbs emit a canonical `{items: T[], count: number}`
shape on stdout:

```bash
$ mu task list -w foo --json
{"items":[{"name":"a",...},{"name":"b",...}],"count":2}
```

`count` is `items.length` pre-computed so `jq '.count'` is one less hop
than `jq '.items | length'`. `mu workspace commits --json` adds `vcs`,
`baseRef`, and `workspacePath` siblings.

Applies to: `mu task list / next / owned-by / notes`,
`mu workstream list`, `mu workstream destroy --empty` (dry-run),
`mu workspace list / orphans / commits`,
`mu undo` (group list), `mu log -n N` (read).

Two carve-outs:
- **`mu sql --json`** keeps bare-array rows. The verb is the typed-
  escape hatch; row shape is per-query, not part of the typed
  contract.
- **`mu log --tail --json`** emits NDJSON (one JSON object per line)
  because it's a stream, not a collection. Stream consumers want one
  envelope per row, not a single envelope that grows forever.

Singleton verbs (`mu task show`, `mu agent show`, `mu workstream init`,
`mu task close`, ...) use object envelopes with named top-level fields
(`{task, blockers, dependents, notes}`, `{taskName, ..., nextSteps}`).
`items + count` is for collection reads only.

### CLI conventions: multi-value flags

Multi-value flags accept repeated invocations
(`--blocked-by a --blocked-by b`), a comma-separated value
(`--blocked-by a,b`), or any mix. The signal is `<value...>` in the
help-text metavar. Variadic positionals (`mu task wait a b c`) stay
space-separated — operands are not commas, and single-valued flags
(`-w`, `--title`) stay single.

- `--by` on `mu task block` / `mu task unblock` is multi-value:
  `mu task block c --by a,b` adds both edges in one call.
- `--status` on `mu task list` / `mu task next` is multi-value and
  returns the union. Omitting it applies no filter.
- `mu task wait --status` stays single — "wait until reaches THIS
  status".

**Empty vs blank fragments.** An *empty* fragment is dropped: a
trailing or doubled comma is a typing artifact, so `--status "OPEN,"`
means `[OPEN]`, and `mu task reparent --blocked-by ''` is the
documented "clear every blocker" sentinel. A *blank* fragment — one
that is entirely whitespace, like `--status " "` or the tail of
`--status "OPEN, "` — is a usage error (exit 2) naming the flag. Nobody
means "filter by the space character", and dropping it silently would
return a different answer than the one typed. Same rule for `-w`,
`--by`, and `--blocked-by`; see docs/VOCABULARY.md § Empty vs blank
flag fragments.

### CLI conventions: flag vs positional

The rule the CLI follows:

> **The primary entity a verb acts on is POSITIONAL. Everything
> else — scoping, modifiers, payload — is a flag.**

So `mu task close <id>`, `mu agent send <name> <text>`,
`mu workstream init <name>`. The workstream
is a *scope* for most verbs (`-w`) — but for `mu workstream <verb>` it
IS the primary entity, so it may be positional:

```bash
mu workstream init  v2                 # positional
mu workstream destroy v2 --yes         # positional (aliases -w)
mu workstream destroy -w v2 --yes      # -w still works
mu workstream export v2 --out ./bucket # positional (aliases -w)
```

Passing both a positional and a disagreeing `-w` is a usage error
(exit 2), not a silent pick-one.

Where sibling verbs supply a payload two ways, the flag form is an
ADDITIVE alias so muscle memory carries across:

```bash
mu task add t -t T -i 5 -e 1 --note "context"   # note as a flag
mu task note t "more context"                   # positional
mu task note t --text "more context"            # --text alias
```

Supplying both shapes at once is a usage error (exit 2).

---

## 3. Create a workstream

A **workstream** is mu's unit of organization. One workstream = one
tmux session = one logical project. Multiple workstreams on the same
machine are isolated (partitioned in the SQLite registry by
`session_id`); they never see each other's agents.

```bash
mu workstream init auth-refactor
```

```
Created workstream auth-refactor (tmux session mu-auth-refactor)
Next:
  Attach the tmux session : tmux a -t mu-auth-refactor
  Plan tasks              : mu task add -w auth-refactor --title "..." --impact 50 --effort-days 1
  Spawn an agent          : mu agent spawn <name> -w auth-refactor
  See state               : mu state -w auth-refactor
```

Behind the scenes: `tmux new-session -d -s mu-auth-refactor` plus a
placeholder window so the session is non-empty. It sits detached,
waiting for agents.

To see what's already on the machine before picking a name:

```bash
mu workstream list
```

```
┌────────────────────────────────────────┬───────┬────────┬───────┬───────┬───────┬────────┐
│ name                                   │ tmux  │ agents │ tasks │ edges │ notes │ parked │
├────────────────────────────────────────┼───────┼────────┼───────┼───────┼───────┼────────┤
│ auth                                   │ —     │ 0      │ 2     │ 1     │ 0     │ —      │
├────────────────────────────────────────┼───────┼────────┼───────┼───────┼───────┼────────┤
│ mu                                     │ alive │ 0      │ 0     │ 0     │ 0     │ —      │
└────────────────────────────────────────┴───────┴────────┴───────┴───────┴───────┴────────┘
```

The list is the **union** of three sources: distinct workstreams in
`agents`, in `tasks`, and tmux sessions matching `mu-*`. A freshly
`init`'d workstream with no tasks shows up via its session; one whose
session was killed externally shows up via its surviving DB rows, so
you can still `mu workstream destroy` it.

### How mu finds your active workstream

Every command after `init` needs to know which workstream you're in.
Resolution order, first match wins:

1. **`--workstream <name>` flag** explicitly
2. **`MU_SESSION` env var** (`export MU_SESSION=auth-refactor`)
3. **Current tmux session name** (mu reads `tmux display-message -p '#S'` and strips the `mu-` prefix)
4. Error if none of the above

The third option is the most ergonomic. Once you `tmux a -t
mu-auth-refactor`, every command "just works" without flags.

### Off-the-cuff agents: the `scratch` workstream

When you just want one helper agent you can keep talking to — not a
crew, not a task DAG, not per-agent workspaces — skip the `init` step
entirely and spawn into the reserved `scratch` workstream:

```bash
mu agent spawn helper -w scratch          # auto-creates mu-scratch
mu agent send helper 'Investigate the failing test in foo.spec.ts'
mu agent read helper -n 50                # check on it anytime
mu agent close helper -w scratch          # done
```

`scratch` is a shared, ephemeral bucket: it auto-creates on first
spawn, tasks are optional, and idle scratch agents get a staleness
nudge in `mu state` and the TUI so they don't pile up. The name is
**reserved** — `mu workstream init scratch` is rejected;
`mu workstream destroy scratch` works normally.

```
$ mu workstream init scratch
error: workstream name "scratch" is reserved: it is the off-the-cuff bucket and auto-creates on first spawn. Don't 'init' it.
Next:
  Just spawn into it (auto-creates) : mu agent spawn <name> -w scratch
  Use a durable workstream instead  : mu workstream init <name>
```

**When to use which:** `mu workstream init <name>` the moment
coordination *is* the work — multiple agents, dependencies, gated
review. `scratch` for a single driveable helper.
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) when you
only need a one-shot result back.

### The log ledger: durable watcher dedupe + memory

A watcher loop reacting to external state — a PR's CI status, a queue
depth, a file's mtime — must remember *what it last saw* so it doesn't
act twice. Don't keep that in the agent's chat context: it evaporates
on compaction and dies with the loop. Use a custom `--kind` tag on the
activity log as an append-only **ledger**:

```bash
# Watcher tick: record what you saw and what you did about it.
mu log -w scratch --kind pr-state 'pr=1234 sha=abc ci=red -> spawned fixer-1'

# Next tick: reconstruct the last-seen state (latest entry of that kind).
mu log -w scratch --kind pr-state -n 1 --json
# {"items":[{"seq":8695,...,"kind":"pr-state",
#            "payload":"pr=1234 sha=abc ci=red -> spawned fixer-1"}],"count":1}
```

The dedupe rule: read the latest `pr-state`, compare its `sha`/`ci` to
what you observed, act only on a difference. The ledger lives in the
`ops` log, so it survives loop death and context compaction.

- **Pick a stable `--kind`** per ledger (`pr-state`, `queue-depth`).
  `mu log --kind <tag>` filters to it, so ledgers coexist in one
  workstream.
- **One line per tick, latest wins.** `-n 1` for the most recent;
  `--since <seq>` replays history a dead watcher missed.
- **Free-form payload.** mu doesn't parse it. Ledger lines have no
  **intent**, so `mu log` prints them verbatim rather than rendering
  them as a verb.

A *convention*, not a feature — `mu log` already has `--kind`,
`--since`, and `--json`. See **log ledger** in
[VOCABULARY.md](VOCABULARY.md).

`--kind` is the operator's channel tag; `--intent` filters on what *mu*
recorded (`--intent task.close`). Two axes, two flags.

---

## 4. Plan some work as a DAG

Tasks have **mandatory** `impact` (1–100) and `effort-days` (>0).
Edges are blocks-relationships, expressed as **`--blocked-by`** on
`mu task add` (and `mu task reparent`): `--blocked-by design` means
"can't start until `design` closes". Tasks are **scoped to a
workstream**.

```bash
# -w can be omitted inside the workstream's tmux session, or with
# $MU_SESSION exported.
mu task add design -w auth-refactor --title "Design auth module" --impact 80 --effort-days 2
mu task add build  -w auth-refactor --title "Build auth module"  --impact 80 --effort-days 5 --blocked-by design
mu task add review -w auth-refactor --title "Review auth module" --impact 60 --effort-days 1 --blocked-by build
```

See [§ 0.1](#01-first-5-minutes) for the output. Add initial context at
creation time with `--note` (shell escapes like `\n` are translated as
in `mu task note`); `--note-author <name>` overrides the actor label:

```bash
mu task add bugfix \
  --workstream auth-refactor \
  --title "Fix token refresh race" \
  --impact 70 --effort-days 1 \
  --note 'REPRO: login, wait 24h, refresh\nSCOPE: auth refresh only' \
  --note-author orchestrator
```

Task creation + the initial note are one transaction: if either part
fails, neither lands.

Ids validate against `/^[a-z][a-z0-9_-]{0,63}$/` and reject duplicates.
`mu task add x --blocked-by y` when `y` already transitively depends on
`x` refuses with a `CycleError`.

**Task ids are per-workstream unique.** Cross-workstream references use
the qualified form `<workstream>/<id>`. Blocks-edges are always
same-workstream — a blocker outside the target workstream is a
`CrossWorkstreamEdgeError`.

### Modeling external dependencies

When a task is waiting on something outside this repo (an upstream PR
shipping, a vendor releasing v3 of an API, a coworker's review), don't
reach for a new status — add a **placeholder task** for the external
thing and `--blocked-by` it. The DAG already encodes "blocked":

```bash
mu task add upstream_react_19_lands -w gchatui-node \
  --title "Wait for React 19 release (vendor)" \
  --impact 30 --effort-days 0.1
mu task note upstream_react_19_lands -w gchatui-node \
  "Tracking https://github.com/facebook/react/issues/...
Last checked: 2026-05-15.
When this lands: bump react in package.json + re-run upgrade tasks."

mu task add migrate_to_use_action -w gchatui-node \
  --title "Migrate ChatInput to React 19 useActionState" \
  --impact 60 --effort-days 1 \
  --blocked-by upstream_react_19_lands
```

When the upstream lands, `mu task close upstream_react_19_lands
--evidence "shipped 2026-08-12"` — the dependent flips from blocked
to ready in the same render. If the upstream gets cancelled, `mu task
reject upstream_react_19_lands --cascade --yes` propagates REJECTED
through every dependent so you re-think the cascade explicitly.

Why this beats a `BLOCKED` status: the placeholder's notes are the
audit trail, one placeholder blocks N downstream tasks, reject cascade
just works, and the placeholder's own status carries the detail
(`OPEN` = someone external is on it, `DEFERRED` = parked,
`IN_PROGRESS` = you're chasing it).

---

## 5. See the graph (dashboard + state API)

`mu` exposes one logical "what's going on?" view with two renderers:

| Surface              | Use it for                                                      |
| -------------------- | --------------------------------------------------------------- |
| **bare `mu`**        | A human at a terminal — launches the interactive TUI dashboard. |
| **`mu state --tui`** | Same TUI, explicitly opt-in. Useful in scripts / aliases.       |
| **`mu state`**       | Static text card. JSON-friendly; pipeable; `watch`-able.        |
| **`mu state --json`** | The canonical full snapshot. Agents and scripts read this.     |

The interactive surface has its own section:
[§ 5b. The TUI dashboard](#5b-the-tui-dashboard-interactive), below.
The rest of this section is the static / JSON contract.

### Static state card (`mu state`)

For an agent/script or a static capture, use explicit `mu state`:

```bash
mu state -w auth-refactor          # human-readable card
mu state -w auth-refactor --json   # full snapshot
mu state --all --json              # every workstream on this machine
```

The static card carries every section the TUI cards summarize: agents +
orphans + tracks + ready / in-progress / blocked / recent-closed tasks
+ workspaces + recent events.

**JSON shapes**

- single-ws: flat `{ workstreamName, agents, orphans, tracks, ready,
  blocked, inProgress, recentClosed, workspaces, recent }`.
- multi-ws: wrapped `{ workstreams: [{...}, ...] }`.
- bare `mu --json` prints `--help`; use `mu state --json`.
- `--tui` is render-only and incompatible with `--json`.

**Multi-workstream**: repeat `-w`, or `--all`. In static mode N≥2
stacks one card per workstream.

`tmux display-popup -E 'mu state -w X'` works for popup-card use.

---

## 5b. The TUI dashboard (interactive)

The interactive TUI is mu's human surface. It is **read-only** —
every act-intent `y`anks the canonical `mu` command to
your clipboard so you run mutations from your shell, with one
documented escape (`t` in git-show drills runs `tuicr` in the project
root, see below).

### Launch

```bash
mu                              # bare; opens the TUI when stdout is a TTY
mu state --tui                  # explicit; same surface
mu state --tui -w a,b           # restrict to specific workstreams
mu state --tui --all            # all workstreams (default for bare `mu`)
MU_NO_TUI=1 mu                  # force the help path even in a TTY
mu --json                       # also forces help; pipe `mu state --json`
```

Quit with `q` or `Ctrl-C`. The dashboard restores your scrollback
on exit (alt-screen).

**Initial active tab** is picked from this ladder:
`$MU_SESSION` → current tmux session name (`mu-<ws>`) → cwd inside a
registered workspace → cwd at the VCS-derived project root of any
workstream (newest activity wins ties) → tab 0.

### Layout: 10 cards, responsive columns

The dashboard renders 10 toggleable cards with rounded borders and
section headers inset into the top border line (lazygit / btop / k9s
convention):

| Slot | Card          | Toggle | Popup     | Content                                              |
| ---- | ------------- | ------ | --------- | ---------------------------------------------------- |
| 0    | Commits       | `0`    | `Shift+0` | Recent project-root commits (git / jj / sl)          |
| 1    | Agents        | `1`    | `Shift+1` | Active agents + status + cli + role                  |
| 2    | Tracks        | `2`    | `Shift+2` | Parallel tracks (union-find clusters)                |
| 3    | Ready (Tasks) | `3`    | `Shift+3` | Ready-to-claim tasks (no open blockers)              |
| 4    | Activity log  | `4`    | `Shift+4` | Recent ops rendered as prose                         |
| 5    | Workspaces    | `5`    | `Shift+5` | Per-agent VCS workspaces + behind/dirty status       |
| 6    | In-progress   | `6`    | `Shift+6` | IN_PROGRESS tasks owned by agents                    |
| 7    | Blocked       | `7`    | `Shift+7` | Tasks with at least one open blocker                 |
| 8    | Recent        | `8`    | `Shift+8` | Recently CLOSED tasks                                |
| 9    | Doctor        | `9`    | `Shift+9` | Cheap health checks (schema, ghosts, orphans, …)    |
| —    | DAG           | —      | `g`       | Full task DAG forest (keybind-only)                  |
| —    | All tasks     | —      | `t`       | Sortable / filterable list of every task             |

Digit toggles HIDE / SHOW the card on the dashboard; `Shift+digit`
opens the matching fullscreen popup. **Single-popup invariant**: only
one popup is visible at a time; `Esc` / `q` returns to the dashboard
with all toggles + tick rate preserved.

**Responsive layout**: cards stack below 120 cols, then reflow into
pair-aware 2 / 3 / 4-column layouts at 120 / 180 / 240 cols. Each
visible card gets a dynamic row budget so a noisy list cannot crowd
out its siblings; overflow shows as `+N more · Shift+N` inset into
the bottom border. On short panes the dashboard culls low-priority
cards (Doctor → Recent → Workspaces → …) and shows
`+N cards hidden · resize taller`.

Ordering is slot-stable: within each column, non-stream cards go by
toggle digit ascending; stream cards (Commits, Activity log) trail,
with slot 0 last.

### Multi-workstream tabs

With N≥2 workstreams (bare `mu` on a multi-workstream machine, or
`mu state --tui -w a,b,c`), a tab strip renders above the cards:

```
workstreams: ▸ auth-refactor · ui-rewrite · demo   (Tab / Shift-Tab)
```

- `Tab` cycles forward, `Shift-Tab` backward (suppressed inside popups
  that bind the key locally).
- The active tab name shows in the status bar next to the tick rate.
- Cards / popups operate on the active tab — no per-row workstream
  column. For N=1 the strip renders nothing.
- Wider than the terminal: the strip windows around the active tab and
  shows `‹N` / `›N` counters for hidden workstreams.
- `*` prefix (e.g. `*scratch`) marks the ephemeral `scratch` bucket;
  `~` marks a workstream presumed parked on another machine. `~` wins.

### Popup drills

`Enter` in any list popup drills into the focused row. Where the
row is itself an entity (a task), a further `Enter` chains into the
shared read-only task-detail leaf (notes timeline):

- **Tracks popup (`Shift+2`)**: list of tracks → `Enter` opens the
  track's task list → `Enter` opens that task's notes timeline.
- **Ready / In-progress / Blocked / Recent / All-tasks**:
  list of tasks → `Enter` opens notes; `y` yanks `mu task show <id>`
  (or `mu task claim` / `mu task close` / `mu task tree` depending
  on popup).
- **Activity log popup (`Shift+4`)**: list of events → `Enter`
  drills into the full untruncated payload of the focused event;
  `y` yanks `mu log --since <seq-1> -n 1 -w <ws>`.
- **Workspaces popup (`Shift+5`)**: list of workspaces → `Enter`
  opens the commits-since-fork list → `Enter` on a commit opens
  the inline `git show <sha> --stat -p` view; `y` yanks `git show
  <sha>`; `t` launches `tuicr -r <sha>`.
- **Commits popup (`Shift+0`)**: project-root recent commits →
  `Enter` opens the backend's show view; `y` yanks the show
  command; `t` launches `tuicr`.
- **Doctor popup (`Shift+9`)**: list of checks → `Enter` opens
  the remediation paragraph for the focused check.
- **DAG popup (`g`)**: keybind-only; renders the active workstream's
  full task DAG forest (one ASCII subtree per root, diamond-collapse
  marker on repeated nodes).

One `Esc` / `q` backs out per recursion level. Drills auto-refresh in
step with the dashboard tick (fast 1s for SQL bodies like notes, slow
10s for subprocess git-show / scrollback). Scroll position survives
refreshes, and subprocess loaders keep the prior body visible until the
new one arrives.

### Search / filter

`/` inside any list popup enters an incremental case-insensitive
substring filter (lazygit / k9s convention). Printable characters
append, `Backspace` pops, `Esc` cancels, `Enter` commits (keeps the
filter, resumes `j/k` navigation), and `/` again refines. The filter
blob is per-popup — agent name/status/cli/role; track head id + title;
task name/title/status/owner; log verb/payload/source — and dies with
the popup.

Task-list popups add **per-status toggles** (`o` / `i` / `c` / `r` /
`d` for OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED; default
all-on). The All-tasks popup adds **sort cycle** on `s`: `roi` →
`recency` → `age` → `id`.

### Mouse

Navigation-in only: double-click a dashboard card to open its popup,
double-click a popup row to drill one level deeper, and scroll-wheel
inside a popup list / drill body to move the cursor or scroll. There is
**no mouse back binding** — use `Esc` / `q`.

### Yank contract (`y`) and the `tuicr` escape (`t`)

Every popup row exposes one canonical `mu` command via `y`, which goes
to your system clipboard (pbcopy / wl-copy / xclip / xsel / clip.exe,
OSC-52 fallback). You run it in your shell; the TUI never mutates.

The one escape is **`t`** inside a `git show` drill (Workspaces or
Commits popup): mu suspends its alt-screen, runs `tuicr -r <sha>` in
the project root / workspace cwd, and restores the dashboard when tuicr
exits. The operator drives another TUI tool; mu still performs no
mutation.

Status cells colour-code as in the static CLI tables: OPEN cyan,
IN_PROGRESS yellow, CLOSED green, REJECTED red, DEFERRED dim/gray.

### Polling tiers

The dashboard has two refresh tiers:

- **Fast tick** (default 1s, adjustable with `+` / `-` / `=` /
  `0`): SQL-only. Refreshes tasks, tracks, workspace registry rows,
  and the activity log.
- **Slow tick** (10s, fixed): subprocess-backed. Refreshes
  tmux-derived agent liveness / orphans, workspace dirty flags,
  recent project commits, and the Doctor summary.

The last slow-tier result is merged into every fast render so cards
do not flicker through a loading state. `r` / F5 refreshes both
tiers immediately. Tab / Shift-Tab triggers an eager slow refresh
for the newly active workstream.

### Keymap reference

| Mode      | Keys                         | Action                                                         |
| --------- | ---------------------------- | -------------------------------------------------------------- |
| dashboard | `0`-`9`                      | toggle card visibility                                         |
| dashboard | `Shift+0`-`Shift+9`          | open the matching popup                                        |
| dashboard | `g`                          | open DAG popup (keybind-only)                                  |
| dashboard | `t`                          | open All-tasks popup (keybind-only)                            |
| dashboard | `Tab` / `Shift-Tab`          | cycle workstream tabs (N≥2)                                   |
| dashboard | `+` / `-` / `=` / `0`        | adjust fast tick rate (faster / slower / default / pause)      |
| dashboard | `r` / `F5`                   | force refresh both tiers                                       |
| dashboard | `?` / `F1`                   | open help overlay                                              |
| any       | `q` / `Ctrl-C`               | quit (or back out of popup; quits at dashboard)                |
| popup     | `j` / `k`                    | move cursor / scroll                                           |
| popup     | `g` / `G`                    | jump top / bottom                                              |
| popup     | `Ctrl-D` / `Ctrl-U`          | half-page down / up                                            |
| popup     | `PgDn` / `PgUp`              | full page                                                      |
| popup     | `Enter`                      | drill into focused row                                         |
| popup     | `Esc` / `q`                  | back out one level                                             |
| popup     | `y`                          | yank canonical `mu` command for focused row                    |
| popup     | `/`                          | enter filter mode                                              |
| filter    | (printable) / `Backspace`    | edit query                                                     |
| filter    | `Esc`                        | cancel (clear query)                                           |
| filter    | `Enter`                      | commit (keep filter, return to nav)                            |
| task popup| `o` / `i` / `c` / `r` / `d`  | toggle OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED       |
| All-tasks | `s`                          | cycle sort key (roi → recency → age → id)                       |
| git-show  | `t`                          | launch `tuicr -r <sha>` (alt-screen handoff)                   |

`?` shows the same table as a scrollable overlay (j/k/Ctrl-D/U/g/G
also work inside the overlay).

### Read-only invariant

The TUI never executes a mutation — a load-bearing pledge in
`docs/ROADMAP.md`, not an implementation detail. If a TUI gesture
tempts you to mutate state from the SDK, file a roadmap entry first.
Yank-and-run is the cost of keeping the TUI inspectable, scriptable
and recoverable from any shell.

---

## 6. Spawn a crew

For a demo with live status detection, spawn pi agents:

```bash
mu agent spawn worker-1 --workstream auth-refactor          # default --cli is pi
```

To play around without needing pi installed, use `--cli sh`:

```bash
mu agent spawn worker-1 --workstream auth-refactor --cli sh
mu agent spawn worker-2   --workstream auth-refactor --cli sh
```

```
Spawned worker-1 (sh) in window worker-1 of mu-auth-refactor, pane %15
```

What just happened:

1. mu checked the agents table — no `worker-1` yet, OK to proceed
2. mu created a tmux window named `worker-1` in the `mu-auth-refactor`
   session
3. mu set the pane title to `worker-1` via `tmux select-pane -T worker-1`
   — **this is the claim protocol identity**
4. mu inserted a row in `agents` with `pane_id=%15`, `status=spawning`

If the DB insert fails after the pane was created, mu kills the pane
to avoid leaking. If the same name was already taken, mu rejects
**before** calling tmux.

### Naming convention (lint, not a rule)

mu accepts any name matching `/^[a-z][a-z0-9_-]{0,31}$/`, but the
recommended shape is **`<role>-<n>`** — a lowercase role plus the
smallest unused integer suffix (e.g. `worker-1`, `reviewer-2`,
`scout-12`). Names that diverge (`worker-tests`, `alice`, `db-leader`,
`x-y-1`) still spawn successfully but trigger a one-line stderr hint:

```
hint: agent name "worker-tests" does not match the smallest-unused-suffix
convention (<role>-<n>; e.g. worker-1, reviewer-2). Accepted; consider
renaming if you spawn additional workers.
```

The hint is suppressed under `--json` so script callers stay clean.

### Multiple agents in one window (split panes)

Give them a shared `--tab`:

```bash
mu agent spawn reviewer-1 --workstream auth-refactor --cli sh --tab Review --role read-only
mu agent spawn audit --workstream auth-refactor --cli sh --tab Review
```

The `Review` window holds whichever agents share `--tab Review`.

### Spawn options

| Flag                         | Meaning                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `--cli <name>`               | Logical CLI family (effectively always `pi`; the flag exists as a key for `MU_<UPPER_CLI>_COMMAND` resolution) |
| `--command <cmd>`            | Executable launched in the pane. Defaults to `$MU_<UPPER_CLI>_COMMAND` (e.g. `MU_PI_COMMAND=pi-alt`) and finally to the `--cli` value |
| `--tab <name>`               | Group with other agents under this window name          |
| `--role <full-access\|read-only>` | Capability flag; stored but not yet enforced |
| `--cwd <path>`               | Initial working directory for the pane                  |
| `-w, --workstream <name>`    | Required if not auto-detectable                         |

If your `pi` binary lives under a different name, set
`MU_PI_COMMAND=<name>` once in your shell rc: every
`mu agent spawn --cli pi` execs it, and reconcile treats that binary's
panes as agent-worthy when surfacing orphans. `MU_PI_COMMAND` (and
`--command`) accept a multi-word string — tmux execs it via a shell, so
`MU_PI_COMMAND="pi-alt --some-flag"` works. Same pattern for
`MU_CLAUDE_COMMAND` / `MU_CODEX_COMMAND`.

**Project-trust prompt (gotcha).** pi asks whether to trust a project
folder on interactive startup, before loading `AGENTS.md` and `.pi/`
resources. A freshly-spawned agent stuck at `needs_input` is usually
waiting on this. Spawn with `--command 'pi --approve'` (or
`MU_PI_COMMAND="pi --approve"`) to auto-trust. Caveat: `--approve`
trusts whatever directory the pane lands in — including `--workspace`
forks — so use it for crews on your own code only. Otherwise the
decision is saved per-directory in `~/.pi/agent/trust.json`, or run
`/trust` in the pane once.

### Adopt an existing tmux pane

You launched a `pi` by hand and decided mid-flow it belongs in the
graph, or `mu` crashed mid-spawn and left an orphan pane with no DB
row. Either way:

```bash
mu agent list -w auth-refactor   # surfaces orphans at the bottom
# Orphan panes (1)
#   %15 title=worker-2 cli=pi

mu agent adopt %15 -w auth-refactor                    # adopt by pane id
mu agent adopt worker-2 -w auth-refactor               # adopt by pane title (same effect)
mu agent adopt %15 --name investigator -w auth-refactor  # adopt and rename the pane
```

The pane title becomes the agent name (the claim-protocol invariant),
so a pane titled `worker-2` registers as agent `worker-2` with no
further config. Use `--name` when the title isn't a valid agent name.

Adopt is **idempotent** (twice on the same pane is a no-op) and
**scope-aware**: the pane must be in the `mu-<workstream>` tmux
session, or the adopt is rejected — no silent cross-session moves.

---

## 7. Watch the crew live

Attach the workstream's tmux session and you see everything.

```bash
tmux attach -t mu-auth-refactor
```

You see one tmux window per agent (or a window with split panes if
they share a `--tab`).

| Tmux key       | What it does                                  |
| -------------- | --------------------------------------------- |
| `Ctrl+b w`     | Pick a window (interactive list)              |
| `Ctrl+b n`/`p` | Cycle next/previous window                    |
| `Ctrl+b d`     | Detach from the session (mu doesn't care)     |

mu does not require you to be attached. Detach freely.

---

## 8. Send work to an agent

From any shell with mu on `$PATH`:

```bash
mu agent send worker-1 "echo hello from outside"
```

mu uses the **canonical bracketed-paste protocol** internally:

0. wait for the pane to stop being mid-modal (`MU_SEND_READINESS_MS`,
   default 15000; 0 disables)
1. `tmux copy-mode -q` (silent if not in copy mode)
2. `tmux set-buffer` (loads text into a uniquely-named buffer)
3. `tmux paste-buffer -p -d -r` (`-p` = bracketed paste, `-d` = delete
   buffer after paste, `-r` = preserve LF)
4. wait `MU_SEND_DELAY_MS` ms (default 500)
5. `tmux send-keys Enter`
6. confirm the Enter took; re-send it if the text is still sitting
   unsubmitted in the input box

Special characters (`/`, `?`, `!`, `$`, `&&`, `|`, `*`, …) therefore
arrive at the agent's CLI **literally**. Naive `tmux send-keys` would
let the agent's TUI hijack `/` for "search forward" and similar.

The send delay is configurable per call:

```bash
MU_SEND_DELAY_MS=300 mu agent send worker-1 "..."     # faster, less safe
MU_SEND_DELAY_MS=1000 mu agent send worker-1 "..."    # slow remote
```

**Steps 0 and 6 make `exit 0` mean "submitted".** A TUI rendering a
modal accepts a bracketed paste but *swallows the Enter after it*,
leaving the prompt typed-but-unsubmitted. The visible symptom is an
agent idle at `needs_input` with 0.0% context on work it never
received. No `sleep` between a clear and a prompt is needed.

If a send cannot be confirmed it prints `warning: ... was NOT
submitted` to stderr (and `"delivered": false` under `--json`).
**Check for that warning before you wait on the task.**

Sending to a **busy** agent is not delayed — that input queues
normally; only a modal/re-init spinner is waited out.

A **stale** target workspace (≥10 commits behind main — the red bucket
in `mu workspace list` and the TUI Workspaces card) warns on stderr but
still sends:

```bash
WARN: worker-1 workspace is 14 commits behind main (≥10 = stale)
Next:
  Refresh first : mu workspace refresh worker-1 -w auth-refactor
```

`--strict-staleness` refuses instead:

```bash
mu agent send worker-1 "..." -w auth-refactor --strict-staleness
```

Agents without workspaces are skipped (common for read-only roles).
`--json` carries `staleness: null` or `{agentName, workstreamName,
commitsBehindMain, isStale}`.

---

## 9. Read what an agent did

```bash
mu agent read worker-1              # full scrollback
mu agent read worker-1 -n 50        # last 50 lines
```

Both go through `tmux capture-pane`. No state change.

---

## 10. The claim protocol — from inside an agent's pane

An agent (the LLM running in a pane) runs `mu task claim foo` **with no
agent name argument** — mu derives "worker-1" from the pane title. In
worker-1's pane:

```bash
mu task claim design
```

```
Claimed design for worker-1 (OPEN → IN_PROGRESS)
```

Behind the scenes: mu reads `$TMUX_PANE`, asks tmux for that pane's
title (`tmux display-message -t %15 -p '#{pane_title}'`), and runs one
atomic conditional UPDATE guarded on `owner IS NULL OR owner = <me>`.
If 0 rows change, mu distinguishes "task doesn't exist" from "already
owned by someone else" and throws the right typed error.

Two agents claiming the same task → the second fails with "already
owned by worker-1". Re-claim by the same agent is idempotent.

You can also claim explicitly from outside any pane:

```bash
mu task claim build --for worker-2
```

`--for` accepts either a bare worker name (`worker-2`, resolved in
the task's workstream) or a qualified ref `<workstream>/<name>` for
**cross-workstream dispatch**:

```bash
# Task lives in mufeedback-v03; worker-1 lives in roadmap-v0-3.
mu task claim some-task -w mufeedback-v03 --for roadmap-v0-3/worker-1
```

The agent stays in its own workstream — only `tasks.owner_id` points
across the boundary (an INTEGER FK to `agents.id`). A bad qualifier
surfaces typed errors and writes nothing:
`WorkstreamNotFoundError` (exit 3) on a missing prefix,
`AgentNotFoundError` (exit 3) when the worker doesn't live there.

When `--for` targets an agent with a **stale** workspace (≥10 commits
behind main), the claim warns on stderr and succeeds:

```bash
mu task claim build -w auth-refactor --for worker-2
# stderr: WARN: worker-2 workspace is 14 commits behind main (≥10 = stale)
# Next: Refresh first : mu workspace refresh worker-2 -w auth-refactor
```

`--strict-staleness` refuses instead with `TaskClaimStaleWorkspaceError`
(exit 4) — for scripts that must never dispatch onto a stale parent.
`--json` carries `staleness: null` or `{agentName, workstreamName,
commitsBehindMain, isStale}`. Bare in-pane and `--self` claims skip the
check; they don't assign work to a named agent.

### The orchestrator pattern: `--self`

Not every action comes from a registered worker pane. An
*orchestrator* (a top-level pi session, a human at a shell, a deploy
script) often does small work directly. Two roles:

- **Worker** — a pane mu spawned (or you adopted). Has a row in the
  `agents` table. Identity = pane title. Claims with bare
  `mu task claim <id>`. `tasks.owner_id` points at the worker row.

- **Actor** — anything that *causes* a state change, including the
  orchestrator. May or may not have a row in `agents`. Always recorded
  on the op (`ops.actor`).

If the orchestrator tries `mu task claim some-task` directly:

```
conflict: claimer 'pi-mu' (pane %6441) is not a registered mu agent.
  Working directly?           Pass --self to attribute via log instead.
  Dispatching to a worker?    Pass --for <worker> to assign.
  Want full registration?     Run: mu agent adopt %6441
```

Pick one based on intent:

```bash
# Orchestrator does the work itself (most common):
mu task claim some-task --self --evidence "trivial 5-line fix"
#   -> tasks.owner_id stays NULL
#   -> the task.claim op records actor='pi-mu' (anonymous claim)
#   -> mu task show surfaces it as 'owner: (self: pi-mu)'

# Orchestrator dispatches to a worker:
mu task claim some-task --for worker-1
#   -> tasks.owner_id points at worker-1

# Orchestrator wants to BE a registered worker (rare):
mu agent adopt %6441 -w <ws>  # only if pane is in mu-<ws> session
mu task claim some-task     # now works as a normal worker claim
```

`--self` is **only** for unregistered actors. Workers continue to
claim with bare `mu task claim` — nothing changes for them. The
`--actor <name>` flag overrides the auto-detected actor name (defaults
to pane title, or `$USER`, or `unknown`):

```bash
mu task claim deploy --self --actor deploy-bot --evidence "prod release"
```

When `tasks.owner_id IS NULL` because of `--self`, `mu task show` looks
up the most recent `task claim` event for that task and surfaces it:

```
owner      : (self: pi-mu)
```

So provenance is preserved — it just lives in `ops.actor` rather
than being conflated with the FK that points at registered workers.

---

## 11. Drop notes (durable context)

Notes are append-only and survive sessions and agent restarts — the
cure for LLM context loss: the next agent reads the full history.

```bash
mu task note design "DECISION: JWT, 24h expiry, refresh via cookie"
mu task note design "FILES: src/auth.rs:45-120"
```

Read them via the typed verb:

```bash
mu task notes design                          # all notes, oldest first
mu task notes design --tail 3                 # only the last 3 (alias --last)
mu task notes design --since 2026-01-01       # only notes after an ISO 8601 cutoff
mu task notes design --since-claim            # only notes since the most recent
                                              # 'task claim' event for this task
                                              # (auto-resolved from the ops log)
mu task notes design --tail 5 --json          # collection envelope {items, count}
```

Filters compose: `--tail` slices the last N of whatever survived
the timestamp filter. `--since` and `--since-claim` are mutually
exclusive (both define a cutoff) — pick one. With no filters you get
every note, oldest-first.

`--since-claim` is the orchestrator form: dispatch flows drop a
multi-screen SPEC note BEFORE claiming, then the worker appends
progress notes AFTER. `--since-claim` slices off the SPEC so you see
only the worker's reports. With no claim event it degrades to no
filter.

For ad-hoc shape, the SQL escape hatch:

```bash
mu sql "SELECT n.author, n.content, n.created_at
        FROM task_notes n
        JOIN tasks t ON t.id = n.task_id
        JOIN workstreams w ON w.id = t.workstream_id
       WHERE t.local_id='design' AND w.name='auth-refactor'
       ORDER BY n.id"
```

Convention for note content: `KEY: value` lines. Common keys are
`FILES`, `DECISION`, `VERIFIED`, `BLOCKED`, `NEXT`. Mu doesn't
enforce these — they're for the agents reading them.

---

## 12. Close out a task

```bash
mu task close design                # OPEN/IN_PROGRESS → CLOSED
mu task close umbrella --if-ready   # close ONLY if every blocker
                                    # is terminal (CLOSED / REJECTED
                                    # / DEFERRED); else no-op + list
                                    # the still-blocking ids
mu task open design                 # CLOSED → OPEN (e.g. closed by mistake)
```

Both are idempotent (closing an already-CLOSED task prints a no-op and
exits 0). Owner is left intact — use `mu task release <id>` to clear
ownership when an agent bails mid-flight. `IN_PROGRESS` flips back to
`OPEN` so the task re-enters the ready set. `--reopen` forces `OPEN`
from `CLOSED` / `REJECTED` / `DEFERRED`.

When the closing actor has a per-agent workspace and that workspace
has uncommitted edits, a successful close adds one extra `Next:` hint
reminding the actor to commit before the next wave:

```bash
cd $(mu workspace path worker-1 -w auth-refactor) && git commit -am 'Design auth module'
```

The hint is best-effort: no workspace, a clean workspace, the `none`
backend, or a failed VCS dirty check simply omit it. The same
`nextSteps` entry is present in `--json` output.

`--if-ready` is the umbrella-on-wave-done shape: fire
`mu task close <umbrella> --if-ready` after each wave-task finishes.
It's a no-op while any blocker is OPEN / IN_PROGRESS, printing the
still-blocking ids + a `mu task wait` hint; once the last blocker is
terminal, the same command closes the umbrella. JSON on the no-op path:
`{ skipped: "not_ready", changed: false, blockingIds: ["..."], ... }`.
Exit 0 either way — the no-op is success.

```bash
mu task release design              # clear owner; IN_PROGRESS → OPEN
                                    # (CLOSED / REJECTED / DEFERRED preserved)
mu task release design --reopen     # clear owner AND force status to OPEN
                                    # (un-close + release in one verb)
```

With `design` closed, `build` is ready:

```
$ mu task next -w auth-refactor
┌───────┬────────┬───────────────────┬────────┬────────┬──────┬───────┐
│ name  │ status │ title             │ impact │ effort │ ROI  │ owner │
├───────┼────────┼───────────────────┼────────┼────────┼──────┼───────┤
│ build │ OPEN   │ Build auth module │ 80     │ 5      │ 16.0 │ —     │
└───────┴────────┴───────────────────┴────────┴────────┴──────┴───────┘
```

---

## 13. The SQL escape hatch is your friend

Most routine operations have a typed verb — prefer those, with `--json`
for scripting. `mu sql` covers ad-hoc joins, manual recovery, and
schema exploration. The schema is 10 tables — 4 **portable**
(`workstreams`, `tasks`, `task_edges`, `task_notes`: what crosses
machines) and 6 **machine-local** (`agents`, `vcs_workspaces`,
`machine_identity`, `sync_peers`, `schema_version`, and the `ops` log,
which is carrier not cargo) — plus three views (`ready`, `blocked`,
`goals`):

```bash
mu sql "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name"
```

### Prefer the typed verb where one exists

| Want                                                  | Typed verb                              |
| ----------------------------------------------------- | --------------------------------------- |
| Tasks owned by an agent (current workstream)          | `mu task owned-by <agent> [--json]`     |
| Tasks owned by ANY same-named worker (all workstreams)| `mu task owned-by <agent> --all [--json]`|
| Highest-ROI ready task                                | `mu task next [-w] [-n K] [--json]`     |
| What did I touch most recently / what's stale         | `mu task list --sort recency` / `--sort age` |
| Visualise what blocks what                            | `mu task tree <id> [--json]`            |
| Show row + edges + notes                              | `mu task show <id> [--json]`            |
| Delete + cascade edges/notes (two-phase: bare = dry-run; `--yes` commits) | `mu task delete <id>` / `mu task delete <id> --yes` |
| Add / remove a single edge                            | `mu task block` / `mu task unblock`     |
| Replace all blockers atomically                       | `mu task reparent <id> --blocked-by ...`    |
| Modify scalar fields                                  | `mu task update <id> [--title ...]`     |
| Read the activity log / subscribe to events           | `mu log [--tail] [--intent task.close]` |
| Block until tasks reach a status (orchestrator wait)  | `mu task wait <ref> [<ref>...] [--first|--any] [--timeout S]` |
| Block until agents finish working (task-less wait)    | `mu agent wait <name> [<name>...] [--first|--any] [--timeout S]` |
### `mu agent wait`: the task-less counterpart to `mu task wait`

Scratch helpers usually own no task, so `mu task wait` has nothing to
watch. `mu agent wait` blocks on the agent's runtime status: an agent
**fires** when it goes **busy → any other state**. It must be observed
busy first, so an already-idle agent does NOT fire instantly — you're
waiting for *this* work to finish. Replaces `sleep` polling loops.

```bash
mu agent spawn helper-1 -w scratch
mu agent send helper-1 'Investigate X. Report findings.'
mu agent wait helper-1 -w scratch --first    # blocks until pi finishes
mu agent read helper-1 -w scratch -n 80      # now read the result
```

Mirrors `mu task wait`'s shape: `--any`/`--first` fire on the first
agent (default: all must finish); `--first` prints the firing agent's
ref; `--json` carries `nextSteps`; refs may be qualified
`<workstream>/<name>`. Exit codes: `0` met, `5` timeout, `6` a watched
agent's pane died. Status detection is pi-only (a non-pi pane always
reads `needs_input`, so it never goes busy and the wait times out).

### `mu task wait`: cross-workstream refs + `--first` returns WHICH

Each `<ref>` is either a bare task name (resolves via `-w` /
`$MU_SESSION` / tmux session) or a qualified `<workstream>/<name>`
ref. When all refs are qualified, `-w` is not required; mixed lists
are allowed (bare uses `-w`, qualified uses its prefix).

```bash
# All-bare with -w
mu task wait build_a build_b -w mufeedback-v03 --timeout 1200

# All-qualified  — cross-workstream wait, no -w needed
mu task wait roadmap-v0-3/archive_phase2 mufeedback-v03/cli_audit --timeout 1800

# Mixed  — bare uses -w; qualified ignores it
mu task wait cli_audit roadmap-v0-3/archive_phase2 -w mufeedback-v03
```

`--first` is an alias for `--any` that ALSO prints the firing ref's
qualified id to stdout (and adds a `firing` field to `--json`). Use
it to drive a single-shot dispatch loop — one wait, one cherry-pick,
one verify, one workspace recycle:

```bash
# The dispatch-pipeline recipe: cycle until in_flight is empty.
in_flight=( mufeedback-v03/foo mufeedback-v03/bar roadmap-v0-3/baz )
while (( ${#in_flight[@]} > 0 )); do
  res=$(mu task wait "${in_flight[@]}" --first --timeout 90 --json)
  closed=$(jq -r '.firing.qualifiedId // empty' <<<"$res")
  if [[ -z "$closed" ]]; then break; fi  # timeout or exit 6 — see below

  worker=$(jq -r '.firing.owner // empty' <<<"$res")
  ws=${closed%%/*}

  # 1. Inspect, then run, the sha-pinned apply hint from nextSteps.
  #    When the worker has commits since its fork point, the command is
  #    `git cherry-pick <sha>` (or `<first>^..<last>` for multiple
  #    commits). When the worker closed without committing, nextSteps
  #    says so and points at manual `git diff` / `git apply` rescue.
  apply=$(jq -r '.nextSteps[0].command' <<<"$res")
  printf 'apply hint: %s\n' "$apply"
  if [[ "$apply" == git\ cherry-pick* ]]; then
    eval "$apply"
  else
    echo "manual rescue required; inspect the worker workspace before continuing"
    break
  fi

  # 2. Verify
  npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build

  # 3. Refresh the workspace for the next dispatch (rebases onto
  #    fresh main WITHOUT killing the worker's LLM context). Default
  #    base = origin/HEAD (git) / trunk() (jj/sl); --from <ref>
  #    overrides. Refuses on dirty WC; conflicts exit 5 with a `cd`
  #    hint to resolve in-place.
  mu workspace refresh "$worker" -w "$ws"
  # Alt: `mu workspace recreate "$worker" -w "$ws"` does free + create
  #      atomically — same shortcut, but throws away the worker's local
  #      changes (the lossy escape: requires --force on a dirty WC).
  #      Use when you don't care about replaying the worker's commits.

  # 4. Drop $closed from in_flight, dispatch the next task, repeat.
  in_flight=( "${in_flight[@]/$closed}" )
done
```

The `--json` shape on success is `{ firing, all, timedOut, nextSteps,
... }`:

* `firing`   — `{ workstreamName, name, qualifiedId, status, owner }`
  on `--first` / `--any` success; `null` on `--all` success or on
  timeout.
* `all`      — array of refs that REACHED the target (with
  `qualifiedId` + `reachedAt`).
* `timedOut` — array of refs that did NOT reach the target. Empty on
  clean success; populated on partial-progress timeout.
* `nextSteps`— the same hint list printed to stdout (cherry-pick,
  verify, free + recreate, or `mu task show` for unmet refs).

### Wait exit codes (`mu task wait`)

`mu task wait` polls the watched tasks every second (cheap indexed
SELECT + a per-poll reconcile of every workstream in the wait set)
and exits with one of:

| Exit | Meaning                                                                 |
|------|-------------------------------------------------------------------------|
| `0`  | The wait condition was met (`--all` reached, or `--any` / `--first` saw at least one). |
| `5`  | `--timeout` expired before the condition was met. `--json` payload still includes `all` (refs that did reach) and `timedOut` (refs that didn't). |
| `6`  | **REAPER_DETECTED.** A WATCHED task transitioned `IN_PROGRESS → OPEN` between polls because the reconciler detected the owning pane was dead and the reaper flipped the task back. Scoped to the wait set: a reaper-flip in some other workstream (or some other task in the same workstream) does NOT trigger exit 6. Fires only when the wait target is `CLOSED` (the default) — with `--status OPEN` a reaper-flip TO open IS the success and the wait returns `0`. Re-dispatch a worker (`mu agent spawn ... && mu task claim --for ...`) and re-run the wait. (`task_wait_reconcile_dead_panes` + `task_wait_cross_workstream`) |
| `7`  | **STALL_DETECTED.** Only with `--on-stall exit`. The existing `--stuck-after` predicate fired on a watched task (IN_PROGRESS, owner alive but in `needs_input` for `>= --stuck-after` seconds) and the wait threw instead of polling forward. Same target=CLOSED carve-out as exit 6 (with `--status OPEN`/etc the worker reaching `needs_input` might BE the success path; `--on-stall exit` is downgraded to warn-only). Stderr names the task + owner + age. Exit 7 is the **ambiguous** sibling of exit 6: dead pane (6) is unambiguous (re-dispatch); idle agent (7) might be transient (operator decides poke vs release). If both fire in the same poll, exit 6 wins (reaper-flip moves status off `IN_PROGRESS`, so the stuck-check's predicate naturally fails). (`task_wait_stall_action_flag`) |

The per-poll reconcile means a worker pane that died **before** you
ran `mu task wait` is also reaped on the first tick — you'll see exit
`6` in well under a second instead of running out the `--timeout`.
For cross-workstream waits the reconcile loops over every workstream
in the wait set (so a dead pane in workstream B is reaped while you
wait on its task there too).

### `mu task wait`: stall detection (`--stuck-after` + `--on-stall`)

Two orthogonal flags govern the stall behaviour:

* `--stuck-after <seconds>` — the **trigger**. An IN_PROGRESS task
  whose owner has been in `needs_input` for `>= N` seconds is marked
  stuck. Default `300` (5 min); pass `0` to disable detection
  entirely (no warn AND no exit).
* `--on-stall <action>` — the **action** when the trigger fires.
  Two values:
  * `warn` (default) — yellow `STUCK` warning to stderr (deduped per
    task per wait call), corroborating `agent stalled <name> owns
    <task> for <secs>s` event in the ops log, and `wait` keeps
    polling.
  * `exit` — same emit + persist, then **exit 7**
    (`STALL_DETECTED`). The unattended-orchestrator escape: a
    wrapping policy can branch on 7 (idle, ambiguous — poke vs
    release) vs 6 (dead pane, unambiguous — re-dispatch). Suppressed
    when `--status` is anything other than `CLOSED` (mirrors
    exit-6's carve-out: with `--status OPEN` reaching `needs_input`
    might BE the success path).

```bash
# Default: warn at 5 min, keep polling.
mu task wait build_a build_b -w mufeedback-v03 --timeout 1800

# Tune the trigger; same warn-only action.
mu task wait build_a -w mufeedback-v03 --stuck-after 60

# Exit on stall (cron-driven wrapper):
mu task wait build_a -w mufeedback-v03 --on-stall exit
#   exit 0 → closed
#   exit 5 → timeout
#   exit 6 → dead pane (re-dispatch)
#   exit 7 → idle agent (poke or release — inspect first)

# Tune both. Exit at 60s of needs_input:
mu task wait build_a -w mufeedback-v03 --stuck-after 60 --on-stall exit

# Disable both warn AND exit (--stuck-after 0 wins):
mu task wait build_a -w mufeedback-v03 --stuck-after 0 --on-stall exit
```

### Common ad-hoc queries

```bash
# Set task to IN_PROGRESS without claiming (claim does this automatically;
# this covers the rare manual case). local_id is per-workstream unique,
# so always scope by workstream_id to avoid hitting a same-named task in
# another workstream.
mu sql "UPDATE tasks SET status='IN_PROGRESS'
         WHERE local_id='build'
           AND workstream_id=(SELECT id FROM workstreams WHERE name='mufeedback-v03')"

# What's blocking what (open tasks only) — same data as `mu task tree`
# but as a flat join when you want a wider report. task_edges is keyed
# by tasks.id, not local_id; join workstreams to scope the report.
mu sql "SELECT b.local_id AS blocked, t.local_id AS by_task
        FROM tasks b
        JOIN workstreams w ON w.id = b.workstream_id
        JOIN task_edges e ON e.to_task_id = b.id
        JOIN tasks t ON t.id = e.from_task_id
        WHERE w.name='mufeedback-v03'
          AND t.status != 'CLOSED' AND b.status = 'OPEN'"

# Recursive CTE: every task that transitively blocks `launch` in a
# given workstream (or use `mu task tree launch --json` for the same
# data structured). local_id is per-workstream, so resolve the seed
# under a workstream filter.
mu sql "WITH RECURSIVE prereqs(id) AS (
          SELECT t.id FROM tasks t
            JOIN workstreams w ON w.id = t.workstream_id
           WHERE t.local_id='launch' AND w.name='mufeedback-v03'
          UNION
          SELECT e.from_task_id FROM task_edges e, prereqs
           WHERE e.to_task_id = prereqs.id
        )
        SELECT t.local_id, t.title, t.status
          FROM prereqs JOIN tasks t ON t.id = prereqs.id"
```

`mu sql` accepts both reads and writes. Reads are pretty-printed as a
table; writes report `<n> rows affected`.

---

## 14. Recovery scenarios

### An agent's pane dies externally

You killed it from another tmux client, or its CLI crashed:

```bash
mu agent list             # worker-1's row prunes itself (ghost detected)
```

Reconciliation runs on every `mu agent list` / `mu`. Three steps:

1. **Prune ghost rows** — DB row whose `pane_id` no longer exists in
   tmux gets deleted
2. **Detect status from scrollback** — for survivors, capture the
   pane and re-derive status (busy / needs_input / needs_permission /
   spawning) per the pi-status detector
3. **Surface orphan panes** — panes in the workstream's session whose
   `pane.command` looks like an agent CLI but that aren't in the
   registry. **Not** auto-adopted; mu lists them under "Orphan panes"
   with the `mu agent adopt <pane-id>` hint

### A worker is wedged on an unbounded tool subprocess

A worker ran `find / -maxdepth 6 ...` (30-60 minutes on a populated
home directory) or a busy-wait loop. `mu agent send` queues steering
messages until the tool returns; `tmux send-keys C-c` against the
pane doesn't propagate (the wrapping pi/claude/codex CLI catches it
as TUI input). The escape hatch:

```bash
mu agent kick worker-1                       # SIGINT (graceful, default)
mu agent kick worker-1 --signal SIGTERM      # polite escalation
mu agent kick worker-1 --signal SIGKILL      # hammer
```

`mu agent kick` looks up the pane's TTY (`tmux display-message -p
'#{pane_tty}'`), asks `ps -t <tty>` for the foreground process group
(the row whose `stat` contains `+`), and signals the whole pgrp.
Refuses with `NoForegroundProcessError` when the foreground IS the
wrapping CLI — use `mu agent close` then.

Prevention: don't prompt workers to run filesystem-wide `find`, broad
`grep -r /`, or unbounded busy-wait loops. Scope to `$WORKSPACE`.

### You closed your terminal session

The workstream's tmux session keeps running detached. Reconnect with
`tmux a -t mu-auth-refactor`. Agents are alive; the DB has the
registry; everything resumes. mu is daemon-free — every `mu`
invocation is a short-lived process that re-reads from
`~/.local/state/mu/mu.db`.

### The mu DB seems wrong

```bash
mu doctor                                   # quick health check (exit 5 = drift)
mu doctor --deep                            # rebuild + field-level diff
sqlite3 ~/.local/state/mu/mu.db .schema     # inspect
rm ~/.local/state/mu/mu.db                  # nuke (last resort; loses task graph and registry)
```

### You ran a destructive verb and want to undo it

Every change any verb makes is captured as **ops** under one
**group**, so undo is per-action rather than per-file.

```bash
mu undo                      # list recent undoable groups (newest first)
mu undo 4a1a6305             # preview the inverse of one group (dry run)
mu undo 4a1a6305 --yes       # apply it
mu undo -n 20                # list more groups
```

A group id may be given as any unique prefix. Full semantics —
granularity, undo-as-an-op (which is also "redo"), and the
superseded-work refusal plus its `--force` override — are in
[§ Undoing one action](#undoing-one-action-mu-undo).

Two important caveats:

- **Only rows are reverted.** Undo emits inverse ops against the
  portable tables. It does not resurrect a killed tmux pane, an
  agent registry row, or a workspace directory `mu workspace free`
  removed — none of those are portable state, so none of them are
  in the log.
- **For whole-DB recovery, use `mu rebuild <file>`**, which replays
  the entire ops log into a NEW file. It never writes in place.

### Workspace orphans (dirs on disk with no DB row)

A `--workspace` spawn that aborted partway, or a manual `rm` of
`vcs_workspaces` rows, can leave dirs in
`<state-dir>/workspaces/<workstream>/<agent>/` with no DB row. They're
invisible to `mu workspace list` but they BLOCK subsequent
`--workspace` spawns under the same name.

```bash
mu state -w <workstream>          # 'Workspace orphans' section in yellow
mu workspace orphans -w <workstream>   # focused list + cleanup recipe
```

For each orphan, the cleanup is one of:

```bash
# git-backed workspace: also prunes the worktree registry
(cd <project-root> && git worktree remove --force <orphan-path>)

# any backend (last resort)
rm -rf <orphan-path>
```

The `Next:` block from `mu workspace orphans` interpolates the
actual paths so you can copy-paste.

### You typo'd a workstream name and want to rename it

The `workstreams.name` column has `ON UPDATE CASCADE` on every
child-table foreign key, so renaming a workstream is a single SQL
statement that propagates atomically through `agents`, `tasks`,
`task_notes`, and `vcs_workspaces`:

```bash
# 1. Validate the new name fits the rules (or mu will reject it on
#    next use). Lowercase alpha first, then alnum/_/-, ≤32 chars,
#    no '.' or ':' (tmux mangles them), no 'mu-' prefix.
# 2. Rename in the DB. Single statement; cascades to every child.
mu sql "UPDATE workstreams SET name='auth-refactor' WHERE name='auth-refator'"

# 3. Rename the tmux session too (only if it's currently alive).
tmux rename-session -t mu-auth-refator mu-auth-refactor
```

There is no typed `mu workstream rename` verb <!-- doc-cli-drift:skip -->: the
schema does the work, and wrapping one safe statement buys nothing (no
atomicity to preserve, no validation to add). The recipe above is the
canonical answer, and the same `ON UPDATE CASCADE` makes `mu sql`
renames safe for `tasks.local_id` and `agents.name` too.

---

## 15. Cleanup

### Close individual agents

```bash
mu agent close worker-1          # kills pane + drops registry row
```

Idempotent: a missing pane and a missing row are both fine.

If the agent has a workspace:

- **Clean** (no uncommitted changes AND no commits since fork) —
  auto-freed alongside the close.
- **Dirty** — close refuses with `WorkspacePreservedError` (exit 4).
  Either `mu workspace free <agent>` first (optionally `--commit` to
  capture pending changes) then close, or
  `mu agent close <agent> --discard-workspace` to do both (lossy).

### Tear down the whole workstream

`mu workstream destroy` is the counterpart of `mu workstream init`: it
kills the workstream's tmux session AND deletes every DB row tagged
with the workstream name (edges and notes go via FK cascade on tasks).
The workstream resolves as everywhere else: `--workstream <name>` >
`$MU_SESSION` > current tmux session (`mu-` prefix stripped).

Two-phase by default: a bare `mu workstream destroy` prints a dry-run
summary and exits without touching anything. Pass `-y` / `--yes` to
destroy.

```bash
mu workstream destroy --workstream auth-refactor          # dry-run: shows counts, exits
mu workstream destroy --workstream auth-refactor --yes    # actually does it

# Or, from inside the workstream's tmux session:
mu workstream destroy --yes                                # workstream auto-detected

# Sweep every empty workstream (zero tasks, agents, vcs_workspaces)
# in one call. Tmux session presence and audit-only log entries do NOT
# disqualify. Also surfaces unregistered `mu-*` tmux sessions (test
# litter, or a partial destroy that dropped the DB row but left the
# session). ONLY `mu-`-prefixed sessions are touched. Mutually
# exclusive with -w. Dry-run lists what WOULD go
# (created_at renders `—` for tmux-only entries); --yes destroys.
mu workstream destroy --empty                  # dry-run: table of empties
mu workstream destroy --empty --yes            # destroy them all
```

```
Workstream auth-refactor (tmux session mu-auth-refactor)
  tmux session : alive (will be killed)
  agents       : 1
  tasks        : 1  (edges: 0, notes: 0)
  workspaces   : 0

Destroyed auth-refactor: killed tmux=true, agents=1, tasks=1, edges=0, notes=0, workspaces=0/0
Pre-destroy export: ~/.local/state/mu/exports/auth-refactor-2026-08-02T06-00-05-869Z
```

Idempotent on every leg: a missing tmux session is fine, zero DB rows
is fine, and a repeat destroy prints "nothing to destroy" and exits 0.

Destroy writes TOMBSTONE ops rather than erasing history, so the work
stays in the ops log. `mu undo <group> --yes` reverses the row
deletions — but not the killed tmux session or freed workspace dirs.
See
[§ 14: You ran a destructive verb and want to undo it](#you-ran-a-destructive-verb-and-want-to-undo-it).

The tmux session is killed BEFORE the DB rows so an unexpected tmux
failure leaves the registry intact (you can retry); if you only want
the DB cleared, use `mu sql` directly:

```bash
mu sql "DELETE FROM tasks
         WHERE workstream_id=(SELECT id FROM workstreams WHERE name='auth-refactor')"   # cascades
mu sql "DELETE FROM agents
         WHERE workstream_id=(SELECT id FROM workstreams WHERE name='auth-refactor')"
```

Or nuke the entire DB:

```bash
rm ~/.local/state/mu/mu.db                           # next mu invocation re-creates an empty schema
```

### Preserve the conversation as markdown before destroying

A workstream's task graph + notes IS the project memory.
`mu workstream destroy` removes the live rows (the ops log keeps them,
but only `mu undo` reads them back). For code
review, handoff, git-checked-in artifacts, or `grep`, render the
workstream as markdown first.

Exports use a **bucket** layout: the `--out` directory is a
multi-source bucket whose top-level contains a bucket-wide
README/INDEX/manifest, and one subdirectory per source workstream:

```
<bucket>/
  README.md           # bucket-level summary (every source-ws + dates + totals)
  INDEX.md            # union of all task tables; first column = source-ws
  manifest.json       # bucketVersion: 2, manifest_version: 2, per-source-ws task summaries + sha256s
  <source-ws>/
    README.md         # per-source-ws (counts)
    INDEX.md          # per-source-ws (table of every task)
    tasks/<id>.md     # one .md per task; YAML frontmatter + notes
```

Bucket exports are **additive**: `mu workstream export -w X --out
<bucket>` creates the bucket scaffolding plus `X/` on first use, and a
follow-up call with `-w Y --out <same-bucket>` appends a sibling `Y/`
without touching `X/`. The top-level `INDEX.md` is the union from
`manifest.sources`, so a single-workstream refresh does not drop
siblings. Re-running with the same `-w` is sha256-idempotent: only
changed task files are rewritten (mtime preserved on identical files),
and tasks deleted from the DB STAY on disk with a
`> **Deleted from DB on <ts>**` banner so you never lose context that
may already be git-blamed.

```bash
# One-shot dump (bucket happens to contain just one source-ws)
mu workstream export -w auth-refactor                         # → ./auth-refactor/
mu workstream export -w auth-refactor --out ~/notes/auth/     # explicit dir

# Additive accumulation across multiple workstreams in one bucket
mu workstream export -w mufeedback     --out exports/mu       # creates exports/mu/mufeedback/
mu workstream export -w roadmap-v0-2   --out exports/mu       # adds exports/mu/roadmap-v0-2/
mu workstream export -w mufeedback-v03 --out exports/mu       # adds exports/mu/mufeedback-v03/
```

`mu workstream destroy --yes` auto-runs an export to
`<state-dir>/exports/<workstream>-<timestamp>/` BEFORE killing the
tmux session and dropping the rows, so the conversation survives
even if you forgot. Pass `--no-export` to opt out.

```bash
(cd ~/notes/auth && git init && git add . && git commit -m 'auth-refactor snapshot')
```

If `--out` points at a directory whose `manifest.json` predates the
bucket layout (no `bucketVersion`, top-level `workstream` field), the
export refuses: `rm -rf <dir>` and re-run, or pick a different `--out`.

Markdown only by design — no HTML/PDF, no embedded VCS, no
cross-workstream merge. Operators can pandoc / `git init`
themselves.

### Bucket exports are read-only artifacts

Bucket exports (`mu workstream export`) are **read-only** artifacts for
humans / git / docs — good for grep, code review and handoff, but not a
DB round-trip path.

Use the typed surfaces for recovery and movement:

| Need | Verb |
| ---- | ---- |
| Laptop ↔ devserver handoff | Ambient **sync** — set `MU_SYNC_DIR` and every command carries it (§ 15.6) |
| Peer status / a torn segment | `mu sync`, `mu sync --repair <peer>` |
| Disaster recovery from the ops log | `mu rebuild <file>` |

---

## 15.6 Multi-machine sync

**One env var, on every machine.** That is the whole configuration:

```bash
export MU_SYNC_DIR=$HOME/Sync/mu     # a folder something else keeps in step
```

Now every `mu` invocation flushes your ops into
`$MU_SYNC_DIR/<machine_id>.jsonl` and reads every OTHER `.jsonl` in that
folder. Nothing else to set up: no peer list, no host names, no daemon.
Drop a third machine in and it appears.

The end-to-end walkthrough with real output is
[§ 0.3 Laptop ↔ devserver](#03-laptop--devserver). There is no export
step, no import step, and no "which side is authoritative" decision.

### `mu sync` — the status report

Sync already happened on your last command, so `mu sync`'s job is to
tell you *who your peers are and whether transport is working*:

```console
$ mu sync
flushed 14 ops · ingested 22 from 1 peer
┌──────────┬───────────┬────────┬─────────┐
│ machine  │ last seen │ behind │         │
├──────────┼───────────┼────────┼─────────┤
│ 7f3a91c2 │ 2m ago    │ 0      │         │
├──────────┼───────────┼────────┼─────────┤
│ c8ec0feb │ 3d ago    │ 47     │ ← stale │
└──────────┴───────────┴────────┴─────────┘
Next:
  Pull fresh segments (1 stale peer) : rsync -av <host>:/home/me/Sync/mu/ /home/me/Sync/mu/
  Or stop doing it by hand           : # share /home/me/Sync/mu with Syncthing
```

Machines are named by `machine_id` prefix, not hostname — a hostname is
machine-local and never travels. `behind` is how many lines of that
peer's segment you *hold but have not applied*; non-zero means either a
transfer caught mid-flight (it resolves itself) or a defect that
stopped the read (see `--repair`).

Two flags, and only two:

```bash
# Read a peer's DB directly — an sshfs mount, or a file you scp'd.
# A different READER: its SQLite ops table, not a JSONL segment.
mu sync --from /mnt/devserver/.local/state/mu/mu.db

# Re-read a peer's segment from zero, after a torn transfer.
# Safe to run any time: ingest is idempotent.
mu sync --repair c8ec
```

A one-off directory needs no flag at all — the env var already does it:

```bash
MU_SYNC_DIR=/media/usb-stick mu state    # ingest from a USB stick
```

### Transport is yours

mu reads and writes files. It never runs `ssh`, `scp`, or `rsync` for
you — that would mean owning ssh config, jump hosts, `ProxyCommand`,
non-standard ports, identity files, and password prompts. When a peer
looks stale, mu prints the command and you paste it.

Pick any file-mover; segments are **append-only and
single-writer-per-file**, so anything works:

| Tier | How | Notes |
| ---- | --- | ----- |
| **Recommended: Syncthing** | Share `$MU_SYNC_DIR` on every machine | Continuous, peer-to-peer, no server, no cloud account. Its `*.sync-conflict-*` copies are ingested rather than ignored — they are still valid op logs, and dedupe makes reading them free. |
| `rsync` in a loop or cron | `rsync -av host:$MU_SYNC_DIR/ $MU_SYNC_DIR/` | Fine. Run it in both directions, or one way from each box. |
| sshfs / NFS mount of the FOLDER | Point `MU_SYNC_DIR` at the mount | OK for segments. **Never** for `MU_DB_PATH`. |
| Fully manual (`scp`, USB stick) | Copy the `.jsonl` files whenever | Still converges, just less often. |

Manual copying is a first-class tier, not a fallback:

1. **Direction-free.** No source-vs-target decision. Copy either way,
   or both ways. You converge.
2. **Idempotent.** Copying the same file ten times equals copying it
   once, so re-copy freely when unsure.
3. **Interruption-safe.** A killed `scp` leaves a truncated last line
   that the parser skips; the next copy completes it.

### Two things not to do

**Never put `MU_DB_PATH` inside `MU_SYNC_DIR`.** THE footgun of the
design. `mu doctor` reports it, with the full remediation paragraph:

```console
$ mu doctor
fleet
  db-vs-sync       : FAIL DB is INSIDE MU_SYNC_DIR — this WILL corrupt it (/tmp/mu-sync-demo/mu.db)
```

A live WAL-mode SQLite database is three files (`mu.db`, `-wal`,
`-shm`) whose mutual consistency *is* its durability. A file-syncer
copies them whole-file and out of order, and will resurrect a peer's
stale `-wal` — yielding a database that opens fine and is silently
corrupt. Two machines writing the same synced file is worse:
last-writer-wins on the whole FILE, so one machine's entire history
disappears. Keep the DB on local disk; only the regenerable segments
travel.

**Avoid iCloud Drive and Dropbox for `MU_SYNC_DIR` on macOS.** Both do
*dataless-placeholder eviction*: an untouched file becomes a stub, and
the `stat()` that materialises it blocks on the network. mu stats the
sync dir at the top of *every* command, so `mu task add` becomes a
multi-second hang — or a failure when offline. Syncthing keeps real
bytes on disk. (Google Drive File Stream and OneDrive Files On-Demand
have the same problem.)

### What does and does not travel

Only **portable** state syncs: workstreams, tasks, edges, notes. Ops
about **agents** and **workspaces** are recorded locally — `mu log`
still shows them — but never leave the machine, because a `pane_id`
like `%17` and a path like `/home/me/...` are meaningless (and often
actively wrong) on another box.

One consequence: **task ownership does not sync.**
`tasks.owner_id` points into the machine-local `agents` table, so a
task claimed by `worker-2` on the devserver shows as unowned on your
laptop. That is correct — `worker-2` is a tmux pane that does not exist
there.

### Concurrent editing

Edit one workstream on two machines at once. Ops are semantic partial
updates merged by **per-field last-writer-wins**, so a devserver crew
closing a task while you re-prioritise it on the laptop keeps *both*
edits:

```bash
# laptop                                    # devserver
mu task update t1 --impact 95 -w app        mu task close t1 -w app
# after both sync: impact=95 AND status=CLOSED, on both machines
```

Only the same *field* of the same row edited on two machines needs a
winner, and the newer HLC takes it.

---

## 15.7 Coming from mu 0.4.x

`mu` refuses to open a pre-v9 DB (`SchemaTooOldError`, exit 4) and
leaves the file untouched — a major version is the moment to stop
carrying a migration ladder.

A sidecar, `scripts/migrate-to-1.0.ts`, imports a pre-1.0 DB into a
fresh v9 one. Run it once, by hand, against a copy. The shape:

```bash
cp ~/.local/state/mu/mu.db ~/mu-pre1.0-backup-$(date +%Y%m%d).db   # there is no path back
npx tsx scripts/migrate-to-1.0.ts ~/mu-pre1.0-backup-$(date +%Y%m%d).db --out /tmp/mu-new.db
MU_DB_PATH=/tmp/mu-new.db mu doctor --deep    # the check that matters: NO drift
mv /tmp/mu-new.db ~/.local/state/mu/mu.db
```

The importer is read-only on the source and **synthesizes ops rather
than inserting rows**, so the result is a first-class v9 DB.
Workstreams, tasks, edges, notes and the agent log come across; agents,
workspaces and task ownership do not (same reasons they do not sync).
Old archives **refuse loudly** rather than becoming live work — export
them with mu 0.4.x first, or pass `--drop-archives`.

**Full recipe, every flag, and the rationale:
[scripts/README.md](../scripts/README.md).**

---

## 16. One-shot demo script

End-to-end against a throwaway DB, so your real registry is untouched.

```bash
export MU_DB_PATH=/tmp/mu-demo.db
tmux kill-session -t mu-demo 2>/dev/null

# Plan
mu workstream init demo
mu task add design --title "Design" -w demo --impact 80 --effort-days 2
mu task add build  --title "Build"  -w demo --impact 80 --effort-days 5 --blocked-by design
mu task add ship   --title "Ship"   -w demo --impact 90 --effort-days 1 --blocked-by build

# Crew
mu agent spawn worker-1 --workstream demo --cli sh
mu agent spawn worker-2 --workstream demo --cli sh

# Assign + observe
mu task claim design -w demo --for worker-1 --evidence "demo assignment"
mu state -w demo

# Watch live (Ctrl+b d to detach)
tmux attach -t mu-demo

# Cleanup
mu workstream destroy --workstream demo --yes
rm -f /tmp/mu-demo.db
```

---

## Mental model in three sentences

1. **One workstream is one tmux session full of agent panes.** Mu
   manages the lifecycle; tmux is the substrate. Workstreams on the
   same machine are isolated by `session_id` in the SQLite registry.

2. **The task DAG decides what can be worked on.** The `Ready` table +
   parallel-tracks union-find answer "what's next?" and "what can I
   parallelize?" deterministically. Diamond patterns (two goals sharing
   a prerequisite) collapse into one merged track so two agents never
   collide on shared deps.

3. **Agents claim tasks via their pane title — zero config.**
   `mu task claim foo` from inside `worker-1`'s pane sets the task's
   `owner_id` to the `worker-1` agent row atomically. mu reads the pane
   title via `tmux display-message -t $TMUX_PANE -p '#{pane_title}'`,
   set on spawn. Two agents cannot claim the same task.

Everything else (`mu sql`, send/read, the bracketed-paste protocol,
ghost reconciliation) is plumbing in service of those three.

---

## What's NOT in mu (and how to work around it)

The full roadmap with promotion criteria lives in
[ROADMAP.md](ROADMAP.md). The short list of gaps you might hit
in real use:

| Want                                          | Workaround                                                              | Status        |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------- |
| Multi-CLI status detection (per-CLI prompts)  | Braille spinner fallback covers pi/pi-meta + every TUI wrapper using standard spinner glyphs. Per-CLI permission-prompt patterns are pi-only. | partially shipped |
| Pi extension (typed tools, HUD, wakeups)      | `mu state --tui` (interactive) covers the dashboard use-case; plain `mu state` (static) is the `watch` / `tmux display-popup` / `status-right` substrate. Other extension tools deferred. | partially shipped |
| Markdown agent-definition discovery           | Spawn accepts `--cli` and `--command` directly; no template registry    | dropped       |
<!-- doc-cli-drift:skip-start -->
| `mu run script.ts` (JS DSL)                   | Use `--json` + bash + jq                                                | rejected      |
| Sync to GitHub Issues / Linear / Asana        | Not in scope; explicitly rejected                                       | —             |
| ~~`mu task blocked`~~ (removed; the `blocked` SQL view is the abstraction) | `mu sql "SELECT b.local_id, b.status, b.title FROM blocked b JOIN workstreams w ON w.id=b.workstream_id WHERE w.name='X'"` | removed-with-recipe |
| ~~`mu task goals`~~ (removed; same shape as `blocked` — view is the abstraction) | `mu sql "SELECT g.local_id, g.status, g.title FROM goals g JOIN workstreams w ON w.id=g.workstream_id WHERE w.name='X'"` | removed-with-recipe |
| ~~`mu task search <pat>`~~ (removed; case-insensitive LIKE is one SQL line) | `mu sql "SELECT t.local_id, t.status, t.title FROM tasks t JOIN workstreams w ON w.id=t.workstream_id WHERE w.name='X' AND LOWER(t.title) LIKE '%pat%'"` (add `LEFT JOIN task_notes` for the old `--in-notes`; drop the workstream join/filter for the old `--all`) | removed-with-recipe |
<!-- doc-cli-drift:skip-end -->

Anything in this table that bites you in real use is a candidate
for **promotion**. Criteria: proven friction in ≥2 real workflows +
fits in <300 LOC + no major refactor of the load-bearing pillars.
The most useful feedback is "I tried to do X and had to fall back
to `mu sql`, twice in one session". File it in [ROADMAP.md](ROADMAP.md).

---

## Where to go from here

| Doc                                          | What's in it                                            |
| -------------------------------------------- | ------------------------------------------------------- |
| [README.md](../README.md)                    | Project overview, install, comparison vs `pi-subagents` |
| [CHANGELOG.md](../CHANGELOG.md)              | Release notes                                           |
| [ROADMAP.md](ROADMAP.md)                     | What's next, with promotion criteria + rejected ideas   |
| [VOCABULARY.md](VOCABULARY.md)               | Canonical terms — source of truth for every word        |
| [VISION.md](VISION.md)                       | The eight load-bearing pillars + design principles      |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | Module map, reconciliation algorithm, layered design    |
| [skills/mu/SKILL.md](../skills/mu/SKILL.md)  | What an LLM running inside an agent pane sees           |

If you're trying mu and something doesn't work as documented, file an
issue with: the exact `mu` command, the full output (set
`MU_DB_PATH=/tmp/mu-debug.db` to isolate from your real registry),
your multiplexer version (the `environment` block of `mu doctor`), and
your platform.

---

## 20. Multiplexer backends (tmux and herdr)

mu drives exactly one multiplexer per invocation. tmux is the
incumbent; [herdr](https://github.com/martintrojer/herdr) is the second
backend, and spawn, send, read and status detection all work on it. The
remaining gaps are narrow and listed under
[Known limits on herdr](#known-limits-on-herdr) — the notable one is
that `mu agent kick` is Linux-only there.

### Which backend am I on?

```bash
mu doctor           # the `environment` block names the active backend
mu doctor --json    # .environment.mux = { name, ok, version, env, remediation }
```

`.environment.tmux` is kept in `--json` as an alias reporting the
*active* backend, so existing scripts keep working. Read
`.environment.mux.name` if you care which one it is.

### The detection ladder

1. `MU_MUX=<name>` — explicit override, wins over everything. An
   unknown value fails the invocation (`error: unknown mux backend:
   nope`, exit 1) rather than quietly running on tmux.
2. `HERDR_ENV=1` → herdr. Compared literally against `1`, as herdr
   documents.
3. `$TMUX` or `$TMUX_PANE` set → tmux. Either one proves the caller is
   in a tmux pane; some setups (`sudo -E`, ssh with a restrictive
   `SendEnv`) pass one and not the other.
4. Availability — whichever binary actually runs, tmux first.
5. `NoMultiplexerError`, exit 5.

Rung 2 outranks rung 3 because it is the narrower claim: herdr panes
routinely host a tmux server, so both signals can be live at once, and
only `HERDR_ENV` says "herdr manages *this* pane". Rungs 2–3 answer
"which mux is the caller in", rung 4 answers "which mux works here" —
mu can create a detached session from a plain shell, so rung 4 alone
is enough to operate.

The backend is resolved once per process and cached.

### What differs between the two

| | tmux | herdr |
| --- | --- | --- |
| Mux session (holds one workstream) | tmux session `mu-<ws>` | herdr *workspace* labelled `mu-<ws>`. herdr's own "session" is server-level and is NOT the workstream unit. |
| Window | tmux window | herdr tab |
| Agent | pane | pane |
| Pane id | `%15` | `w1:p1` (workspace-qualified, so a pane moved between workspaces gets a new id) |
| Pane title | `select-pane -T` | `herdr pane rename` writes the pane *label* |
| Attach hint | `tmux a -t mu-<ws>` | `herdr session attach mu-<ws>` |
| Pane borders | 4-side border showing agent name + status glyph | no-op — herdr owns its pane chrome; mu-managed panes carry the label instead |
| Layout | `select-layout` | no-op — herdr splits are explicit, geometry is yours |
| Status detection | scrollback scraping (`src/detect.ts`) | herdr classifies panes natively via `paneStatus()`; the scraper is bypassed |
| Focus | mu creates detached | `--no-focus` on every mutating call, always. `detached: false` still gets you a detached workspace; run `herdr workspace focus` yourself. |
| Isolation seam | `MU_TMUX_SOCKET` (`-L <name>`) | `MU_HERDR_SESSION` (`--session <name>`, its own socket) |
| `mu agent send` / `read` | six-step paste/Enter protocol | one atomic `agent prompt --wait` |
| `mu agent spawn` | one `new-window`/`split-window` carrying the command | create-then-start: bare pane, then `agent start` |

`MU_TMUX_SOCKET` is tmux-only and ignored under herdr;
`MU_HERDR_SESSION` is its herdr analogue. Both exist so a test run can
never observe or destroy your real panes.

### Known limits on herdr

- **Spawn is two steps, not one.** herdr has no create-and-run form, so
  mu creates a bare pane and then calls `agent start` in it. The
  creation verbs refuse a command rather than silently dropping it —
  dropping would leave an empty shell that mu records as an agent,
  which is the worst available failure. If step two fails, mu closes
  the pane and writes no agent row.
- **`--lines` cannot recover scrolled-off rows from an
  alternate-screen pane.** A pane on the alternate screen does not
  spill into host scrollback, so there is nothing behind the viewport
  to read.
- **`mu agent kick` is Linux-only on herdr.** herdr reports a shell
  pid, not a tty, so `paneTTY` resolves `/proc/<pid>/fd/0`. On macOS
  that path does not exist and the call fails with a `HerdrError`
  naming the limitation rather than lying about the tty.
- **`herdr pane list` has no foreground-command field**, so a pane's
  command reads as empty from a listing. The authoritative answer
  costs one `herdr pane process-info` round trip per pane. mu does not
  fake it.
- **`MU_<UPPER_CLI>_COMMAND` has no herdr equivalent.** herdr resolves
  the agent binary itself by kind. The override is honoured on tmux
  only; on herdr it stays moot while spawn is unimplemented, and the
  spawn work has to either pass it through or refuse it explicitly.

### A degraded backend reports, it does not crash

With no herdr server running, `mu doctor` still prints a full report
(exit 0) and any verb that genuinely needs the mux fails with exit 5
and herdr's own message plus remediation steps:

```bash
MU_MUX=herdr mu doctor              # exit 0; `herdr: ok (0.8.0)` from the client
MU_MUX=herdr mu agent list -w foo   # exit 5: no herdr server is running at ...
MU_MUX=herdr mu task claim t1 -w foo --self   # exit 0 — identity is best-effort
```

That last line is the load-bearing / best-effort split. Verbs that ARE
the mux (spawn, send, kill, reconcile, session create/destroy) fail
loudly. Verbs where the mux is decoration (identity fallback, pane
titles, banners, `mu workstream list`) degrade and carry on. Reconcile
is pointedly in the first group: treating an unreachable mux as "zero
panes" would prune every agent as a ghost.

One error is deliberately outside that scheme. herdr returns argument
errors with exit 2, which mu raises as `HerdrSyntaxError` — not a
`MuxError`. That is CLI drift after a herdr upgrade, i.e. a bug in mu,
and bucketing it as "herdr is down" would send you chasing a healthy
server.
