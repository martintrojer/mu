# Remote workers

Running mu agents on another machine. A recipe, not a feature: mu has
no remote backend, no ssh code, and no host registry, and it needs
none.

Read this before spawning your first remote agent. The recipe is short;
the traps below it are the part that costs time.

**If you read one thing:** on a session-capped host, never leave an
attach pane open — it holds the only ssh channel and silently breaks
`git fetch`, `murmur collect` and every other ssh. Attach to look, then
`mu agent close`. See § Never leave an attach pane open.

---

## The model

**The pane is local, the process is remote.** `mu agent spawn
--command 'ssh <host> -t "..."'` starts an ordinary tmux pane whose
foreground process happens to be ssh. Everything mu does is
pane-shaped, so `mu agent send`, `mu agent read`, status detection and
the reaper all work unchanged, across the network, with no mu changes.

**One orchestrator DB; panes may be remote.** All state stays on your
machine. Do not run a second mu on the host to "coordinate": ownership
is machine-local by construction — `tasks.owner_id` is an FK into the
`agents` table, which never syncs — so a remote mu could not claim
tasks in your DAG. Two half-views, no benefit.

**murmur sees the REMOTE pane** — the opposite of the line above. Its
extension runs inside the agent's process, so it claims the pane on the
HOST; mu's local pane holds an ssh client and reports nothing. Two
addresses, one worker.

murmur ties them back together by looking for the AGENT NAME in your
local pane's command line. When it matches, the remote row shows
`attached here %N` and enter focuses your existing pane instead of
opening a second connection — which matters on a capped host, where the
second one fails.

Both recipes below work, for the same reason: the agent name is in the
argv either way. A direct spawn carries it in the remote command; the
detached shape carries it in the session name, because you named the
session after the agent. **Keep doing that** — `-s mu-<agent>` is what
makes the attachment findable, and a session named anything else costs
you the hint.

Do not bother putting `MU_AGENT_NAME=` in front of the attach command
to help it along. An environment prefix is consumed by your shell and
never reaches the process arguments, which is all `ps` reports on macOS.

What mu does NOT know about a remote agent: the workspace. There is no
`vcs_workspaces` row, so no `mu workspace list / refresh / commits /
free`, no `behind` column, no staleness warning on claim, and no
auto-free on close. You own that bookkeeping.

---

## Never leave an attach pane open

On a host that caps sessions per connection, **your attach pane holds
the only ssh channel**. While it is open, every other ssh to that host
fails — `git fetch`, `git push`, `murmur collect`, `rsync`, a plain
`ssh <host> true`. So the pane you opened to watch the agent is the
thing preventing you from seeing it.

The error names none of this. You get `Permission denied
(keyboard-interactive)`, which reads as a credentials problem, and
`git push` can report success while having pushed nothing.

**Attach to look, then close immediately.** `mu agent close <name>`
detaches without stopping a detached-tmux agent, so closing costs you
nothing. Poll with `murmur collect` + `murmur status`, never by sitting
in the pane.

This was walked into twice in one session by the person who wrote this
section, so do not assume knowing it is enough. If a collect fails and
you are not sure why:

```bash
ps -o pid=,command= -ax | grep "[s]sh <host>"   # who holds the channel
```

Current murmur says it for you: `dev: ssh session limit reached -- pane
%210 is your own attachment to this peer. Close it, then collect.`

---

## The recipe

```bash
# 1. WORKSPACE — you create it; --workspace does NOT work remotely
ssh dev 'git -C ~/repo worktree add ~/ws/worker-1'

# 2. RECORD — the note is the only durable record of where work went
mu task note t1 -w big 'REMOTE: dev:~/ws/worker-1'

# 3. SPAWN — env vars go INSIDE the command (tmux -e stops at the hop)
mu agent spawn worker-1 -w big --command \
  'ssh dev -t "cd ~/ws/worker-1 && MU_MANAGED_AGENT=1 MU_AGENT_NAME=worker-1 MU_WORKSTREAM=big pi --approve"'

# 4. CLAIM + SEND — identical to a local agent
mu task claim t1 -w big --for worker-1 --evidence 'remote on dev'
mu agent send worker-1 -w big '...'

# 5. COLLECT — fetch straight from the remote worktree
git fetch "ssh://dev/~/ws/worker-1" HEAD && git cherry-pick FETCH_HEAD
```

Local and remote agents mix freely in one workstream. The DAG, tracks,
`mu state` and `mu task wait` do not care where a pane's process runs
— task status is a row in YOUR database, written by you, so a wait on
it is exact.

**Agent STATUS is different, and this is the one place "nothing
changes" is false.** `busy` / `needs_input` / `idle` come from reading
the local pane's scrollback, which for a remote worker is a nested tmux
rendered over ssh. What you get is redraw lag and quiet periods that
look like idleness, so anything derived from status is unreliable here:

| waiting on | remote? |
| --- | --- |
| `mu task wait` (task status) | exact — a DB poll |
| exit 6, the reaper | fires, but see below |
| `--on-stall exit` (exit 7) | **do not rely on it** |
| `mu agent wait --first` | same, it is status-based |

Measured both directions in one session: a stall fired at 300s against
a worker that was visibly mid-turn, and `mu agent list` showed
`needs_input` for another that was working. So on a remote worker, drop
`--on-stall exit` and give the wait a generous `--timeout`.

The reaper is right for a DIRECT spawn — the connection dying really
does kill that agent — and wrong for a detached-tmux one, where the
agent outlives the ssh but mu reaps the task anyway. See § A dropped
connection reaps the task but NOT the commit.

**If you need trustworthy remote status, ask murmur, not mu.** Its
extension runs inside pi ON THE HOST and pushes state, so nothing is
scraped and no ssh hop distorts it:

```bash
murmur collect && murmur status --json   # activity is host-reported
```

That is the division worth remembering: mu owns the work, murmur owns
what the agent is doing.

### On step 2 — the note is load-bearing

mu keeps no record of the remote path, and the agent row that held the
command string disappears when the agent dies. The task note is the
only thing that survives. Keep it in the literal `REMOTE: <host>:<path>`
shape: `mu state` lists those lines as its remote-worker inventory, and
the recovery command is mechanical:

```bash
git fetch "ssh://<host>/<path>" HEAD && git cherry-pick FETCH_HEAD
```

### On step 5 — fetching from a worktree

`git fetch "ssh://<host>/<path>" HEAD` reads a remote worktree
**directly**. No shared remote, no push, no bare repo in between. This
is the part people expect to be hard and it is not.

- It exits **128** on failure, so `&&` chaining is safe.
- **Quote the URL.** `~` is legal in an `ssh://` URL (git's own docs
  list `ssh://host/~user/path`), but unquoted it is expanded by your
  LOCAL shell into your laptop's home.
- Two workers editing one file still conflict on cherry-pick, exactly
  as locally. Bucket work by file cluster, not by machine.

---

## Traps

### Use the host's real CLI command

The wrapper you run locally is not what a bare `pi` gives you on the
host. If your local `$MU_PI_COMMAND` is `pi-meta --pi-meta-no-solo
--approve`, spawning plain `pi` remotely yields a live pane, a healthy
status, and an agent with **no models configured** — it looks fine
until you send it work. Check first:

```bash
ssh dev 'command -v pi-meta'
```

### Tell the worker that mu is absent

`mu` is usually not installed on the host, and the DB is on your
laptop regardless. The in-pane worker loop (`mu task claim` / `note` /
`close`) therefore cannot run. Say so in the prompt and have the
worker print its sha instead; YOU claim, note and close from the
orchestrator. Omit this and the worker burns a turn on `command not
found`, or worse, silently fails to close and your `mu task wait`
hangs.

### Everything is orchestrator-PULL

The host frequently cannot resolve your laptop at all — a corporate
devserver typically has no route back to a NAT'd machine. So: you push
setup out, you fetch commits back. Never write a recipe in which the
host reaches you, and never assume a peer can `git fetch` from you.

### A dropped connection reaps the task but NOT the commit

If the ssh client dies — network drop, laptop sleep, VPN blip — the
pane dies with it, and mu behaves exactly as for a dead local agent:
the agent row goes, and the reaper reverts the task `IN_PROGRESS →
OPEN` with a `[reaper]` note. That is correct and desirable.

But the worker's **commit is still on the host**, and mu has no record
of where. Before re-dispatching, fetch from the path in the task note
and look: re-running the task blind duplicates work that already
exists. This is the strongest argument for step 2.

### A crashed remote worker disappears rather than reporting `crashed`

murmur records `crashed` only when a **pane outlives the process** in
it: that is how an unreported death leaves a trace. Locally it holds —
a pi exits inside a shell pane and the pane stays. It does not hold
here, because the agent is the remote session's only process, so tmux
reaps the session with it and the row is simply gone at the next
collect.

Measured: SIGKILL a remote agent and murmur reports **zero rows and
zero crashed**, not a crash. Nothing distinguishes "it died" from "it
finished and I closed it". A second consequence of the same rule: the
crash path only fires for an agent killed **mid-turn**, since an idle
agent is already `stopped` and a stopped owner dying reads as a normal
finish.

So do not wait for a crash signal on a remote worker. The durable
traces are the ones mu already gives you:

- the reaper flipping the task back to `OPEN` with a `[reaper]` note
- the `REMOTE:` task note, which is where the commit is

`ssh <host> 'tmux ls'` confirms whether the session is really gone.

### Cleaning up

mu will not remove a remote worktree, because it does not know it
exists:

```bash
ssh dev 'git -C ~/repo worktree remove ~/ws/worker-1'
```

`mu agent kick` signals the local pane's foreground process group —
that is the ssh client, not the remote agent. Use `mu agent close` and
respawn.

---

## mu and murmur, and what you lose without it

[murmur](https://github.com/martintrojer/murmur) is optional and
**strictly additive**. Nothing in mu needs it: the DAG, claim/close/
wait, workspaces, spawn/send/read, the reaper, `mu state`, this whole
remote recipe and `git fetch` collection all work with murmur absent.
What you lose is the *view* — cross-machine agent state, the tmux
status pills, `prefix+a`, the attachment hint, and `murmur peer list`
for host reachability. Guard on it (`if it is installed`) rather than
assuming it.

The division: **mu owns the work, murmur owns what an agent is doing.**
murmur never places work.

| question | ask |
| --- | --- |
| what should happen next | mu — the DAG |
| who owns this task | mu — `claim` / `close` |
| is the task done | mu — `task wait`, a DB poll |
| what is this agent doing right now | murmur — pushed from inside pi |
| is anything blocked on me, anywhere | murmur |
| which host can I reach | murmur — `peer list` |

**The seam is three env vars, and it is load-bearing.** `mu agent
spawn` injects `MU_MANAGED_AGENT=1`, `MU_AGENT_NAME` and
`MU_WORKSTREAM`; pi inherits them and murmur's extension reads them.
That one mechanism gives you:

1. `driver=orchestrated`, so crew stays out of the human's status bar
   unless it is blocked or crashed — true for local and remote alike
2. the workstream and agent name on the row, for grouping
3. the attachment back-reference for a remote worker

For a remote worker they go **inside** the ssh command (tmux `-e` stops
at the hop). Miss them and the agent reports `driver=human`: it appears
in your own counts as if it were yours.

## Picking a host

mu does not track hosts and should not; that is
[murmur](https://github.com/martintrojer/murmur)'s job. If it is
installed:

```bash
murmur peer list --json | jq -r '.[] | select(.error) | .name'
```

Read it correctly, because it is **best-effort by design**:

- `ssh` is **last-known** reachability; `error` is the **current**
  attempt. A host can read `warm` and be failing right now.
- The command exits **0** either way — a fleet with sleeping machines
  is the normal state, not a fault.
- So branch on `.error`, never on presence in the list.

`murmur status` and `pick` are polling paths and stay silent whatever
the fleet is doing. `murmur collect` is a deliberate dial and prints
one line per host it could not reach — that is the one to run when you
need "can I reach this host *right now*".

### Reaching a host is two different questions

A peer carries `target` (for a COMMAND — always ssh, used by the
collector) and a jump command (for a HUMAN — need not be ssh):

```bash
murmur peer set <name> --jump-command '<command with {pane}>'
```

Opaque template: murmur substitutes `{pane}` and runs the rest
unparsed. The default reproduces `ssh -t <target> tmux attach`, so an
unconfigured peer behaves as before.

On a session-capped host this is the difference between holding the one
slot for your whole visit and holding nothing (see the ET section).
Don't hardcode `et` — a site wrapper may add VPN selection and its own
binary resolution, which is why the value is opaque.

---

## When the host limits concurrent sessions

Rare, but it presents as a credentials bug, so learn to recognise it.

Most sshd allow 10 sessions per connection (`MaxSessions`, default
10), and the recipe above is all you need. A hardened host may set
**`MaxSessions 1`**. Then the long-lived ssh holding your AGENT
consumes the only session channel, and every other ssh to that host —
including your `git fetch` — is refused.

The error is actively misleading. The refused channel makes ssh fall
back to a fresh connection, which hits the host's 2FA and dies there:

```
mux_client_request_session: session request failed: Session open refused by peer
Permission denied (keyboard-interactive)
```

The second line is the one that scrolls past, and nothing in it
mentions sessions.

`ControlMaster no` is still the right setting for such a host — it
stops ssh spawning masters you did not ask for — but do **not** expect
it to make callers fail honestly. It only governs master *creation*;
a refused channel falls back regardless. Measured with `no` set: three
of four concurrent calls still produced the misleading 2FA error.

**Diagnostic:** if `mu agent read` works fine while a plain `ssh
<host> true` fails, it is session exhaustion, not credentials.
Confirm with `ps aux | grep 'ssh <host>'` — you will see your own
agent holding the connection.

### Fix: detached remote tmux

Run the agent in its own tmux session on the host, and attach to
*that*. The agent's lifetime is then decoupled from the connection, so
the session can be released.

```bash
# Agent runs DETACHED on the host; the ssh returns immediately
ssh dev 'tmux new-session -d -s mu-worker-1 -c ~/ws/worker-1 \
  "MU_MANAGED_AGENT=1 MU_AGENT_NAME=worker-1 MU_WORKSTREAM=big pi --approve"'

# Attach a local pane to it; claim/send are then normal
mu agent spawn worker-1 -w big --command 'ssh dev -t "tmux attach -t mu-worker-1"'

# COLLECT: detach FIRST to free the session, then fetch
mu agent close worker-1 -w big
git fetch "ssh://dev/~/ws/worker-1" HEAD && git cherry-pick FETCH_HEAD

# Reattach — same session, LLM context intact
mu agent spawn worker-1 -w big --command 'ssh dev -t "tmux attach -t mu-worker-1"'
```

Two consequences, both counterintuitive:

- **An attached pane blocks concurrent ssh just as much as a direct
  one.** Nesting does not make the host concurrent; it makes detaching
  cheap and non-destructive. You must close the pane BEFORE fetching.
- **`mu agent close` detaches, it does not stop the agent** — the
  inverse of local semantics, and the whole point. To actually stop
  one: `ssh dev 'tmux kill-session -t mu-worker-1'`. Skip that and you
  accumulate orphaned remote sessions mu cannot see; `ssh dev 'tmux
  ls'` is the only inventory.

This adds a THIRD address: local pane → ssh → remote tmux session →
agent pane. `kick` reaches only the first, `ssh dev 'tmux ls'` is the
only view of the third. Keep the session name equal to the agent name
— mu records neither, so it is the only handle tying them together.

The session name is load-bearing beyond readability: murmur finds your
attachment by spotting the agent name in the local pane's argv, and
with this shape the session name is the only place it appears. `-s
mu-worker-1` for agent `worker-1` gives you `attached here %N` on the
remote row; `-s scratch` silently does not.

The upside beyond unblocking `git fetch`: a dropped connection no
longer reaps the task, since the agent outlives the ssh session, and a
reattach preserves full LLM context.

Use this shape only where you need it. On an ordinary host it is
pointless indirection.

### For your own interactive work, use ET instead

The recipe above is for mu agents, which need a pane whose process mu
controls. Your own shell on the host has an easier answer: **Eternal
Terminal holds no ssh session at all.** It bootstraps over ssh and then
hands off to `etserver` on its own transport, so `MaxSessions` never
counts it.

```bash
et dev        # or your site's wrapper, e.g. `x2ssh -et dev`
```

Verified on a `MaxSessions 1` devvm: an interactive `ssh dev` starved
every other ssh for as long as it stayed open, while an ET session on
the same host left `ssh dev true` succeeding throughout.

So the clean split on a capped host is ET for you, one `ssh -MNf <host>`
master for tooling, and detached tmux for mu agents. The three do not
compete.

Note ET cannot serve murmur or `git fetch` — it exposes no multiplexing
socket to attach to. That is exactly why it pairs well: it takes none of
the capped slots those tools need.

Measured 2026-09-08, extending that from a plain ET shell to one
running tmux: with `<wrapper> -et dev -c 'tmux attach -t <pane>'` open
and the nested tmux live, `ssh -O check dev && ssh dev true` succeeded
and a concurrent `murmur collect` reached the host. So an ET attach
costs the capped slot nothing, which is what makes it usable as a jump
command; `ssh -t` holds the slot for the whole visit.
