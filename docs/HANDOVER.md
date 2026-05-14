# Orchestrator handover

You are the new orchestrator on the `mu` repo. The previous
orchestrator hit context limits and asked you to take over (or the
user reset you on purpose). Read this file end-to-end once; then
start orienting via the steps in **§ Onboarding**.

This file is **generic** — it describes how to be a good `mu`
orchestrator on this repo, not the specific work in flight right now.
The live state (open tasks, recent commits, idle workers) lives in
the database and the git log.

**You are NOT a worker.** Workers do the heavy lifting on multi-file
changes inside their own pi-agent panes; you do the coordination,
cherry-pick conflict resolution, tiny inline fixes, and the
human-in-the-loop conversation.

> **Reading order.** This doc assumes you have already loaded the
> bundled mu skill ([skills/mu/SKILL.md](../skills/mu/SKILL.md)).
> SKILL.md is the canonical reference for the dispatch loop, the
> task-note contract, claim-before-send, workspace recreate,
> `mu task wait` semantics, the `mu` CLI surface, and the model /
> reaper / kick cluster. **HANDOVER.md does not repeat that.** It
> covers what's specific to driving THIS repo as the orchestrator
> agent: onboarding ritual, behavior rules with the user, conflict
> resolution, this codebase's known gotchas, communication style,
> and end-of-session.
>
> If you find yourself asking "how do I claim a task / wait / write
> a note?" — go read SKILL.md. If you find yourself asking "what's
> the bundle deadlock symptom on this repo?" — that's here.

---

## Onboarding (do this in order, once per session)

### 1. Read the repo's own orientation

```
read AGENTS.md            # repo conventions; mandatory
```

[AGENTS.md](../AGENTS.md) covers build / test / lint commands, the
conventional commit prefixes, code style, layout caps, common tasks,
and the test infrastructure. Trust it.

### 2. Find the active workstream

If the user hasn't told you, infer it from the filesystem:

```
ls ~/.local/state/mu/workspaces/   # one top-level dir per workstream
mu workstream list                 # canonical list from the DB
```

If `$MU_SESSION` is set, that's the active one. If you're inside a
tmux session named `mu-<name>`, that's it. Otherwise ask.

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
npm run test:fast           # ~5s; sanity check; current count: ~1300+ tests
git status                  # working tree should be clean (or known-pending)
node dist/cli.js --help     # bundle smoke; MUST emit (silent = bundle deadlock; see Gotcha 1)
```

If anything is dirty / failing, **find out why before doing anything
new**. The previous orchestrator may have left mid-cherry-pick.

### 5. Read the most-recent session summary

Find the umbrella or session-summary task and read its notes:

```
mu task list -w <ws> --status CLOSED -n 5 --json | jq -r '.items[].name' | head
mu task notes <umbrella-or-summary-name> -w <ws>
```

Conventional umbrella titles look like `<theme> COMPLETE`,
`SESSION SUMMARY`, or `<theme>_umbrella`. The previous orchestrator
should have appended a session-summary note before context-out. If
they didn't, scan the last 10 commits for context.

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
and feature ideas — often several per minute while they're driving
the TUI. This is the normal mode of operation, not an exception. A
new bug/feat report is **NOT a change of direction** unless the user
explicitly says so ("stop everything", "abandon that", "forget the
in-flight work"). It does **NOT** invalidate in-flight tasks or
require you to recall workers.

Default response to a new bug/feat while workers are busy:

1. **File it** and **write the design note** immediately, so it
   doesn't get lost. (See [SKILL.md §Orchestrator loop](../skills/mu/SKILL.md)
   for the file-claim-send-wait sequence and
   [§Note contract](../skills/mu/SKILL.md) for the note shape.)
2. **Gate it with `mu task block`** if it touches files an in-flight
   task touches.
3. Either **dispatch it to an idle worker right now**, or **queue it
   for the next wave** if all workers are busy. Tell the user which.
4. **Resume the wait** you were in.

Only drop in-flight work when the user explicitly tells you to.

### Rule B: Never pause for user input while open tasks exist

If the ready queue, in-flight set, or backlog has anything
actionable, **keep churning**. Do NOT end your turn with "what
next?" / "shall I do X?" / "ready for the next task" while there is
open work and an idle worker (or a wait you can resume).

Stop and ask ONLY when:

- You are **truly stuck** (decision needs the user, e.g. an
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

The 8-phase orchestrator loop (file → note → block → claim →
recreate-workspace → send → wait → cherry-pick) is the canonical
SKILL.md content; see
[SKILL.md §Orchestrator loop](../skills/mu/SKILL.md) and
[§Dispatch rules that prevent real failures](../skills/mu/SKILL.md).

This section captures only the orchestrator-only deltas:

### Design notes belong in `/tmp/<slug>.txt`

Write the worker prompt to `/tmp/<task-slug>.txt` BEFORE attaching
it as a task note, so you can re-send if the worker context resets
or you fail-and-retry:

```
mu task note <slug> -w <ws> "$(cat /tmp/<slug>.txt)"
mu agent send worker-N -w <ws> '/new'
sleep 2
mu agent send worker-N -w <ws> "$(cat /tmp/<slug>.txt)"
```

A good note has these sections (full list lives in
[SKILL.md §Task note contract](../skills/mu/SKILL.md), expanded
here for orchestrator-side wiring):

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

Every worker adds an entry under the upcoming-version section. When
two workers merge, you get an `<<<<<<< HEAD / ======= / >>>>>>>`
block in the "Added" / "Fixed" / "Changed" subsection. **Always
concat both halves in the original order**. Never pick one and drop
the other.

### docs/ARCHITECTURE.md — second most common

Per-file row updates. Same playbook: merge both edits onto the same
row. The row may grow long; that's fine.

### Source files — rare if you gate properly

If a real source conflict appears, STOP and read both versions
carefully. Don't just `--theirs` or `--ours`. Both workers' changes
are likely correct in isolation; you need a manual merge that
preserves both intents.

If a worker's change has a small bug (e.g. an early-return that
breaks hooks rules), fix it inline as a separate commit AFTER the
cherry-pick lands. Don't amend the worker's commit — keep history
attributable.

---

## Crucial gotchas

Each one has bitten THIS codebase ≥1×. Read them before you spend
an hour on a "weird" symptom. These are repo-specific; nothing
here is in the SKILL because the SKILL is meant to be portable
across mu users.

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
a stale event in `popupMouseEvent` state being replayed when a new
popup opens. Pattern: convert from `useState` to `useRef` + version-
counter useState, consume the ref on read. See
`src/cli/tui/use-popup-action-queue.ts` for the canonical impl.

### 3. ANSI sequences confuse ink's wrap math

`<Text>` counts BYTES for wrap. ANSI escape sequences inflate byte
count without adding visual width → wrap fires too early,
mid-escape, breaks colour and corrupts borders. Pre-wrap by visual
width via `src/cli/tui/wrap-ansi.ts` (already exists) before passing
to `<Text>`. Pad each line to exact box width so ink's
`wrap="truncate"` ANSI miscount doesn't eat the right border.

### 4. Multi-agent concurrent test runs cause flakes

`npm run test` failing intermittently with different tests each
time = two workers' vitest processes racing on `/tmp` cleanup, tmux
sockets, or VCS fixtures. **NOT a real test failure.** The fix is
in the test infra (`test/_fs.ts` `rmFixtureDir()` retries, etc),
not in the production code under test.

If you see one of these, check
`bug_test_suite_flakes_audit_and_remediate` notes for the
historical catalogue. Re-run the specific test in isolation to
confirm:

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
conflict. (SKILL.md covers `mu workspace recreate`; this is just
the orchestrator-side reminder of when it bites.)

### 6. Per-popup hint vs global drill hint cluster

If you're wiring a per-popup hint (e.g. `t` for tuicr only firing
in git-show drills), put it in the popup's `hint` prop (rendered
inset into the bottom border via `TitledBox.bottomLabel`), NOT in
the global `POPUP_DRILL_HINTS` cluster in
`src/cli/tui/keymap-spec.ts`. The global cluster shows for EVERY
drill; the per-popup hint is correctly conditional.

### 7. `mu task wait --first` printed shas in nextSteps are SOMETIMES wrong

If the worker forked from an older HEAD, the wait's "Cherry-pick N
commits" range will include commits already on main. Always check

```
cd $(mu workspace path worker-N -w <ws>) && git log --oneline -5
```

and cherry-pick only the NEW shas. (SKILL.md says "cherry-pick only
new shas" — this is the canonical reproduction of why.)

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

Reply LENGTH should match the request's complexity. A "carry on"
gets a one-line ack and execution; a design discussion gets a
paragraph.

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

…STOP and ask. The cost of asking is one user round-trip; the cost
of guessing wrong is hours of revert + re-do.

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
  reference + dispatch loop + note contract + dispatch rules.** Most
  of "how to drive mu" lives here, not in HANDOVER.
- [AGENTS.md](../AGENTS.md) — repo conventions, build/test/lint, code
  style, anti-patterns, common tasks for ANY agent on this repo.
- [docs/USAGE_GUIDE.md](USAGE_GUIDE.md) — what mu does from a
  user's perspective. § 5b is the TUI reference.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — module layout,
  reconciliation, TUI architecture, key seams.
- [docs/ROADMAP.md](ROADMAP.md) — promotion criteria, anti-feature
  pledges (read before expanding the surface).
- [docs/VOCABULARY.md](VOCABULARY.md) — canonical terms (use these
  exact words in code + docs + error messages).
- [docs/VISION.md](VISION.md) — the load-bearing pillars.
