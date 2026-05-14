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
2. **[CHANGELOG.md](CHANGELOG.md)** — the upcoming version's
   entry (currently `[0.4.0] — unreleased`). Single source of truth
   for the verb list, schema, env vars.
3. **[docs/VISION.md](docs/VISION.md)** — the load-bearing pillars.
   The design principles you must not violate.
4. **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's next, with
   promotion criteria. **Read the "Anti-feature pledges" section
   before adding any new dep, abstraction, or surface.**
5. **[docs/VOCABULARY.md](docs/VOCABULARY.md)** — canonical terms.
   **Source of truth for every word** in code, docs, and error
   messages. If you use a term not defined there, fix the docs first.
6. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module layout,
   reconciliation algorithm, TUI architecture, key seams.

Design rationale for rejected and unbuilt features (DSL, snapshots,
task_artifacts, ...) is now folded into
[docs/ROADMAP.md](docs/ROADMAP.md) per item, alongside its
promotion criteria.

> **If you are an orchestrator** — a coding agent driving a crew of
> pi worker agents on this repo via `mu` — read
> **[docs/HANDOVER.md](docs/HANDOVER.md)** instead of the order
> above. It is the goto reset doc for orchestrators: onboarding
> steps, the 8-phase dispatch loop, conflict-resolution playbook,
> known gotchas, and end-of-session checklist. AGENTS.md is for
> workers (and humans editing the repo directly); HANDOVER.md is for
> orchestrators.

---

## Repo layout

```
mu/
├── README.md              # human-user entry point
├── AGENTS.md              # this file
├── CHANGELOG.md           # release notes
├── docs/                  # everything else
│   ├── USAGE_GUIDE.md     # user-facing tour (§ 5b is the TUI reference)
│   ├── HANDOVER.md        # orchestrator goto reset doc (8-phase loop + gotchas)
│   ├── ROADMAP.md         # what's next; promotion criteria; anti-feature pledges
│   ├── VISION.md          # load-bearing pillars
│   ├── VOCABULARY.md      # canonical terms (single source of truth)
│   └── ARCHITECTURE.md    # module layout, TUI architecture, key seams
├── src/                   # all source (root files: SDK + shared infra; one
│                          # level of subdirs OK for cohesive clusters — see
│                          # `src/cli/`, `src/agents/`, `src/tasks/` below)
│   ├── db.ts              # SQLite schema + openDb (single CREATE-IF-NOT-EXISTS block; v7)
│   ├── tmux.ts            # tmux wrapper, send protocol, pane validation
│   ├── detect.ts          # pi status detector + Braille-spinner fallback for other CLIs
│   ├── reconcile.ts       # ghost prune + status detect + orphan surface
│   ├── agents.ts          # CRUD + send/read/list/close/free + liveness + reaper hub (re-exports src/agents/*)
│   ├── agents/            # cohesive cluster of agent-lifecycle internals
│   │   ├── spawn.ts       # spawnAgent + resolveCliCommand / awaitSpawnLiveness / pane create-or-reuse / prestage / rollback
│   │   ├── kick.ts        # reaper events + cleanup of dead agent rows
│   │   ├── adopt.ts       # adoptAgent: register an existing tmux pane as a managed agent
│   │   └── errors.ts      # typed agent error classes (AgentNotFoundError, AgentDiedOnSpawnError, …)
│   ├── tasks.ts           # task SDK hub (re-exports src/tasks/*)
│   ├── tasks/             # cohesive cluster of task-graph internals
│   │   ├── status.ts      # TaskStatus enum + helpers
│   │   ├── core.ts        # core SDK funcs reused across cluster files
│   │   ├── id.ts          # tryResolveTaskId / qualified-id helpers
│   │   ├── queries.ts     # listTasks / nextTasks / owned-by
│   │   ├── edit.ts        # addTask / setTaskTitle / etc (no edges)
│   │   ├── edges.ts       # block / unblock / reparent / delete + dedupe
│   │   ├── claim.ts       # claim / release + resolveActorIdentity (atomic CAS)
│   │   ├── lifecycle.ts   # setTaskStatus / closeTask / openTask / rejectTask / deferTask + cascade
│   │   ├── wait.ts        # waitForTasks: block until tasks reach a target status
│   │   ├── sort.ts        # sortTasks (roi / recency / age / id)
│   │   └── errors.ts      # typed task error classes (TaskAlreadyOwnedError, CycleError, …)
│   ├── tracks.ts          # parallel-tracks union-find with diamond merge
│   ├── workstream.ts      # ensureWorkstream / list / summarize / destroy / export
│   ├── archives.ts        # cross-workstream archive bucket SDK hub (re-exports src/archives/*)
│   ├── exporting.ts       # unified bucket renderer (workstream + archive export)
│   ├── importing.ts       # inverse of exporting.ts: parse a bucket dir → live DB rows
│   ├── logs.ts            # agent_logs SDK (append, list, latestSeq, emitEvent)
│   ├── vcs.ts             # VcsBackend hub (re-exports src/vcs/*: jj/sl/git/none impls)
│   ├── workspace.ts       # per-agent VCS workspaces hub (re-exports src/workspace/*)
│   ├── snapshots.ts       # whole-DB snapshots hub (re-exports src/snapshots/*)
│   ├── dag.ts             # full-DAG forest builder (loadFullDag for `mu task tree` + DAG popup)
│   ├── state.ts           # SDK seam for `mu state` (fast SQL tier + slow subprocess tier + merge)
│   ├── staleness.ts       # WORKSPACE_STALE_THRESHOLD + isStaleWorkspace
│   ├── project-root.ts    # detectProjectRoot for the TUI launch cwd ladder
│   ├── doctor-summary.ts  # TUI-friendly slice of `mu doctor` checks + remediation helpers
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
│   │   ├── workspace.ts   # workspace create / list / free / path / orphans / refresh / commits
│   │   ├── log.ts         # log read / write / tail
│   │   ├── archive.ts     # archive create / list / show / add / remove / delete
│   │   ├── state.ts       # `mu state` (canonical state card); --tui dispatches to src/cli/tui/
│   │   ├── staleness.ts   # shared workspace-staleness CLI helpers + warn formatter
│   │   ├── tui-launch-focus.ts # initial-tab focus ladder for bare `mu` and `mu state --tui`
│   │   ├── tui/           # interactive ink-based TUI cluster; ONLY place ink/react are imported
│   │   │   ├── index.ts            # runTui entrypoint; alt-screen + mouse-mode lifecycle
│   │   │   ├── escapes.ts          # pure ANSI escape constants (ALT_SCREEN_*, mouse-mode bytes) — no ink imports
│   │   │   ├── app.tsx             # <App> root (popup state machine + global keymap + footer + tick + tabs)
│   │   │   ├── state.ts            # poll-loop hook (useDashboardSnapshot; fast/slow tick split)
│   │   │   ├── keys.ts             # pure dispatchGlobalKey + dispatchPopupKey + shouldSwallowGlobalKey
│   │   │   ├── keymap-spec.ts      # canonical keymap source-of-truth (drives help overlay + dispatch)
│   │   │   ├── yank.ts             # clipboard probe + write (pbcopy/wl-copy/xclip/xsel/clip.exe + OSC-52)
│   │   │   ├── mouse.ts            # vendored SGR mouse layer (parser + double-click + useMouse hook)
│   │   │   ├── layout.ts           # responsive multi-column dashboard + per-card row budgets
│   │   │   ├── columns.ts          # column-aligned row layout with protect/clip clipping
│   │   │   ├── wrap-ansi.ts        # ANSI-aware visual-width line wrapper + SGR close-on-end
│   │   │   ├── glyphs.ts           # superscript digit + status glyphs
│   │   │   ├── format-helpers.ts   # shared TUI formatters (relTime, sinceClaim, ROI, etc.)
│   │   │   ├── titled-box.tsx      # rounded border with section header inset into top border + bottomLabel
│   │   │   ├── popup-shell.tsx     # popup outer chrome (cyan TitledBox)
│   │   │   ├── list-row.tsx        # centralised non-selected row primitive (width pin + gutter + truncate)
│   │   │   ├── padded-rows.tsx     # per-card body padder
│   │   │   ├── help.tsx            # ?/F1 keymap overlay (scrollable on short panes)
│   │   │   ├── status-bar.tsx      # bottom status bar (mode + active ws + tick + footer flash)
│   │   │   ├── tab-strip.tsx       # multi-workstream tab switcher (N≥2)
│   │   │   ├── tab-strip-layout.ts # pure window-around-active layout helper for the tab strip
│   │   │   ├── tuicr.ts            # `t` shortcut: alt-screen handoff to tuicr -r <sha>
│   │   │   ├── use-popup-filter.tsx       # shared '/' substring filter hook + applyFilter + FilterPrompt
│   │   │   ├── use-status-filter.tsx      # task-status toggles for task-list popups (o/i/c/r/d)
│   │   │   ├── use-notes-drill.ts         # shared notes-drill memo (5 task popups consume it)
│   │   │   ├── use-popup-action-queue.ts  # consume mouse PopupAction queue once per render
│   │   │   ├── cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor}.tsx + _placeholder.tsx
│   │   │   └── popups/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,commits,doctor,dag,all-tasks}.tsx
│   │   │                          # plus drill.tsx (DrillScrollView), task-detail.tsx (TaskDetailDrill),
│   │   │                          # cursor-row.tsx, scroll.ts (applyCursor/applyScroll), viewport.ts,
│   │   │                          # show-loader.ts (shared subprocess-preserving loader)
│   │   ├── snapshot.ts    # undo / snapshot list / snapshot show
│   │   ├── sql.ts         # sql escape hatch
│   │   ├── doctor.ts      # doctor diagnostic
│   │   ├── format.ts      # pure rendering helpers (table renderers, status colourers, truncate/relTime)
│   │   └── handle.ts      # typed-error → exit-code map + handle() wrapper
│   └── index.ts           # SDK entrypoint (re-exports)
├── test/                  # ~165 *.test.ts files / ~2000 it()/test() calls; many use real tmux/git/jj/sl
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
npm run typecheck        # source + test TypeScript checks
npm run lint             # biome check src test
npm run test:fast        # fast unit/dev-loop tier (excludes *.integration.test.ts / *.smoke.test.ts)
npm run test             # full vitest suite, including integration tests
npm run test:watch       # vitest in watch mode
npm run test:watch:fast  # fast-tier watch mode
```

Use `npm run test:fast` for the inner dev loop and concurrent
worker checks; it is the concurrency-safe tier that avoids real
tmux/VCS subprocess integration fixtures. All four green gates still
include `npm run test` (the full suite) before any commit. Full tests
include real-tmux integration tests that need `$TMUX` set. If you're
not in tmux, those tests skip themselves; CI runs inside tmux.

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
- TUI popup/card behaviour tests should follow `test/README.md`:
  prefer the `test/_ink-render.ts` CaptureStream seam over
  `readFileSync` source-greps except for narrow structural guards.
- Fast tier: `npm run test:fast` runs `test/**/*.test.ts` while
  excluding `*.integration.test.ts` and `*.smoke.test.ts`. Keep this
  tier pure/in-process: mocked tmux/VCS, real SQLite only in per-test
  temp DBs, no real tmux/git/jj/sl subprocess fixtures, no
  filesystem-heavy export/import/snapshot paths, and no fixed sleeps
  above 50ms.
- Integration tests: full-only tests use the `.integration.test.ts`
  suffix (e.g. `tmux.integration.test.ts`). They may touch real tmux
  servers, git/jj/sl fixture repos, subprocess-backed smoke paths,
  filesystem-heavy export/import/snapshot flows, or intentionally
  slower in-process CLI flows. Real-tmux tests are skipped when
  `$TMUX` is unset. These tests typically opt out of the spawn
  liveness check via `process.env.MU_SPAWN_LIVENESS_MS = "0"` in
  `beforeEach` since the long-running sh subprocesses they spawn are
  intentionally alive.
- Each test gets its own temp DB and (for integration) a unique
  tmux session like `mu-test-<pid>-<ts>-<rand>` to avoid colliding
  with the user's panes or with parallel test runs.
- Dogfood reality: multiple pi worker agents often run `npm run test`
  concurrently on the same machine from different workspaces. Treat
  flakes that pass in isolation but fail under load as concurrency
  bugs first (shared `/tmp` cleanup, tmux socket/session collisions,
  leaked subprocesses, VCS background file activity). Use
  `npm run test:stress` for the pre-release/stability gate; it runs
  the suite repeatedly with a per-run timeout and can simulate
  parallel full-suite runs via
  `MU_TEST_STRESS_MODE=parallel MU_TEST_STRESS_PARALLEL=2`.
- The acceptance test in `test/acceptance.integration.test.ts` is the
  "everything works" gate. Keep it passing.
- **DB baseline**: `openDb()` refuses to open the user's REAL
  default DB (`<HOME or XDG_STATE_HOME>/mu/mu.db`) when
  `process.env.VITEST` is set or `NODE_ENV === "test"`. Tests
  MUST use a per-test temp DB — either via MU_DB_PATH (which
  `test/_runCli.ts` sets automatically) or an explicit `{ path }`
  argument to `openDb`. A regression that forgets either one
  fails loudly at the offending openDb() call site instead of
  silently writing to the dev box's live state. Production never
  sets VITEST, so the guard is a no-op outside the test runner.
- **Env baseline**: `test/_setup.ts` (vitest `setupFiles`) clears
  every `MU_*` env var inherited from the parent shell at the start
  of each fork, so SDK-level overrides (`MU_PI_COMMAND`,
  `MU_IDLE_THRESHOLD_MS`, `MU_SEND_DELAY_MS`, …) can't silently
  change behaviour underneath tests. Allowlist: `MU_TMUX_SOCKET`
  (set by `_global-teardown.ts` at MODULE LOAD time — BEFORE vitest
  spawns the worker pool — for Layer-3 isolation; see round-3
  Part A in the file's header comment for why module-load not
  setup()). Tests that need a specific value opt IN per-test via
  `process.env.X = "..."` or `withEnv()` from `test/_env.ts`.
- **Default-socket sweep philosophy**: `_global-teardown.ts` runs
  an ALLOWLIST sweep of `mu-*` sessions on the user's default tmux
  socket at suite setup AND teardown. The allowlist is DB-rooted:
  (1) `mu-<name>` for every workstream in the user's REAL DB
  (read-only via better-sqlite3, bypassing the `openDb()` test
  guard) and (2) `mu-$MU_SESSION` if the orchestrator runs the suite
  inside a tmux pane. Anything else is, by elimination, test residue
  and is killed. Replaces the old regex-prefix sweep that missed
  bare-name leftovers like `mu-alpha` / `mu-demo` / `mu-ws`. Round-4
  removed the previous "pre-existing sessions snapshot" source
  (`bug_test_flake_round_4_self_heal`): leftover test residue at
  module-load time was getting grandfathered in as protected forever,
  defeating the self-healing intent. Cost: an ad-hoc
  `tmux new-session -t mu-foo` with no DB row gets killed; workaround
  is `mu workstream init foo` first. New tests can hardcode any
  workstream name they want — if they accidentally bypass the
  private socket the sweep catches them by default.

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
- No daemon / background process beyond what tmux + SQLite give us
- No anticipatory abstractions (no traits with zero implementors)
- No wrappers around wrappers
- No codegen / embedded JS engine / workflow DSL
- No template/discovery system for agent roles (spawn flags + first
  message ARE the definition)
- No render layer beyond `cli-table3` + `picocolors`, EXCEPT `ink`
  confined to `src/cli/tui/`. NO second TUI stack alongside `ink`
  (no `blessed` / `terminal-kit` etc.); if `ink` ever stops paying
  off, REPLACE it, don't stack stacks.
- No plugin runtime, web UI, RPC, chat/docs integrations, memory
  system, workflow engine
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

1. Current schema version is **v7** (see `CURRENT_SCHEMA_VERSION`
   in `src/db.ts`). The schema lives in `src/db.ts` as the
   `applySchema(db)` block, which is idempotent CREATE-IF-NOT-EXISTS
   plus targeted `DROP TABLE IF EXISTS` for retired tables
   (e.g. v7's `DROP TABLE IF EXISTS approvals`). `openDb` rejects
   pre-current DBs with `SchemaTooOldError` (exit 4) and a
   migration hint.
2. Bump `CURRENT_SCHEMA_VERSION` in `src/db.ts` and mirror the new
   shape in `CURRENT_SCHEMA`. Two of the last three bumps were
   script-free: v5 → v6 was purely additive (existing
   CREATE-TABLE-IF-NOT-EXISTS picked up new tables); v6 → v7 was a
   destructive-but-idempotent `DROP TABLE` block. Reach for a
   one-shot migration script only when the change can't be
   expressed that way (the v4 → v5 surrogate-PK substrate switch
   was the canonical example).
3. Update tests that exercise the schema (`test/db.test.ts`).
4. Update [CHANGELOG.md](CHANGELOG.md) under the upcoming version's
   `### Changed` section.

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
npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build
```

All four green gates, plus the fast dev-loop tier. The acceptance
test (`test/acceptance.integration.test.ts`) must pass — it's the
"end-to-end works" gate.

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
