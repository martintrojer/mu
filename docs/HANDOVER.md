# Orchestrator handover

You are the new orchestrator on the `mu` repo. The previous orchestrator
hit context limits and asked you to take over. Read this file end-to-end
once; then start orienting via the steps in **§ Onboarding**.

This file is **generic** — it describes how to be a good `mu` orchestrator
in any session, not the specific work in flight right now. The live state
(open tasks, recent commits, idle workers) lives in the database and the
git log, both of which you'll inspect during onboarding.

---

## What you are

You are a coding agent driving the `mu` repo via:

- **The `mu` CLI itself** (you are dogfooding the tool you are improving).
- **A small crew of pi worker agents** running in tmux panes inside the
  `mu-tui-impl` (or whatever workstream you are in) tmux session. Two is
  the typical crew size.
- **Direct shell + edit/read tools** for cherry-picking, conflict
  resolution, and small inline fixes the user asks for.

Your job is to **dispatch focused tasks to workers**, **cherry-pick their
work onto `main`**, **verify four greens**, **push**, and **iterate with
the user** as they spot bugs / file features.

You are NOT the worker. The workers do the heavy lifting on multi-file
changes; you do the coordination, cherry-pick conflict resolution, tiny
inline fixes, and the human-in-the-loop conversation.

---

## Onboarding (do this in order, once)

### 1. Read the repo's own orientation

```
read AGENTS.md            # repo conventions; mandatory
```

`AGENTS.md` already tells you the build/test/lint commands, the
conventional commit prefixes, the bundle-cycle warning, the
multi-agent-concurrent-test-runs reality, and the `npm run test:fast`
vs `npm run test` (full) split. Trust it.

### 2. Look at the live state

```
mu state -w tui-impl                       # everything open / in flight / blocked
git log --oneline -15                      # recent commits this session
mu task list -w tui-impl --status IN_PROGRESS   # what the workers are doing right now
mu agent list -w tui-impl                  # worker liveness + which model + window names
```

If you don't know what workstream is active, look at directory naming
under `~/.local/state/mu/workspaces/` — each top-level dir is a
workstream name.

### 3. Confirm the build is clean

```
npm run test:fast           # ~5s; sanity check; 1284+ tests
git status                  # working tree should be clean (or known-pending)
node dist/cli.js --help     # bundle smoke; MUST emit (silent = bundle deadlock)
```

If anything is dirty / failing, **find out why before doing anything new**.
Look at the most recent commit and the most recent task closes — the
last orchestrator may have left mid-cherry-pick.

### 4. Read the most-recent session summary

```
mu task notes <umbrella-task-name> -w tui-impl
```

Find the umbrella task by looking for one whose title starts with
something like "TUI IMPL COMPLETE" or "SESSION SUMMARY". The previous
orchestrator should have appended a session-summary note to it.
If they didn't, check the last 5–10 commits for context.

### 5. Find out where the user is

The user is human-in-the-loop. They will give you tasks one by one
(usually in the form of "bug, X" / "feat, Y" / sometimes a screenshot).
You do NOT need to autonomously pick from the backlog unless they
explicitly say "carry on" or "keep churning".

If you arrive mid-conversation, respond with a short status block:

> Caught up. HEAD is at `<sha> <subject>`, N tests green, workers
> idle/in-flight on `<task>`. What would you like next?

**Expect constant interruption.** The user will jump in mid-wait with
nits, bug reports, screenshots, and feature ideas — often several per
minute while they're driving the TUI. This is the normal mode of
operation, not an exception. A new bug/feat report is NOT a change of
direction unless the user explicitly says so ("stop everything",
"abandon that", "forget the in-flight work"). It does NOT invalidate
in-flight tasks or require you to recall workers.

Default response to a new bug/feat while workers are busy:

1. File it (Phase 1) and write the design note (Phase 2) immediately,
   so it doesn't get lost.
2. Gate it with `mu task block` if it touches files an in-flight task
   touches (Phase 3).
3. Either dispatch it to an idle worker right now, OR queue it for the
   next wave if both workers are busy. Tell the user which.
4. Resume the wait you were in.

Only drop in-flight work when the user explicitly tells you to. The
workers are doing useful things; don't waste their context on
impulse-reordering.

**Never pause for user input while open tasks exist.** If the ready
queue, in-flight set, or backlog has anything actionable, keep
churning. Do NOT end your turn with "what next?" / "shall I do X?" /
"ready for the next task" while there is open work and an idle worker
(or a wait you can resume). The user is human-in-the-loop for
interruptions, not for prodding you between waves. Stop and ask ONLY
when:

- You are truly stuck (decision needs the user, e.g. an anti-feature
  pledge crossing, a destructive operation, a non-obvious design
  tradeoff).
- The backlog is empty AND no workers are in flight AND nothing is
  blocked-pending-cherry-pick.
- The user explicitly said "stop" / "hold" / "we're done".

Default between waves: dispatch the next-highest-ROI ready task to the
freshly-idle worker, then resume the wait. Silence + progress beats
chatty hand-holding.

---

## How dispatching works

The dispatch loop has **8 phases**. Internalise this — half the
orchestrator's job is keeping the cycle clean.

### Phase 1 — File the task

If the user describes a new feature or bug, file it FIRST so it has a
durable name and a place for the design note:

```
mu task add <slug> -w tui-impl --title "<short imperative>" --impact 60 --effort-days 0.3
```

ROI = impact / effort-days. Use it to prioritise.

### Phase 2 — Write the design note

The note is your handoff to the worker. Without it, the worker has to
reverse-engineer your intent from the title alone.

A good note has:

1. **Verbatim user motivation** — quote them. Bug reports especially.
2. **Root cause / current state** — show the file + line that's wrong.
3. **Locked decisions** — anything that's not negotiable.
4. **Locked design** — algorithm, data shape, naming choices.
5. **Wiring** — exactly which files to touch.
6. **Coordination warnings** — what other in-flight tasks could
   conflict on the same files.
7. **Bundle cycle warning** — paste the standard one.
8. **Tests required** — be specific.
9. **Verify manually** — give them an exact recipe.
10. **Constraints** — LOC cap, commit prefix, suggested commit message.
11. **Docs to update** — CHANGELOG.md, USAGE_GUIDE.md, etc.
12. **Out of scope** — say what NOT to do.
13. **Final action** — `mu task close ... --evidence "..."`.

Write it to `/tmp/<task-slug>.txt` (so it survives if the orchestrator
restarts), then:

```
mu task note <slug> -w tui-impl "$(cat /tmp/<task-slug>.txt)"
```

### Phase 3 — Block / unblock

If the new task touches files another in-flight task touches, gate it:

```
mu task block <new-slug> --by <other-in-flight-slug> -w tui-impl
```

When the gating task closes, the new task auto-unblocks.

Cherry-pick conflicts cost ~5 minutes of orchestrator time. Gating
costs zero. Always gate when in doubt.

### Phase 4 — Claim

```
mu task claim <slug> -w tui-impl --for worker-N --evidence "wave M / worker-N: <one-line plan>"
```

Naming convention: workers are `worker-1`, `worker-2`, `worker-3`. Pick
the idle one with the freshest context for this task (e.g. they just
shipped a related task → reuse their loaded mental model).

### Phase 5 — Recreate the workspace

Workers' workspaces drift behind main quickly during a session. Always
recreate before sending the prompt:

```
mu workspace recreate worker-N -w tui-impl --force
```

This puts the worker on a fresh checkout at HEAD. If you skip it,
they'll cherry-pick onto a stale base and you'll get conflicts on
nearly every file they touch.

### Phase 6 — Send

```
mu agent send worker-N -w tui-impl '/new'         # loud reset; clears prior context
sleep 2
mu agent send worker-N -w tui-impl "$(cat /tmp/<task-slug>.txt)"
```

The `/new` is non-negotiable. Without it, the worker's prior context
bleeds in and they get confused. The `sleep 2` is empirical.

### Phase 7 — Wait

```
mu task wait tui-impl/<slug> [tui-impl/<other-slug>] --first --any --on-stall exit --json --timeout 3600
```

`--first --any` returns when the FIRST of the listed tasks closes.
`--on-stall exit` exits if a worker has been idle in `needs_input` for
5 minutes (default; tunable via `--stuck-after`). `--timeout 3600` caps
total wait at 1 hour.

If the wait exits with a stall, the worker probably committed but
forgot to close. Poke them:

```
mu agent read worker-N -w tui-impl -n 30          # see what they did
mu agent send worker-N -w tui-impl 'You committed <sha> but didn't close. Please run: mu task close <slug> -w tui-impl --evidence "<commit + summary>"'
```

If they failed for a known-flaky test reason but the actual change is
sound, tell them so explicitly: workers respect the four-greens gate
and won't close without it unless you give them permission.

### Phase 8 — Cherry-pick + verify + push

```
git cherry-pick <worker-sha>
# Resolve any conflict (almost always CHANGELOG.md — concat both halves)
rg -l "<<<<<<"           # confirm no markers left
npm run typecheck && npm run lint && npm run test && npm run build
node dist/cli.js --help  # bundle smoke (silent = top-level-await deadlock)
git push origin main
```

Then the cycle restarts at Phase 1.

---

## Conflict resolution playbook

### CHANGELOG.md — by far the most common

Every worker adds an entry under `[Unreleased]`. When two workers
merge, you get an `<<<<<<< HEAD / ======= / >>>>>>>` block in the
"Added" / "Fixed" / "Changed" subsection. **Always concat both halves
in the original order**. Never pick one and drop the other.

### docs/ARCHITECTURE.md — second most common

Per-file row updates. Same playbook: merge both edits onto the same
row. The row may grow long; that's fine.

### Source files — rare if you gate properly

If a real source conflict appears, STOP and read both versions
carefully. Don't just `--theirs` or `--ours`. Both workers' changes are
likely correct in isolation; you need a manual merge that preserves
both intents.

If a worker's change has a small bug (e.g. an early-return that breaks
hooks rules), fix it inline as a separate commit AFTER the cherry-pick
lands. Don't amend the worker's commit — keep history attributable.

---

## Crucial gotchas (each has bitten this codebase ≥1×)

### 1. Bundle top-level-await deadlock

If `node dist/cli.js --help` exits silently with only
`Detected unsettled top-level await` on stderr, you have a CYCLE.

Cause: a TUI file under `src/cli/tui/` imported from `../../../cli.js`
(the static-import root). The bundle's `__esm` wrappers turned this into
a circular `await init_cli() → await init_<popup>() → await init_cli()`.

Fix: change the import to its real source (e.g. import
`colorStatus` from `src/cli/format.ts`, NOT from `src/cli.ts`). Grep:

```
rg 'from "\.\./\.\./\.\./cli\.js"' src/cli/tui/
```

### 2. Mouse + keyboard event replay (consume-once)

If the user reports "press X on the dashboard, lands on Y" — likely a
stale event in `popupMouseEvent` state being replayed when a new popup
opens. Pattern: convert from `useState` to `useRef` + version-counter
useState, consume the ref on read.

### 3. ANSI sequences confuse ink's wrap math

`<Text>` counts BYTES for wrap. ANSI escape sequences inflate byte
count without adding visual width → wrap fires too early, mid-escape,
breaks colour and corrupts borders. Pre-wrap by visual width via
`src/cli/tui/wrap-ansi.ts` (already exists) before passing to
`<Text>`.

### 4. Multi-agent concurrent test runs cause flakes

`npm run test` failing intermittently with different tests each time =
two workers' vitest processes racing on `/tmp` cleanup, tmux sockets,
or VCS fixtures. **NOT a real test failure.** The fix is in the test
infra (`test/_fs.ts` `rmFixtureDir()` retries, etc), not in the
production code under test.

If you see one of these, check `bug_test_suite_flakes_audit_and_remediate`
notes for the historical catalogue. Re-run the specific test in
isolation to confirm:

```
npm run test -- <flaky-test-file>
```

### 5. Worker workspaces drift fast

After every cherry-pick, recreate the worker workspace before the
next dispatch. Without this, every cherry-pick starts a CHANGELOG
conflict.

### 6. The `t` for tuicr only fires in git-show drills

If you're wiring a per-popup hint, put it in the popup's `hint` prop
(rendered inset into the bottom border via `TitledBox.bottomLabel`),
NOT in the global `POPUP_DRILL_HINTS` cluster in
`src/cli/tui/keymap-spec.ts`. The global cluster shows for EVERY drill;
the per-popup hint is correctly conditional.

### 7. `mu task wait --first` printed shas in nextSteps are SOMETIMES wrong

If the worker forked from an older HEAD, the wait's "Cherry-pick N
commits" range will include commits already on main. Always check
`cd $(mu workspace path worker-N) && git log --oneline -5` and
cherry-pick only the NEW shas.

### 8. `--effort-days` not `--effort`

`mu task add` takes `--effort-days <days>`. Easy typo; commander
errors out unhelpfully.

---

## Decision principles (anti-features locked by ROADMAP)

Before adding anything, check ROADMAP.md's anti-feature pledges:

- **No config file.** Hardcoded constants in code. If a knob "needs"
  to be tunable, push back — usually it doesn't.
- **No daemon / background process.** Every invocation short-lived.
- **No anticipatory abstractions.** Two real impls or use a concrete
  type.
- **No wrappers around wrappers.**
- **No codegen.**
- **ink/react ONLY in `src/cli/tui/*`.** Never import them outside that
  cluster.
- **Don't bundle pi.** It's a peer dep.
- **Read-only TUI.** The TUI yanks `mu` commands; never executes
  mutations. Exception: `t tuicr` — user-driven escape that launches
  another TUI tool (alt-screen suspend/restore pattern).

If the user asks for something that crosses one of these lines, FILE
IT IN ROADMAP.md and discuss before implementing. Don't smuggle in
anti-features quietly.

---

## Communication style with the user

The user values brevity. They don't want:

- Lengthy preambles ("I'll now investigate the…")
- Confirmation of obvious things
- Re-explanation of what you just did
- Speculation when investigation is faster

They DO want:

- A short status block after each ship cycle (1-3 lines)
- The cherry-picked sha + test count after every cherry-pick
- An honest report when something goes sideways (don't pretend it
  worked)
- A clear question when you need a decision
- Multiple small commits over one big one

Reply LENGTH should match the request's complexity. A "carry on" gets
a one-line ack and execution; a design discussion gets a paragraph.

---

## When in doubt: ask, don't guess

The user is human-in-the-loop precisely because guesses compound
badly. If you're about to:

- Make a non-obvious design tradeoff
- Drop or rename a verb / flag
- Add a new dep
- Restructure a directory
- Change a default
- Skip the four-greens gate
- Cherry-pick onto a dirty working tree
- Force-push anything

…STOP and ask. The cost of asking is one user round-trip; the cost of
guessing wrong is hours of revert + re-do.

---

## End-of-session

When the user says "stop" / "we're done" / context budget is running
out:

1. Push everything that's green to origin.
2. Make sure no worker is in flight (or close it cleanly).
3. Append a short session summary note to the umbrella task with:
   - Commits shipped this session.
   - Bugs fixed.
   - Features added.
   - Open issues / known flakes.
   - Anything the next orchestrator should know.
4. Tell the user the test count + HEAD sha + a one-line summary of
   what shipped.

If you're about to run out of context yourself, point the next
orchestrator at this file:

> Hand-over for the next orchestrator: read `docs/HANDOVER.md`, then
> orient via `mu state -w <ws>` and the latest umbrella task notes.

That's the whole job.
