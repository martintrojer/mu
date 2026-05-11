# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [0.4.0] — unreleased

Feature theme: **interactive TUI**. `mu state --tui` opens an
ink-based dashboard (rounded-border cards, fullscreen popups,
live-updating, keyboard-driven, read-only). Default `mu state`
behaviour is unchanged — the static card stays the default; the TUI
is opt-in via the new `--tui` flag.

### Added

- **`mu state --tui`** — interactive ink-based dashboard. v0 ships:
  - 4 cards on the dashboard (Agents, Tracks, Ready, Activity log)
    toggleable with `1`-`4`. Each card uses `<TitledBox>`: rounded
    border with the section header inset into the top border line
    (lazygit/btop convention).
  - 4 fullscreen popups opened with `Shift+1`-`Shift+4` (US-glyph-row
    bound: `!`/`@`/`#`/`$`). Single-popup invariant; `Esc`/`q`
    closes and restores prior dashboard state (toggles + tick rate).
  - **Read-only**: act-intents `y`-yank the canonical `mu` command
    to the clipboard via `pbcopy`/`wl-copy`/`xclip`/`xsel`/`clip.exe`,
    falling back to OSC-52. The TUI never executes a mutation; the
    user runs the yanked command in their shell.
  - **Yank matrix** in the Tasks popup: state-aware. OPEN+ready
    → `mu task claim`, OPEN+owned → `mu task release`,
    IN_PROGRESS → `mu task close --evidence`, CLOSED/REJECTED/DEFERRED
    → `mu task open`.
  - **Tick adjust live**: `+`/`=` faster, `-` slower, `0` reset (1s
    default; 100ms floor; 10s ceiling).
  - **Help overlay**: `?` / `F1` shows the global + in-popup keymap.
  - **Alt-screen**: enters `\x1b[?1049h` on launch, restores on
    quit. Dashboard is flush with row 0; main scrollback is preserved.
  - **Column-aligned rows** with protect/clip clipping policy: task
    IDs / agent names / status tokens never truncate; titles /
    payloads / paths clip with `…`. Uses `string-width` for
    emoji + ANSI awareness.
- **TUI Workspaces card (slot 5)** — toggleable with `5`. Shows
  per-agent rows: status glyph (★ dirty / ⓘ stale / ✓ clean),
  agent name, backend, commits-behind-main (green ≤2 / yellow 3-9 /
  red ≥10), parent_ref short. Subtitle inlines `N stale` /
  `M dirty` counts when non-zero. The card surfaces the
  cherry-pick / refresh-between-waves signals previously only
  visible via `mu workspace list`. Slot-5 popup (Shift+5 / `%`) is
  not shipped yet; tracked by feat_more_cards_umbrella.
  - New SDK helper `decorateWithDirty(rows)` in `src/workspace.ts`
    populates `WorkspaceRow.dirty` via `backend.listDirtyFiles`
    (capped at DECORATE_CONCURRENCY = 4 in flight, mirroring
    `decorateWithStaleness`). jj / none backends short-circuit to
    `false` (no operator-visible "dirty" concept).
  - `loadWorkstreamSnapshot(db, ws, { withDirty: true })` opts in
    to the extra shellouts; the static `mu state` card and `mu
    workspace list` keep the cheap fast path.
- New SDK surface (`src/state.ts`):
  - `loadWorkstreamSnapshot(db, ws, opts?)` — the data contract
    both the static renderer and the TUI consume.
  - `agentStatusHistogram(agents)`, `summarizeOwnedTasks(owned)`,
    `roiBucket(impact, effortDays)` — small derivation helpers
    used by both surfaces.
- `classifyEventVerb(payload)` in `src/logs.ts` — the parsing
  half of the previous HUD-mode `colorEventPayload`, now reused
  by the static renderer's static event row + the TUI's log card.

### Removed

- **`mu state --hud`** and supporting infrastructure (≈417 LOC):
  `hudPaneSize`, `formatHud{Agents,Tasks,Recent,Tracks}Table`,
  `renderHudMode`, the dynamic-fit greedy budget layout, the
  `MU_HUD_FORCE_SIZE` env override, the `--hud` and `-n/--lines`
  options, the private `colorEventPayload` colour wrapper. The TUI
  is the conceptual replacement; users wanting the old HUD shape
  can pin to 0.3.x.
- The previous private `loadWorkstreamData` + `PerWsData` in
  `src/cli/state.ts` — now `loadWorkstreamSnapshot` +
  `WorkstreamSnapshot` in `src/state.ts`.

### Changed

- Bare `mu state` outside a tmux session no longer prints the
  silent `(no workstreams)` line. With workstreams on the machine
  it now errors with the workstream list and three suggested fixes
  (`mu state -w <name>`, `mu state --all`, `mu --help`), exit 2.
  `--all` on a truly empty machine still prints a helpful hint.
  `--json` callers continue to get `{workstreams: []}` for back-compat.

### Pillar amendments

- **VISION.md Constraint #7 (new)**: "Every invocation is
  short-lived — except for two named interactive readers." Names
  the previously-implicit pillar and carves a bounded exception
  for `mu log --tail` (existing) and `mu state --tui` (new).
  The exception is gated by four properties: interactive (not a
  daemon), read-only (against SQLite), no resources beyond stdio +
  a poll timer, opt-in (via `--tui` flag) with a static fallback.
- **ROADMAP.md anti-feature pledge updates**: the "no render
  layer beyond cli-table3 + picocolors" pledge is replaced with a
  TIGHTER form that permits `ink` ONLY in the `src/cli/tui/`
  subtree. New companion pledge: no second render layer alongside
  ink (no blessed/neo-blessed/reblessed/terminal-kit/hand-rolled
  ANSI in parallel — if ink ever fails, REPLACE the stack and
  amend the pledge; don't stack stacks).

### Deps added

- `ink ^5.0.0` (interactive TUI render layer; lazy-imported)
- `react ^18.0.0` (peer of ink)
- `@types/react ^18.0.0` (devDep)
- `string-width` (transitive via ink) — used by `columns.ts` for
  emoji + ANSI-aware cell width measurement.

Non-TUI cold-start unchanged (every other verb avoids the lazy import).

### Schema

Unchanged.

---

## [0.3.2] — 2026-05-11

Feature theme: aggressive cleanup + dogfood-driven verbs. The 0.3.1 wave
generated a fresh round of mufeedback: a wedged-worker escape hatch
(`mu agent kick`), a clean-workspace `mu agent close` shortcut, a
`mu workspace recreate` between-wave verb, scrollback-pattern detection
for provider-auth failures during spawn, `mu task notes --tail`, and
filters across `mu task add --json`. Then a sweep dropped every
same-session deprecation alias / shim that nobody depended on yet:
top-level `mu adopt`, the pre-v0.3 export-bucket detection, the legacy
`mu task wait --json` envelope fields, the `TaskRow.localId` duplicate.

### Removed

- **Pre-v0.3 ("v1", single-source) export-bucket detection** in
  `src/exporting.ts` and `src/importing.ts`. v0.3 shipped
  2026-05-10 with the new bucket layout (top-level
  README/INDEX/manifest + per-source-ws subdirs). There are no
  pre-v0.3 buckets in the wild, so the operator-facing branches
  that probed for the old shape and threw
  `LegacyExportLayoutError` / `ImportLegacyLayoutError` with a
  re-export hint are now dead weight. Dropped: both error
  classes, the `{ kind: "legacy" }` arm of `ManifestProbe`, the
  legacy detection in `readManifest`, the `if (probe.kind ===
  "legacy") throw` blocks in `renderToBucket` /
  `loadBucketLayout`, the imports + `instanceof` arms in
  `src/cli/handle.ts`'s usage-class predicate and `classifyError`,
  the SDK re-exports in `src/index.ts`, and the legacy-throw
  tests in `test/exporting.test.ts` / `test/importing.test.ts`.
  Manifests that aren't `bucketVersion: 2` now fall through to
  the existing `corrupt` lane (export: re-scaffold; import:
  `ImportBucketInvalidError` with the standard `manifest.json is
  unreadable / malformed` reason) — a single typed surface
  instead of two near-identical ones.

- **`TaskRow.localId` duplicate field dropped**
  (`drop_taskrow_localid_duplicate_of_name`). Commit 26a914a added
  `localId` alongside `name` on every TaskRow as a "compat-safe"
  duplicate so jq recipes like `.[].localId` (matching the
  agents/workstreams JSON pattern) would work. With one user and the
  rest of the codebase reading `.name` canonically across 134+ sites,
  the duplicate was dead weight. `TaskRow.localId` is gone from the
  SDK type and from every JSON read (`task list/next/show`, archive
  bucket exports, etc.). `localId` survives as a function-parameter
  NAME on `addTask` / `closeTask` / `releaseTask` and friends — that
  is internal API shape, not a JSON key. The `mu agent list` JSON
  shape (which renames the underlying SQL column to `localId` for an
  internal struct) is untouched. Operators reading task JSON from jq
  must switch `.localId` → `.name`. The corresponding regression-guard
  tests (`test/json-output.test.ts` and
  `test/output-labels-human-rename.test.ts`) flip from "emits both
  keys" to "emits `name` only".

### Breaking

- **`mu task wait --json`: dropped legacy fields from the envelope**
  (`drop_legacy_mu_task_wait_json_fields`). The previous shape spread
  the SDK `TaskWaitResult` into the JSON envelope, which leaked
  `tasks` / `allReached` / `anyReached` / `elapsedMs` and a *boolean*
  `timedOut` alongside the operator-facing `firing` / `all` /
  `timedOut` (array) / `nextSteps`. The legacy fields were kept for
  back-compat at the time — but mu has a single user, no callers
  pinned to the prior shape, and the dual-shape `timedOut`
  (overwritten boolean → array) was an accident waiting to bite.
  The canonical envelope is now exactly:

  ```
  { firing, all, timedOut, nextSteps }
  ```

  with `timedOut` always an array (`[]` on a clean exit; populated
  on actual timeout). The SDK `TaskWaitResult` shape shrinks to
  match: `{ refs, timedOut }`. Callers that need elapsed wall-clock
  time wrap `waitForTasks` with their own `Date.now()` bracket.
  `isDone()` inside `waitForTasks` now derives any/all from
  `refs.filter(r => r.reachedTarget)` directly.

### Changed

- **`mu agent close` auto-frees a clean workspace instead of requiring
  `--discard-workspace`** (`allow_mu_agent_close_without_discard`).
  Real-user pain (mufeedback gchatui): a misconfigured spawn left two
  workers whose `--workspace` dirs contained nothing but the
  backend's `.git` / `.jj` pointer file (no commits since fork, no
  uncommitted changes). `mu agent close <name>` refused both with the
  WorkspacePreservedError nag, forcing the user through the lossy
  `--discard-workspace` flag (or two extra `mu workspace free`
  invocations) just to clean up. Now: `closeAgent` calls
  `isWorkspaceClean(row)` and, if true (no uncommitted changes per
  the backend's new `isClean` probe AND zero commits since fork per
  `commitsSinceBase`), silently frees the workspace and proceeds with
  the close — the same audit trail (`workspace free` event) is
  emitted, just without the operator friction. Non-clean workspaces
  (uncommitted changes OR commits since fork) still throw
  WorkspacePreservedError and still require `--discard-workspace` for
  the lossy escape hatch. The new `VcsBackend.isClean(workspacePath)`
  method is implemented for git (empty `git status --porcelain`), jj
  (empty `jj diff -r @ --summary`), sl (empty `sl status`), and `none`
  (unconditionally true: a cp -a snapshot has nothing committed worth
  preserving). `closeAgent`'s `CloseAgentResult` gains a
  `workspaceAutoFreedClean: boolean` so the CLI can render
  "workspace auto-freed" vs "workspace discarded" accurately and JSON
  consumers get a stable signal.

- **Renamed `mu adopt` → `mu agent adopt`**
  (`mu_adopt_should_be_mu_agent_adopt_for` +
  `remove_top_level_mu_adopt_alias_now_was`). Every other
  agent-lifecycle verb (`spawn`, `send`, `read`, `show`, `list`,
  `close`, `free`, `attach`, `kick`) lives under `mu agent`;
  `adopt` was the lone holdout at the top level. `mu agent adopt`
  is now the only form — the top-level `mu adopt` alias is gone.
  Bare `mu adopt` falls through to commander's default
  unknown-command error. Internal next-step hints
  (`ClaimerNotRegisteredError`, the orphan-list footer in
  `mu agent list`, `mu undo`'s reconcile note) all use the
  canonical form.

### Added

- **`mu agent kick <name>`: signal a wedged worker pane's foreground
  process group from outside the pane**
  (`workers_commonly_attempt_unbounded_find`). Live dogfood report:
  workers running `find / -maxdepth 6 ...` or unbounded busy-wait
  loops blocked their pi event loop for tens of minutes; `mu agent
  send` queued steering messages until the tool returned, and
  `tmux send-keys C-c` did NOT propagate (the wrapping CLI catches
  it as TUI input). Recovery story was: drop out of mu, `pgrep -af
  "find /"`, `kill <pid>` — fiddly and breaks the orchestrator's
  mental model.

  `mu agent kick <name>` looks up the pane's TTY (`tmux
  display-message -p '#{pane_tty}'`), asks `ps -t <tty>` for the
  foreground process group (the row whose `stat` field contains
  `+`), and `kill -<signal> -<pgid>` signals the whole pgrp
  directly. Default `--signal SIGINT` (graceful, matches Ctrl-C);
  `--signal SIGTERM` / `--signal SIGKILL` escalate. Refuses with
  a typed `NoForegroundProcessError` when the foreground IS the
  wrapping CLI itself (`pi`/`claude`/`codex`/`bash`/...) — use
  `mu agent close` for that. Emits an `agent kick <name>
  (signal=..., pgid=..., comm=...)` event so the activity log
  records the intervention.

  SDK: `kickAgent(db, name, { workstream, signal? })` returns
  `{ agentName, paneId, tty, signaledPgid, signal, foregroundComm
  }`. New tmux helper `paneTTY(paneId)`. Process executor is
  swappable via `setKickProcessExecutor` (mirror of
  `setTmuxExecutor`) so unit tests don't touch real `ps` / `kill`.

- **`mu task notes` gains `--tail / --since / --since-claim` filters**
  (`fb_task_notes_tail`). Live mufeedback note: `mu task notes <id>`
  dumps EVERY note attached to the task, including the multi-screen
  pre-task SPEC the orchestrator drops before dispatching. Checking
  "what did the worker actually report at close?" required scrolling
  past the spec every time. Three composable filters:

  - `--tail N` (alias `--last N`): print only the last N notes.
    Must be a positive integer; commander's `parsePositiveNumber`
    rejects 0 / negatives at parse time (exit 2).
  - `--since <iso>`: print only notes with `created_at > <iso>`.
    Comparison is lexicographic on the ISO string. Unparseable
    timestamps error with `--since must be an ISO 8601 timestamp`
    (exit 2).
  - `--since-claim`: auto-resolves to the `created_at` of the most
    recent `task claim` event in `agent_logs` for this task and
    uses it as the cutoff. When no claim event exists, degrades to
    no filter (equivalent to `--since-beginning`) so the verb stays
    useful on un-claimed tasks. Mutually exclusive with `--since`
    (both define a cutoff); passing both errors with `--since and
    --since-claim are mutually exclusive` (exit 2).

  Filters compose multiplicatively: the timestamp filter is applied
  first, then `--tail` slices the last N of what survived. Default
  behaviour (no filters) is unchanged — every note, oldest-first.
  `--json` keeps the `{items, count}` collection envelope per
  `audit_json_envelope_uniformity`.

  SDK: `listNotes(db, id, ws, opts?)` gains an optional fourth
  `ListNotesOptions` argument (`{tail?, since?, sinceClaim?}`).
  All-undefined preserves the historical "return every note" shape
  so every existing caller (`cmdTaskShow`'s notes block,
  `exporting.ts`'s bucket renderer, `agents.test.ts`) keeps working
  unchanged. `lastClaimEventAt` is the new helper in `src/logs.ts`
  that resolves `--since-claim`; it mirrors `lastClaimActor`'s
  LIKE-with-escape pattern so a same-prefix id (`foo` vs `foo_2`)
  can't cross-match.

- **`mu workspace recreate <agent>`: free + create in one shot**
  (`add_mu_workspace_recreate_free_create`). Live dogfood report:
  between waves the operator was running `mu workspace free worker-N`
  + `mu workspace create worker-N -w X` for every agent in the wave;
  the `mu task wait --json` `nextSteps` already suggested `free && create`
  as one combined intent. The new verb does both atomically:
      mu workspace recreate worker-1 [-w <ws>] \
        [--backend <jj|sl|git|none>] [--from <ref>] \
        [--project-root <path>] [--force] [--json]
  Reuses the previous backend unless `--backend` overrides; bases on
  the project's current main unless `--from` overrides. Refuses on a
  dirty workspace (uncommitted changes, git/sl) the same way `free`
  does — throws `WorkspaceDirtyError` (exit 4) listing the dirty
  files, with a `--force` `nextStep` for the lossy escape. `--force`
  discards the dirty edits and rebuilds; jj is always-snapshotted so
  it never refuses; `none` has no VCS to consult so the dirty check
  is a no-op. Audit trail: ONE `workspace recreate <agent>` event
  (with both old + new `parent_ref` in the payload) instead of
  separate free + create entries; ONE pre-mutation snapshot under
  the same label. Sibling of `mu workspace refresh`: refresh
  PRESERVES the worker's local commits (rebases them onto fresh
  main); recreate THROWS THEM AWAY. Use refresh when you've already
  cherry-picked the worker's HEAD; use recreate when you want a
  pristine dir for the next dispatch. SDK: `recreateWorkspace(db,
  agent, opts) → { workspace, previousParentRef }`.

- **`mu task add --json` surfaces auto-id truncation telemetry**
  (`task_add_slugify_silently_truncates_ids`). Sibling fix to the
  human stderr hint in `slugifytitle_silently_drops_clauses`:
  scripted callers parse stdout JSON and never see the stderr
  prose, so they cannot tell when the SLUG_SOFT_CAP word-boundary
  cut dropped trailing clauses from the auto-derived id. The JSON
  envelope now adds two top-level fields (siblings of `task` /
  `blockers` / `nextSteps`, NOT inside `task`) when auto-id
  derivation actually truncated:

      truncated:    boolean   // only present when true
      originalSlug: string    // un-truncated slug, only present when truncated

  Both fields are omitted when the operator passed an explicit
  `<id>` positional (no auto-derive happened) and when
  auto-derivation produced no truncation — the omission itself is
  the false-signal, matching the singleton-envelope convention
  established by `audit_json_envelope_uniformity` (only emit
  optional fields when meaningful). SDK: `SlugifyResult` and
  `IdFromTitleResult` both gain an `originalSlug` field.

### Fixed

- **`mu agent spawn`: validate `--cli` resolves to a PATH binary BEFORE
  any side effect; surface env-var attribution in the success line**
  (`fb_agent_spawn_no_validation`). Live dogfood report: `mu agent
  spawn worker-1 --cli pi-meta` on a host where `pi-meta` wasn't on
  PATH printed `Spawned worker-1 (pi-meta)` and the pane immediately
  died with `command not found`; the existing 1.5s liveness check
  sometimes missed it (the shell stays alive past a failed exec).
  Three coordinated fixes:

  - **Pre-flight PATH check**: `spawnAgent` now resolves `--cli`
    through `MU_<UPPER_CLI>_COMMAND` and then verifies the first
    token is on PATH (via `command -v`) BEFORE `prestageWorkspace`.
    A typo throws the new typed `AgentSpawnCliNotFoundError` with
    no orphan workspace dir, no pane, no DB row.
    `errorNextSteps()` carries three remediation hints: try the
    default `--cli pi`, set the conventional env var
    (`export MU_<KEY>_COMMAND=...`), and `which pi pi-meta claude
    codex`. Hookable via `setCommandResolverForTests` so tests
    don't depend on what's installed in the test env.
  - **Extended scrollback scanner**: the post-spawn liveness scan
    added in `agent_spawn_model_auth_failure_counts_as_live` now
    also matches `/command not found/i` and
    `/No such file or directory/i` in the first ~30 lines. Catches
    the post-spawn variant that slips past the pre-flight (`--command`
    opt-out, login-shell PATH drift, …) and maps to the existing
    `AgentSpawnStartupError` (rolled back the same way).
  - **Env-var attribution in the success line**: when `--cli` was
    resolved via `$MU_<KEY>_COMMAND`, the human success line now
    reads `Spawned worker-1 (pi-meta via $MU_PI_META_COMMAND)` and
    the `--json` envelope carries `resolvedFromEnvVar:
    "MU_PI_META_COMMAND"`. Stale aliases are now obvious without
    `mu agent show`.

  SDK additions: `AgentSpawnCliNotFoundError`,
  `checkCommandResolvable`, `envVarNameForCli`,
  `resolveCliCommandWithSource`,
  `setCommandResolverForTests`/`resetCommandResolverForTests`.

- **`mu agent spawn`: detect provider-auth startup failures during the
  liveness check** (`agent_spawn_model_auth_failure_counts_as_live`).
  Live dogfood report: `pi-meta --no-solo --model sonnet:high` printed
  `Error: No API key found for amazon-bedrock` and parked at a prompt.
  The pane stayed alive (1.5s liveness check passed) but the worker
  could never do work — the orchestrator only discovered this when
  `mu task wait` stalled minutes later. Fix: after confirming
  `paneExists`, `awaitSpawnLiveness` now scans the LAST ~30 lines of
  the post-liveness pane capture for a curated list of startup-error
  patterns:
      - `/No API key found for [\w-]+/i`
      - `/Error: invalid API key/i`
      - `/Authentication failed/i`
      - `/401 Unauthorized/i`
      - `/Could not authenticate/i`
  On a match the spawn rolls back (workspace + agent row) and throws
  the new typed `AgentSpawnStartupError` with the matched line, the
  full scrollback tail, and `nextSteps` pointing at the safe pi-meta
  default (`--command "pi-meta --no-solo"`) and the
  `export ANTHROPIC_API_KEY=...` recipe. The new error is exit-code 1
  (substrate-level, same lane as `AgentDiedOnSpawnError`). The scan is
  tail-only (last 30 lines of a 50-line capture) so harmless
  prior-session text scrolled off the top of a brand-new pane can't
  trip it; the patterns must come from the spawned CLI's first ~1.5s
  of output. Disable with `MU_SPAWN_LIVENESS_MS=0` if you actually
  wanted the parked prompt (CI / scripted recovery).

- **`mu agent spawn --workspace`: rollback the workspace dir + agent
  row when tmux pane creation fails** (`agent_spawn_abort_leaves_orphan_workspace`).
  Live dogfood report: spawning a worker into a workstream whose tmux
  session didn't exist (and where tmux refused `new-session`)
  prestaged the workspace dir + placeholder agent row, then threw —
  but the existing rollback only fired on later phases (finalize,
  liveness). The orphan workspace dir survived; `mu workspace list`
  showed nothing; `mu workspace orphans` was the only way to find
  it. Fix: a single outer try wraps `createOrReusePane` +
  `setPaneTitle` + `enableMuPaneBordersForPane` + `finalizeAgentRow`
  + `awaitSpawnLiveness`; any failure runs the existing
  `rollbackSpawn` (idempotent and best-effort). When the failure
  happens after a workspace was prestaged, the thrown error is
  augmented with two orphan-cleanup `nextSteps` (`mu workspace
  orphans -w <ws>`, `mu workspace free <agent> -w <ws>`) so the
  operator gets the cleanup recipe inline. Two follow-ups left
  out of scope (filed for triage): auto-creating the missing tmux
  workstream session before spawn (operator's update note 3), and
  SIGINT handlers between prestage and the first try-block (needs
  process-global state).

---

## [0.3.1] — 2026-05-11

**First npm release.** Published as `@martintrojer/mu`. The skill
ships in the same repo and installs via the
[skills CLI](https://github.com/vercel-labs/skills):
`npx skills add martintrojer/mu`.

Feature theme: contract uniformity. Two `--json` audits make every
operator-error path and every collection-read verb structurally
identical, so a script can `jq` any verb's output / error envelope
without per-verb special-casing. Plus four small typed-verb wins
from the v0.3 dogfood feedback wave.

### Added

- **`mu task close --if-ready`: idempotent umbrella-on-wave-done
  closer** (`fb_umbrella_no_auto_close`, impact=60). Live dogfood
  report: built `wave_w3_tests` umbrella with 18 blockers; after
  every blocker reached CLOSED / DEFERRED the umbrella stayed OPEN
  and had to be hand-closed. `--if-ready` is the cheap fix — the
  bare `mu task close <id>` semantics are unchanged (still closes
  regardless), but `--if-ready` no-ops unless every direct blocker
  is in a terminal status (CLOSED / REJECTED / DEFERRED). On the
  no-op path the verb prints the still-blocking ids + a Next: hint
  pointing at `mu task wait <ids> --first --any`. JSON gains
  `skipped: "not_ready"` and `blockingIds: [...]` so an
  orchestrator can fire the closer eagerly after each pipeline
  cherry-pick. Exit code 0 either way (no-op is success).
  Option (a) auto-close on last-blocker-close was rejected because
  it changes lifecycle semantics for umbrellas with content of
  their own. SDK: `closeTask` gains `ifReady?: boolean` and a new
  `CloseSkippedResult` return shape (typed-union with
  `SetStatusResult`).

- **`mu workspace commits <agent> [--since <ref>]`**
  (`fb_workspace_commits_verb` /
  `mu_workspace_commits_print_since_fork`). Promotes the dogfood-
  painful `cd $(mu workspace path X) && git log <base>..HEAD`
  incantation into a typed verb that knows the workspace's
  recorded `parent_ref`. Default text output is `<sha> <subject>`
  per line, oldest-first. `--json` emits the full array
  `[{sha, subject, body, authorDate}]` for piping (e.g.
  `mu workspace commits worker-X --json | jq -r '.[] | select(...) |
  .sha' | xargs git cherry-pick`).
  - **git**: `git log --reverse -z --format='%H%x00%s%x00%b%x00%aI'
    <base>..HEAD` (NUL-delimited per record so subjects/bodies with
    embedded newlines survive parsing).
  - **jj / sl**: equivalent NUL-field / `\x1e`-record templates;
    `parseNulRecords()` is the shared parser.
  - **none**: throws `WorkspaceVcsRequiredError` (exit 4) — cp -a
    snapshots have no fork point.
  - SDK: `listCommitsForWorkspace(db, agent, opts)` returns
    `{ vcs, baseRef, commits, workspacePath }`.
  - VcsBackend interface gains
    `commitsSinceBase(workspacePath, baseRef): Promise<CommitSummary[]>`
    where `CommitSummary = { sha, subject, body, authorDate }`.

- **`mu workspace refresh <agent> [--from <ref>]`**
  (`fb_workspace_recycle_verb` /
  `mu_workspace_refresh_rebase_agent`). Rebases an agent's workspace
  onto a fresh base WITHOUT touching the agent or pane — the worker
  keeps its LLM context while the on-disk dir moves. Default base =
  the backend's tracked main: `origin/HEAD` for git (with a
  best-effort `git fetch` first), `trunk()` for jj / sl. `--from
  <ref>` overrides.
  - **git**: refuses on dirty WC with `WorkspaceDirtyError` carrying
    the dirty file list (exit 4) and Next: hints to commit/stash.
    On rebase conflict aborts the rebase and throws
    `WorkspaceConflictError` carrying the conflicting paths (exit 5)
    with a `cd` hint to resolve manually.
  - **jj / sl**: rebase onto `trunk()` (or `--from`), surface
    conflicts via `conflict()` revset / `sl resolve --list`. jj is
    always-snapshotted so dirty WC isn't an issue; sl pre-checks.
  - **none**: throws `WorkspaceVcsRequiredError` (exit 4) —
    refresh is meaningless for a `cp -a` snapshot.
  - JSON shape: `{ vcs, fromRef, replayed: string[], conflicts:
    string[], workspacePath }`. Card output lists each replayed
    commit subject. Replaces the dogfood-painful
    `close → free → spawn` recycle that killed worker context.
  - SDK: `refreshWorkspace(db, opts)` returns the same shape.
  - VcsBackend interface gains `rebaseTo(workspacePath, fromRef?):
    Promise<RebaseResult>`.

### Changed

- **Uniform `--json` collection envelope across every list/search/
  notes/orphans/commits verb** (`audit_json_envelope_uniformity`).
  Pre-1.0 breaking. Every collection-read verb used to emit a bare
  array (`mu task list --json` → `[{...}, {...}]`); a sibling field
  could not be added later (e.g. `baseRef`, `behindCount`,
  `totalAcrossPages`) without breaking every caller. Now uniformly
  `{items: T[], count: number}`. Affected verbs:
  `mu task list / next / owned-by / notes`, `mu workstream list`,
  `mu workstream destroy --empty` (dry-run), `mu archive list /
  search`, `mu workspace list / orphans / commits`, `mu snapshot
  list`, `mu log -n N` (read; NOT `mu log --tail` which stays NDJSON
  one-object-per-line for stream consumers).
  - `count` is `items.length` pre-computed; future siblings can
    layer on without breaking the existing two fields.
  - `mu workspace orphans` (with `-w`) was already an object
    envelope; renamed `orphans` field to `items` for uniformity
    and added `count`. The `--all` form was bare-array; now matches.
  - **Carve-outs**: `mu sql --json` keeps bare-array rows (it's the
    escape hatch; row shape is per-query, not part of the typed
    contract; envelope-wrapping is paternalism). `mu log --tail`
    keeps NDJSON (one object per line) since it's a stream, not a
    collection.
  Codified by a new `emitJsonCollection<T>(items)` helper in
  `src/cli.ts` so any future collection-read verb gets the shape
  for free.

- **Uniform validation-error contract across every operator-error
  path** (`audit_cli_validation_uniformity`). Pre-1.0 breaking on
  exit codes. Three error classes used to produce three different
  surfaces: commander mistakes (missing required option, unknown
  option/subcommand, missing positional, type-coercion failure)
  exited 1 with a help dump and ignored `--json`; handler-thrown
  `UsageError` (mutex flags, range checks) exited 2 with NO help
  and a `{error,message,nextSteps,exitCode}` JSON; typed `*Invalid*`
  domain errors (workstream-name / archive-label / task-id / prune-
  options) exited 2 with no help. Now all three:
  - print red `error: <msg>` then the failing subcommand's `--help`
    (human path), exit **2** uniformly.
  - emit `{error, message, nextSteps, exitCode: 2, usage}` to stderr
    (`--json` path) where `usage` is a structured rendition of the
    same `--help`: `{command, synopsis, description, args[], options[]}`.
    `usage.options[].mandatory` distinguishes "operator MUST pass"
    (`.requiredOption()`) from `valueRequired` ("if passed, value
    can't be omitted"); the two were conflated as one `required`
    flag in the previous JSON.
  Plumbing: every command in the tree now calls `.exitOverride()`
  recursively, the active subcommand is tracked in a module-local
  set by `handle()`, and the parseAsync catch routes commander
  errors through the same `emitError()` pipeline. `_runCli.ts` test
  helper updated to mirror the new entry-point shape. Excluded from
  the help-on-error rendering: `Import*Error` / `LegacyExportLayoutError`
  (those fault on directory contents the operator pointed at;
  `--help` wouldn't have prevented them; their typed `nextSteps`
  already carry the fix).

- **`mu task delete <id>` is now two-phase: bare = dry-run preview;
  `--yes` commits** (`fb_task_delete_no_yes`, impact=30). Pre-1.0
  breaking change. The dogfood report: typed `mu task delete X
  --yes` (mirroring `mu workstream destroy --yes`) and got
  'unknown option --yes' — the verb took no confirmation flag at
  all. Two failed deletes left long-named tasks lingering until
  noticed. Mirrors `mu workstream destroy` / `mu archive delete`
  / `mu snapshot prune`. Bare `mu task delete <id>` now prints
  the cascade preview (the task + edges that would drop + notes
  that would drop, with counts) plus a Next: hint pointing at
  `mu task delete <id> --yes`; nothing is mutated and no snapshot
  is taken on the dry-run. `--yes` keeps today's behaviour
  byte-for-byte (auto-snapshot, then DELETE; FK CASCADE drops
  task_edges + task_notes). JSON shape: dry-run carries `dryRun:
  true` + `deletedEdges` / `deletedNotes` (would-be counts) +
  `present: boolean`; commit carries `dryRun: false` + actual
  counts. SDK: `deleteTask` gains `opts: { dryRun?: boolean }`
  and the result type gains `dryRun: boolean` + `present:
  boolean` (discriminator for the missing-row case). Idempotent
  on a missing task in both phases.

---

## [0.3.0] — 2026-05-10

### Added

- **Stderr lint hint when `mu agent spawn <name>` violates the
  smallest-unused-suffix convention** (`agent_spawn_stderr_hint_when_name_does`,
  source ws task `fb_agent_naming_convention`). Names that don't match
  `^[a-z][a-z0-9]*(?:-[0-9]+)$` (e.g. `worker-tests`, `alice`,
  `db-leader`, `x-y-1`) still spawn successfully — this is a lint, not
  a rule — but mu now writes a one-line hint to stderr after the spawn:
  `hint: agent name "X" does not match the smallest-unused-suffix
  convention (<role>-<n>; e.g. worker-1, reviewer-2). Accepted; consider
  renaming if you spawn additional workers.` Suppressed under `--json`
  so script callers stay clean. Mirrors the slugify-truncation hint in
  `cmdTaskAdd` (`slugifytitle_silently_drops_clauses`): stderr-only,
  exit 0, no schema or behaviour change for scripts that ignore stderr.
  Surfaced by the dogfood report where the operator named
  `reviewer-1/2/3`, `worker-1/2/3`, then drifted to `worker-tests` and
  mu accepted it silently.

- **`mu snapshot prune` and `mu snapshot delete <id>`**
  (`snapshot_gc_caps_too_lax_no_cleanup_verb`). Two new manual
  cleanup verbs for the snapshots collection; both promote what
  used to require `rm -rf <state-dir>/snapshots/*.db` + a `mu sql
  DELETE FROM snapshots` (scary; bypasses the schema-version safety
  check that keeps `mu undo` honest).
  - **`mu snapshot prune`** — bulk policy-driven cleanup. Bare form
    runs the GC policy (count + age caps) explicitly. Flags select
    alternate modes: `--keep-last N` (top-N by id), `--older-than
    <DAYS>d` (accepts `7d`/`30d`/bare integer), `--stale-version`
    (drop rows whose `schema_version != CURRENT_SCHEMA_VERSION` —
    unrestorable; pure disk weight after a schema bump), `--all`
    (nuke everything). Two-phase: prints a dry-run summary by
    default; `--yes` commits. `--all --yes` auto-captures a
    safety-net snapshot of the live DB FIRST so a subsequent
    `mu undo --to <safety-net-id> --yes` recovers. JSON shape:
    `{deletedRows, deletedFiles, freedBytes,
    safetyNetSnapshotId?}`. SDK: `pruneSnapshots(db, opts)` returns
    a structured `{victims, freedBytes, deletedRows, deletedFiles}`
    + `safetyNetSnapshotId` when `mode='all'`.
  - **`mu snapshot delete <id>`** — surgical removal mirroring
    `mu task delete`. Drops the row + unlinks the on-disk .db file.
    Errors with `SnapshotNotFoundError` on miss. Does NOT auto-
    snapshot first (the point is to delete one stepping-stone, and
    that can't break `mu undo` — every other snapshot remains).
    SDK: `deleteSnapshot(db, id)`.

- **`mu task claim --for` accepts cross-workstream qualified refs**
  (`task_claim_for_cross_workstream`). `--for <name>` keeps today's
  same-workstream resolution; `--for <workstream>/<name>` (NEW)
  dispatches across the boundary — the agent stays in its own
  workstream, only `tasks.owner_id` crosses (FK is workstream-
  agnostic at the schema level). Cures the per-workstream-worker-pool
  friction where a free worker in A and a queued task in B forced
  closing + respawning the worker (losing LLM context) or hand-edits
  via `mu sql`. Bad qualifier surfaces typed `WorkstreamNotFoundError`
  (missing prefix) or `AgentNotFoundError` (worker not in named ws);
  nothing committed on failure. SDK `claimTask` gains an optional
  `agentWorkstream` field; default = `opts.workstream`.

- **`mu task wait --on-stall <warn|exit>`: expose the stall ACTION as
  a flag** (`task_wait_stall_action_flag`). Today's `--stuck-after`
  defines the TRIGGER (IN_PROGRESS task whose owner sat in
  `needs_input` for >= N seconds); `--on-stall` defines what to do
  when it fires. `warn` (default) = today's behaviour byte-for-byte
  (yellow STUCK to stderr + corroborating `agent stalled` event;
  wait keeps polling). `exit` = same emit + persist, then exit 7
  (`STALL_DETECTED`) so an unattended orchestrator can branch on the
  ambiguous-idle (7) vs unambiguous-dead-pane (6) distinction.
  Suppressed when `--status` is not `CLOSED` (mirrors exit-6's
  carve-out). If both reaper-flip (6) and stall (7) would fire in
  the same poll, exit 6 wins (the reaper-flip in `beforePoll`
  pre-empts the snapshot's stuck-check; once status is OPEN,
  isStuck naturally returns false). New typed
  `StallDetectedDuringWaitError` (HasNextSteps: poke worker /
  inspect scrollback / release --reopen / show task); SDK
  `waitForTasks` gains `onStall?: 'warn' | 'exit'`.

- **Derived `idle` flag on `AgentRow`: alive + assigned + no recent
  progress** (`idle_assigned_agent_detection`). Surfaces the third
  agent lifecycle state (pi crashed mid-task without crashing the
  pane: `Operation aborted`, model timeouts, transient connection
  drops). Predicate: `status === 'needs_input'` AND owns ≥1
  IN_PROGRESS task AND `(now - updated_at) >= MU_IDLE_THRESHOLD_MS`
  (default 300_000ms; matches today's `mu task wait --stuck-after`
  default). Computed at read time only — NOT a 5th status enum
  value, NOT stored in the DB. `listLiveAgents` enriches each row;
  `mu state` (full / hud / mission) prefixes a yellow ⚠ glyph and
  yellows the agent name when idle; `mu state --json` emits
  `idle: true` (omitted otherwise). `mu task wait --stuck-after`
  also persists a `kind='event'` row payload `agent stalled <name>
  owns <task-id> for <secs>s` as corroborating signal. Recovery is
  operator-driven: `mu agent send <name> '<retry>'` or `mu task
  release <id> --reopen` — mu deliberately does NOT auto-restart pi
  or auto-release the task (idle is ambiguous; the operator decides).

- **`mu --help` and every subcommand `--help` now list commands
  alphabetically** (`cli_help_alphabetical_subcommands`). Options
  list ordering inside each verb is unchanged — those are curated
  semantically; only the Commands listings are sorted.

- **`mu workstream import <bucket-dir>`** — inverse of
  `mu workstream export`. Walks a v0.3 bucket directory (markdown +
  manifest.json) and rebuilds every source-ws subdir as live tasks,
  edges, and notes. Markdown-only by design (no `.db` imports;
  cross-machine `.db` is `mu undo` + snapshots). Per-source-ws
  transactional; refuses to merge silently into an existing
  workstream (`--workstream <name>` for single-source rename, or
  destroy first). Supports `--dry-run` and `--json`. Pre-0.3 layouts
  surface a typed `ImportLegacyLayoutError`. New SDK in
  `src/importing.ts` exports `importBucket()` and the typed errors.

- **`mu workstream import` — partial bucket import** (per-source-ws
  subdir path OR `--source-ws <names...>` CSV filter on a bucket).
  Form 1 auto-detects a per-source-ws subdir via `README.md` +
  `INDEX.md` + `tasks/` and validates against the parent bucket's
  `manifest.json`; Form 2 keeps the bucket root and filters via the
  variadic flag (repeat or comma-separate; or both, per
  `cli_audit_plurality_uniformity`). `--workstream <new-name>` is
  allowed when the resolved source list is single (Form 1, or Form 2
  with one name); multi-source filters keep today's rejection. New
  typed `ImportSourceNotInBucketError` (exit 4) names the bad name +
  the valid ones.

- **`mu hud` accepts multiple workstreams via `-w/--workstream` (now
  variadic) or `--all`** (`hud_multi_workstream` + `hud_unify_workstream_flag`).
  N=1 (the common case, including legacy `mu hud -w X`) renders
  byte-for-byte unchanged — same columns, same JSON shape — so
  existing tmux status-bar pipes (`#(mu hud --json) | jq ...`) keep
  working. N≥2 grows the workstream-summary table to N rows, gains
  a leading bold-cyan `workstream` column on every section table,
  and switches the JSON envelope to `{ workstreams: [...] }`.
  Recent-events table becomes a cross-workstream timeline (DESC by
  `created_at` across the union). The variadic shape uses the
  parseCsvFlag convention from cli_audit_plurality_uniformity
  (repeat OR comma-separate OR both); the originally-shipped
  `--workstreams` companion flag was unified into `-w` before
  release (see the Changed `hud_unify_workstream_flag` entry below).

- **CLI multi-value flags now accept repeat OR comma-separated forms
  uniformly** (today's `--blocked-by a,b,c` keeps working; you can now
  also `--blocked-by a --blocked-by b`). Codified by
  `cli_audit_plurality_uniformity`: every variadic flag is post-processed
  through a single `parseCsvFlag` helper; help text uses the stock phrase
  "(repeat or comma-separate; or both)"; the `<value...>` metavar is the
  syntactic signal.

- **`src/archives.ts` SDK** (Phase 1 of the v0.3 archive feature):
  `createArchive`, `listArchives`, `getArchive`, `deleteArchive`,
  `addToArchive`, `removeFromArchive`, `listArchivedTasks`. Idempotent
  at (archive, source_workstream) granularity — re-running
  `addToArchive` against the same workstream is a no-op; adding a
  new task and re-running picks up only the delta. Typed errors:
  `ArchiveNotFoundError`, `ArchiveAlreadyExistsError`,
  `ArchiveLabelInvalidError`. Phases 2 (CLI), 3 (destroy hook), and
  4 (export renderer) follow.

- **`mu archive search <pattern>` — LIKE-search archived titles
  AND archived note content** (Phase 4b). `--label <l>` scopes to one
  archive (throws `ArchiveNotFoundError` on miss); `--limit N`
  defaults to 50; `--json` emits the `ArchiveSearchHit[]` array.
  The pattern is bound as a SQL parameter (never concatenated), so
  `mu archive search "'); DROP TABLE archives; --"` is just an
  empty result. Title matches win over note matches when the same
  task hits both.

- **`mu archive create / list / show / add / remove / delete` —
  feature complete (6 verbs + tests + docs).** Phase 2 of the v0.3
  archive feature: thin commander glue (`src/cli/archive.ts`) over
  the Phase 1 SDK. `mu archive add <label> -w <ws> [--destroy]` is
  the headline workflow — preserve a workstream's task graph in an
  operator-named bucket, optionally cascading to `mu workstream
  destroy --yes`. The bucket is additive: re-add new workstreams
  under the same label as new releases finish. `mu archive delete`
  is two-phase (dry-run by default, `--yes` captures a snapshot
  first). Typed errors map to exit codes: `ArchiveNotFoundError`
  → 3, `ArchiveAlreadyExistsError` → 4, `ArchiveLabelInvalidError`
  → 2. `--json` on every verb.

- **Unified bucket renderer + `mu archive export <label> --out <dir>`**
  (Phase 4 of the archive feature; `archive_phase4_export_renderer_unified`).
  The renderer factored out of `src/workstream.ts` into a new
  `src/exporting.ts` module that takes N source workstreams (each
  with its tasks/edges/notes) and writes a `bucketVersion: 2`
  bucket on disk. Both `mu workstream export` (one source) and the
  new `mu archive export` (every source-ws in an archive) delegate
  to the same renderer, producing byte-identical disk shapes.
  Bucket exports are additive across calls (sha256 short-circuit
  per task; sibling source-ws subdirs are never touched by an
  unrelated re-export). `mu workstream destroy --yes`'s pre-destroy
  auto-export uses the new shape automatically. Pre-0.3 export
  directories are no longer accepted in place — see Breaking above.

- **`mu workstream destroy --archive <label>`** (Phase 3 of the v0.3
  archive feature): atomic snapshot-then-destroy. The label must
  already exist (anti-feature: no auto-create — run `mu archive
  create <label>` first). Archive add runs BEFORE destroy; if it
  fails, the destroy is aborted. Dry-run mode (no `--yes`) reports
  "would archive N tasks to <label>" alongside the existing
  pre-destroy summary.

- **`mu workstream destroy --empty`** sweeps every empty workstream
  (zero tasks, agents, vcs_workspaces, approvals) in one call;
  replaces the per-name `jq` incantation over `mu workstream list
  --json`. Tmux session presence and audit-only `agent_logs` do NOT
  disqualify. Mutually exclusive with `-w` and `--archive`. Dry-run
  lists candidates as a table (or array via `--json`); `--yes`
  captures ONE whole-DB snapshot for the batch, then best-effort
  destroys each (a per-workstream failure is collected into
  `failed[]` and the sweep continues). Closes
  `workstream_destroy_empty_sweep`.

### Removed

- **Phantom `mu workspace adopt` hint dropped from `cmdWorkspaceOrphans`
  nextSteps** (`nextsteps_audit_workspace_orphans_phantom_verb`). The
  hint pointed operators at a verb that does not exist (and at a
  ROADMAP entry that also does not exist), violating the "nextSteps
  must not point at non-existent verbs" framing. Workspace adoption
  is theoretical; the remaining `git worktree remove` / `rm -rf`
  hint is the one workable path.

- **`docs/OUTPUT_LABELS_AUDIT.md` removed.** v0.2 single-purpose
  audit; output-label rename work shipped; no live readers.

- **`docs/VERB_AUDIT.md` removed** (`remove_or_shrink_verb_audit_md`).
  v0.2-vintage 1122-LOC verb-by-verb audit (typed-vs-`mu sql`,
  atomicity / side-effect / error-mapping / nextstep scoring); the
  promotion decisions it informed have shipped (`mu hud` merged into
  `mu state --hud`; `mu approve *` removed; `whoami` / `my-tasks` /
  `my-next` merged into `mu me`; `mu task search/blocked/goals`
  removed; `mu adopt` re-wired). The audit was a one-shot exercise,
  not a living spec; doc_stale_verb_audit_v01's drift was too large
  (every audit row references the v0.2 verb surface) for in-place
  fixes to be worthwhile. No live readers (only links: this
  CHANGELOG entry + a README pointer); both updated.
- **`scripts/` directory + CI grep guards removed.**
  `grep-v4-references`: job done (v4 migration code removed; remaining
  v4 mentions are intentional history). `grep-name-without-workstream`:
  invariant now structurally enforced by the v5 surrogate-id schema
  (per-workstream UNIQUE on name + INTEGER FKs). `lint` becomes
  biome-only.

- **`mu hud` removed; behavior moved to `mu state --hud`**
  (`merge_state_into_hud_render_mode`). The verb was a render-strategy
  variant of `mu state` (same data set; different presentation), so
  it collapses to a flag on the canonical card. Update tmux configs
  accordingly: `tmux display-popup -E 'mu hud -w X'` becomes
  `tmux display-popup -E 'mu state --hud -w X'`. Pre-1.0; no
  deprecation shim.

- **`mu approve` verbs + `approvals` schema table — REMOVED.** Zero
  usage across the v0.2 + v0.3 dogfood waves (200+ tasks). Anti-
  anticipatory pruning per VISION.md "no traits with zero
  implementors". 706 LOC of SDK + CLI gone (`src/approvals.ts` +
  `src/cli/approve.ts`); `mu approve add/list/grant/deny/wait` are
  no longer recognised verbs. The `approvals` table, its indexes,
  and the `approval add/granted/denied/timeout` event prefixes are
  all gone too. v6→v7 schema migration drops the table in-place
  via `applySchema` (DROP TABLE IF EXISTS approvals on any pre-v7
  DB; gated on the detected pre-bump version so it's a one-shot).
  The pre-v5 refusal floor in `openDb` stays at v5. May return in
  v0.4+ when a real second implementor surfaces (e.g., an unattended
  pi-orchestrator running mu). If you have approvals rows you want
  to preserve, snapshot first via `mu undo` (or copy them out via
  `mu sql`) before upgrading.

### Changed

- **`src/cli.ts` split below the 800-LOC refactor signal**
  (`review_cli_ts_past_refactor_signal`). cli.ts had drifted to 1339
  LOC — well past AGENTS.md's 800-LOC refactor signal — hosting
  ~600 LOC of pure rendering helpers (table renderers, status
  colourers, `truncate` / `relTime`) and ~150 LOC of typed-error →
  exit-code mapping (`classifyError` / `emitError` / `handle` /
  `UsageError` / `NameAmbiguousError`) on top of its actual job
  (workstream resolution + commander wiring). Extracted to two
  cluster-mates inside `src/cli/`: `format.ts` (418 LOC; pure
  rendering, no I/O beyond `printLogRow`'s single `console.log`) and
  `handle.ts` (247 LOC; typed-error catalogue + the wrapping helper).
  cli.ts shrinks to 718 LOC and re-exports every moved symbol so the
  ~30 import sites in `src/cli/*.ts` and `test/` keep working without
  churn. No behaviour change; ARCHITECTURE.md cluster-table updated.

- **`mu task release` auto-flips `IN_PROGRESS` → `OPEN` by default;
  `--reopen` re-scoped to the un-close escape hatch**
  (`review_release_open_in_progress_inconsistency`). Bare `mu task
  release <id>` against an `IN_PROGRESS` task used to clear `owner`
  but leave `status = IN_PROGRESS` — a structurally stranded state
  (no owner to drive the task forward; `mu task next` skipped it
  because it wasn't `OPEN`; `mu task wait` blocked indefinitely; `mu
  state`'s in-progress section listed it with an empty owner column).
  The reaper's dead-pane recovery already does the right thing
  (clears owner AND flips to `OPEN`); release now matches. New
  default semantics:
    * `IN_PROGRESS` → owner cleared + status flipped to `OPEN` (the
      "give it back to the pool" workflow operators already describe).
    * `OPEN` → owner cleared, status preserved (today's behaviour).
    * `CLOSED` / `REJECTED` / `DEFERRED` → owner cleared, status
      preserved (release is not an un-decide).
  `--reopen` is now the explicit force-OPEN escape hatch — useful
  when un-closing a `CLOSED` owned task in one verb (previously the
  only thing `--reopen` did beyond bare release; on an `IN_PROGRESS`
  task `--reopen` is now a no-op vs. bare release). Pre-1.0 breaking
  change in the `releaseTask` SDK return shape (`status` may now be
  `OPEN` where it would have been `IN_PROGRESS`); CLI exit code and
  flag surface unchanged. Snapshot + agent_logs event behaviour
  unchanged.

- **`mu state` gains `--hud` and `--mission` render flags. Bare `mu`
  (no verb) is now an alias for `mu state --mission`** (today's
  stripped 5-col glance card; `merge_state_into_hud_render_mode`).
  One verb, three render modes:
    * default    — full top-to-bottom card (today's `mu state`)
    * `--hud`    — dynamic-fit budget renderer (today's `mu hud`)
    * `--mission` — stripped 5-column glance card (today's bare `mu`)
  `--hud` and `--mission` are mutually exclusive. The flag toggles
  rendering ONLY — the data set is identical across modes. JSON shape
  follows the renderer: default + `--hud` emit the unified flat shape
  `{ workstreamName, agents, orphans, tracks, ready, blocked,
  inProgress, recentClosed, workspaces, recent }`; `--mission` emits
  the stripped subset `{ workstreamName, agents, orphans, tracks,
  ready }`. Bare `mu --json` matches `--mission --json`. Net `-570`
  LOC src/ (entire `src/cli/hud.ts` lifted into `src/cli/state.ts`
  as render helpers).

- **`mu task wait` accepts cross-workstream qualified refs and gains
  `--first` (alias of `--any` that prints WHICH ref closed)**
  (`task_wait_cross_workstream`). Each `<ref>` is now bare
  (resolves via `-w` / `$MU_SESSION` / tmux session) or qualified
  `<workstream>/<name>` — `-w` is dropped when every ref is
  qualified; mixed lists are allowed. The per-poll reconcile loops
  over every workstream in the wait set (so reaper-flip exit 6
  fires across the whole watched surface, NOT just `-w`); a
  reaper-flip on an UNWATCHED workstream does not bleed into the
  exit code. `--first` adds a `firing: { workstreamName, name,
  qualifiedId, status, owner }` field to `--json` and prints the
  qualified id to stdout, so the dispatch-pipeline loop reduces to
  `closed=$(mu task wait <refs> --first --json | jq -r .firing.qualifiedId);
  cherry-pick; verify; free; recreate; repeat`. `--json` shape on
  the default `--all` path: `{ firing: null, all: [<ref reaching
  status>...], timedOut: [<unmet refs>...], nextSteps }`. SDK
  `waitForTasks` now accepts `TaskWaitRef[]` (each carrying its own
  `workstreamName`) in addition to the legacy `string[] + opts.workstream`
  shape; new exported `TaskWaitRef` type; `TaskWaitTaskState` gains
  a `workstreamName` field.

- **`mu task wait` now reconciles the workstream each poll and fails
  fast on a dead worker pane** (`task_wait_reconcile_dead_panes`).
  Per-poll `reconcile(mode: "full")` runs the reaper, which flips an
  IN_PROGRESS task whose owning pane is gone back to OPEN. With the
  default `--status CLOSED` the wait then exits with new code `6`
  (REAPER_DETECTED) and a stderr message naming the dead task + prior
  owner — cures the silent multi-minute stall after a tmux server
  restart kills worker panes. Suppressed when `--status` is not
  CLOSED (a reaper-flip TO open IS the success when `--status OPEN`).
  New `ReaperDetectedDuringWaitError`; `TaskWaitTaskState` gains an
  `owner` field; SDK gains a `beforePoll` hook on `waitForTasks`.

- **`mu workstream destroy --empty` now also surfaces unregistered
  `mu-*` tmux sessions** (`destroy_empty_match_tmux_only`). Test
  litter and partial-destroy remnants (DB row gone, tmux session
  survived) are now matched by the same sweep verb. Predicate is
  narrow on the `mu-` prefix; arbitrary tmux sessions are never
  touched. Synthetic `WorkstreamSummary` for tmux-only entries has
  `registered=false`, all counts 0, `tmuxAlive=true`; the dry-run
  table renders an em-dash for the missing `created_at`.

- **`--status` accepts multi (union) on `mu task list`, `mu task next`,
  and `mu approve list`** (`task_list_multi_status_union`). Same
  dual-form as every other multi-value flag (`--status OPEN,CLOSED`,
  `--status OPEN --status CLOSED`, or any mix), case-insensitive,
  deduped. Missing `--status` keeps today's no-filter shape (no auto-
  default to `OPEN ∨ IN_PROGRESS`). Single value is byte-identical to
  today's behaviour. `mu task wait --status` stays single (the verb is
  semantically "wait until reaches THIS status"). New shared helper
  `parseStatusesOption` in `src/cli.ts`; SDK `listTasks` /
  `listReady` / `listApprovals` accept `status?: T | readonly T[]`.

- **`mu hud`: `-w/--workstream` is now variadic; `--workstreams` removed**
  (`hud_unify_workstream_flag`). One flag does single + multi via
  parseCsvFlag (repeat OR comma-separate OR mix). `--all` kept as
  orthogonal sugar (mutually exclusive with `-w`). Pre-1.0, no
  back-compat shim: the only consumer was the orchestrator's own
  dispatch. hud is the one verb where `-w` accepts multi; every other
  verb keeps `WORKSTREAM_OPT` (single-valued).

### Fixed

- **`mu workspace orphans` no longer hides dirs from destroyed
  workstreams; `--all` flag added; `-w <unknown>` now errors**
  (`workspace_orphans_misses_destroyed_workstreams`). Three failure
  modes were folded into one nit: the verb required `-w <ws>`, had
  no scan-everything mode, and silently returned "no orphans" when
  the workstream itself didn't exist (so a typo, OR a workstream
  that had been destroyed without its on-disk dir cleared, hid
  permanent garbage). Fix is two-part:
  (1) New `mu workspace orphans --all` enumerates every workstream
  subdir under `<state-dir>/workspaces/`, recurses one level, and
  reports orphans across ALL workstreams INCLUDING workstreams
  whose row is gone. Each entry carries `stranded: boolean` — true
  when the parent workstream has no DB row, surfacing the destroyed-
  workstream case. JSON output is a flat array of
  `{workstreamName, agentName, path, stranded}`. `--all` overrides
  `-w` (a typo'd `-w` with `--all` is ignored, not an error).
  (2) `mu workspace orphans -w <unknown>` now throws
  `WorkstreamNotFoundError` (exit 3) via the same path the mutating
  verbs use, instead of silently happy-pathing to "(no orphan
  workspace dirs in <typo>)". The single-ws path now resolves the
  workstream tightly via `tryResolveWorkstreamId` before scanning.
  SDK side: new `listAllOrphanWorkspaces(db)` in `src/workspace.ts`
  and a new `StrandedWorkspaceOrphan` row shape, both re-exported
  from `src/index.ts`. No env vars, no new layout assumptions, no
  prune flag (the existing rm/`git worktree remove --force` recipe
  in Next: hints stays). Regression tests in
  `test/workspace-sdk.test.ts` cover the SDK aggregation, the
  destroyed-workstream stranded marker, the typo-`-w` exit-3 path,
  and the `--all` overrides-`-w` documented choice.

- **Snapshot GC was AND-of-caps, leaking 458 rows / 731MB after
  one day's dogfood; flipped to OR**
  (`snapshot_gc_caps_too_lax_no_cleanup_verb`). `gcSnapshots()`'s
  WHERE clause was `(created_at < cutoff) AND (id NOT IN top-100)`
  — "delete only if BOTH old AND past the count cap". Under bursty
  use every row was younger than the 14-day age cap, so the date
  filter spared everything regardless of row count and the 100-row
  cap NEVER fired. Operator-facing intent is the union ("keep at
  most 100 OR things <14 days old"); the impl was the intersection.
  Fix is one-line: WHERE flips to `(id NOT IN top-N) OR
  (created_at < cutoff)` — "delete if past the count cap OR past
  the age cap, whichever fires first." Matches the docstring.
  Regression test in `test/snapshots.test.ts` creates >GC_MAX_COUNT
  snapshots all <GC_MAX_AGE_DAYS old and asserts the count cap now
  fires. The defaults (100 rows / 14 days) are unchanged — with
  the OR fix they behave correctly.

- **`mu snapshot list` now shows `schema_version`; stale rows render
  dimmed** (`snapshot_gc_caps_too_lax_no_cleanup_verb`). New `ver`
  column between `id` and `label`, rendered as `v<N>` (e.g. `v7`).
  When a row's `schema_version != CURRENT_SCHEMA_VERSION` the entire
  row renders dimmed via `pc.dim` (mirroring the satisfied-blockers
  bucket in `mu task show`) so operators can see at a glance which
  snapshots are stepping-stones to nowhere (restore raises
  `SnapshotVersionMismatchError`). When stale rows are present the
  Next: block grows a one-paste `mu snapshot prune --stale-version
  --yes` suggestion. `--json` already exposed `schemaVersion` — no
  shape change.

- **GC caps are now env-tunable: `MU_SNAPSHOT_KEEP_LAST` (default
  100) and `MU_SNAPSHOT_MAX_AGE_DAYS` (default 14)**
  (`snapshot_gc_caps_too_lax_no_cleanup_verb`). Mirrors the
  `MU_SPAWN_LIVENESS_MS` / `MU_IDLE_THRESHOLD_MS` precedent in
  `src/agents.ts`: typed reader fns (`gcMaxCount()` /
  `gcMaxAgeDays()`) that fall back to the default on bad input
  rather than throwing — a typo'd env var must not crash auto-GC
  in a destructive verb's hot path. Replaces the prior
  `const GC_MAX_*` declarations.

- **`AgentDiedOnSpawnError.errorNextSteps()` now leads with a per-spawn
  `--command` recipe** (`agent_spawn_liveness_check_trips_on`). The
  prior Next: block jumped straight to `export MU_<UPPER_CLI>_COMMAND`,
  which is overkill for a one-off spawn (e.g. a single read-only scout
  hitting a wrapper CLI's per-project solo lock) and silently leaks
  into every subsequent spawn in the shell. The per-spawn recipe
  (`mu agent spawn <name> --command "<cli> <bypass-flag>"`, e.g.
  `pi-meta --no-solo`) already worked but was undocumented in the
  error path. Step order is now scrollback / per-spawn / global / disable
  liveness / doctor — smallest-blast-radius first. Error message body
  unchanged. Regression test in `test/error-nextsteps.test.ts` pins
  the per-spawn step's existence, position before the env-var step,
  and agent-name interpolation.

- **Task JSON now exposes `localId` alongside `name`**
  (`task_list_show_json_omits_localid_only`). Prior to this fix,
  `mu task list/next/show --json` only carried the per-workstream
  identifier as `name`, so the natural inference
  `jq -r '.[].localId'` (matching agents/workstreams JSON, and the
  literal recipe in `skills/mu/SKILL.md` "Pick the highest-ROI"
  block) returned `null`. `TaskRow` now carries both keys, set to
  the same value; `name` is preserved for compat. Regression test
  pins both keys across all three verbs in `test/json-output.test.ts`.

- **`tasks.updated_at` now bumps on every write that mutates the task
  row OR its child rows** (`task_updatedat_not_bumped_by_reparent`).
  Status changes (close/open/reject/defer) and field updates
  (--title/--impact/--effort-days) already bumped it; note inserts,
  edge inserts/deletes (block/unblock/reparent), and claim/release
  did not (claim/release in fact already updated `updated_at`; the
  three child-row writes did not). `mu task list --sort recency`
  uses `updated_at` and was silently demoting tasks that had just
  had a note appended or their blockers reshuffled. Fix is
  SDK-side: a single shared `touchTask(db, id)` helper called from
  `addNote`, `addBlockEdge`, `removeBlockEdge`, `reparentTask` in
  the same transaction as the child-row mutation. Idempotent no-ops
  (block-already-exists, unblock-already-gone, reparent to the same
  empty set) skip the bump so `--sort recency` stays honest about
  what was actually written.

- **`mu task add` now warns to stderr when the auto-id derivation
  truncates the title's slug**
  (`slugifytitle_silently_drops_clauses`). The `SLUG_SOFT_CAP=40`
  word-boundary cut keeps ids tidy in tables, but it silently dropped
  trailing clauses — dogfood-observed twice in one session, with one
  cut producing an id (`task_list_show_json_omits_localid_only`)
  whose meaning was the *opposite* of the original title. Now: when
  the slugify pass dropped real characters, `mu task add` writes a
  one-line stderr hint (`hint: id 'foo_bar' truncated from a longer
  slug; pass <id> positional to override...`) before the usual
  `Added task` line. Stderr-only, exit 0, suppressed under `--json`,
  no slug-algorithm change — zero behaviour change for scripts; the
  hint is the entire UX. New SDK helpers `slugifyTitleVerbose()` /
  `idFromTitleVerbose()` return the same string the plain forms do
  plus a `truncated: boolean`. `mu task add --help` now documents the
  word-boundary cap so the operator hears about it before getting
  bitten.

- **`mu task show` now groups blockers/dependents by status and dims
  the satisfied bucket** (`task_show_blocked_by_renders_closed`).
  Prior rendering printed every blocker in one comma-joined list
  regardless of status, so a reader could not tell from `mu task
  show` alone which prereqs still gated work vs which were already
  CLOSED-and-stale. The new layout under `Edges`:

  ```
    blocked by : sil_virtual_static_class_dispatch [OPEN]
    satisfied  : code_declenv_typed_keys [CLOSED],
                 parity_latent_reporting_detail [CLOSED]   (dimmed)
    blocks     : downstream_a [OPEN]
    no longer  : downstream_b [CLOSED]                     (dimmed)
  ```

  Each entry carries `[<STATUS>]` colour-coded the same way the
  task-list table colours statuses (`src/cli/format.ts`
  `colorStatus`). REJECTED + DEFERRED stay in the still-gating
  bucket because they continue to gate downstream work per
  `src/tasks/status.ts`. Empty `satisfied` / `no longer` lines are
  omitted (no clutter); empty `blocked by` / `blocks` keep the `—`
  back-compat marker. New SDK helper `getTaskEdgesWithStatus()`
  exposes `{name, status}` per edge so the renderer doesn't N+1.
  `--json` shape extended: `blockers` and `dependents` are now
  `Array<{name, status}>` (was `string[]`). NO new flag
  (`--all-blockers`, `--hide-closed`) was added — the grouping IS
  the fix; CLOSED entries are kept visible-but-recessive so DAG
  history stays readable.

- **SKILL.md `Next:` invariant now matches the empirical truth: it's
  emitted on MUTATING verbs only**
  (`nextsteps_audit_read_verbs_emit_no_nextsteps`). The skill claimed
  "Every successful verb also prints a `Next:` block" but ~17
  read-only verbs (`mu task list/next/owned-by/tree/show/notes`, `mu
  state` all 3 modes, `mu doctor`, `mu log read`, `mu workspace
  list/path`, `mu agent show/list/read/attach`, `mu me`, `mu archive
  show` happy path) have always omitted it on the read happy path —
  the table itself is the answer and the operator already chose to
  look. Doc-side fix (per fix-sketch on the task note: code-side
  would be ~50 LOC across 17 verbs to add hints of dubious value to
  idempotent verbs the operator just typed). VOCABULARY.md needed no
  change — it never asserted the universal form.

- **`TaskNotFoundError` next-step recipe no longer references the
  removed `tasks.workstream` column**
  (`nextsteps_audit_task_not_found_workstream_col`). The hint a
  user sees first on a missed-task lookup was a `mu sql "SELECT
  workstream, ..."` recipe; v5 dropped TEXT `tasks.workstream` for
  FK `tasks.workstream_id`, so the recipe failed at runtime with
  `no such column: workstream`. Replaced with a `JOIN workstreams`
  pattern matching the v5 `AgentExistsError` fix at
  `src/agents/errors.ts:35`. Added a regression test in
  `test/error-nextsteps.test.ts` that prepares every SELECT recipe
  in `TaskNotFoundError.errorNextSteps()` against a freshly-opened
  v-current DB — catches future stale-column drift before users do.

- **`CrossWorkstreamEdgeError.errorNextSteps()` now emits v5-shaped
  recipes** (`nextsteps_audit_cross_workstream_edge_v4_columns`). The
  "move the blocker" hint printed `UPDATE tasks SET workstream='…'
  WHERE local_id='…'` — v4 schema. Post-v5 there is no
  `tasks.workstream` column (it's `workstream_id` INT FK to
  `workstreams.id`) and `local_id` is unique only per
  `workstream_id`, so the v4 recipe both errored at runtime ("no
  such column: workstream") and was ambiguous across workstreams.
  Replaced with a v5-correct form that scopes the WHERE by the
  blocker's workstream_id and resolves the destination via
  subselect. Also dropped the "rename one workstream to the other"
  hint: it silently moves *every* task in the source workstream and
  fails outright when the destination name already exists (UNIQUE
  violation) — almost never what the operator wants. Duplicate-the-
  blocker hint kept since that's the safest fallback.

- **`mu workspace create <missing-agent>` now throws a typed
  `AgentNotFoundError` (exit 3) instead of leaking SQLite's bare
  `NOT NULL constraint failed: vcs_workspaces.agent_id`**
  (`workspace_create_typed_no_agent_error`). The error message
  includes the agent name and workstream context so the operator
  knows which scope was searched. Surfaced during the parallel-
  fan-out spawn dogfood when an agent name was passed against the
  wrong workstream.

- **`WorkstreamNameInvalidError` now uses a direct next-step intent
  for the `mu-` prefix branch** (`workstream_init_name_rejected_mu`,
  feedback ws). Pre: the only loud action line on `mu workstream
  init mu-foo` was "Try a sanitized name (best guess) : mu workstream
  init foo" — the prefix-rejection rationale lived only in the red
  error message above. Dogfooding showed agents skipped the rationale
  and read the hedge as a hint, not a fix. Post: when the failure is
  the unambiguous `mu-` prefix case, the intent reads "Retry without
  the 'mu-' prefix". For the regex/dot/colon branch the hedge stays
  honest (the sanitiser really is guessing). Code path + message body
  unchanged; only the intent label branches. ~10 LOC + regression
  test in `test/error-nextsteps.test.ts`.

### Schema

- **Schema v7: drops the `approvals` table.** Destructive in-place
  migration via `applySchema` (DROP INDEX + DROP TABLE IF EXISTS,
  gated on the detected pre-bump version so it runs once on a v6
  DB and is a no-op on a fresh v7). The pre-v5 refusal floor in
  `openDb` stays in place; v5 DBs still get the v5→v6 archive
  tables added before the v6→v7 approvals drop. See the Removed
  entry above for the rationale.

- **Schema v6: 5 new `archive_*` tables; additive only.** Backs the
  in-progress `mu archive` verb (cross-workstream preservation of
  task graphs before destroy). Tables: `archives`, `archived_tasks`,
  `archived_edges`, `archived_notes`, `archived_events`. v5 DBs are
  forward-bumped to v6 in place by `applySchema` (no migration
  script needed; the v5 → v6 transition touches no existing column,
  FK, or view). The pre-v5 refusal floor stays in place.

### Breaking

- **Bucket export layout (`bucketVersion: 2`); old single-workstream
  layout no longer supported.** `mu workstream export` and the new
  `mu archive export` both write a multi-source bucket: top-level
  `<bucket>/{README.md,INDEX.md,manifest.json}` plus one
  `<bucket>/<source-ws>/{README.md,INDEX.md,tasks/<id>.md}`
  subdirectory per source workstream. Re-exporting `-w X` into a
  bucket containing `-w Y` appends `X/` without touching `Y/`.
  Pre-0.3 export directories (top-level `tasks/`, no `bucketVersion`
  in `manifest.json`) are NOT migrated in place; the export refuses
  with a `LegacyExportLayoutError` (exit 2) and asks the operator
  to `rm -rf <dir>` and re-run. The per-source-ws subdir layout
  preserves task `.md` paths byte-identically across export → archive
  → re-export, so `git`'s rename detector tracks history through
  the migration (verified on the in-repo `exports/mu/` migration
  commit; ~150 task files renamed cleanly, no new add/delete pairs).

## [0.2.0] — 2026-05-09

### Breaking

- **`--json` shape rewritten end-to-end** (`output_json_keys_rename_v5`).
  Every entity row's keys realigned to the v5 name-vs-surrogate-id split:
  `localId` → `name`; `slug` → `name`; `workstream` → `workstreamName`;
  `owner` → `ownerName`; `agent` → `agentName`; counts on
  `WorkstreamSummary` gain a `*Count` suffix; composite-verb wrappers
  rename `task:` / `agent:` / `workstream:` → `taskName` / `agentName`
  / `workstreamName`; `TaskNoteRow` drops `id` + `taskId`. CLI text,
  exit codes, and column rendering unchanged. No `--json-shape v4`
  flag, no dual-emit. `jq` migration recipes inline in the matching
  task notes.

- **Schema bumped to v5 — surrogate INTEGER PKs everywhere
  (`schema_surrogate_pks_for_global_uniqueness`).** Every entity table
  gets `id INTEGER PRIMARY KEY AUTOINCREMENT` + `UNIQUE (<scope_id>,
  <name>)`; FKs become INTEGER. `tasks.local_id` and `agents.name` are
  now per-workstream unique (the same name in two workstreams is
  legal). Pre-v5 DBs are rejected at `openDb` with
  `SchemaTooOldError`; the operator runs a one-shot
  `scripts/migrate-v4-to-v5.ts` (loud, not auto-applied). See
  [docs/ARCHITECTURE.md § State of truth](docs/ARCHITECTURE.md#state-of-truth)
  and the deleted `docs/SCHEMA_v5_DESIGN.md` (in git history).

- **SDK signatures rewired for v5 (`schema_v5_sdk_signatures`).**
  Every public function that took an entity name now takes
  `workstream` first; the v4 nullable-workstream fall-back branches
  are gone (`v5_prune_v4_fallback_branches`, ≈ −160 LOC). External
  SDK consumers must re-thread `workstream`. CLI behaviour unchanged.
  CI guard `scripts/grep-name-without-workstream.sh` (wired into
  `npm run lint`) bans unscoped name lookups under `src/`.

- **`addApproval` requires a non-null workstream.** v5's
  `approvals.workstream_id` is `NOT NULL`; the v4 nullable contract
  is gone. The runtime check is replaced by the type system.

- **`mu hud` mode flags removed** (`--line` / `--small` / `--mid`
  / `--full`). The HUD now renders one shape — a dynamic table
  layout that fills the available pane height + width — by default.
  `--json` is preserved unchanged. Status-bar callers should use the
  one-line first row of the default render or `mu hud --json | jq`.

- **`mu agent close` no longer touches the workspace** (pre-v0.2;
  retained for migration clarity). Closing an agent kills the pane
  and removes the registry row only; run `mu workspace free <agent>`
  explicitly. The `--keep-workspace` / `--commit-workspace` flags are
  gone. Migration: scripts that did `mu agent close X` should add
  `mu workspace free X` after.

### Added

- **Cross-workstream verb args via `<workstream>/<name>`
  qualified form** (`verb_arg_qualified_workstream_name`). Every verb
  taking a task / agent / approval / workspace name accepts either
  bare `<name>` (resolved via `-w` / `$MU_SESSION` / current tmux
  session) or `<workstream>/<name>` (skips `-w` resolution; from any
  shell). Mixing qualified ref with non-matching `-w` errors out
  (`UsageError`, exit 2). Bare name with no `-w` and ≥2 candidate
  workstreams raises `NameAmbiguousError` (exit 4) with a one-paste
  qualified-form hint per candidate. SDK signatures unchanged — the
  qualifier lives entirely above `src/cli.ts`.

- **`mu workstream export -w <ws> [--out <dir>]` writes the
  workstream's task graph + notes as a directory of plain markdown.**
  Closes `export_tasks_to_md_folder`. One `.md` per task with
  frontmatter (status / impact / effort / ROI / owner / timestamps /
  blocked_by / blocks) + body (title + chronological notes, fenced
  with a backtick-run long enough to escape literal triple-fences),
  plus `INDEX.md` (per-status table), `README.md` (counts), and
  `manifest.json` (per-file sha256 + `latestSeq` cursor). Idempotent
  re-export (sha256 short-circuit); deleted-from-DB tasks are
  preserved with a one-time banner. `mu workstream destroy --yes`
  now auto-exports to `<state-dir>/exports/<ws>-<ts>/` first; opt
  out with `--no-export`.

- **`mu task wait --stuck-after <seconds>` warns when a worker
  committed but skipped `mu task close`.** Closes
  `agent_close_discipline_gap` Phase 1. `waitForTasks` accepts
  optional `stuckAfterMs` (default 300_000 = 5 min); on every poll
  it checks IN_PROGRESS tasks owned by an agent in `needs_input`
  whose `agents.updated_at` is older than the threshold and emits
  one yellow line to stderr per stuck task per call (Set-deduped).
  `TaskWaitResult.tasks[i]` gains `stuck: boolean`. Wait keeps
  polling — the warning is observational; force-close /
  re-prompt / escalate is the operator's call. Phase 2 adds a
  matching SKILL.md bullet.

- **`--sort` for `mu task list / next` (recency / age / id /
  roi).** Closes `nit_task_list_sort_by_recency`. Two new shapes
  formerly stuck behind `mu sql`: "what did I touch most
  recently?" (`--sort recency` = `updated_at` DESC) and "what's
  gone stale?" (`--sort age` = `created_at` ASC). Unknown keys exit
  2. Time-based sorts add a relative-time column (`12s` / `5m` /
  `3h` / `2d` / `2w`); other sorts keep the historical narrow
  table. JSON is reordered, never reshaped.

- **Workspace staleness signal in `mu state` and `mu workspace
  list`.** Closes `bug_workspace_stale_parent_silent_drift`
  (Option 2 only — warn-only). Each `vcs_workspaces` row gets an
  optional `commitsBehindMain` populated by
  `decorateWithStaleness` (per-backend `commitsBehind(path,
  ref)`). Rendered as a colour-coded `behind` column (≤2 green,
  3–9 yellow, ≥10 red). `mu state` prefixes the Workspaces header
  with `⚠ (N stale ≥10 commits behind)` when any row qualifies, and
  appends a `mu workspace free + create` remediation tip. Pure
  observation: no auto-fetch. Backends that can't resolve the
  default branch return `null` (renders `—`).

- **`mu workspace create` refuses outright when projectRoot is
  `$HOME`** and cleans up partial dirs on failure. New typed
  `HomeDirAsProjectRootError` (exit 4) catches `cd $HOME && mu
  workspace create`, `--project-root ~/`, etc. Direct children of
  `$HOME` are deliberately not blocked. `createWorkspace` now wraps
  `backend.createWorkspace` in a try/catch: on throw, the partial
  workspace path is removed via `rm -rf` before the original error
  re-throws.

- **`mu undo` / `mu snapshot list` / `mu snapshot show` — the
  user-facing recovery verbs.** Closes `snap_undo_verb`. Default
  restores the latest snapshot; `--to N` picks one. Confirmation
  gate mirrors `mu workstream destroy --yes`: dry-run prints
  summary + the explicit "tmux NOT rolled back" warning; `--yes`
  commits. Post-restore reconcile reports ghost-pruned /
  orphan-surfaced counts. No `mu redo`: each restore captures a
  pre-restore snapshot, so re-running `mu undo` rolls forward.
  Typed errors map to exit 3 / 4 / 5.

- **Snapshots + auto-capture before destructive verbs (schema v4).**
  Closes `snap_schema`. Every destructive verb (workstream destroy,
  agent close, task close/reject/defer/release/delete, workspace
  free, approve grant/deny/timeout) captures a whole-DB snapshot
  via `VACUUM INTO`. Files land in `<dirname(db-path)>/snapshots/`,
  indexed by a `snapshots` sidecar table (no FK on workstream — the
  snapshot must outlive its workstream). Capture happens at the
  verb wrapper, not inside `setTaskStatus`, so `--cascade reject`
  produces ONE snapshot per invocation. GC: keep <14 days OR <100
  rows.

- **`mu workstream destroy` advertises `mu undo` in its `Next:`
  block.** Closes `snap_destroy_safety`. Dry-run output names the
  pre-destroy snapshot and the explicit "tmux NOT rolled back"
  caveat; `--yes` output adds an `Undo` next-step.

- **`mu task reject --cascade` / `mu task defer --cascade` are now
  dry-run by default; require `--yes` to commit.** Closes
  `bug_cascade_reject_too_aggressive`. `RejectDeferOptions` gains
  `yes?: boolean`; `RejectDeferResult` gains `dryRun` +
  `affectedIds`. Single-task case (no open dependents) skips the
  preview. `--yes` without `--cascade` errors with `UsageError`.

- **`mu hud` rewritten as a dynamic table layout.** Closes
  `nit_hud_render_tables`. Greedy top-down by priority: header line
  → agents → ready tasks → in-progress → tracks → recent events.
  Each section is a width-aware cli-table3; truncated sections show
  an `… +N more (<verb>)` footer. Pane size resolved via
  `MU_HUD_FORCE_SIZE` → `process.stdout` TTY → `tmux
  display-message` → 120×30 fallback. `--json` shape unchanged.

- **`mu hud` verb (initial form, superseded above).** Print-once
  HUD card; the operator-side complement to the agent pane border.
  Composes via `watch -n 5 mu hud -w X`, `tmux display-popup -E`,
  status-bar `#()` injection.

- **Pane border + composed pane title carry mu's interpreted
  state.** Closes `hud_visual_cue_design` + `_impl`.
  `enableMuPaneBorders` sets `pane-border-status=top` +
  `pane-border-format=' [mu] #{pane_title} '` + heavy box-drawing
  on all four sides (`pane-border-lines=heavy`,
  active=`fg=cyan,bold`, inactive=`fg=brightblack`). Pane title is
  composed from current DB state and refreshed after every
  state-touching verb + on every reconcile (`<name> · <emoji> ·
  <task-id>`); `parseAgentNameFromTitle` keeps the agent name as
  the first ` · ` token so the claim-protocol fallback still works.
  Opt-out: `MU_BANNER_QUIET=1`.

- **Spawned agent panes inherit identifying env vars**
  (`MU_MANAGED_AGENT=1`, `MU_AGENT_NAME=<name>`,
  `MU_WORKSTREAM=<name>`). Closes `pass_mu_env_to_panes`. Tmux
  3.0+ `-e KEY=VALUE` is set in the new pane's environment only;
  no global server pollution. Pane-creating helpers in
  `src/tmux.ts` gain an optional `env` arg.

- **`mu task wait <ids...>` blocks until tasks reach a status.**
  Closes `nit_no_mu_task_wait`. `--status` (default `CLOSED`),
  `--any`, `--timeout` (default 600s, 0 = forever). Exit 0
  (condition met) / 3 (TaskNotFoundError pre-flight) / 5
  (timeout). 1s poll. Replaces the hand-rolled bash+awk
  multi-task wait; the awk tail-pattern remains valid for
  one-event ad hoc.

- **`mu agent close` refuses by default if the agent has a
  workspace.** Closes `bug_workspace_orphaned_after_agent_close`.
  Throws `WorkspacePreservedError` (exit 4) with three actionable
  resolutions; `--discard-workspace` (and SDK
  `closeAgent(db, name, { discardWorkspace: true })`) frees the
  workspace BEFORE deleting the agent.

- **`WorkspacePathNotEmptyError` typed-error + defensive `git
  worktree prune` on create.** Closes
  `agent_spawn_workspace_fails_when_prior` +
  `workspace_free_cleanup_leaves_git`. Replaces bare backend
  errors when an on-disk dir is occupied with no DB row;
  `errorNextSteps()` lists the three concrete recoveries.
  `gitBackend.createWorkspace` runs `git worktree prune`
  defensively before `add` (cheap, idempotent).

- **Status detector recognises Braille spinner glyphs as busy.**
  Closes `bug_status_detector_pi_solo_misclassifies`. Fallback
  regex `/[\u2800-\u28FF]/` after the existing permission +
  `to interrupt)` patterns; covers pi-meta and every TUI spinner
  library. Order of precedence preserved: permission > busy
  literal > braille fallback > needs_input.

- **Task states gain `REJECTED` and `DEFERRED`; new verbs
  `mu task reject` / `mu task defer`.** Schema v3. `goals` view
  excludes both; `ready` / `blocked` views unchanged (only
  CLOSED satisfies a `--blocked-by` edge — REJECTED + DEFERRED
  still BLOCK downstream by design). Stranded-dependent guard
  surfaces `TaskHasOpenDependentsError` (exit 4) with three
  resolutions; `--cascade` walk PRUNES at CLOSED / REJECTED /
  DEFERRED nodes.

- **`mu workstream destroy` now actually cleans workspaces.**
  Closes `workstream_destroy_yes_leaves_workspace`. Calls each
  `vcs_workspaces` row's backend `freeWorkspace()` before the FK
  CASCADE; `DestroyResult` gains `freedWorkspaces` /
  `failedWorkspaces`. Empty `<state>/workspaces/<ws>/` parent dir
  is reaped (best-effort `rmdir`). Bare-registry workstreams are
  no longer treated as "nothing to destroy".

- **Agent identity propagates to task notes; spawn output
  surfaces `--command` overrides.** Closes
  `nit_agent_note_author_identity` + `nit_spawn_custom_command_display`.
  `mu task note` author resolves via `resolveActorIdentity()`
  (`$MU_AGENT_NAME` > pane title > `$USER` > `'orchestrator'`); pass
  `--author` to override. `mu agent spawn` output reads
  `Spawned X (pi (cmd: pi-meta --no-solo))` when the resolved
  command differs from the cli value; JSON gains `resolvedCommand`
  + `commandOverridden`.

- **`mu sql` accepts multi-statement scripts** (BEGIN/COMMIT
  blocks, semicolon-separated batches). Closes
  `nit_sql_multi_statement`. Probes via `db.prepare`; on
  `'more than one statement'` throw, falls back to `db.exec`
  with a hand-rolled `countTopLevelStatements()` for the report.

- **Auto-generated task IDs trim at a 40-char word boundary.**
  Closes `nit_long_auto_slug`. `slugifyTitle` cuts at the last
  `_` at-or-before the soft cap; collision-loop respects the
  64-char hard ceiling.

- **Self-documenting verb output: `Next:` hints + structured JSON
  errors + universal `--json`.** Closes the `selfdoc_*` track
  (infra, errors, verbs_round2, json_universal, skill_cleanup).
  Every successful write verb prints follow-up commands; every
  typed error class implements `errorNextSteps()` with actionable
  resolutions; every verb (one allow-listed exception, `mu agent
  attach`) accepts `--json`. Errors emit
  `{ error, message, nextSteps, exitCode }` to stderr;
  `nextSteps` carry the same structured shape in human + JSON
  output. `mu doctor --json` returns a fully structured
  `{ environment, db, workstream, state }` report. SKILL.md
  trimmed 771 → 574 LOC over two passes.

- **`mu task claim --self`, `mu adopt <pane-or-title>`,
  `mu task list --status <S>`** — three smaller v0.2 additions
  for the orchestrator pattern: `--self` records the actor in
  `agent_logs` while leaving `tasks.owner` NULL; `mu adopt`
  registers an existing tmux pane as a managed agent (idempotent;
  scope-checked); `--status` filter on `mu task list`
  (case-insensitive `OPEN | IN_PROGRESS | CLOSED`).

### Changed

- **`mu task ready` merged into `mu task next -n 0`** — closes
  `audit_merge_task_ready_into_next`. `cmdTaskNext` treats `-n 0`
  as unlimited (the historical `task ready` shape); default
  `-n 1` keeps "what should I do right now?". The `ready` SQL
  view stays (consumed by `mu state` / `mu hud`); the verb +
  Commander wiring + `cmdTaskReady` (~25 LOC) are gone.

- **`mu whoami` / `mu my-tasks` / `mu my-next` merged into
  `mu me [tasks|next]`** — closes
  `audit_merge_self_verbs_into_mu_me`. `mu me` (default = former
  `whoami`); `mu me tasks` (former `my-tasks`); `mu me next [-n
  K]` (former `my-next`, with `-n 0` extended to "all ready"). No
  back-compat aliases.

- **CLI output labels: `name`/`<entityType>Name`.** Closes
  `output_id_vs_name_audit` (audit) +
  `output_labels_human_rename` (Phase 2, non-breaking). Every
  cli-table3 first column renamed `id` / `slug` → `name`;
  surrogate ids stay strictly internal. `mu undo --to <id>` and
  `mu log --since SEQ` keep their integer surrogate column names
  (operator-facing by design). Phase 3 (`<workstream>/<name>`
  qualified refs) and the breaking JSON rewrite both ship in
  separate entries above.

- **CLI boundary discipline: `WorkstreamNotFoundError` maps to
  exit 3** (`schema_v5_cli_boundary`). Registers the missing
  class next to `AgentNotFoundError` / `TaskNotFoundError` and
  exports `classifyError` for unit-testing the full map.

- **`reconcile()` `dryRun: boolean` replaced with `mode: "full"
  | "status-only" | "report-only"`.** Closes
  `reconcile_split_dryrun_into_status_only_mode` +
  `bug_pane_title_glyph_stuck_at_needs_input`. Splits
  prune-suppression from status-suppression. `mu state` / `mu
  hud` use `"status-only"` (refresh status + pane title; no
  prune); `mu doctor` / `mu undo` use `"report-only"` (no
  mutation); `mu agent list` defaults to `"full"`. **Breaking**
  for SDK consumers of `ReconcileOptions` / `ReconcileReport` /
  `ListLiveAgentsOptions`: `dryRun?: boolean` → `mode?:
  ReconcileMode`. CLI verb behaviour is strictly better.

- **Read-only verbs no longer race in-flight `--workspace`
  spawns.** Closes (re-opened) `bug_agent_spawn_workspace_fk_failure`.
  Pre-fix: `watch -n 5 mu hud` could prune the placeholder agent
  row mid-spawn, FK-failing the subsequent `vcs_workspaces`
  insert. `ListLiveAgentsOptions` gains `dryRun?: boolean`;
  `cmdHud` / `cmdState` / `cmdMission` / `cmdAttach` / `cmdDoctor`
  set it. `cmdList` keeps the mutating behaviour (the documented
  escape hatch).

- **`mu undo` no longer silently drops recovered agent rows
  whose panes are dead.** Closes
  `snap_undo_reconcile_destroys_recovered_agents`. Post-restore
  reconcile runs in `"report-only"` mode so the snapshot's
  agents + workspaces survive the restore.

- **`mu task claim <task> -w <wsA> --for <agent>` rejects when
  `<agent>` lives in a different workstream.** Closes
  `cross_workstream_claim_for`. Pre-FK check throws
  `AgentNotInWorkstreamError` (exit 4). The `--self` path is
  untouched.

- **HUD colors survive `watch` and other non-TTY pipes.** Closes
  `hud_colors_stripped_under_watch_and`. New `colorEnabled()`
  helper returns true if any of `picocolors.isColorSupported`,
  `MU_FORCE_COLOR`, `FORCE_COLOR`, or `process.env.TMUX` is set;
  `NO_COLOR` trumps. Every `picocolors` import re-exports from
  `src/output.ts` so every colour-using verb picks up the fix
  uniformly.

- **`mu task add` invalid id throws typed `TaskIdInvalidError`
  (exit 4)** instead of bare `TypeError`. Closes
  `nit_invalid_id_typeerror`. `errorNextSteps()` returns the
  drop-`--id` recipe + a sanitised candidate.

- **`docs/VERB_AUDIT.md`: typed-vs-`mu sql` audit of every
  verb.** Closes `audit_verbs_typed_vs_sql`. 51 KEEP, 3 REMOVE
  (`mu task search/blocked/goals`), 4 MERGE (`task ready` into
  `task next -n 0`; `whoami`/`my-tasks`/`my-next` into `mu me`).
  Each disposition filed as a follow-up; the operator decides
  which ship.

- **`docs/SCHEMA_v5_DESIGN.md` design + amendments.** Closes
  `schema_surrogate_pks_for_global_uniqueness` (design) +
  `schema_v5_design_amendments` (review fixes: pinned 10-step
  migration ordering, SDK consumer impact, real-DB fixture,
  snapshot interaction). Doc removed in the post-landing
  cleanup; load-bearing patterns (boundary discipline, surrogate-
  PK pattern) absorbed into [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **`src/cli/tasks.ts` split: 1234 → 29 LOC re-export hub.**
  Closes `review_code_cli_tasks_oversize`. Five sibling files in
  `src/cli/tasks/` (`wire.ts`, `edit.ts`, `claim.ts`, `edges.ts`,
  `tree.ts`); every file < 500 LOC, median 200. Re-export hub
  surfaces only `wireTaskCommands` / `cmdMyTasks` / `cmdMyNext` /
  `unescapeNoteText` (the only outside-cluster imports).

- **`muTable()` helper bakes in HUD truncation safety belt
  (`wordWrap: false` + per-column `colWidths`).** Closes
  `tables_truncate_long_cols_audit`. Surfaces eight existing call
  sites; per-site truncation budgets target user-data columns
  (`path` 40 cols front-truncated, `name` 40, `label` 50,
  `reason` 60, `window`/`role` 32/14). `mu sql` divides terminal
  width evenly with a 12-char floor.

- **`mu task note` Next: hints + --help teach single-quote
  discipline.** Closes `nit_task_note_shell_metachar_hint`.
  Backticks / `$VAR` / `$(...)` expand in the operator's shell
  before mu sees the note; double-quoted hints in
  `cmdTaskAdd` / `cmdClaim` / `mu task note --help` now show the
  single-quote form.

- **De-duplicated SDK + CLI patterns.** Closes
  `review_code_should_overwrite_status_dup`,
  `_raw_task_state_duplicate`, `_views_recreated_thrice`,
  `_assert_in_workstream_smell`, `_resolveselfnameoruser_dup_resolveself`,
  `_banner_quiet_env_repeated`, `_cli_tasks_re_export_indirection`,
  `_taskerrors_sanitise_lives_in_errors`. Net ≈ −80 LOC across
  status-overwrite predicate, `RawTaskRowForState`+`rawTaskRowToTask`
  CLI→SDK consolidation, `READY/BLOCKED/GOALS_VIEW_SQL` constants,
  `assertEntityInWorkstream` collapse, `resolveSelfOptional`
  layering, `MU_BANNER_QUIET` self-checking border helpers,
  re-export hub cleanup, `sanitiseTaskId` migration to `tasks.ts`.

- **`spawnAgent` workspace pre-stage extracted into named
  helpers** (`prestageWorkspace` / `finalizeAgentRow` /
  `rollbackSpawn`); the placeholder pane-id (`%pending-<name>`)
  becomes the named `PENDING_PANE_PREFIX` constant. Closes
  `review_code_spawn_workspace_dance_too_clever`. The 18-line
  rejected-designs narration is gone.

- **`mu task show --self` actor lookup is no longer brittle.**
  Closes `review_code_last_claim_actor_brittle`. Claim events
  carry a tab-delimited structured prefix
  (`task.claim<TAB><id><TAB>actor=<x><TAB>self=<0|1><TAB>`);
  consumer does an indexed `LIKE` with no recent-window cap.
  Display layer strips the prefix via `displayEventPayload`.

- **`mu adopt <pane>` is wired again.** Closes
  `bug_adopt_verb_unwired`. The f42e86d `wireXxxCommands`
  refactor dropped the top-level `program.command("adopt
  <pane-or-title>")` registration; restored. Two new regression
  cases pin the wiring in `test/verbs.test.ts`.

- **Per-workstream name lookups no longer silently misroute.**
  Closes `bug_v5_name_clash_silent_misroute` (Phase 1). Every
  public SDK function that takes a TEXT name now also takes (or
  threads) the workstream; internal SQL filters by
  `(workstream_id, name)`. CI guard
  `scripts/grep-name-without-workstream.sh` enforces. 26 new
  cases in `test/v5-name-clash.test.ts`. Phase 2
  (`NameAmbiguousError` for unscoped SDK consumers) shipped under
  `verb_arg_qualified_workstream_name` above.

- **Test-suite repair (v5).** SDK callsites threaded through
  `workstream`; helpers (`insertTask` / `insertEdge` / `insertNote`
  in `test/db.test.ts`; `insertVcsWorkspaceRow` in
  `test/workstream.test.ts` + `test/snapshots.test.ts`) translate
  operator-facing names to surrogate ids on insert. The 9
  v1→v2 / framework-rollback migration tests are
  `describe.skip(...)` (substrate no longer reachable).

- **Doc staleness sweep — 9 files updated, 3 obsolete sections
  removed, 12 duplicated paragraphs collapsed.** Closes
  `docs_staleness_review_capstone`. README compressed
  600+ → ≤ 250 LOC; CHANGELOG `[Unreleased]` compressed
  ~3300 → ~400 LOC; SKILL.md trimmed; `docs/SCHEMA_v5_DESIGN.md`
  load-bearing patterns absorbed into ARCHITECTURE.md before the
  doc was deleted; broken links fixed.

### Removed

- **Three audit-flagged read-only verbs deleted: `mu task
  blocked`, `mu task goals`, `mu task search`.** Closes
  `audit_remove_task_*`. All scored 1/4 in the verb audit
  (since-removed `docs/VERB_AUDIT.md`); the underlying
  abstractions (the two SQL views + case-insensitive `LIKE`)
  are one-liners against `mu sql`. SDK helpers (`listBlocked`
  / `listGoals` / `searchTasks`) survive as reusable surface
  consumed by `mu state` / `src/tracks.ts`. SQL recipes published
  in `docs/USAGE_GUIDE.md` "What's NOT in 0.2.0".

- **Four schema-v5-defunct workarounds deleted
  (`schema_v5_cleanups`; net ≈ −40 LOC).** The `mu_`
  reserved-prefix gymnastics, the `idFromTitle`
  collision-loop hard-cap defensive truncation, the
  `cross_workstream_claim_for` pre-check residue, and the brittle
  `lastClaimActor` CLI-side wrapper. Each existed because v4 had
  a global TEXT namespace; v5's per-workstream UNIQUE makes them
  moot.

- **Every "preserves the v4 contract" fall-back branch in `src/`
  deleted (≈ −160 LOC).** Closes `v5_prune_v4_fallback_branches`.
  Tightened ~30 SDK signatures (workstream now required, not
  optional). Helper `lookupTaskAnyWorkstream(db, localId)` is the
  one legitimate cross-workstream task lookup, used by `addTask`
  + `reparentTask` blocker resolvers so a same-name blocker in a
  different workstream surfaces `CrossWorkstreamEdgeError`. CI
  guard `scripts/grep-v4-references.sh` (wired into
  `npm run lint`) bans `v4` / `backward-compat` in `src/`.

- **`src/migrations.ts` deleted (≈ −450 LOC src+test).** Closes
  `schema_v5_drop_migrations_ts`. The v1→v2 / v2→v3 / v3→v4
  in-process migrators are dead code post-v5: the loud-fail hook
  in `openDb` rejects every pre-v5 DB before any migration would
  run, and v4→v5 is a one-shot out-of-process script.

- **`src/cli/tasks.ts` no longer re-exports the
  lifecycle/queries cluster's `cmd*` functions.** Closes
  `review_code_cli_tasks_re_export_indirection`. No outside-cluster
  caller went through the re-exports; deleted the 24 lines of
  ceremony.

- **`docs/SCHEMA_v5_DESIGN.md` + `scripts/migrate-v4-to-v5.ts`
  + `test/migrate-v4-to-v5.integration.test.ts` deleted
  (capstone, separate commit).** Per the temp-impl-artifact
  cleanup rule (`docs_staleness_review_capstone`): files named
  for a SPECIFIC OPERATION (`migrate-vN-to-vM`,
  `decision-doc-for-X`) are temporary by construction. Operator's
  DBs migrated; the loud-fail hook in `openDb` stays as the
  safety belt; restore from git history if needed.

### Fixed

- **`destroyWorkstream` no longer double-counts already-gone
  workspaces as freed.** Closes
  `review_code_destroy_freed_workspaces_double_count`.
  `DestroyResult` gains `alreadyGoneWorkspaces: number`; the CLI
  appends `(N already gone on disk)` only when non-zero. The
  `workstream destroy` log event gains `already_gone=N`.

- **`waitForTasks` returns within `timeoutMs` even when `pollMs >
  timeoutMs`.** Closes `review_test_waitfortasks_polling_unverified`.
  Sleep clamped to `min(pollMs, deadline - now)`; `timeoutMs=0`
  still uses the full poll cadence.

- **`mu task note` escape translation no longer relies on an
  in-band sentinel string.** Closes
  `review_code_unescape_note_text_placeholder_brittle`.
  Single-pass regex `/\\([\\ntr])/g`.

- **`mu hud` recent-events tail colours every emitter verb.**
  Closes `review_code_hud_event_color_regex_drift`. Verb prefix
  list extracted to single source of truth `EVENT_VERB_PREFIXES`
  in `src/logs.ts`; two-sided regression tests scan every
  `emitEvent(...)` callsite.

- **`mu log`'s `resolveLogContext` `??` consistency + pane-branch
  asymmetry comment.** Closes
  `review_code_resolve_log_workstream_branch_dup`.

- **`decorateWithStaleness` no longer fans out N concurrent VCS
  shellouts.** Closes
  `review_code_decorate_with_staleness_n_plus_one`.
  Concurrency cap of 4 (inline `mapWithConcurrency`) +
  per-invocation memoization keyed by `(backend, parentRef)`.

- **`colorEnabled()` is synchronously testable.** Closes
  `review_test_color_enabled_no_color_module_load_caveat`.
  Reimplemented from scratch reading every signal at call time;
  picocolors is the renderer, the decision is ours. Two new
  cases pin `TERM=dumb` and `NO_COLOR=""` semantics.

- **Long task titles no longer blow out the terminal** (pre-v0.2;
  retained for migration clarity). Table views compute a
  title-column budget from `process.stdout.columns`; the `id`
  column is never truncated.

- **Task JSON output now includes `roi`** (impact ÷ effortDays).
  Tasks with `effortDays === 0` omit the field.

- **`mu workstream init <name>` validates the name.** Names with
  `.`, `:`, `/`, uppercase, leading digit/hyphen, or > 32 chars
  are rejected with `WorkstreamNameInvalidError` (exit 2). The
  same regex applies to `ensureWorkstream`.

- **Workstream names with the `mu-` prefix are rejected at init
  time.** Caught the `mu-mu-foo` double-prefix case.

- **`mu task claim` from an unregistered pane gives an actionable
  error** (`ClaimerNotRegisteredError`, exit 4). Pre-check
  throws before the atomic CAS UPDATE. Three actionable hints in
  `errorNextSteps()`: `--self`, `--for`, `mu adopt %<pane>`.

### Test-suite repair (non-v5 follow-ups)

- **`destroyWorkstream` `failedWorkspaces` accumulation path now
  has direct test coverage** (new `WorkstreamOptions.resolveBackend`
  injection seam). Closes
  `review_test_destroy_failed_workspaces_uncovered`.
- **`TaskIdInvalidError` test assertions relaxed off the exact
  sanitised-command suffix.** Closes
  `review_test_invalid_id_overspecs_sanitised_command`.
- **`workspace list` "behind" column anchored structurally**
  (JSON pin + cli-table3 `│`-separator regex). Closes
  `review_test_workspace_staleness_behind_value_unanchored`.
- **`createWorkspace` `opts.backend` accepts a `VcsBackend` object
  for cleanup-on-throw test injection** (drops the
  monkey-patched singleton). Closes
  `review_test_workspace_cleanup_throws_monkeypatch_smell`.
- **`STATUS_EMOJI` round-trip tests now interpolate every entry,
  not three.** Closes
  `review_test_status_emoji_drift_only_three_glyphs`.
- **`printNextStepsTo('stderr')` routes to `console.error`** is
  now pinned. Closes
  `review_test_print_next_steps_stderr_branch_uncovered`.
- **`claim.integration.test.ts` regains end-to-end coverage of
  the cross-workstream guard.** Closes
  `review_test_claim_integration_xws_rewrite`.
- **`listTasksByOwner` cross-workstream test exercises the read
  codepath honestly.** Closes
  `review_test_listtasksbyowner_xws_owner_state_unreachable`.
- **`tasks.test.ts` `--self` identity tests strip
  `MU_AGENT_NAME`** alongside `TMUX_PANE` / `USER` (extracted
  `withCleanIdentityEnv` to `test/_env.ts`). Closes
  `review_test_tasks_mu_agent_name_env_pollution`.

### Schema

- **Schema bumped to v5** — see Breaking above.
- **`schema_version` table + migration framework** (v1 → v2;
  later removed once v5 landed). The framework existed for the
  ON-UPDATE-CASCADE migration and the v3 `REJECTED`/`DEFERRED`
  states; the file is gone post-v5.
- **All 10 foreign keys gain `ON UPDATE CASCADE`** (v1 → v2,
  pre-v5). Renaming a workstream / task / agent name now leaves
  no dangling children. Recovery recipes in
  [USAGE_GUIDE § 14](docs/USAGE_GUIDE.md#you-typod-a-workstream-name-and-want-to-rename-it).

## [0.1.0] — Initial release

First public release. Mu is a CLI that manages a persistent crew
of pi agents in tmux panes, coordinated through a built-in task
DAG and per-agent VCS workspaces. State lives in one SQLite file
at `<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

This release packages a body of work developed against real
multi-day investigations. The version number resets at the
public boundary; see git history for the per-step evolution.

### What's in 0.1.0

**~50 typed verbs across 6 namespaces, plus `mu`, `mu state`,
`mu sql`, `mu doctor`.** Every read verb supports `--json`.

| Area                     | Verbs                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| **workstream** (3)       | `init`, `list`, `destroy`                                             |
| **agent** (8)            | `spawn` (with `--workspace*`), `send`, `read`, `show`, `list`, `close`, `free`, `attach` |
| **task** (22)            | `add` (id auto-derived from title), `list`, `show`, `notes`, `note`, `tree`, `next`, `ready`, `blocked`, `goals`, `owned-by`, `search`, `claim` (`--evidence`), `release` (`--evidence`), `close` (`--evidence`), `open` (`--evidence`), `block`, `unblock`, `update`, `delete`, `reparent` |
| **workspace** (4)        | `create`, `list`, `free` (`--commit`), `path`                         |
| **log** (1, overloaded)  | write, read, `--tail` subscription; auto-emits on every state change  |
| **approve** (5)          | `add`, `list`, `grant`, `deny`, `wait` (exit 0/4/5 = granted/denied/timeout) |
| **self-id** (3)          | `whoami`, `my-tasks`, `my-next` (resolves agent via `$TMUX_PANE`)     |
| **utilities** (4)        | bare `mu` (quick mission control), `mu state` (canonical state card), `sql`, `doctor` |

### Pillars (what makes mu mu)

- **One workstream = one tmux session.** All agents live as
  panes/windows inside it. Detach and reattach freely; the crew
  survives.
- **The CLI is the product.** Anything mu can do, you can do from
  a shell. No daemon, no config file, no extension required.
- **One DB is canonical.** SQLite WAL at `~/.local/state/mu/mu.db`.
  Multiple processes share it safely.
- **Reality wins reconciliation.** Every list-style verb queries
  tmux, prunes ghost agents, and surfaces orphan panes.
- **Agents are dumb workers; the task DAG is the brain.** Tasks
  have mandatory `impact` and `effort_days`; edges are `blocks`
  relationships; the parallel-tracks union-find with diamond-merge
  guarantees two agents never collide on a shared dependency.
- **Per-agent VCS workspaces.** `--workspace` auto-creates
  isolated jj workspaces / sl shares / git worktrees / `cp -a`
  snapshots; auto-freed on `mu agent close`.
- **Async coordination via `mu log`.** Every state-changing verb
  auto-emits a `kind='event'` row; subscribers `mu log --tail`
  instead of polling.
- **Human-in-the-loop approvals.** `mu approve add/wait` lets
  agent scripts gate destructive actions on operator sign-off.
- **Audit trail with grounding.** `--evidence` on lifecycle verbs
  records what the caller observed. First inch of "observed vs
  claimed state" discipline.
- **Crash recovery.** Reconciliation prunes ghost agents; the
  reaper reverts their IN_PROGRESS tasks to OPEN with an
  explanatory note; no manual cleanup.
- **Get out of the model's way.** Mu owns no model selection,
  effort tier, prompt engineering, or tool routing. Pi already
  has those abstractions; mu doesn't recreate them.

### Schema (8 tables)

- `workstreams` — top-level partition; one tmux session each.
- `agents` — pane registry; identity is `(workstream, name)`.
- `tasks` — the work graph nodes. Mandatory `impact` (1–100) +
  `effort_days`.
- `task_edges` — `blocks` relationships; cycles rejected at write
  time.
- `task_notes` — append-only per-task notes. FILES / DECISION /
  VERIFIED conventions documented in SKILL.md.
- `vcs_workspaces` — per-agent isolated working copies.
- `agent_logs` — append-only timeline. Manual broadcasts, auto
  state-change events, and external `--as` writes share one table
  via the `kind` column. `seq` is AUTOINCREMENT for tail cursors.
- `approvals` — human-in-the-loop gate state. FK CASCADE on
  workstreams; CHECK constraint on status enum.

Built-in views: `ready`, `blocked`, `goals` (in `tasks` schema).

### Environment variables

| Variable                     | Purpose                                                |
|------------------------------|--------------------------------------------------------|
| `MU_DB_PATH`                 | Override the SQLite file path                          |
| `MU_STATE_DIR`               | Override the state directory (`<dir>/mu.db`)           |
| `XDG_STATE_HOME`             | Standard XDG fallback                                  |
| `MU_SESSION`                 | Override active workstream name                        |
| `MU_<UPPER_CLI>_COMMAND`     | Pick the executable for `--cli <cli>` (e.g. `MU_PI_COMMAND="pi-alt --some-flag"`) |
| `MU_SEND_DELAY_MS`           | Bracketed-paste → Enter delay (default 500)            |
| `MU_SPAWN_LIVENESS_MS`       | Spawn liveness window (default 1500; 0 disables)      |
| `MU_TMUX_SOCKET`             | Override tmux socket (`-L <name>`); default uses `$TMUX` |

### Known limits in 0.1.0

- **Pi-only status detection.** Other CLIs (claude, codex) can be
  spawned via `--cli <name>` + `MU_<UPPER_CLI>_COMMAND` but always
  show `needs_input`. See [docs/ROADMAP.md](docs/ROADMAP.md).
- **Polling-based subscriptions.** `mu log --tail` and `mu approve
  wait` poll SQLite once per second. Real subscription mechanisms
  (SQLite update hooks, fs.watch on the WAL) are deferred.
- **No `mu undo`.** Snapshots / undo are deferred. `mu workstream
  destroy --yes` is irreversible; recovery is restoring `mu.db`
  from a backup.
- **No capability enforcement.** The `role` field on agents
  (`full-access` / `read-only`) is stored but not enforced. The
  flag is operator discipline, not a guard.
- **Local-only state.** No cross-machine sync. Layer something
  like syncthing on top if you want it.
- **Pi extension not yet shipped.** Mu is CLI-only in 0.1.0; a
  pi extension is on the roadmap.

### Inspirations

- **[pi-subagents](https://github.com/nicobailon/pi-subagents)** by
  Nico Bailon — the pi-native delegation pattern. mu reuses its
  frontmatter format and borrows operational machinery (worktrees,
  mutation guards, model fallback, doctor).
- A prior internal multi-agent runtime (Rust) — the "tmux as
  universal substrate + per-CLI status detection + reality-wins
  reconciliation + parallel-track union-find with diamond-merge"
  patterns originated there. Mu adopts the patterns; not the
  deps.
- An internal critique of that prior runtime — sharpened the case
  for the anti-feature pledges (no DSL, no plugins, no daemon, no
  config file, no web UI) and motivated several of the verbs in
  this release (state cards, approvals, observed-vs-claimed
  evidence on lifecycle verbs).
