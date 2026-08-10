# Orchestrator handover

You are the new orchestrator on the `mu` repo. Read this file
end-to-end once, then orient via **§ Onboarding**.

This file is **generic** — how to be a good `mu` orchestrator on this
repo, not the work in flight. Live state (open tasks, recent commits,
idle workers) lives in the database and the git log.

**You are NOT a worker.** Workers do the heavy lifting on multi-file
changes inside their own pi-agent panes; you do the coordination,
cherry-pick conflict resolution, tiny inline fixes, and the
human-in-the-loop conversation.

> **Reading order.** Load the bundled mu skill first
> ([skills/mu/SKILL.md](../skills/mu/SKILL.md)): it is the canonical
> reference for the dispatch loop, the task-note contract,
> claim-before-send, workspace recreate, `mu task wait` semantics,
> and the `mu` CLI surface. **HANDOVER.md does not repeat that.** It
> covers driving THIS repo: onboarding, behavior rules with the user,
> conflict resolution, known gotchas, communication style, and
> end-of-session.
>
> "How do I claim a task / wait / write a note?" → SKILL.md.
> "What's the bundle deadlock symptom on this repo?" → here.

---

## Onboarding (do this in order, once per session)

### 1. Read the repo's own orientation

```
read AGENTS.md            # repo conventions; mandatory
```

[AGENTS.md](../AGENTS.md) covers build / test / lint, commit
prefixes, code style, layout caps, common tasks, and the test
infrastructure. Trust it.

### 2. Find the active workstream

If the user hasn't told you, infer it from the filesystem:

```
ls ~/.local/state/mu/workspaces/   # one top-level dir per workstream
mu workstream list                 # canonical list from the DB
```

If `$MU_SESSION` is set, that's the active one. If you're inside a mux
session named `mu-<name>` — a tmux session, or a herdr workspace with
that label — that's it. Otherwise ask.

The first row of `mu doctor`'s environment block is the resolved
multiplexer — `tmux : ok (3.7b)` or `herdr : ok (0.8.0)` — followed by
that backend's ambient vars. If you are driving a crew you are almost
certainly on tmux; herdr supports the same verbs, but `mu agent kick`
is Linux-only there.

Throughout the rest of this doc the placeholder `<ws>` means the
active workstream name.

### 3. Look at the live state

```
mu state -w <ws>                                # everything open / in flight / blocked
git log --oneline -15                           # recent commits this session
mu task list -w <ws> --status IN_PROGRESS       # what the workers are doing right now
mu agent list -w <ws>                           # worker liveness + cli + window names
```

### 4. Confirm the build is clean

```
npm run test:fast           # ~5s sanity check
git status                  # clean, or known-pending
node dist/cli.js --help     # bundle smoke; MUST emit (silent = deadlock, Gotcha 1)
```

If anything is dirty / failing, **find out why before doing anything
new**. The previous orchestrator may have left mid-cherry-pick.

### 5. Read the most-recent session summary

Find the umbrella or session-summary task and read its notes:

```
mu task list -w <ws> --status CLOSED -n 5 --json | jq -r '.items[].name' | head
mu task notes <umbrella-or-summary-name> -w <ws>
```

Umbrella titles look like `<theme> COMPLETE`, `SESSION SUMMARY`, or
`<theme>_umbrella`. If no summary note exists, scan the last 10
commits for context.

### 6. Find out where the user is

If you arrive mid-conversation, respond with a short status block:

> Caught up. HEAD `<sha> <subject>`, N tests green, workers
> idle/in-flight on `<task>`. What would you like next?

---

## Two non-negotiable behavior rules

These are NOT in SKILL.md because they're about the
human-in-the-loop dynamic with this user, not about the mu CLI.

### Rule A: Expect constant interruption — it's not a change of direction

The user will jump in mid-wait with nits, bug reports, screenshots,
and feature ideas — often several per minute while driving the TUI.
That is the normal mode. A new bug/feat report is **NOT a change of
direction** unless the user says so ("stop everything", "abandon
that"). It does not invalidate in-flight tasks or require recalling
workers.

Default response to a new bug/feat while workers are busy:

1. **File it** and **write the design note** immediately, so it
   doesn't get lost. ([SKILL.md](../skills/mu/SKILL.md) has the
   file-claim-send-wait sequence and the note shape.)
2. **Gate it with `mu task block`** if it touches files an in-flight
   task touches.
3. Either **dispatch it to an idle worker right now**, or **queue it
   for the next wave** if all workers are busy. Tell the user which.
4. **Resume the wait** you were in.

Only drop in-flight work when the user explicitly tells you to.

### Rule B: Never pause for user input while open tasks exist

If the ready queue, in-flight set, or backlog has anything you can
act on, **keep churning**. Do NOT end your turn with "what
next?" while there is open work and an idle worker (or a wait you
can resume).

Stop and ask ONLY when:

- You are **stuck** (the decision needs the user, e.g. an
  anti-feature pledge crossing, a destructive operation, a
  non-obvious design tradeoff).
- The backlog is empty AND no workers are in flight AND nothing is
  blocked-pending-cherry-pick.
- The user explicitly said "stop" / "hold" / "we're done".

Default between waves: dispatch the next-highest-ROI ready task to
the freshly-idle worker, then resume the wait. Silence + progress
beats chatty hand-holding.

---

## The dispatch loop

The 8-phase loop (file → note → block → claim → recreate-workspace →
send → wait → cherry-pick) lives in
[SKILL.md](../skills/mu/SKILL.md). Orchestrator-only deltas:

### Always `/new` before a brief — then VERIFY DELIVERY

Four steps, in this order, every single dispatch:

```
mu workspace recreate worker-N -w <ws>
mu agent send worker-N -w <ws> '/new'
mu agent send worker-N -w <ws> "$(cat /tmp/<slug>.txt)"
mu agent read worker-N -w <ws> -n 3     # must show nonzero context
```

**Why `/new`:** without it every task inherits the previous task's
prompt, notes, and tool output. Measured on a real session: by wave 6
both workers sat at 65-68% of an 800k context and cost per task had
climbed from ~$5 to ~$35. A worker that hits the ceiling mid-task
either compacts (losing the brief) or stalls — far more expensive
than a reset.

**Why step 4:** an undelivered brief is INVISIBLE. Both sends exit 0,
the pane sits idle, and you find out ~300s later when `mu task wait
--on-stall exit` returns 7. That cost ~30 minutes twice in one
session. `mu agent read -n 3` showing nonzero context is the cheap
check; `--json` exposing `delivered: false` is the precise one.

**Caveat, and why step 4 is not optional:** an orchestrator runs the
INSTALLED mu, which may be older than the branch build it is driving
work on — so the send-delivery guarantee may not be in the binary
doing the dispatching. Always verify.

Worker-side `/new` mechanics are
[SKILL.md §Follow-on prompts](../skills/mu/SKILL.md); this section is
the orchestrator's obligation, which is different.

### Design notes belong in `/tmp/<slug>.txt`

Write the worker prompt to `/tmp/<task-slug>.txt` BEFORE attaching
it as a task note, so you can re-send if the worker context resets
or you fail-and-retry:

```
mu task note <slug> -w <ws> "$(cat /tmp/<slug>.txt)"
mu agent send worker-N -w <ws> '/new'
mu agent send worker-N -w <ws> "$(cat /tmp/<slug>.txt)"
```

No `sleep` between those sends: `mu agent send` waits for the pane to
finish re-initialising, re-submits a swallowed Enter, and prints
`warning: ... was NOT submitted` to stderr, naming the pane, when it
cannot confirm. **Exit 0 with no warning means submitted** — in the
branch build. Verify anyway; see the caveat above.

A good note has these sections (the contract lives in
[SKILL.md](../skills/mu/SKILL.md); expanded here for
orchestrator-side wiring):

1. Verbatim user motivation (quote them)
2. Root cause / current state (file + line)
3. Locked decisions, locked design
4. Wiring (which files to touch)
5. Coordination warnings (other in-flight tasks, file overlap)
6. Bundle cycle warning (paste the standard one — see Gotcha 1)
7. Tests required
8. Verify manually (exact recipe)
9. Constraints (LOC cap, commit prefix, suggested commit message)
10. Docs to update
11. Out of scope
12. Final action (`mu task close ... --evidence "..."`)

### Stall recovery

If `mu task wait --on-stall exit` returns exit 7, the worker
probably committed but forgot to close. Poke them:

```
mu agent read worker-N -w <ws> -n 30
mu agent send worker-N -w <ws> 'You committed <sha> but didn'\''t close. Please run: mu task close <slug> -w <ws> --evidence "<commit + summary>"'
```

If they failed for a known-flaky test reason but the actual change
is sound, tell them so explicitly: workers respect the four-greens
gate and won't close without it unless you give them permission.

### The verify + push step

After cherry-picking the worker's commit:

```
git cherry-pick <worker-sha>
# Resolve any conflict (almost always CHANGELOG.md — concat both halves)
rg -l "<<<<<<"           # confirm no markers left
npm run typecheck && npm run lint && npm run test && npm run build
node dist/cli.js --help  # bundle smoke (silent = top-level-await deadlock)
git push origin main
```

---

## Conflict resolution playbook

### CHANGELOG.md — by far the most common

Every worker adds an entry under the upcoming-version section, so two
merged workers give you a conflict block in "Added" / "Fixed" /
"Changed". **Always concat both halves in the original order.**

### docs/ARCHITECTURE.md — second most common

Per-file row updates. Same playbook: merge both edits onto the same
row. The row may grow long; that's fine.

### Source files — rare if you gate properly

If a real source conflict appears, STOP and read both versions. Don't
`--theirs` or `--ours`: both changes are likely correct in isolation,
so merge them by hand.

If a worker's change has a small bug (e.g. an early-return that
breaks hooks rules), fix it inline as a separate commit AFTER the
cherry-pick lands. Don't amend the worker's commit — keep history
attributable.

---

## Gotchas

Each has bitten THIS codebase ≥1×. Read them before spending an hour
on a "weird" symptom. Repo-specific, so none of it is in the SKILL.

### 1. Bundle top-level-await deadlock

If `node dist/cli.js --help` exits silently with only
`Detected unsettled top-level await` on stderr, you have a CYCLE.

Cause: a TUI file under `src/cli/tui/` imported from `../../../cli.js`
(the static-import root). The bundle's `__esm` wrappers turn this
into a circular `await init_cli() → await init_<popup>() →
await init_cli()`.

Fix: change the import to its real source (e.g. import
`colorStatus` from `src/cli/format.ts`, NOT from `src/cli.ts`).
Grep:

```
rg 'from "\.\./\.\./\.\./cli\.js"' src/cli/tui/
```

### 2. Mouse + keyboard event replay (consume-once)

If the user reports "press X on the dashboard, lands on Y" — likely
a stale event in `popupMouseEvent` state replayed when a new popup
opens. Fix: `useRef` + version-counter useState, consume the ref on
read. Canonical impl: `src/cli/tui/use-popup-action-queue.ts`.

### 3. ANSI sequences confuse ink's wrap math

`<Text>` counts BYTES for wrap. ANSI escape sequences inflate byte
count without adding visual width, so wrap fires too early and
mid-escape: broken colour, corrupted borders. Pre-wrap by visual
width via `src/cli/tui/wrap-ansi.ts` (already exists) before passing
to `<Text>`. Pad each line to exact box width so ink's
`wrap="truncate"` ANSI miscount doesn't eat the right border.

### 4. Multi-agent concurrent test runs cause flakes

`npm run test` failing intermittently with different tests each
time = two workers' vitest processes racing on `/tmp` cleanup, tmux
sockets, or VCS fixtures. **NOT a real test failure.** The fix is in
the test infra (`test/_fs.ts` `rmFixtureDir()` retries, etc), not the
code under test. Re-run the test in isolation to confirm:

> Distinguish this from a test that fails in ISOLATION too — that is a
> real bug, and "pre-existing flake" is not a diagnosis. The
> `exit-empty` race in `test/tmux.integration.test.ts` looked like this
> class for a while; it turned out to be a genuine defect that also hit
> any user with `exit-empty off` in their `~/.tmux.conf`. Bisect before
> you shrug.

```
npm run test -- <flaky-test-file>
```

For pre-release, run the stress suite:

```
MU_TEST_STRESS_MODE=parallel MU_TEST_STRESS_PARALLEL=2 npm run test:stress
```

### 5. Worker workspaces drift fast

After every cherry-pick, recreate the worker workspace before the
next dispatch. Without this, every cherry-pick starts a CHANGELOG
conflict.

### 6. Per-popup hint vs global drill hint cluster

Wiring a per-popup hint (e.g. `t` for tuicr, only in git-show
drills)? Put it in the popup's `hint` prop (inset into the bottom
border via `TitledBox.bottomLabel`), NOT in the global
`POPUP_DRILL_HINTS` cluster in `src/cli/tui/keymap-spec.ts`. The
global cluster shows for EVERY drill.

### 7. `mu task wait --first` printed shas in nextSteps are SOMETIMES wrong

If the worker forked from an older HEAD, the wait's "Cherry-pick N
commits" range will include commits already on main. Always check

```
cd $(mu workspace path worker-N -w <ws>) && git log --oneline -5
```

and cherry-pick only the NEW shas.

### 8. `--effort-days` not `--effort`

`mu task add` takes `--effort-days <days>`. Easy typo; commander
errors out unhelpfully.

### 9. Commit author drift across rewrites

Worker pi-agents commit as `worker-N <worker-N@mu>` because each
git worktree picks up its own per-worktree identity by default.
After each cherry-pick the commit lands on main with the worker's
identity. For release prep, rewrite history to a single human
author via:

```
git filter-repo --mailmap /tmp/mailmap --force
# /tmp/mailmap maps every worker-* / mu-bot identity to your name+email
git remote add origin <url>           # filter-repo strips the remote
git fetch origin main
git push --force-with-lease=main:$(git rev-parse origin/main) origin main
```

This is destructive history rewrite — only do it when the user
explicitly asks (e.g. for release prep), and only when no other
clones have pulled the soon-to-be-rewritten commits.

---

## Communication style with the user

The user values brevity. Don't:

- Preambles ("I'll now investigate the…")
- Confirm the obvious
- Re-explain what you just did
- Speculate when investigation is faster

Do give:

- A short status block after each ship cycle (1-3 lines)
- The cherry-picked sha + test count after every cherry-pick
- An honest report when something goes sideways
- A clear question when you need a decision
- Multiple small commits over one big one

Match reply length to the request. "Carry on" gets a one-line ack and
execution; a design discussion gets a paragraph.

---

## When in doubt: ask, don't guess

If you're about to:

- Make a non-obvious design tradeoff
- Drop or rename a verb / flag
- Add a new dep
- Restructure a directory
- Change a default
- Skip the four-greens gate
- Cherry-pick onto a dirty working tree
- Force-push anything (especially history rewrites — see Gotcha 9)
- Cross any anti-feature pledge in
  [docs/ROADMAP.md § Anti-feature pledges](ROADMAP.md#anti-feature-pledges)

…STOP and ask. Asking costs one round-trip; guessing wrong costs
hours of revert + re-do.

---

## End-of-session

When the user says "stop" / "we're done" / context budget is
running out:

1. **Push everything that's green** to origin.
2. Make sure **no worker is in flight** (or close it cleanly).
3. **Append a short session summary note** to the umbrella task
   with:
   - Commits shipped this session (sha + one-line subject each).
   - Bugs fixed (slug + one-line summary).
   - Features added.
   - Open issues / known flakes.
   - Anything the next orchestrator should know.
4. Tell the user the **test count + HEAD sha + a one-line summary**
   of what shipped.

If you're about to run out of context yourself, point the next
orchestrator at this file:

> Hand-over for the next orchestrator: read `docs/HANDOVER.md`,
> then orient via `mu state -w <ws>` and the latest umbrella task
> notes.

That's the whole job.

---

## Cross-references

- [skills/mu/SKILL.md](../skills/mu/SKILL.md) — **canonical mu CLI
  reference + dispatch loop + note contract + dispatch rules.**
- [AGENTS.md](../AGENTS.md) — repo conventions, build/test/lint, code
  style, common tasks for ANY agent on this repo.
- [docs/USAGE_GUIDE.md](USAGE_GUIDE.md) — what mu does from a
  user's perspective. § 5b is the TUI reference.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — module layout,
  reconciliation, TUI architecture, key seams.
- [docs/ROADMAP.md](ROADMAP.md) — promotion criteria, anti-feature
  pledges (read before expanding the surface).
- [docs/VOCABULARY.md](VOCABULARY.md) — canonical terms (use these
  exact words in code + docs + error messages).
- [docs/VISION.md](VISION.md) — the design pillars.
