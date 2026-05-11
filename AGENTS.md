# Repo guide for AI coding agents

You're an AI coding agent working on the `mu` repo, which builds
**mu** — a CLI that manages a persistent crew of AI agents in tmux
panes coordinated through a built-in task DAG.

This file is your orientation. Read the linked docs before you
write code. Follow the conventions below.

---

## Read these first (in this order)

1. **[docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)** — what mu does
   from a user's perspective. ~10 minutes.
2. **[CHANGELOG.md](CHANGELOG.md)** — the v0.1.0 release entry.
   Single source of truth for the verb list, schema, env vars.
3. **[docs/VISION.md](docs/VISION.md)** — the load-bearing pillars.
   The design principles you must not violate.
4. **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's next, with
   promotion criteria. **Read the "Anti-feature pledges" section
   before adding any new dep, abstraction, or surface.**
5. **[docs/VOCABULARY.md](docs/VOCABULARY.md)** — canonical terms.
   **Source of truth for every word** in code, docs, and error
   messages. If you use a term not defined there, fix the docs first.
6. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module layout,
   reconciliation algorithm, key seams.

Design rationale for rejected and unbuilt features (DSL, snapshots,
task_artifacts, ...) is now folded into
[docs/ROADMAP.md](docs/ROADMAP.md) per item, alongside its
promotion criteria.

---

## Repo layout

```
mu/
├── README.md              # human-user entry point
├── AGENTS.md              # this file
├── CHANGELOG.md           # release notes
├── docs/                  # everything else
│   ├── USAGE_GUIDE.md
│   ├── ROADMAP.md         # what's next; promotion criteria
│   ├── VISION.md
│   ├── VOCABULARY.md
│   └── ARCHITECTURE.md
├── src/                   # all source (root files: SDK + shared infra; one
│                          # level of subdirs OK for cohesive clusters — see
│                          # `src/cli/`, `src/agents/`, `src/tasks/` below)
│   ├── db.ts              # SQLite schema + openDb (single CREATE-IF-NOT-EXISTS block)
│   ├── tmux.ts            # tmux wrapper, send protocol, pane validation
│   ├── detect.ts          # pi-only status detector
│   ├── reconcile.ts       # ghost prune + status detect + orphan surface
│   ├── agents.ts          # CRUD + send/read/list/close/free + liveness + reaper hub (re-exports src/agents/*)
│   ├── agents/            # cohesive cluster of agent-lifecycle internals
│   │   ├── spawn.ts       # spawnAgent + resolveCliCommand / awaitSpawnLiveness / pane create-or-reuse / prestage / rollback
│   │   ├── adopt.ts       # adoptAgent: register an existing tmux pane as a managed agent
│   │   └── errors.ts      # typed agent error classes (AgentNotFoundError, AgentDiedOnSpawnError, …)
│   ├── tasks.ts           # task SDK hub (re-exports src/tasks/* + edit/edges/queries verbs)
│   ├── tasks/             # cohesive cluster of task-graph internals
│   │   ├── status.ts      # TaskStatus enum + helpers (single source of truth for statuses)
│   │   ├── claim.ts       # claim/release + resolveActorIdentity (atomic CAS)
│   │   ├── lifecycle.ts   # setTaskStatus / closeTask / openTask / rejectTask / deferTask + cascade
│   │   ├── wait.ts        # waitForTasks: block until tasks reach a target status
│   │   └── errors.ts      # typed task error classes (TaskAlreadyOwnedError, CycleError, …)
│   ├── tracks.ts          # parallel-tracks union-find with diamond merge
│   ├── workstream.ts      # ensureWorkstream / list / summarize / destroy / export
│   ├── archives.ts        # cross-workstream archive buckets (create / add / remove / restore)
│   ├── exporting.ts       # unified bucket renderer (workstream + archive export)
│   ├── importing.ts       # inverse of exporting.ts: parse a v0.3 bucket dir → live DB rows
│   ├── logs.ts            # agent_logs SDK (append, list, latestSeq, emitEvent)
│   ├── vcs.ts             # VcsBackend interface + jj/sl/git/none impls
│   ├── workspace.ts       # per-agent VCS workspaces (CRUD over vcs_workspaces)
│   ├── snapshots.ts       # whole-DB snapshots (VACUUM INTO) + auto-capture hook
│   ├── output.ts          # NextStep type + printNextSteps / errorNextSteps
│   ├── cli.ts             # commander wiring (buildProgram); re-exports format/handle for back-compat
│   ├── cli/               # one file per verb-namespace; thin wrappers over the SDK
│   │   ├── workstream.ts  # workstream init / list / destroy / export
│   │   ├── agents.ts      # agent spawn / send / read / list / show / close / free / adopt / attach
│   │   ├── tasks.ts       # `mu task` hub (re-exports wireTaskCommands / cmdMyNext / cmdMyTasks / unescapeNoteText)
│   │   ├── tasks/         # sub-cluster of the `mu task` namespace
│   │   │   ├── queries.ts    # list / next / owned-by + cmdMyTasks / cmdMyNext (back `mu me tasks` / `mu me next`)
│   │   │   ├── lifecycle.ts  # close / open / reject / defer + cascade preview
│   │   │   ├── edit.ts       # add / show / notes / note / update + helpers
│   │   │   ├── edges.ts      # block / unblock / reparent / delete
│   │   │   ├── claim.ts      # claim / release / wait
│   │   │   ├── tree.ts       # tree rendering
│   │   │   └── wire.ts       # Commander glue
│   │   ├── workspace.ts   # workspace create / list / free / path / orphans
│   │   ├── log.ts         # log read / write / tail
│   │   ├── archive.ts     # archive create / list / show / add / remove / delete
│   │   ├── state.ts       # `mu state` (canonical state card) + bare `mu` (mission control); --tui dispatches to src/cli/tui/
│   │   ├── tui/           # interactive ink-based TUI cluster (mu state --tui); ONLY place ink/react are imported
│   │   │   ├── index.ts    # runTui entrypoint; writes alt-screen enter/exit around ink render
│   │   │   ├── escapes.ts  # pure ANSI escape constants (ALT_SCREEN_ENTER/EXIT) — no ink imports
│   │   │   ├── app.tsx     # <App> root (popup state machine + global keymap + footer + tick)
│   │   │   ├── state.ts    # poll-loop hook (useDashboardSnapshot) + tick constants
│   │   │   ├── keys.ts     # pure dispatchGlobalKey + dispatchPopupKey
│   │   │   ├── yank.ts     # clipboard probe + write (pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52)
│   │   │   ├── titled-box.tsx  # rounded border with section header inset into top border
│   │   │   ├── columns.ts  # column-aligned row layout with protect/clip clipping
│   │   │   ├── help.tsx    # ?/F1 keymap overlay
│   │   │   ├── use-popup-filter.tsx  # shared '/' substring filter (hook + reducer + applyFilter + FilterPrompt)
│   │   │   ├── cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent}.tsx  # 8 dashboard glance cards
│   │   │   └── popups/{agents,tracks,ready,log}.tsx  # 4 fullscreen drill-down popups
│   │   ├── snapshot.ts    # undo / snapshot list / snapshot show
│   │   ├── sql.ts         # sql escape hatch
│   │   ├── doctor.ts      # doctor diagnostic
│   │   ├── format.ts      # pure rendering helpers (table renderers, status colourers, truncate/relTime)
│   │   └── handle.ts      # typed-error → exit-code map + handle() wrapper
│   └── index.ts           # SDK entrypoint (re-exports)
├── test/                  # 60 files / 57 *.test.ts / ~996 it()/test() calls; many use real tmux/git/jj/sl
├── skills/mu/SKILL.md     # what the LLM running inside an agent pane sees
├── package.json           # bin: { mu: ./dist/cli.js }, type: module
├── tsconfig.json          # strict + noUncheckedIndexedAccess + verbatimModuleSyntax
├── tsup.config.ts         # bundles src/ → dist/ (cli + index entries)
├── biome.json             # lint + format
└── vitest.config.ts       # tests
```

---

## Working conventions

### Build / test / lint

```bash
npm install
npm run build            # tsup → dist/
npm run typecheck        # tsc --noEmit
npm run lint             # biome check src test
npm run test             # vitest run
npm run test:watch       # vitest in watch mode
```

All four must pass before any commit. Tests include real-tmux
integration tests that need `$TMUX` set. If you're not in tmux,
those tests skip themselves; CI runs inside tmux.

### Commits

- Conventional but not strict: prefix with the scope when helpful
  (e.g. `R4 + R9: ...`, `schema: ...`). One logical change per
  commit.
- Body explains **what changed and why**, not just what. Reference
  the [VISION.md](docs/VISION.md) pillar / [ROADMAP.md](docs/ROADMAP.md)
  item / promotion criterion that motivated the change.
- Always verify typecheck + lint + tests + build clean before
  committing. Commit messages should say so explicitly.

### Code style

- TypeScript, strict mode. `noUncheckedIndexedAccess` is on — don't
  trust array indices to be defined; use early returns.
- ESM only (`"type": "module"`). NodeNext module resolution.
- No `any`. Use `unknown` and narrow.
- No non-null assertions (`!`). Use early returns or `if (!x) throw`.
- Errors are typed classes (e.g. `AgentNotFoundError`,
  `TaskAlreadyOwnedError`, `CycleError`, `TmuxError`,
  `AgentDiedOnSpawnError`) so the CLI's `handle()` wrapper can map
  them to specific exit codes.
- Imports stay sorted (Biome's `organizeImports` enforces this).
- Run `npx biome check --write src test` to auto-fix sort + format.
  **Do not** run `--write --unsafe`; it has rewritten `delete
  process.env.X` to `process.env.X = undefined` for us, which
  silently produces the literal string `"undefined"`. The codebase
  pattern for env deletion is `const key = "FOO"; delete
  process.env[key];` (computed-key form).
- Hard cap: 1500 LOC per file. Refactor signal at 800.
- **Layout: flat at the root; one level of subdirs is allowed when a
  cluster of files is naturally cohesive** (e.g. `src/cli/` for the
  thin commander wrappers, one file per verb-namespace). The original
  flat-only rule was authored when `src/` had ~12 files; past ~20 the
  flat layout starts hurting (Finder/IDE listing becomes noise; `ls
  src/` no longer reads as architecture). Each subdir cluster needs:
  (1) a clear theme (every file does the same kind of thing),
  (2) imports go from cluster-files → root-files (no upward imports),
  (3) ARCHITECTURE.md's module table has a row covering it.

### Tests

- Unit tests: real SQLite (in-temp-dir), mocked tmux executor via
  `setTmuxExecutor()`. Fast, deterministic.
- Integration tests: real tmux server. File suffix
  `.integration.test.ts` (e.g. `tmux.integration.test.ts`). Skipped
  when `$TMUX` is unset. These tests typically opt out of the spawn
  liveness check via `process.env.MU_SPAWN_LIVENESS_MS = "0"` in
  `beforeEach` since the long-running sh subprocesses they spawn are
  intentionally alive.
- Each test gets its own temp DB and (for integration) a unique
  tmux session like `mu-test-<pid>-<ts>-<rand>` to avoid colliding
  with the user's panes or with parallel test runs.
- The acceptance test in `test/acceptance.test.ts` is the
  "everything works" gate. Keep it passing.

### When you change behaviour, update VOCABULARY first

Vocabulary is canonical. If you introduce a new concept, name, or
verb, **add it to docs/VOCABULARY.md before the code lands**. If
you rename something, update VOCABULARY.md in the same commit. The
"term not defined here, fix the docs" rule is enforced by code
review.

### Deferred features — don't smuggle them in

[docs/ROADMAP.md](docs/ROADMAP.md) lists what's next, by version,
with **promotion criteria**:

> 1. A real user hits the missing feature in real workflows ≥2
>    times.
> 2. The current substrate makes the addition straightforward (no
>    major pillar refactor).
> 3. The addition fits in <300 LOC or has a clear smaller subset.

If you find yourself adding something not on the roadmap and not
meeting these criteria, **stop**. Add an entry to
[docs/ROADMAP.md](docs/ROADMAP.md) (or open an issue) and move on.

The "anti-feature pledges" in ROADMAP.md are firm:

- No config file
- No daemon
- No anticipatory abstractions (no traits with zero implementors)
- No wrappers around wrappers
- No codegen
- An agent template/discovery system requires explicit promotion
- No render layer beyond `cli-table3` + `picocolors`
- Don't bundle pi (it's a peer dep)

### When in doubt: be small

The README, ROADMAP, and VISION docs all hammer this. Pi-subagents
philosophy: ship the smallest thing that works, then layer on as
real friction proves itself.

---

## Common tasks

### "Add a new CLI verb"

1. Find or write the programmatic function in `src/agents.ts`,
   `src/tasks.ts`, `src/workstream.ts`, etc. Test it with mocked
   tmux. Return a typed result object (`{ changed: boolean,
   previousStatus, ... }`) so callers can log lifecycle
   transitions.
2. Wire the verb in `src/cli.ts` using `commander`. Use
   `handle(...)` so typed errors map to exit codes. If the verb
   takes `--workstream`, use `command.optsWithGlobals()` (via
   `this`) so the top-level option doesn't swallow it (commander
   gotcha).
3. Update [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md) with the new
   verb in the right section.
4. Update [docs/VOCABULARY.md](docs/VOCABULARY.md) operations
   table.
5. Update [skills/mu/SKILL.md](skills/mu/SKILL.md) verb list.
6. Update [CHANGELOG.md](CHANGELOG.md) under the upcoming version.
7. If this verb promotes a `mu sql` workaround, remove the
   workaround entry from `docs/USAGE_GUIDE.md` "What's NOT in 0.1.0"
   table.
8. Smoke-test: `MU_DB_PATH=/tmp/mu-smoke.db node dist/cli.js <verb>
   ...` to verify it works against real tmux.

### "Update the schema"

1. 0.1.0 has no migration layer. Schema lives in `src/db.ts` as a
   single CREATE-IF-NOT-EXISTS block. The first non-additive
   change should land alongside a `schema_version` table.
2. Update tests that exercise the schema (`test/db.test.ts`).
3. Update [CHANGELOG.md](CHANGELOG.md) §"Schema" snapshot.

### "Add a new tmux operation"

All tmux invocations go through `src/tmux.ts` `tmux(args)`. **No
raw `execa("tmux", …)` anywhere else.** The wrapper produces typed
`TmuxError` and the test suite mocks via `setTmuxExecutor`.

For send-style operations: use the canonical bracketed-paste
sequence already in `src/tmux.ts` `sendToPane`. Naive `tmux
send-keys "<text>"` is broken — characters like `/`, `?`, `f` get
interpreted by the agent's TUI.

### "Fix a flaky integration test"

Integration tests against real tmux can be slow because tmux/sh
processes need time to settle. Use:

- Unique session names (`mu-test-<pid>-<ts>-<random>`) so parallel
  runs never collide.
- Polling loops (50ms × 10 attempts) when waiting for state to
  propagate, not fixed sleeps.
- `try { ... } catch {}` cleanup in `afterEach` for tmux session
  kills and DB closes — a failure mid-test should never block the
  next.
- `setSleepForTests(async () => {})` in unit tests so the real
  `MU_SEND_DELAY_MS` doesn't slow them.
- `process.env.MU_SPAWN_LIVENESS_MS = "0"` in integration-test
  `beforeEach` to skip the 1500ms post-spawn check (the unit-test
  suite covers it).

---

## What NOT to do

- **Don't add a config file.** mu is CLI flags + env vars.
- **Don't add a daemon, watcher, or background process.** Every
  invocation is short-lived.
- **Don't add abstractions for hypothetical future flexibility.**
  A prior internal LLM-runtime had a `RunContext` trait with zero
  implementors — that's the cautionary tale. Two real impls today,
  or use a concrete type.
- **Don't grow stream wrappers around stream wrappers.**
  Stream-of-streams wrappers (`TextStream` / `TextState` /
  `StreamResult`) we've seen before are the cautionary tale.
- **Don't generate JS strings as a "typed protocol."** A prior
  internal agent-protocol layer regretted `await
  spawnCliAgent(...)` strings.
- **Don't put state-snapshot/handle layering on top of SQLite.**
  SQLite is the canonical state. Read it directly; don't introduce
  a `MuStateHandle` facade.
- **Don't add a template/discovery system for agent roles** until
  pattern promotion criteria are met.
- **Don't bundle pi.** It's a peer dep, optional.
- **Don't write to files outside `~/.local/state/mu/` or the
  project repo** without documenting why.
- **Don't promote a roadmap item to "shipped"** unless its
  promotion criteria in [docs/ROADMAP.md](docs/ROADMAP.md) are met.

---

## When you're done

Before opening a PR or marking a task complete:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

All four green. The acceptance test (`test/acceptance.test.ts`)
must pass — it's the "end-to-end works" gate.

Checklist for any non-trivial change:

- [ ] If you added a typed verb, the corresponding `mu sql`
      workaround row was removed from `docs/USAGE_GUIDE.md`.
- [ ] If you added vocabulary, `docs/VOCABULARY.md` has the new
      entry.
- [ ] If you changed an architectural seam,
      `docs/ARCHITECTURE.md` is updated.
- [ ] [CHANGELOG.md](CHANGELOG.md) has an entry under the upcoming
      version.

That's it. Be small, be typed, follow the conventions, ship clean
green builds.
