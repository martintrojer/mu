# Remote workers

Running mu agents on another machine. A recipe, not a feature: mu has
no remote backend, no ssh code, and no host registry, and it needs
none.

Read this before spawning your first remote agent. The recipe is short;
the traps below it are the part that costs time.

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

What mu does NOT know about a remote agent: the workspace. There is no
`vcs_workspaces` row, so no `mu workspace list / refresh / commits /
free`, no `behind` column, no staleness warning on claim, and no
auto-free on close. You own that bookkeeping.

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

Local and remote agents mix freely in one workstream. `mu task wait`,
`mu state`, tracks and the DAG do not care where a pane's process
runs.

### On step 2 — the note is load-bearing

mu keeps no record of the remote path, and the agent row that held the
command string disappears when the agent dies. The task note is the
only thing that survives. Keep it in the literal `REMOTE: <host>:<path>`
shape and the recovery command is mechanical:

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
