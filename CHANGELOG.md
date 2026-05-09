# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [Unreleased]

### Added

- **`mu task wait --stuck-after <seconds>` warns when a worker
  committed but skipped `mu task close`.** Closes
  `agent_close_discipline_gap` in `mufeedback` (Phase 1 of 2). Live
  surface: 4-way wave-3 dispatch, 2 workers cleanly closed their
  tasks, 2 committed + reported done in chat-style and went idle
  without running `mu task close <id>` — `mu task wait` correctly
  kept polling because the DB row was still IN_PROGRESS, but to the
  operator it looked like a hang. The contract "agent does work →
  agent calls `mu task close` → wait sees the transition" has been
  in `skills/mu/SKILL.md` since 0.1.0, but doc-only is necessary +
  insufficient (both stuck workers "knew" the rule).

  `waitForTasks` now accepts an optional `stuckAfterMs` (default
  `300_000` = 5 min); the CLI exposes it as `--stuck-after <seconds>`
  on `mu task wait`. On every poll cycle the SDK checks each
  IN_PROGRESS task whose owner is a registered agent in `needs_input`
  whose `agents.updated_at` is older than the threshold, and emits
  one yellow line to stderr per stuck task per wait call (a
  `Set<localId>` deduper guarantees exactly-once — operators don't
  want stderr filled with the same line every poll second).
  `TaskWaitResult.tasks[i]` gains a `stuck: boolean` so the JSON
  output (`mu task wait --json`) carries the same signal
  programmatically. Backwards-compatible: pass `--stuck-after 0` (or
  set `stuckAfterMs: 0` from the SDK) to disable; consumers ignoring
  the new field see no behaviour change. Wait keeps polling — the
  warning is purely observational, leaving force-close /
  re-prompt / escalate to the operator (auto-close-on-heuristics is
  documented as an anti-feature in the original diagnosis note).

  Layer-3 (agent-runtime hook that auto-injects the close call into
  the agent's prompt) is deliberately not shipped: it would couple
  mu to the inner CLI's lifecycle, exactly the seam mu refuses to
  cross. Phase 2 of this change tightens `skills/mu/SKILL.md` with
  one bullet noting the failure mode (next entry).

  Tests: two new cases in `test/tasks.test.ts` `waitForTasks` block.
  The first inserts a registered agent in `needs_input` with an
  `updated_at` 10 minutes in the past, claims a task to it, runs
  `waitForTasks` for ~80ms / pollMs=10 (≈ 8 polls), and asserts the
  warning fired exactly once via the new `setWaitStuckWarnForTests`
  test seam (also asserts `tasks[0].stuck === true` on the JSON
  shape). The second confirms `stuckAfterMs: 0` disables the
  warning entirely. Existing `waitForTasks` tests updated for the
  new `stuck` field on `TaskWaitTaskState`.

### Changed

- **`mu log`'s `resolveLogContext` now uses `??` consistently
  and documents the pane-branch asymmetry.** Closes
  `review_code_resolve_log_workstream_branch_dup` in `mufeedback`.
  The `--as` and fallback branches both used `??` to fall back to
  `resolveOptionalWorkstream()` when no `-w` was given; the original
  `--as` branch used the older `?:` shape. Style nit only. Pane
  branch is now annotated with a one-line comment explaining the
  intentional asymmetry (agent's own `agents.workstream` wins over
  `$MU_SESSION` / tmux session) so the next reader doesn't "fix" it.
  Behaviour unchanged.

- **`skills/mu/SKILL.md` Working loop now flags the
  skipped-`mu task close` failure mode.** Phase 2 of
  `agent_close_discipline_gap`. One bullet directly under the
  worker-path code block: "If you committed/finished but skipped
  `mu task close <id>`, the orchestrator's `mu task wait` will hang.
  Always close as the LAST action of a dispatched task." Kept to a
  single bullet (no paragraph) per the SKILL.md tightening guardrail
  recorded under `docs_staleness_review_capstone` — every byte ships
  in every agent's context window. Pairs with the orchestrator-side
  `--stuck-after` warning above: docs catch the ones that read SKILL,
  the warning catches the ones that don't.

- **Moved `sanitiseTaskId` from `src/tasks/errors.ts` to `src/tasks.ts`
  (next to `slugifyTitle` / `idFromTitle`).** Closes
  `review_code_taskerrors_sanitise_lives_in_errors` in `mufeedback`.
  `sanitiseTaskId` is a slug helper (lowercase + non-alnum-replace +
  first-char-fix + reserved-prefix-fix), not an error helper — it just
  happened to be defined inside the file that holds
  `TaskIdInvalidError` because the only caller is
  `TaskIdInvalidError.errorNextSteps()`. Living in `tasks/errors.ts`
  was a layering smell (the helper conceptually belongs to the task-id
  namespace alongside `slugifyTitle`, which mirrors the same prefix
  corrections) and a future-drift risk (the next person needing to
  sanitise a task id would have grepped `src/tasks.ts`, missed it, and
  written a third copy). The function now reuses the existing
  `SLUG_HARD_CAP` (64) and `RESERVED_PREFIX` (`mu_`) constants from
  `src/tasks.ts` instead of repeating the literals; `tasks/errors.ts`
  imports it back from `"../tasks.js"` for the one error-message hint.
  Behaviour unchanged.

- **De-duplicated `shouldOverwriteAgentStatus` policy (one impl in
  `src/agents.ts`).** Closes `review_code_should_overwrite_status_dup`
  in `mufeedback`. The status-overwrite predicate (`free` is sticky
  unless detected `busy` / `needs_permission`; everything else
  overwrites freely) lived as two byte-equivalent copies: a private
  `shouldOverwrite` in `src/reconcile.ts` and an inline
  `shouldOverwriteAgentStatus` in `src/cli/agents.ts` that the latter
  even documented as "re-implemented here for `mu agent show`." The
  encapsulation justification didn't survive scrutiny — the predicate
  is pure and tiny, both call sites already import the SDK directly,
  and the next `free`-stickiness rule (e.g. `unreachable` stickiness)
  would have landed in only one of the two files with operators only
  noticing drift on `mu agent show <name>`. The canonical impl now
  lives in `src/agents.ts` next to `updateAgentStatus` (it's a
  property of the agent's status field, not of the reconcile loop);
  `src/reconcile.ts` and `src/cli/agents.ts` both import it. Behaviour
  unchanged; net **-12 LOC** with one fewer place that needs editing
  the next time the policy evolves.

- **De-duplicated `RawTaskRowForState` + `rawTaskRowToTask` (CLI →
  SDK consolidation).** Closes `review_code_raw_task_state_duplicate`
  in `mufeedback`. The `IN_PROGRESS` and `recent CLOSED` task slices
  used by `mu state` and `mu hud` were re-querying the `tasks` table
  inline and re-implementing the snake_case → camelCase row-shape
  conversion via a CLI-level `RawTaskRowForState` interface +
  `rawTaskRowToTask` helper exported from `src/cli.ts`. That row shape
  was byte-identical to the private `RawTaskRow` already used by the
  rest of `src/tasks.ts` (inside `listReady` / `listBlocked` /
  `listGoals` / etc.), so an eventual `TaskRow` field addition would
  have had to be threaded through three converters in lockstep with no
  compiler help (the duplicate type would have silently dropped the
  new column on the floor). Two new SDK helpers now live alongside the
  existing list-by-view helpers: `listInProgress(db, workstream)` and
  `listRecentClosed(db, workstream, limit?)`. `mu state` and `mu hud`
  call them directly; the CLI-level raw row + converter are deleted
  (-30 LOC in `src/cli.ts`, -25 LOC net across the two `cli/*`
  callers, +27 LOC of SDK helpers, +2 LOC of `src/index.ts`
  re-exports — net **-26 LOC** with one fewer exported surface and
  one fewer place that has to learn about new task columns). No SQL
  projections changed; only the wrapper around them.

- **`ready` / `blocked` / `goals` view DDL now lives in one place
  (`src/db.ts`).** Closes `review_code_views_recreated_thrice` in
  `mufeedback`. The three views were previously redefined at three
  sites: the canonical `CURRENT_SCHEMA` block in `src/db.ts`, plus
  inline `CREATE VIEW` blocks at the end of both `migrateV1ToV2`
  and `migrateV2ToV3` (each migration drops the views before
  rebuilding view-dependent tables and so has to recreate them).
  Comparing the SQL byte-for-byte: `ready` and `blocked` were
  identical across all three sites; `goals` matched in `db.ts` and
  `migrateV2ToV3` (the v3 shape, excluding `CLOSED` + `REJECTED` +
  `DEFERRED`) but differed in `migrateV1ToV2` (the v2 shape,
  excluding only `CLOSED`). Three new exported constants in
  `src/db.ts` — `READY_VIEW_SQL`, `BLOCKED_VIEW_SQL`,
  `GOALS_VIEW_SQL` — each emit a `DROP VIEW IF EXISTS` + `CREATE
  VIEW`. `applySchema` interpolates all three into the schema
  template; `migrateV2ToV3` imports and `db.exec`s all three
  (`v3` IS the current shape); `migrateV1ToV2` imports `READY` +
  `BLOCKED` but keeps its own inline `goals` body since rewriting
  it to the current shape would lie about what the v2 schema
  looked like. Migrations remain forward-only history. `mu doctor`
  on a fresh DB still reports schema OK and all three views are
  queryable; `db.test.ts` continues to exercise both v1→v2 and
  v2→v3 migrate paths.

- **`mu`-managed tmux panes now have a visually distinct frame on
  all four sides, not just the labeled top status band.** Closes
  the first half of `tmux_pane_border_top_and_bottom_plus_glyph_audit`
  in `mufeedback`. `enableMuPaneBorders` now also sets:
  ```
  pane-border-lines        heavy
  pane-active-border-style fg=cyan,bold
  pane-border-style        fg=brightblack
  ```
  The top still carries `[mu] #{pane_title}`; the bottom + sides now
  carry a heavy box-drawing rule that's bright cyan on the active
  pane and dim brightblack on inactive ones. tmux's
  `pane-border-status` only takes `{off, top, bottom}`, so true
  "all four sides labeled" isn't possible — the heavy/colored frame
  is the reasonable compromise.

- **`STATUS_EMOJI` drift cleanup.** Closes the second half of
  `tmux_pane_border_top_and_bottom_plus_glyph_audit`. `STATUS_EMOJI`
  in `src/agents.ts` (Nerd Font private-use codepoints, picked for
  1-cell-width column alignment) is the single source of truth for
  agent-status glyphs. Five doc comments plus one test fixture had
  drifted to the OLD Unicode emoji (`⚙️`, `💤`, `🛂`, `✅`)
  that production hasn't emitted in days. Comments no longer name
  specific codepoints (they point at `STATUS_EMOJI` directly so
  they can't drift again); `test/tmux.test.ts` `parseAgentNameFromTitle`
  fixtures now interpolate `STATUS_EMOJI.needs_input` / `.busy`, so
  any future reshape breaks the test loud instead of silently
  parsing a different glyph. The `mu task wait` `✓`/`•` markers
  and the pi-prompt `❯` detection glyph are deliberately untouched
  (different semantic).

### Added

- **`--sort` for `mu task list / next / ready` (recency / age / id / roi).**
  Closes `nit_task_list_sort_by_recency` in `mufeedback`. Two new use
  cases that were previously stuck behind a `mu sql` workaround now
  have typed verbs: "what did I touch most recently?" (`--sort
  recency` — `updated_at` DESC) and "what's gone stale?" (`--sort
  age` — `created_at` ASC). The four legal keys are `roi` (default
  for `next` / `ready`), `recency`, `age`, `id` (default for `list`,
  preserves prior `local_id` ordering); an unknown key fails fast
  with exit 2 and an error message naming every legal value.

  Under `--sort recency` / `--sort age` the table view gains a
  trailing `updated` / `created` column rendered as a compact
  relative-time string (`12s` / `5m` / `3h` / `2d` / `2w`) so the
  dimension being sorted by is visible at a glance. The sort key
  alone toggles the column — no separate `--show-time` flag, since
  the user opted in by choosing a time-based sort. Default sort and
  `--sort id`/`--sort roi` keep the historical narrow table.

  JSON shape unchanged: `--sort` only reorders rows. `createdAt` and
  `updatedAt` were already present on every `TaskRow`, so consumers
  can keep doing `jq 'sort_by(.updatedAt)'` if they want
  client-side re-sort.

  The relative-time helper (`relTime`) used by the new column is the
  same one HUD already used; moved from `src/cli/hud.ts` to `src/cli.ts`
  and exported, with weeks (`Nw`) added on top of the existing
  s/m/h/d buckets to keep stale-task tags readable. New SDK helpers:
  `TASK_SORT_KEYS`, `parseSortOption(raw)`, `sortTasks(tasks, key)`,
  `relTimeBasisForSort(key)`. Tests: SDK-level coverage in
  `test/tasks.test.ts` (one per sort key + parser + helper); CLI
  integration in `test/json-output.test.ts` covers each verb × each
  key, the table-mode column toggle, and the unknown-key error path.

- **Workspace staleness signal in `mu state` and `mu workspace list`.**
  Closes `bug_workspace_stale_parent_silent_drift` in `mufeedback`
  (Option 2 only — warn-only). Surfaced live: `roadmap-v0-2`'s
  `worker-1` workspace was 9 commits behind main when dispatched on
  `cross_workstream_claim_for`; the worker correctly implemented the
  fix against its stale tree, but the resulting diff vs. main was
  6500 insertions / 7700 deletions because the workspace pre-dated
  the `refactor_split_large_src_files` series. The orchestrator had
  no signal that the workspace had drifted.

  Each row in `vcs_workspaces` now carries an optional
  `commitsBehindMain` field, populated by a new
  `decorateWithStaleness(rows)` SDK helper that calls the row's
  backend's `commitsBehind(workspacePath, ref)` method. The number
  is rendered as a color-coded `behind` column (green ≤2, yellow
  3–9, red ≥10). When `mu state` finds ANY workspace ≥10 commits
  behind, it prefixes the Workspaces section header with a yellow
  `⚠ (N stale ≥10 commits behind)` annotation and appends a one-
  line tip pointing at the only remediation today: `mu workspace
  free <agent> + mu workspace create <agent>`.

  Pure observation: NO automatic `git fetch` / `jj git fetch` /
  `sl pull`. The number is as fresh as the workspace's local
  remote-tracking refs cache; the operator decides when to refresh.
  Backends that can't resolve the project's default branch (no
  `origin/HEAD`, no `origin/main`, no `origin/master` for git;
  unresolvable `trunk()` for jj/sl) return `null`, which renders as
  a dim `—` and never triggers the warn line. The `none` backend
  (no VCS) always returns `null`.

  Out of scope (deliberate): a `mu workspace rebase` verb (Option 1
  in the bug's diagnosis) — filed as a follow-up if Option 2's
  warning leaves residual friction. Auto-rebase (Option 3) is an
  anti-feature (silent mutation). Reject-stale-spawn (Option 4)
  layers on top of Option 1 only.

  Tests: `test/workspace.test.ts` covers each backend's
  `commitsBehind` (git fetches OK after a manual fetch; jj and sl
  return sane numbers or null; none always returns null) plus
  `decorateWithStaleness` shape; new `test/workspace-staleness.test.ts`
  drives the CLI in-process to assert the rendered table column +
  the `mu state` warn line at the threshold boundary.

### Fixed

- **`mu hud` recent-events tail now colours every emitter verb
  (was silently mis-colouring `task block` / `approval granted` /
  `task reparent`).** Closes `review_code_hud_event_color_regex_drift`
  in `mufeedback`. The `colorEventPayload` helper in `src/cli/hud.ts`
  used a hand-maintained regex enumerating two-token verb prefixes
  (`task add`, `agent spawn`, ...). Three drifts had accumulated:
  the regex listed `task edge add` / `task edge remove` (no caller
  emits these — the actual edge events are `task block ${...} by
  ${...}` and `task unblock ...`); listed `approve add|grant|deny`
  while the SDK emits `approval add` and `approval ${granted|denied|
  timeout} ${slug}`; and missed `task reparent` outright. Net: the
  three highest-frequency "structural" event verbs after
  add/close/note/claim/release rendered as plain dim text in the
  HUD's events column, defeating the verb-colour grouping the
  function was supposed to provide.

  Fix is two-part. (a) Pull the verb list out of the regex into a
  single source of truth `EVENT_VERB_PREFIXES` exported from
  `src/logs.ts` (lives next to `emitEvent` so the maintenance
  contract is local: "adding a new emitter? add its prefix here").
  (b) Rewrite `colorEventPayload` to walk the list and match by
  prefix + word boundary; falls back to the dim payload when
  nothing matches (information-preserving). The list itself enumerates
  every two-word prefix actually emitted by the SDK today (audited
  via `grep -rn emitEvent src/`): 11 task verbs, 4 agent verbs, 2
  workspace verbs, 2 workstream verbs, 4 approval verbs.

  Regression coverage in `test/hud.test.ts` is two-sided: one test
  walks every entry in `EVENT_VERB_PREFIXES` through
  `colorEventPayload` and asserts ANSI cyan wraps the verb (catches
  the HUD failing to recognise something on the canonical list);
  another grep-scans every `emitEvent(...)` callsite under `src/`
  and asserts each payload's leading two tokens are a member of
  `EVENT_VERB_PREFIXES` (catches the OTHER drift direction — a
  contributor adding a new emitter and forgetting to extend the
  list). Verified by deleting `"task block"` from the constant: the
  scanning test fails loudly with the offending callsite path. A
  third small test asserts unknown payloads (including the trap
  string `"approve granted slug"` — wrong noun) round-trip unchanged.
  Behaviour change: HUD now renders the formerly-dim verbs in cyan;
  no JSON shape changes.

- **`mu task note` escape translation no longer relies on an
  in-band sentinel string.** Closes
  `review_code_unescape_note_text_placeholder_brittle` in
  `mufeedback`. The `unescapeNoteText` helper in `src/cli/tasks.ts`
  used a two-pass split/join that swapped every literal `\\` for a
  fixed Unicode placeholder (`\u{1F511}backslash\u{1F511}`),
  translated the remaining `\n` / `\t` / `\r` escapes, then
  swapped the placeholder back. A note body that legitimately
  contained the literal placeholder string would have been
  corrupted on its way through; more importantly the in-band
  sentinel pattern itself was harder to read than the underlying
  intent. Replaced with a single-pass regex
  (`/\\([\\ntr])/g`) that decides per-match what to emit, which
  collapses the two passes into one and removes the sentinel
  entirely. New unit tests in `test/unescape-note-text.test.ts`
  cover `\n` / `\t` / `\r` translation, the `\\n` → literal `\n`
  case (the one the placeholder previously protected), the
  `\\\n` → backslash + newline case, and the no-longer-dangerous
  placeholder-string passthrough.

- **`destroyWorkstream` no longer double-counts already-gone
  workspaces as freed.** Closes
  `review_code_destroy_freed_workspaces_double_count` in
  `mufeedback`. The per-workspace cleanup loop in
  `src/workstream.ts` had a dead `if (result.removed) { freed++ }
  else { /* path already gone */ freed++ }` branch — both arms
  bumped the same counter, so a registry row whose on-disk path
  was already missing (manual `rm -rf` or an interrupted prior
  destroy) was reported as a successful free even though the
  backend did zero filesystem work. The destroy summary the user
  saw at the CLI (`workspaces=N/M`) therefore overstated how much
  cleanup mu actually performed.

  `DestroyResult` gains a sibling field `alreadyGoneWorkspaces:
  number`. The two cases are now split honestly:
  `freedWorkspaces` only ticks when `backend.freeWorkspace`
  reports `removed: true` (the on-disk path was actually deleted
  on this destroy); `alreadyGoneWorkspaces` ticks when the
  backend's free was a no-op because the path was already missing
  (the DB row was still cascade-deleted, just nothing happened on
  disk). The CLI's `Destroyed ws ...` line now appends `(N
  already gone on disk)` only when the count is non-zero, so the
  common case stays terse and the operator gets a hint when stale
  registry rows exist. The `workstream destroy ...` log event
  also gains an `already_gone=N` field for `mu log` archaeology.

  Regression test in `test/workstream.test.ts`
  ("splits freedWorkspaces (real removal) from alreadyGoneWorkspaces
  (no-op on disk)"): seeds two `vcs_workspaces` rows in the same
  workstream against the `none` backend — one with the on-disk
  path present, one with it absent — and asserts
  `freedWorkspaces=1, alreadyGoneWorkspaces=1` plus
  `existsSync(presentPath)===false` afterward. The four existing
  `destroyWorkstream` test assertions were updated to include
  `alreadyGoneWorkspaces: 0`.

- **`waitForTasks` now returns within `timeoutMs` even when `pollMs >
  timeoutMs`.** Closes `review_test_waitfortasks_polling_unverified`
  in `mufeedback`. The poll loop in `src/tasks/wait.ts` awaited a
  full `pollMs` before re-checking the deadline, so a caller asking
  for a 50ms timeout with a 1000ms poll interval blocked ~1s instead
  of returning promptly. The CLI maps timeouts to exit code 5; any
  script picking unbalanced poll/timeout silently observed wrong
  latency.

  The sleep is now clamped to `min(pollMs, deadline - now)`, so the
  function returns within `timeoutMs + small slack` regardless of
  `pollMs`. `timeoutMs=0` ("wait forever") still uses the full
  `pollMs` cadence; when the clamp goes <= 0 the sleep is skipped
  and the loop re-snapshots before bailing on the timeout (last
  chance for a winning state at the deadline boundary, and avoids
  passing 0 / negatives to `setTimeout`).

  Alongside the fix: `setWaitSleepForTests` + `getWaitPollCount` /
  `resetWaitPollCount` test seams (mirrors `setSleepForTests` in
  `src/tmux.ts`) so the regression has a poll-count assertion in
  addition to the elapsed-time bound. Three new tests in
  `test/tasks.test.ts`: clamped-sleep regression bound (elapsed <
  200ms with `pollMs=1000, timeoutMs=50`), poll-cadence assertion
  (5–15 polls with `pollMs=10, timeoutMs=100`), and a
  sibling-progress check that deletion of one task mid-wait does
  not block detection of another sibling reaching CLOSED.

- **`mu task add` with an invalid id now throws a typed
  `TaskIdInvalidError` instead of a bare `TypeError`.** Closes
  `nit_invalid_id_typeerror` in `mufeedback`. Surfaced while doing
  the `roadmap-v0-2` design pass: passing `tmpA` (uppercase) as a
  task id produced `{"error":"TypeError", ..., "nextSteps":[],
  "exitCode":1}` — a generic exit-1 error with no recovery hint,
  because the error class wasn't in the CLI's `classifyError()`
  exit-code map.

  Now: a `TaskIdInvalidError extends Error implements HasNextSteps`
  in `src/tasks/errors.ts` (alongside `TaskExistsError` and
  friends). `errorNextSteps()` returns two actionable hints — drop
  `--id` and pass `--title` to use the auto-derived path, or run
  the verb again with a sanitised candidate (lowercase + every
  non-`[a-z0-9_-]` char rewritten to `_`, leading non-letter
  trimmed, reserved `mu_` prefix rewritten to `t_mu_`). Mapped to
  exit code 4 (validation / conflict) in `classifyError()`.

- **`mu workspace create` no longer leaves a partial dir behind on
  failure, and refuses outright when projectRoot is `$HOME`.** Closes
  `workspace_create_partial_dir_on_failure` in `roadmap-v0-2`;
  surfaced live in `snap_dogfood` Finding 4. Two interlocking
  sub-bugs:

  1. `mu workspace create` invoked from `cwd=$HOME` with no
     `--project-root` would kick the `none` backend into a recursive
     `cp -a $HOME/.` of the user's home directory — ~/Music,
     ~/.config, ~/Library, etc. — into
     `~/.local/state/mu/workspaces/<ws>/<agent>/`. On macOS the
     first DRM-protected file in `~/Music` stalls the copy
     indefinitely.
  2. On interrupt (or any backend throw) mid-`createWorkspace`, the
     partial on-disk dir was left behind AND no DB row was ever
     inserted, so `mu workspace list` showed nothing while the next
     `mu workspace create` refused with `WorkspacePathNotEmptyError`.

  Fix:
  - New typed `HomeDirAsProjectRootError` (exit 4): thrown when
    `path.resolve(projectRoot) === path.resolve(os.homedir())` —
    catches `cd && mu workspace create`, `--project-root ~/`,
    `--project-root ~/.`, etc. Direct children of `$HOME` (e.g.
    `~/Documents`) are deliberately NOT blocked; that would be
    overreach. There is no `--force` escape hatch — the resolution
    is `--project-root <real-path>` (or `cd` somewhere real).
  - `createWorkspace` now wraps `backend.createWorkspace` in a
    try/catch: on throw, the partial workspace path is removed via
    `rm -rf` (best-effort) before the original error is re-thrown.
    This complements the existing INSERT-failure rollback (from
    `bug_agent_spawn_workspace_fk_failure`), so the on-disk +
    registry-row pair is now atomic-ish at every failure boundary.

  The orphan-detection path (`mu workspace orphans`) already
  surfaces the partial dir if cleanup fails (the dir-with-no-row
  case); verified by code reading.

  Tests: `test/workspace.test.ts` adds (a) HOME guard rejects via
  `homedir()`, `${homedir()}/`, and `${homedir()}/./`; (b) a flaky
  backend that creates a partial dir then throws is cleaned up,
  and a follow-up `createWorkspace` succeeds without
  `WorkspacePathNotEmptyError`. Manually verified end-to-end with
  `cd $HOME && mu workspace create ...` (rejected with the typed
  error + nextSteps, exit 4) and with a real `--project-root /tmp`
  (the `cp -a` hit unprintable sockets, threw, and the partial dir
  was cleaned up cleanly).

- **HUD colors survive `watch` and other non-TTY pipes.** Closes
  `hud_colors_stripped_under_watch_and` in `mufeedback`. Surfaced
  live: `watch --no-title -n 2 --color mu hud -w roadmap-v0-2`
  rendered the HUD with no colors (status emojis without fg color,
  dim hints not dimmed, bold headers plain) even though the same
  `mu hud` in a regular shell rendered colors correctly.

  Root cause: picocolors auto-detects color support from
  `process.stdout.isTTY && env.TERM !== 'dumb'`. `watch` runs the
  command with stdout as a pipe, so `isTTY` is false and picocolors
  disables ANSI output. `watch --color` only tells `watch` to
  *preserve* ANSI from the captured output — it can't make the
  child process emit them in the first place. Same problem applies
  to `tmux display-popup -E mu hud | cat` and any pipe-into-pager
  flow inside tmux.

  Fix: new `colorEnabled()` helper in `src/output.ts` returns true
  if any of `picocolors.isColorSupported`, `MU_FORCE_COLOR`,
  `FORCE_COLOR`, or `process.env.TMUX !== undefined` (the
  load-bearing clause: surrounding pane is a real terminal even
  though our stdout is a pipe). `NO_COLOR` trumps all four, per
  the no-color.org convention. Every `picocolors` import in `src/`
  is now a re-export from `src/output.ts` (`export const pc =
  picocolors.createColors(colorEnabled())`), so every color-using
  verb — not just `mu hud` — picks up the fix uniformly.

  Tests: new `test/output.test.ts` covers the env-var matrix
  (no env / TMUX / MU_FORCE_COLOR / FORCE_COLOR / NO_COLOR
  precedence); existing `test/hud.test.ts` updated to set
  `NO_COLOR=1` via `vi.hoisted()` so its raw-layout substring
  assertions stay deterministic regardless of where the test runs.

- **`mu task claim <task> -w <wsA> --for <agent>` now rejects when
  `<agent>` lives in a different workstream than `<task>`.** Closes
  `cross_workstream_claim_for` in `roadmap-v0-2`; surfaced live in
  `snap_dogfood` Section D (note #362, Finding 1).

  Pre-fix, the schema's FK on `tasks.owner` references `agents(name)`
  with no workstream qualifier, so a worker-claim from a different
  workstream silently succeeded and the rest of mu treated the row
  as in-scope (a scope leak, not a coordination feature).

  Fix: a pre-FK check in `claimTask`'s worker path looks up the
  resolved agent's workstream and the task's workstream; on mismatch
  it throws the existing `AgentNotInWorkstreamError` (already wired
  to exit 4 in `cli.ts`'s `handle()` map). The `--self` (anonymous)
  path is untouched: there's no agent FK to check, and the
  orchestrator legitimately drives any workstream's tasks.

  Tests: 3 new in `test/tasks.test.ts` (cross-workstream `--for`
  rejection; error carries actionable next-steps; `--self` regression
  cover). Pre-existing tests that constructed cross-workstream owner
  state via the buggy claim path (1 in `test/tasks.test.ts`, 3 in
  `test/claim.integration.test.ts`) updated to either set the owner
  via direct SQL (the read-side `listTasksByOwner` test, whose
  cross-workstream contract is unchanged) or to spawn agents in the
  task's workstream (the integration tests).

- **Read-only verbs no longer race in-flight `--workspace` spawns.**
  Closes (re-opened) `bug_agent_spawn_workspace_fk_failure` in
  `mufeedback`. Surfaced live: `mu agent spawn ... --workspace` in
  the `infer-rs` workstream consistently failed with a confusing
  `error: FOREIGN KEY constraint failed` whenever there was a
  `watch -n 5 mu hud -w infer-rs` running in another pane (the
  common live-monitoring pattern documented in the SKILL).

  Root cause: the spawn path inserts a placeholder agent row
  (`pane_id = '%pending-<name>'`) BEFORE calling
  `gitBackend.createWorkspace`, which `git worktree add`s a
  detached checkout of the project into the workspace path. For a
  large repo (`infer-rs` is 13k files) this takes 2-3 seconds.
  Meanwhile, the `watch mu hud` invocation calls `listLiveAgents`
  every 5s, which calls `reconcile()`, which prunes any agent row
  whose `pane_id` doesn't match a live tmux pane — and
  `'%pending-<name>'` is not a live tmux pane. The placeholder
  row gets DELETEd mid-spawn; the subsequent `INSERT INTO
  vcs_workspaces` then fails its `agent` FK because the agent row
  is gone. Surfaces as the FOREIGN KEY error on the wrong line.

  Fix: `ListLiveAgentsOptions` gains a `dryRun?: boolean`,
  forwarded to `reconcile()`'s same-name option (which already
  exists since `snap_undo_reconcile_destroys_recovered_agents`).
  Every read-only call site sets it:
  - `cmdHud` (the surfacer-of-the-bug verb)
  - `cmdState` (`mu state` — canonical state card)
  - `cmdMission` (bare `mu` — quick mission control)
  - `cmdAttach` (`mu agent attach` — reads scrollback)
  - `cmdDoctor` + `cmdDoctorJson` (`mu doctor` — diagnostic)

  `cmdList` (`mu agent list`) keeps the mutating behaviour: it's
  the documented escape hatch for forcing a real prune. Same shape
  as the snap_undo fix: read verbs are read-only by default; the
  one explicit "refresh and prune" verb keeps its mutating semantics.

  Tests: 3 new in `test/verbs.test.ts` covering dryRun propagation
  through `listLiveAgents` (ghost survives in dryRun mode; default
  remains mutating; orphan-detection still runs in dryRun).
  710 + 3 = 713/713 green.

  Smoke-tested: a tight `while true; do mu hud > /dev/null; sleep
  0.1; done` loop in one shell + `mu agent spawn ... --workspace
  --workspace-project-root /Users/mtrojer/infer-rs` in another now
  succeeds; pre-fix this raced reliably on every attempt.

- **`mu undo` no longer silently drops recovered agent rows whose
  panes are dead.** Closes
  `snap_undo_reconcile_destroys_recovered_agents` in roadmap-v0-2;
  caught live in `snap_dogfood` Section D (note #362, Finding 2).

  Pre-fix, `mu workstream destroy --yes` followed by `mu undo --yes`
  recovered the workstreams + tasks + edges + notes from the
  snapshot, but the `agents` row and `vcs_workspaces` row were
  silently dropped — even though the snapshot file on disk
  contained them. Root cause: `cmdUndo`'s post-restore `reconcile()`
  loop would prune any agent row whose pane no longer existed in
  tmux; the destroy had killed every pane in the workstream just
  moments before the snapshot was taken read; the prune ran and
  the FK ON DELETE CASCADE on `vcs_workspaces.agent` did the rest.
  The "agents pruned: N" line in the undo output was honest
  diagnostic but the recovery PROMISE was broken.

  Fix (Option C from the issue's three-options sketch, narrowed to
  the smallest cut): `reconcile(opts)` gains a `dryRun?: boolean`
  flag. `cmdUndo` passes `dryRun: true`. In dryRun mode:
  - **prune step**: counts ghosts but doesn't `deleteAgent()`
  - **status-detect step**: skipped entirely (no scrollback
    capture, no `refreshAgentTitle`, no DB writes)
  - **orphan-surface step**: still runs (pure read)

  `mu agent list` and `mu doctor` keep the mutating behaviour
  they always had (dryRun defaults to false). The user-visible
  output reflects the new contract:

  ```
  Reconcile (tmux NOT rolled back; rows NOT pruned):
    would-be-pruned (DB row → dead pane) : 1 (suppressed: rows preserved as restored)
    orphan panes surfaced                 : 0
  Next:
    Confirm + actually prune dead-pane rows you don't want to re-spawn : mu agent list -w <ws>
    Re-spawn an agent the DB now lacks                                 : mu agent spawn <name> -w <ws>
  ```

  JSON shape changed: `reconcile.ghostsPruned` is now
  `reconcile.wouldBePrunedGhosts`; `reconcile.statusChanges` is
  removed (always 0 in dryRun mode); `reconcile.dryRun: true`
  added. `mu agent list` / `mu doctor` consumers see no change.

  `ReconcileReport` likewise gains `dryRun: boolean`.

  Tests: 5 new in `test/reconcile.test.ts` (dryRun preserves
  rows; non-dryRun pass right after still prunes; status-detect
  skipped; orphan-surface still works; the snap_dogfood Finding
  2 regression test). 2 new end-to-end in `test/snapshots.test.ts`
  (full restore-then-reconcile cycle through the SDK; counter-test
  proves the fix is load-bearing). Existing
  `test/cli-snapshot.test.ts` JSON shape assertion + heading text
  assertion updated. **Gate green at 711 tests (2 pre-existing
  `claimTask --self` flakes from snap_schema unchanged).**

  Smoke verified live on a temp DB:
  ```
  $ mu workstream init dogfix
  $ mu task add design -w dogfix --title D --impact 80 --effort-days 1
  $ # ...insert agents row + vcs_workspaces row via mu sql...
  $ mu workstream destroy -w dogfix --yes
  $ mu undo --yes
  Reconcile (tmux NOT rolled back; rows NOT pruned):
    would-be-pruned (DB row → dead pane) : 1 (suppressed: rows preserved as restored)
  $ mu sql "SELECT * FROM agents WHERE workstream='dogfix'"   # → dog-1 still there
  $ mu sql "SELECT * FROM vcs_workspaces WHERE workstream='dogfix'"  # → still there
  ```

### Schema

- **`schema_version` table + migration framework.** First
  non-additive schema change earns its first migration. `openDb`
  now sniffs the existing DB shape, stamps the version, and runs
  any pending migrations from `src/migrations.ts` (forward-only,
  one transaction each, post-migration `PRAGMA foreign_key_check`
  for safety). The framework lives in `src/migrations.ts`;
  `src/db.ts` keeps the schema definition and exports
  `CURRENT_SCHEMA_VERSION` as the single source of truth.

- **All 10 foreign keys gain `ON UPDATE CASCADE`** (v1 → v2
  migration). Previously the FKs only had `ON DELETE CASCADE`,
  so renaming a workstream / task / agent name would have left
  every child row dangling. Now every child column follows
  atomically. Affected FKs:
  - `agents.workstream` → `workstreams.name`
  - `tasks.workstream` → `workstreams.name`
  - `tasks.owner` → `agents.name` (already SET NULL on delete)
  - `task_edges.from_task` → `tasks.local_id`
  - `task_edges.to_task` → `tasks.local_id`
  - `task_notes.task_id` → `tasks.local_id`
  - `agent_logs.workstream` → `workstreams.name`
  - `vcs_workspaces.agent` → `agents.name`
  - `vcs_workspaces.workstream` → `workstreams.name`
  - `approvals.workstream` → `workstreams.name`

  The migration rebuilds 7 tables in place (CREATE _new / INSERT
  SELECT / DROP / RENAME) because SQLite can't `ALTER TABLE` to
  modify FK clauses. Existing data is preserved; the migration
  is covered end-to-end in `test/db.test.ts`. Recovery recipes
  for typo'd workstream names live in [USAGE_GUIDE § 14](docs/USAGE_GUIDE.md#you-typod-a-workstream-name-and-want-to-rename-it).

  **No new verb.** Renaming is a single-statement `mu sql`
  recipe; wrapping it in a typed verb would add surface area
  without buying anything (no atomicity to preserve, no
  validation a verb adds, single statement, no side effects).

### Breaking

- **`mu hud` mode flags removed** (`--line`, `--small`, `--mid`,
  `--full`). The HUD now renders one shape — a dynamic table
  layout that fills the available pane height + width — by
  default. `--json` is preserved unchanged. Status-bar / dotfile
  callers that used `mu hud --line` should switch to the
  one-line first row of the default render (or `mu hud --json |
  jq` for structured extraction). See the Added entry below.

### Added

- **`mu hud` rewritten as a dynamic table layout.** Closes
  `nit_hud_render_tables` in `mufeedback`. The five mode flags
  (`--line` / `--small` / `--mid` / `--full`) are gone; `--json`
  is the only remaining flag (besides `-n` for the events tail
  cap, default raised 5 → 10). The default human render is now
  one verb that fills the available terminal (or tmux pane)
  height + width with as much useful data as fits.

  Layout is greedy top-down by priority — every section is a
  cli-table3 (header + body, box-drawing border):
  1. Header line: `mu-<ws> · Nr · Np · Ntrk · N agents (💤N ⚙️N)`
  2. Agents table
  3. Ready tasks table (operator's 'what to dispatch next')
  4. In-progress table
  5. Tracks table (`#`, `roots`, `tasks`, `ready`, `kind`)
  6. Recent events table

  Each table has a width-aware truncation budget for the most-
  compressible cell (title / payload / roots / task). When a
  section is truncated, an `… +N more (<verb>)` footer points at
  the follow-up verb.

  Pane size is resolved in this order:
  1. `MU_HUD_FORCE_SIZE=WxH` env override (test-only / operator
     escape hatch).
  2. `process.stdout` if it's a TTY.
  3. `currentPaneSize()` via `tmux display-message -p
     '#{pane_width} #{pane_height}'` (catches
     `watch -n 5 mu hud -w X` and `tmux display-popup -E '...'`,
     both of which strip TTY-ness but still run inside a tmux pane).
  4. `120 × 30` fallback for non-tmux pipes.

  `--json` shape is unchanged — same keys, same types. Scripts
  that consumed the JSON before keep working.

  Tests: 7 cases covering default render at roomy size, tiny
  pane (truncation + `+N more` footer), narrow width
  (ellipsis), empty workstream, `MU_HUD_FORCE_SIZE` validation,
  `--json` shape stability, and `-n` cap.

- **Docs synced for snapshots + `mu undo` shipping.** Closes
  `snap_docs` in roadmap-v0-2.
  - `docs/USAGE_GUIDE.md` — new "You ran a destructive verb and
    want to undo it" subsection in § 14 (Recovery), explicit
    callout from § 15 (Cleanup) when describing
    `mu workstream destroy`, removed the `mu redo` row from the
    § 18 workaround table, header anchor + "What's NOT in 0.2.0"
    title aligned with the v0.2 reality.
  - `docs/ROADMAP.md` — promoted the `mu undo` /
    `mu snapshot {list,show}` block from SHIPPING to SHIPPED with
    the as-shipped surface and the design decisions held to
    (no `mu redo`, cross-version restores rejected, tmux NOT
    rolled back).
  - `skills/mu/SKILL.md` — new "Snapshots + undo (3)" block in
    the verb list, replaced "There is no `mu undo`" in the
    Cleanup pattern with the snapshot-aware version, added
    "Recover from a destructive verb (DB only)" in-pane pattern,
    added the safety belt ("even though both auto-snapshot, the
    tmux side effects are NOT recoverable") to the irreversible
    section.
  - `docs/VOCABULARY.md` — dropped the stale "verb shipping in
    snap_undo_verb" parenthetical.
  - `README.md` — "Not undoable" caveat replaced with the more
    honest "DB-undoable, not tmux-undoable" framing.

- **`mu workstream destroy` advertises `mu undo` in its `Next:`
  block.** Closes `snap_destroy_safety` in roadmap-v0-2. Dry-run
  output now includes a one-line note that a snapshot will be
  taken before the destroy plus the explicit caveat that tmux
  panes / on-disk workspace dirs are NOT rolled back. The `--yes`
  output adds an `Undo` next-step. Both human and `--json` paths
  carry the new hints (the JSON path adds a `nextSteps` field on
  the `--yes` response when no workspace cleanups failed). The
  destroy itself already auto-snapshotted via `captureSnapshot`
  in `destroyWorkstream`; this is purely the user-visible
  surface that promised `mu undo` discoverability. No new tests
  — the existing 704-test gate exercises the dry-run/--yes/JSON
  paths and they kept passing.

- **`mu task reject --cascade` / `mu task defer --cascade` are now
  dry-run by default; require `--yes` to commit.** Surfaced live
  during roadmap-v0-2 hud cleanup: an accidental cascade reject
  swept `hud_dogfood` (which had independent merit and needed
  reopening). The DB rebuild was recoverable via `mu task open`,
  but the lossy step — silently sweeping the dependents — is
  exactly the class of footgun ROADMAP's 'data-loss footguns ship
  on first occurrence' rule promotes.

  Now mirrors `mu workstream destroy --yes`: cascade alone shows
  the affected list as a preview, `--yes` commits.

  ```
  $ mu task reject design --cascade
  Reject design would sweep 3 task(s) (root + 2 dependent(s)):
    * design  Design X
      build   Build X
      review  Review X
  (dry-run; rerun with --yes to actually sweep)
  Next:
    Commit the cascade after reviewing the list  : mu task reject design --cascade --yes
    Address one dependent first, then re-preview : mu task reject <dep>
  ```

  - SDK: `RejectDeferOptions` gains `yes?: boolean`.
  - SDK: `RejectDeferResult` gains `dryRun: boolean` and
    `affectedIds: string[]`. `affectedIds` is the would-touch
    list on dry-run AND the did-touch list on commit — callers
    always know what was/will-be swept.
  - CLI: `--yes` flag added to both `mu task reject` and
    `mu task defer`. `--yes` without `--cascade` errors with
    `UsageError` (single-task case is unconditional commit; the
    flag is meaningless there).
  - CLI: dry-run human output renders one line per affected task
    (`* root` / `  dep`) with truncated titles, then the next
    steps. JSON dry-run carries `dryRun: true` + the
    `affectedIds` array.
  - Single-task case (no open dependents, cascade flag passed
    anyway) skips the dry-run since there's nothing to preview.
  - errorNextSteps for `TaskHasOpenDependentsError` now lists
    both the `--cascade` preview AND `--cascade --yes` commit
    recipes (4 hints total: preview, commit, drop edge, address
    dependents one at a time).

  Tests: 4 new cases (dryRun shape; commit shape; single-task
  bypass; affectedIds populated on commit). 2 existing tests
  updated (`cascade: true` -> `cascade: true, yes: true`). 647
  tests total.

  Closes `bug_cascade_reject_too_aggressive` in the `mufeedback`
  workstream.

- **`mu hud` verb: print-once HUD card with five mode flags.**
  Operator-side complement to the agent-side pane border. Exits
  after one render — mu owns the data, the user owns the redraw.

  Modes (mutually exclusive; default `--mid`):

  | flag | shape |
  |---|---|
  | `--line` | one-liner: `<ws> · Nr · Np · Ntrk · last: <event> +T` |
  | `--small` | counts header + agent-status histogram |
  | `--mid` | counts + agent table (default) |
  | `--full` | + tracks list + recent-events tail |
  | `--json` | structured: workstream / summary / agents / orphans / tracks / ready / inProgress / recent |

  `-n N` overrides recent-events tail length (only meaningful for
  `--full` / `--json`; default 5).

  Composition recipes:

  ```bash
  watch -n 5 mu hud -w X                       # live pane
  tmux display-popup -E 'mu hud -w X'          # peek overlay
  tmux set-option -wg @mu_summary '#(mu hud -w X --line)'
                                               # dotfile injection
  mu hud -w X --json | jq .summary             # script
  ```

  No `--watch`, no auto-spawn, no tmux side effects — mu prints,
  the user composes. Substrate-aligned with every other typed
  verb (print, exit, compose).

  Tests: 8 cases covering each mode + the mutual-exclusion check.
  641 tests total.

  Closes part of `hud_design` in roadmap-v0-2; the remaining
  pi-extension framing is rejected as out-of-scope (would violate
  'don't bundle pi'). The verb-in-a-pane shape obviates the
  pi-extension HUD widget tasks (`hud_extension_skeleton`,
  `hud_widget_impl`) — they should be repurposed or rejected next.

- **`mu undo` / `mu snapshot list` / `mu snapshot show` — the
  user-facing recovery verbs.** Closes `snap_undo_verb` in
  roadmap-v0-2 (designed in `snap_design` note #293; impl by
  worker-1 on top of the `snap_schema` substrate). Promotes the
  `mu task delete` next-step from "restore from backup" to
  "`mu undo --yes`".

  ```
  $ mu task close design                # auto-snapshots before flip
  $ mu undo                              # dry-run; shows what would be restored
  About to restore snapshot #1
    label        : task close design
    workstream   : auth
    taken at     : 2026-05-08T13:21:40Z
    size         : 144.0 KB
  This will REPLACE the live mu.db with the snapshot. tmux state
  will NOT be rolled back: agents in DB whose panes are gone will
  be pruned by reconcile; tmux panes whose DB rows are gone will
  surface as orphans on the next `mu agent list`.
  $ mu undo --yes                        # commit
  Restored snapshot #1 (task close design, taken 2026-05-08T13:21:40Z)
  Reconcile (tmux NOT rolled back):
    agents pruned (DB row → dead pane) : 0
    orphan panes surfaced              : 0
  $ mu undo --yes                        # roll forward (undo of undo)
  Restored snapshot #2 (pre-restore of snapshot 1, taken ...)
  ```

  Three verbs, one substrate:
  - **`mu undo [--yes] [--to <id>]`** — default restores the
    latest snapshot; `--to N` picks one. Confirmation gate
    mirrors `mu workstream destroy --yes`: dry-run prints the
    summary + the explicit "tmux NOT rolled back" warning;
    `--yes` commits. Post-restore, every workstream is
    reconciled (best-effort per-workstream) and the
    ghost-pruned / orphans-surfaced counts go in the output so
    the user knows where DB-vs-tmux drift now lives.
  - **`mu snapshot list [-n N] [--json]`** — newest-first table
    with `id | label | workstream | created_at | size`. Defaults
    to 20 rows; `-n` overrides.
  - **`mu snapshot show <id> [--json]`** — one snapshot's full
    metadata (label, workstream, schema_version, db_path, size,
    created_at).

  No `mu redo`. The design (note #293) rejected it explicitly:
  mu verbs have side effects (tmux pane kills, `git worktree
  remove`, etc.) that aren't replayable. Undo-of-undo falls out
  for free — each restore captures a pre-restore snapshot
  first, so re-running `mu undo` rolls forward to that
  snapshot. Verified end-to-end on the smoke run above.

  Typed errors map cleanly through `cli.ts`'s `handle()`:
  - `SnapshotNotFoundError` → exit 3 (not found)
  - `SnapshotVersionMismatchError` → exit 4 (conflict)
  - `SnapshotFileMissingError` → exit 5 (substrate)

  One captureSnapshot fix surfaced live during this work: the
  row's `db_path` was being UPDATEd AFTER `VACUUM INTO`, which
  meant the snapshot file captured the row with `db_path=''`.
  Restoring it lost the path. Reordered to UPDATE then VACUUM;
  the snapshot now contains the correct path on its own row.
  Caught by the first round-trip smoke test on snap_undo_verb.

  Tests: 16 new in `test/cli-snapshot.test.ts` (no-snapshots
  friendly path; bad-id exit 3; dry-run is non-destructive;
  --yes round-trips a `task close`; second --yes rolls forward;
  list/show shape across human + JSON; -n cap). 33 existing
  snapshot tests still green. **Gate green.**

  Closes `snap_undo_verb`. `snap_destroy_safety` (soften the
  `mu workstream destroy` confirmation text) and `snap_docs`
  are now unblocked.

- **Snapshots + auto-capture before destructive verbs (schema v4).**
  Closes `snap_schema` in roadmap-v0-2 (designed in `snap_design`
  by worker-1, note #293; impl by worker-1 in their
  ~/.local/state/mu/workspaces/roadmap-v0-2/worker-1 worktree;
  merged via patch). Lays the substrate for `mu undo` /
  `mu snapshot list` (snap_undo_verb, next).

  How it works
  - Each destructive verb (workstream destroy, agent close, task
    close/reject/defer/release/delete, workspace free, approve
    grant/deny/timeout) now opens with a `captureSnapshot()`
    call. The snapshot is a whole-DB SQLite copy via `VACUUM INTO`
    (synchronous; no async refactor needed; FK-page-level atomic).
  - Files land in `<dirname(db-path)>/snapshots/<id>.db` (flat;
    one autoincrement id; colocated with the DB they back so
    tests sharing `~/.local/state/mu/snapshots/` don't collide).
  - One sidecar `snapshots` table indexes them: `(id, workstream,
    label, db_path, schema_version, created_at)`. NO FK on
    `workstream` — destroying a workstream must NOT cascade-delete
    its pre-destroy snapshot (the whole point).
  - Capture-at-the-verb-wrapper, not inside `setTaskStatus`: a
    `--cascade reject` produces ONE snapshot per user invocation,
    not N per cascaded child. Reconcile / test plumbing that calls
    `setTaskStatus` directly stays unsnapshotted.
  - GC opportunistic in-hook: keep <14 days OR <100 rows,
    whichever permissive. No daemon, no `--gc` verb.
  - Schema-version stamp per row enables version-check on restore
    (`mu undo` will reject cross-version restores; migrations are
    forward-only).

  Five honest deviations from the design (each documented in
  task note):
  1. `VACUUM INTO` instead of `db.backup()` (sync vs async —
     spares an SDK-wide async refactor; identical on-disk shape).
  2. `snapshotsDir(db)` colocates snapshots with the live DB (not
     a single global dir) so per-test isolation works.
  3. Pre-unlink stale snapshot files before `VACUUM INTO` (handles
     the abandoned-timeline-after-restore case).
  4. Re-stamp the pre-restore snapshot row into the post-restore
     DB (otherwise it vanishes the moment we file-swap, breaking
     the undo-of-undo invariant from the design).
  5. Hooks at the verb wrapper, not inside `setTaskStatus` (so
     `--cascade` produces one snapshot, not N).

  SDK in `src/snapshots.ts` (522 LOC, 288 non-comment):
  - `captureSnapshot(db, label, workstream?)`
  - `listSnapshots(db, opts?)`
  - `restoreSnapshot(db, id)`
  - `gcSnapshots(db)`
  - `snapshotsDir(db?)` / `snapshotFileSize(snapshot)`
  - 3 typed errors (`SnapshotNotFoundError`,
    `SnapshotVersionMismatchError`, `SnapshotFileMissingError`)
    all implementing `HasNextSteps`.

  Migration `v3 -> v4`: additive, just one CREATE TABLE +
  CREATE INDEX. Existing v1 -> v2 -> v3 migration chain still
  works.

  Tests: 33 new in `test/snapshots.test.ts` (capture round-trip;
  GC honours both caps; whole-DB integrity; cross-version
  restore rejected; restore-then-list shows the pre-restore
  snapshot; cascade behaviour produces one snapshot per verb,
  not per child). `test/db.test.ts` table-count assertions
  bumped 8 -> 9. **683 tests pass; gate green.**

  Live verified on the live DB:

  ```
  $ mu sql 'SELECT version FROM schema_version'
  4                              # migrated cleanly
  $ mu task close temp_snap_test -w mufeedback
  $ ls ~/.local/state/mu/snapshots/
  1.db
  $ mu sql 'SELECT id, label, schema_version FROM snapshots'
  1 | task close temp_snap_test | 4
  ```

  Closes `snap_schema`. `snap_undo_verb` (mu undo / mu snapshot
  list) is now ready and the SDK + typed errors it consumes are
  in place.

- **Pane border + composed pane title carry mu's interpreted state.**
  Closes `hud_visual_cue_design` + `hud_visual_cue_impl` in the
  `roadmap-v0-2` workstream. Two complementary signals shipped
  together; one is tmux chrome, the other is the pane title.

  **Border (chrome).** `mu workstream init` now sets
  `pane-border-status=top` and `pane-border-format=' [mu] #{pane_title} '`
  on every window in the `mu-<ws>` session. `mu agent spawn` and
  `mu adopt` apply it to their freshly created/adopted windows. The
  options are window-scoped in tmux (a documented gotcha:
  set-option on a session target only updates the active window;
  windows created later inherit from the GLOBAL value, which we
  must NOT touch). The border is one row of vertical real estate
  per pane and survives copy-mode + scroll. Opt-out via
  `MU_BANNER_QUIET=1`.

  Per-session override means dotfile-curated tmux configs are
  untouched: only `mu-<ws>` sessions get the border; everything
  else stays at the user's global default. Confirmed against a
  254-line opinionated tmux.conf with custom `pane-border-style`,
  `status-right`, `window-status-format`, and TPM plugins.

  **Title (state-carrying).** mu now composes the pane title from
  current DB state and refreshes after every state-touching verb:

  ```
  worker-a                            # spawning (initial)
  worker-a · 💤                         # idle, no claim
  worker-a · ⚙️                          # busy, no claim
  worker-a · ⚙️ · build_x                # busy, owns one task
  worker-a · 💤 · build_x                # needs_input, owns one task
  worker-a · 🛂 · build_x                # needs_permission
  worker-a · ✅                          # free, no claim
  worker-a · ⚙️ · ⊕2 tasks              # multi-claim case
  ```

  Refresh hooks: `cmdSpawn`, `cmdAdopt`, `cmdFree`, `cmdClaim`,
  `cmdTaskRelease`, `cmdTaskClose`, `cmdTaskReject`,
  `cmdTaskDefer`, and `reconcile`. Reconcile **always** refreshes
  (not just on detected status change) so inner CLIs that
  self-set their pane title (pi, pi-meta, vim) get overwritten
  with mu's composed title on the next `mu state`/`mu agent list`.

  Agent name MUST remain the first ` · `-separated token so the
  pane-title-as-identity claim-protocol fallback keeps working.
  New `parseAgentNameFromTitle()` helper (and `currentAgentName()`
  convenience wrapper) handle both shapes (composed: take first
  token; legacy/adopted: return as-is). `adoptAgent` uses the
  parser too — re-adopting a pane mu previously owned now works
  (was failing because `agent-name · ✅` failed `isValidAgentName`).

  Truncation: 64-char cap; agent name preserved at the start.

  Refresh is best-effort — a tmux failure never blocks the
  calling verb (titles are decorative; the DB is authoritative).

  Tests: 13 new (composeAgentTitle: 6 cases covering every
  state-shape combination including multi-task compression and
  truncation; parseAgentNameFromTitle: 3 cases including legacy
  pane back-compat; enableMuPaneBorders: 1 verifies the `-w` flag
  is set; existing `MU_SPAWN_LIVENESS_MS=0` test re-scoped from
  no-display-message to no-capture-pane since
  `getWindowIdForPane` legitimately uses display-message).
  633 tests total.

  Live verified end-to-end against 3 real pi-meta workers in
  workspaces:

  ```
  $ mu task release demo_build_x -w borderdemo
     -> worker-a's title drops '· demo_build_x'
  $ mu task claim demo_build_x --for worker-b -w borderdemo
     -> worker-b's title gains '· demo_build_x'
  $ mu task close demo_build_x -w borderdemo
     -> worker-b's title drops the task suffix
  ```

- **Status detector recognises Braille spinner glyphs as busy
  (covers pi-meta + every TUI wrapper).** Filed in roadmap-v0-2
  `bug_status_detector_pi_solo_misclassifies` after the
  multi-agent dogfood: 3 workers spawned with
  `--command pi-meta --solo-name <X> --solo-force` all reported
  `needs_input` while actively grinding (scrollback showed
  `⠋ Working...`).

  Root cause: `src/detect.ts` looked for the literal
  `'to interrupt)'` in the pane tail; pi-meta's solo-wrapped
  chrome doesn't render that exact string. Falls through to
  `needs_input`. SKILL.md acknowledged this category
  ('Status detection lags with custom --command wrappers') but
  there was no fix.

  Fix (~5 LOC, regex `/[\u2800-\u28FF]/`): if no permission
  pattern and no `'to interrupt)'` literal matched, fall back to
  'any Unicode Braille block character in the tail = busy'.
  Every TUI spinner library worth using cycles a subset of these
  glyphs (⠇⠏⠙⠧⠷⠿⠟⠋…); they essentially never appear
  in agent prose, so the false-positive risk is negligible. The
  fallback is wrapper-agnostic — no per-CLI patches needed for
  pi-meta, claude-code, codex, or any future TUI runtime.

  Order of precedence preserved: needs_permission > busy literal
  > braille fallback > needs_input. Permission still wins over a
  spinner-AND-dialog scrollback (the dialog is the actionable
  signal).

  Tests: 6 new cases including the actual dogfood scrollback
  fixture, glyph variations across the block, the priority
  ordering, the no-false-positive-on-prose check, and the
  tail-window staleness rule. 622 tests total.

  Live verified: spawned a real pi-meta worker, sent a 'count to
  200' prompt, `mu agent list` correctly shows `busy` (was
  `needs_input` before).

  Closes `bug_status_detector_pi_solo_misclassifies` in the
  `roadmap-v0-2` workstream.

- **`mu task note` Next: hints + --help now teach single-quote
  discipline.** Filed in `mufeedback` notes #256/#257: a worker
  ran `mu task note id "... `prune e` ..."` from a shell;
  backticks were executed by the parent shell before mu saw the
  note, producing 'command not found: prune' and dropping the
  inline code snippets. Repeat offence in the corrective note.

  Three-line fix:
  - `cmdTaskAdd` Next: hint changed from
    `mu task note <id> "..."` to
    `mu task note <id> '...'` with a 'single-quote to defer shell
    expansion' label.
  - Same for `cmdClaim`'s 'Drop a note' Next: hint.
  - `mu task note --help` description gained a sentence:
    "Single-quote the text (or use a quoted heredoc) to defer
    shell expansion of \$VAR / \$(...) / backticks; double
    quotes expand them in your shell before mu sees the note."

  The skill already documented this; the gap was that the
  CLI's own self-documenting hints kept showing the unsafe form,
  so even agents who'd read the skill would see
  `mu task note ... "..."` printed as the canonical recipe and
  copy that form. Closing the loop: the hints now match the
  guidance.

  Closes `nit_task_note_shell_metachar_hint` in the `mufeedback`
  workstream.

- **Task states gain `REJECTED` and `DEFERRED`; new verbs
  `mu task reject` / `mu task defer`.** Two real mufeedback tasks
  (`git_workspaces_start_without_node` = wontfix; `nit_no_task_move_verb`
  = not justified yet) didn't fit `CLOSED`. Closing them as a
  workaround would lie in the audit trail ("completed work" view
  would count them as ships).

  Schema v2 -> v3:
  - `tasks.status` CHECK widened to include `REJECTED` and
    `DEFERRED`.
  - `goals` view excludes them too (only OPEN / IN_PROGRESS leaves
    are 'goals we're working toward').
  - `ready` / `blocked` views unchanged: only CLOSED satisfies a
    `--blocked-by` edge — REJECTED and DEFERRED still BLOCK
    downstream by design (see TaskHasOpenDependentsError below).
  - Live DB migrated cleanly (no rows changed; only schema +
    view).

  Predicate matrix (the design constraint that fixes the state
  count at exactly 5):

  | state       | active | blocks ↓ | terminal |
  |-------------|--------|----------|----------|
  | OPEN        | y      | y        | n        |
  | IN_PROGRESS | y      | y        | n        |
  | CLOSED      | n      | n        | y        |
  | REJECTED    | n      | y        | y        |
  | DEFERRED    | n      | y        | n        |

  CLI:
  - `mu task reject <id> [--cascade] [--evidence ...]` — terminal
    'won't do' (out of scope, duplicate, wontfix).
  - `mu task defer <id> [--cascade] [--evidence ...]` — parked,
    may revisit. Reopen with `mu task open`.

  SDK: `rejectTask` / `deferTask` exported from src/tasks.ts; both
  share `RejectDeferOptions` (`evidence`, `cascade`) and return
  `RejectDeferResult` (`changedIds`, `status`, `changed`).

  Stranded-dependent guard: rejecting/deferring a task with OPEN
  or IN_PROGRESS dependents throws `TaskHasOpenDependentsError`
  (exit 4) listing the dependents and three resolutions: pass
  `--cascade` to apply the same status to the whole sub-tree,
  drop the now-irrelevant blocking edge first with
  `mu task unblock <dep> --not-blocked-by <id>`, or
  reject/defer dependents individually first.

  Cascade walk PRUNES at CLOSED / REJECTED / DEFERRED nodes: a
  CLOSED intermediate has already satisfied its blocked-by edge,
  so its downstream is independent of `<id>` and must NOT be
  swept. (Unit-tested: `--cascade DEFERRED` on `design` with a
  CLOSED `build` and OPEN `ship` leaves `ship` alone.)

  `listTasksByOwner` default tightened from `status != 'CLOSED'`
  to `status NOT IN ('CLOSED','REJECTED','DEFERRED')`. The 'live
  work' view should not include 'won't do' or 'parked' work.
  `includeClosed: true` re-includes ALL terminal/parked statuses.

  Tests: 12 new cases covering happy path, idempotency, the
  stranding refusal, all status transitions in the predicate
  matrix (only-CLOSED-unblocks), and `--cascade` semantics
  including the prune-at-closed property. 616 tests total.

  Closes `git_workspaces_start_without_node` (REJECTED — not
  mu's job to seed pnpm/cargo/pip deps; that's a project-level
  setup script or first task instruction) and
  `nit_no_task_move_verb` (DEFERRED — the `mu sql` workaround
  works; ~80 LOC of new typed-verb surface not justified by
  current friction. Promotion criteria documented on the task.)

- **`mu workstream destroy` now actually cleans workspaces.** Filed
  in `mufeedback` note #195: destroying a workstream killed the
  tmux session and cascade-deleted every DB row but left the
  per-agent on-disk worktrees behind, plus the git worktree
  registry entries pointing at them. Surfaced after closing a
  14-task workstream with 3 historical worktrees — every one had
  to be cleaned by hand with `git worktree remove --force`.

  - `summarizeWorkstream` now returns `workspaces: number` and
    `registered: boolean`. Both surface in the destroy dry-run
    and final summary.
  - `destroyWorkstream` enumerates `vcs_workspaces` for the
    target workstream and calls each row's backend
    `freeWorkspace()` before the FK cascade nukes the rows.
    Return type gains `freedWorkspaces: number` and
    `failedWorkspaces: WorkspaceFailure[]` so the CLI can surface
    paths + recovery hints when (e.g.) `git worktree remove`
    refuses because of uncommitted changes.
  - Empty `<state>/workspaces/<ws>/` parent dir is reaped via
    `rmdir` after every per-agent worktree is freed (best-effort:
    refuses if non-empty, which is the right outcome).
  - `cmdDestroy`'s `nothingToDo` short-circuit factored
    `summary.registered` in. The earlier behaviour treated
    bare-registry workstreams (a row in `workstreams` with 0
    agents/tasks/notes) as 'nothing to destroy' and refused to
    clean them — making such rows orphaned forever. Two such
    rows on the live DB (`temp_confirm_a/b` from earlier
    `--confirm-rows` testing) were unreachable until this fix.

  Net diff: 178 insertions across 4 files (workstream.ts +75,
  cli.ts +25, index.ts +1, workstream.test.ts +60). Live
  verified end-to-end (sh + git workspace) and on the two live
  orphan rows.

  Closes `workstream_destroy_yes_leaves_workspace` in the
  `mufeedback` workstream.

- **`skills/mu/SKILL.md` second terseness pass: 701 -> 574 LOC**
  (−18% on top of the earlier 771 -> 701 trim, −26% total since
  the last trim). User feedback: "keep it terse and to the point.
  Just the point."

  Cuts:
  - Orchestrator loop reduced from prose-heavy 7-step + sub-bullets
    to 6 numbered lines.
  - Default workspace rule + workspaces-stop-trampling: dropped
    `~/hacking/repo/...` and `target/` / `node_modules/.cache/`
    examples; the why is generic, the example is project-specific.
  - Plan + spawn a crew: project-name examples (`payments`,
    `infer-rs`) replaced with `<ws>`.
  - Parallel heavy-task + read-only audit: dropped storytelling
    ("Maps directly to the most common parallelisation shape");
    kept the actual safety-belt point.
  - Status section: cut the "reconcile fresh from scrollback"
    explanation; the four-line code block carries the point.
  - After spawning, observe: collapsed three-section three-pattern
    explanation into one block of three commented examples.
  - When you need to wait: dropped duplicate semantics paragraph
    (now lives in `mu task wait --help`).
  - Working loop: 25-line annotated script -> 8-line minimal
    script; comments only mark phase boundaries.
  - DOs / DON'Ts: removed the explanation paragraphs after each
    bullet (the bullet is the point).

  Kept: the multi-verb composites, the actually-load-bearing
  vocabulary, the irreducible-discipline orchestrator loop, the
  approval-pattern code, the `mu task wait` quick examples.

  No project-specific names in examples (`<ws>` placeholder used
  consistently). Only exception: the rename-recovery `mu sql`
  example uses `auth-refator` deliberately because the typo IS
  the point.

  Closes `skill_nudge_prompt_agents_with_relative` in the
  `mufeedback` workstream (added the relative-paths nudge as part
  of this trim).

- **Agent identity propagates to task notes; spawn output surfaces
  `--command` overrides.** Two related UX nits from the
  `mufeedback` workstream addressed in one pass.

  - `mu task note` author was always `<orchestrator>` even from
    spawned-agent panes (mufeedback note #176). Now resolves via
    `resolveActorIdentity()`: `$MU_AGENT_NAME` (the env var
    injected at spawn by `f3d4bdd`) > pane title > `$USER` >
    `'orchestrator'`. Pass `--author <name>` to override.

    Same helper now powers `mu task claim --self`'s actor
    resolution; the `--self` default fallback changed from
    `'unknown'` to `'orchestrator'` for symmetry. The `'unknown'`
    label was a placeholder; `'orchestrator'` is meaningful.

  - `mu agent spawn` output read `Spawned X (pi)` even when
    `--command pi-meta --no-solo` overrode the binary
    (mufeedback note #159). Now reads
    `Spawned X (pi (cmd: pi-meta --no-solo))` when the resolved
    command differs from the cli value; bare `(pi)` when running
    the default. JSON gains `resolvedCommand` and
    `commandOverridden` fields.

  Resolution chain matches `spawnAgent`'s actual behaviour:
  explicit `--command` > `$MU_<UPPER_CLI>_COMMAND` > the cli value
  itself. The display logic reuses the existing
  `resolveCliCommand` SDK function so display + actual-spawn stay
  in sync.

  Tests: 4 new cases for `resolveActorIdentity` covering each
  step of the resolution chain; 1 existing claim test updated
  for the new default. 601 tests total.

  Closes `nit_agent_note_author_identity` and
  `nit_spawn_custom_command_display` in the `mufeedback` workstream.

- **Workspace-recovery flow no longer bubbles bare backend errors.**
  Two related user-reported bugs from the `mufeedback` workstream
  (notes #143 + #145) addressed in one cohesive pass:

  - `WorkspacePathNotEmptyError` (typed, exit 4) replaces the bare
    `vcs <name>: workspacePath already exists: <path>` from each
    backend. Fires when `createWorkspace` finds the on-disk dir
    occupied with no DB row — the orphan-from-older-mu case, OR a
    user who manually `rm -rf`'d the dir while a stale registration
    persists.

    `errorNextSteps()` lists three concrete recovery commands:
      mu workspace free <agent> -w <ws>   (if a row remains)
      rm -rf <path>                        (if just orphaned dir)
      cd <project-root> && git worktree prune   (git-specific)

  - `gitBackend.createWorkspace` runs `git worktree prune`
    defensively BEFORE `git worktree add`. Cheap (~10ms), idempotent.
    Immunises against the 'missing but already registered worktree'
    failure mode that previously required manual operator recovery
    (`cd <main-repo> && git worktree prune`). Now automatic; no
    operator intervention.

  Combined with `cccba88` (`mu agent close` refuses with workspace),
  the natural recovery flow JUST WORKS end-to-end:

      $ mu agent spawn worker -w foo --workspace
      $ mu agent close worker -w foo
      conflict: agent worker has a workspace at /path; refusing to close
      Next: ... mu workspace free worker ... mu agent close --discard-workspace
      $ mu workspace free worker -w foo
      $ mu agent close worker -w foo
      $ mu agent spawn worker -w foo --workspace    # works; defensive prune handles git

  Surfaced as `agent_spawn_workspace_fails_when_prior` (note #143)
  and `workspace_free_cleanup_leaves_git` (note #145) by another mu
  user; both closed in this commit. The first user-reported bug
  (`agent_close_orphans_workspace_dir_from`, note #144) was a
  duplicate of `bug_workspace_orphaned_after_agent_close` shipped
  in cccba88; closed with cross-references.

  Tests:
    - `test/workspace.test.ts`: WorkspacePathNotEmptyError
      regression case (raw orphan via DELETE FROM vcs_workspaces +
      verify typed error fires); gitBackend defensive-prune case
      (rm-rf the workspace dir then re-create at same path; verify
      the second create succeeds where it would have failed pre-fix).
    - `test/error-nextsteps.test.ts`: WorkspacePathNotEmptyError
      added to the generic well-formed-steps registry.
  597 tests total.

- **`mu agent close` refuses by default if the agent has a workspace.**
  Surfaced during the multi-agent dogfood teardown: closing three
  worker agents silently orphaned their on-disk workspaces (the FK
  CASCADE drops the `vcs_workspaces` registry row but the directory
  survives, invisible to every subsequent `mu workspace list / free /
  path` call).

  New behaviour: if the agent has a workspace, `mu agent close` throws
  `WorkspacePreservedError` (exit 4 conflict) with three actionable
  resolutions:

      conflict: agent worker-a has a workspace at /path/to/ws;
        refusing to close (would orphan the on-disk dir)
      Next:
        Free the workspace first (preserves agent for next step) :
          mu workspace free worker-a  (--commit to commit pending changes first)
        Or close + discard the workspace in one shot (lossy)     :
          mu agent close worker-a --discard-workspace
        Or just inspect what's in the workspace                  :
          cd /path/to/ws

  The `--discard-workspace` flag (and SDK `closeAgent(db, name,
  { discardWorkspace: true })`) frees the workspace BEFORE deleting
  the agent (we control the order; FK cascade no longer leaks the
  on-disk dir). Lossy: pending changes in the workspace are gone
  unless the caller frees with `mu workspace free --commit` first.

  Backwards compat: agents WITHOUT a workspace close exactly as
  before. Existing tests + scripts that closed agents with no
  workspace are unaffected. The SDK signature gained an optional
  second arg `opts: CloseAgentOptions` so `closeAgent(db, name)`
  remains valid.

  `CloseAgentResult` gained a `workspaceFreed: boolean` field; the
  legacy `workspaceKept` field is preserved (always `false` on the
  success paths now) so callers branching on it don't break.

  Tests: 4 cases in `test/workspace.test.ts` covering the four
  outcomes (refuse-default, --discard succeeds + frees, no-workspace
  agent closes cleanly, no-such-agent returns false flags) plus the
  generic `errorNextSteps` shape check in `test/error-nextsteps.test.ts`.
  594 tests total.

  Closes `bug_workspace_orphaned_after_agent_close` in workstream
  `roadmap-v0-2`. Surfaced as note #122 during the same dogfood
  that motivated `mu task wait` and `bug_status_detector_pi_solo_misclassifies`.

- **`mu task wait <ids...>` blocks until tasks reach a status.**
  The orchestrator's most common wait pattern, finally first-class.
  Before this verb, multi-task waits were a 30+ line bash+python+sql
  polling loop hand-rolled by the orchestrator; the
  `mu log --tail | awk '...'` pattern only handled ONE task because
  the awk script becomes stateful for N.

  Behaviour:

      mu task wait <id> [<id>...] [--status CLOSED] [--any]
                       [--timeout SECONDS] [-w <ws>] [--json]

  - Default: every listed task must reach `--status` (default CLOSED).
  - `--any`: succeed as soon as ONE listed task reaches the status.
    Useful for parallel-race patterns ('act on the first worker done').
  - `--timeout SECONDS` (default 600 = 10 min). 0 = forever (matches
    `mu approve wait`).
  - Exit 0: condition met. Exit 5: timeout (mirrors `mu approve wait`).
  - Exit 3: any listed task doesn't exist (TaskNotFoundError pre-flight,
    loud-fail by design — a typo'd id silently waiting forever is
    the worst-case UX).
  - `--json`: emits a structured result with per-task state + the
    `allReached` / `anyReached` / `elapsedMs` / `timedOut` flags +
    `nextSteps` hints ("investigate <id>" for laggards on timeout).

  Live demo:

      $ mu task wait closed_task open_task --timeout 3
      Timed out after 3003ms
        ✓ closed_task (CLOSED)
        • open_task (OPEN)
      Next:
        Investigate open_task (status=OPEN) : mu task show open_task -w roadmap-v0-2
      exit: 5

      $ mu task wait closed_task --json
      {"tasks":[{"localId":"closed_task","status":"CLOSED","reachedTarget":true}],
       "allReached":true,"anyReached":true,"elapsedMs":0,"timedOut":false,...}

  Implementation: `waitForTasks(db, ids, opts)` SDK in `src/tasks.ts`
  mirrors `waitApproval`'s shape exactly. Initial check (immediate
  return if already satisfied) + 1s poll loop on the tasks table. We
  poll the table directly rather than subscribing to `agent_logs`
  because (a) we'd still need to re-query tasks to learn the current
  status, (b) some status changes happen via `mu sql` which doesn't
  emit events, and (c) one indexed SELECT every second is cheaper
  than parsing the log stream.

  Coordination patterns now have clean separation — each pattern
  owns its niche, no overlap:

      Want                                          | Use
      ----------------------------------------------|----------------------
      Block until task(s) reach status X            | mu task wait ← NEW
      Stream all events as they happen              | mu log --tail
      Block until human grants/denies an approval   | mu approve wait
      Per-agent narrative with status transitions   | hand-rolled poll (rare)

  SKILL.md (§ 'After spawning, observe') is rewritten around the
  three-pattern split. The previous awk-pipe pattern is gone from
  the canonical examples; it remains a valid fallback for ad-hoc
  one-event waits but is no longer the recommended approach.

  Tests: 10 cases in `test/tasks.test.ts` covering immediate-return,
  block-until, timeout, `--any`, non-default status, missing-task,
  empty-list, partial-progress timeout, and survives-mid-wait-deletion.
  592 tests total.

  Closes `nit_no_mu_task_wait` in workstream `roadmap-v0-2`.

- **Spawned agent panes inherit identifying env vars** (`MU_MANAGED_AGENT=1`,
  `MU_AGENT_NAME=<name>`, `MU_WORKSTREAM=<name>`) so anything running
  inside (pi extensions, claim-protocol scripts, status segments) can
  branch on 'I'm a mu-managed worker' vs 'I'm a regular interactive pi'
  without scraping pane titles or hitting the DB.

  How it works: tmux 3.0+ supports `-e KEY=VALUE` (repeatable) on
  `new-session`, `new-window`, and `split-window`. The env is set in
  the new pane's environment only — no global tmux server pollution.
  All four pane-creating helpers in `src/tmux.ts` (`newSession`,
  `newSessionWithPane`, `newWindow`, `splitWindow`) gain an optional
  `env?: Record<string, string>` field. Validation: keys must be
  non-empty and must not contain `=` (TypeError otherwise; tmux's own
  error in that case is obscure).

  `spawnAgent` builds the env once and threads it through
  `createOrReusePane` to whichever path fires:

      const paneEnv: Record<string, string> = {
        MU_MANAGED_AGENT: "1",
        MU_AGENT_NAME: opts.name,
        MU_WORKSTREAM: opts.workstream,
      };

  Verified live (the spawned shell's `env` dump):

      MU_AGENT_NAME=env_test_2
      MU_WORKSTREAM=env_smoke2
      MU_MANAGED_AGENT=1

  And `tmux show-environment -g` is untouched (no global pollution).

  Not exposed via `SpawnAgentOptions` — mu identity is not
  user-tunable. Adding a new key here is one line and applies to
  every spawned pane automatically.

  Tests: 6 unit cases in `test/tmux.test.ts` (env-flag emission +
  ordering before the command + key-validation TypeError) and 3
  integration cases in `test/verbs.test.ts` (one per spawn path:
  fresh session, new window in existing session, split into existing
  window). 582 tests total.

  Closes `pass_mu_env_to_panes` in workstream `roadmap-v0-2`.

- **Auto-generated task IDs trim at a 40-char word boundary**
  (was: hard-truncate at 64 chars). `mu task add --title "NIT:
  this is exactly the kind of title that produces a 60-plus
  char auto-id"` now yields `nit_this_is_exactly_the_kind_of_title`
  (37 chars) instead of the previous 60+ char truncation. Easier
  to type and to read in `mu task tree`/list output.

  How it works: `slugifyTitle` does the existing alnum-to-`_`
  collapse, then if the result exceeds the **40-char soft cap**,
  cuts at the last `_` at-or-before that position (preserving
  word boundaries). Falls back to a hard 40-char truncate if the
  title is one giant word with no separators. The collision-suffix
  loop in `idFromTitle` (`_2`, `_3`, ...) still respects the
  **64-char hard ceiling** so collisions never exceed the original
  cap.

  No schema change; this is purely a slug-generation tweak. The
  hard cap on the schema column is unchanged. Existing IDs in DBs
  are untouched (the truncation only happens at slug-derivation
  time).

  Closes `nit_long_auto_slug` in workstream `roadmap-v0-2`.

- **`mu sql` accepts multi-statement scripts** (BEGIN/COMMIT
  blocks, semicolon-separated batches, top-level migrations).
  Previously, `prepare()` rejected anything with more than one
  statement, forcing N invocations for any cleanup or migration
  script.

  How it works: `cmdSql` first probes via `db.prepare(query)`. If
  better-sqlite3 throws `'more than one statement'`, the verb
  falls back to `db.exec(query)` which runs the script verbatim
  (BEGIN/COMMIT honoured). The single-statement path is
  unchanged — still reports row counts for writes, structured
  rows for reads.

  Multi-statement output:

      $ mu sql "BEGIN; INSERT INTO t VALUES(1); INSERT INTO t VALUES(2); COMMIT;"
      ran 4 statements

      $ mu sql "..." --json
      {"statements":4,"multiStatement":true}

  The statement count comes from a hand-rolled
  `countTopLevelStatements()` that respects single-quote / double-
  quote / line-comment / block-comment / SQL-escape contexts when
  splitting on `;`. Pure function, exported from `src/cli.ts`,
  covered by 13 unit tests in `test/sql-multi-statement.test.ts`.

  Surfaced via `nit_sql_multi_statement` (note #96) when the
  v0.1.0 dot-mangle workstream-rename recipe required N
  invocations to do an UPDATE-then-cleanup. Now it's one shot.

  Closes `nit_sql_multi_statement` in workstream `roadmap-v0-2`.

- **`skills/mu/SKILL.md` trimmed 771 -> 659 LOC** (−14%) now
  that per-verb tips live in verb output. Final commit of the
  selfdoc track. Specific cuts:
  - CLI verb list collapsed to one-liners (every per-flag
    commentary deferred to `mu <verb> --help`).
  - `### Evidence on lifecycle verbs` (12 LOC) -> one bullet in
    new `Universal flags worth knowing without --help` block.
  - `### Machine-readable output: --json` (~25 LOC) -> one bullet
    in same block.
  - `### Picking the spawned executable` (~25 LOC) -> deleted
    entirely (covered by `mu agent spawn --help`).
  - `### Picking model + thinking effort per agent` tightened
    (~37 -> 18 LOC); rubric kept, env-var examples condensed.
  - `### Tear down a workstream` collapsed (~13 -> 6 LOC); the
    `mu workstream destroy` output now hints `--yes`.
  - `### Drop durable context on a task` (~10 LOC) -> deleted
    (the task-note contract section above already covers it).
  - `## If you ARE the agent` orchestrator-pattern subsection
    rewritten to defer to `ClaimerNotRegisteredError`'s
    `errorNextSteps()` for the three actionable resolutions.
  - SQL section header updated: 8 tables -> 9 tables (was stale
    after the v2 schema_version table landed).

  What stayed (irreducible LLM-only context): vocabulary, when to
  reach for mu, mental model, orchestrator loop discipline, the
  multi-verb common patterns (parallel work, quote-rich prompts,
  status approximation, subscribe-vs-poll, irreversible-needs-
  approval, when to wait for another agent), DOs / DON'Ts, what
  mu is NOT.

  `docs/USAGE_GUIDE.md § 2` gains a paragraph explaining the
  self-documenting verb output (Next: hints, --json everywhere,
  the `mu agent attach` opt-out).

  Closes selfdoc_skill_cleanup in workstream `roadmap-v0-2`. The
  whole selfdoc_* track is now complete; only `selfdoc_dogfood`
  remains (a fresh-agent walkthrough validating that verb output
  alone is sufficient to drive a plan/spawn/claim/note/close cycle).

- **Every CLI verb accepts `--json` (universal); every write verb
  carries `nextSteps` hints in both human + JSON output.** Third
  commit of the selfdoc track. Combined `selfdoc_verbs_round2` and
  `selfdoc_json_universal` (filed mid-session as a complementary
  task) into one pass since both touch every cmd handler.

  Verbs that gained `--json` (22 total): `mu workstream init /
  destroy`, `mu agent spawn / send / read / close / free`,
  `mu workspace create / free / path`, `mu task note / open /
  block / unblock / delete / update / reparent`, `mu approve grant
  / deny`, `mu sql`, `mu doctor`. The remaining read verbs already
  had `--json` from v0.1.0; this commit closes the write-verb gap.

  `mu sql --json` distinguishes:
  - Read query (SELECT / WITH / EXPLAIN) — emits the rows array.
  - Write query (UPDATE / DELETE / INSERT) — emits
    `{ changes, lastInsertRowid }`.
  - Errors from SQLite (e.g. `no such column`) flow through the
    standard structured-error path to stderr, exit 1.

  `mu doctor --json` returns a fully structured
  `{ environment, db, workstream, state }` report with per-subsystem
  status fields (`schemaVersion: { value, expected, status }`
  etc.). Pipe to jq, alerts, monitoring — no prose parsing.

  Verbs that gained `nextSteps` hints (in addition to the 8 from
  selfdoc_infra): `mu agent send / free`, `mu workspace create /
  free`, `mu task note / open / block / unblock / delete / update
  / reparent`, `mu approve add` (revised hints; existing prose
  retained), `mu workstream destroy`. With selfdoc_infra’s 8, that
  makes 19 verbs with self-documenting nextSteps. Read verbs and
  status-only verbs (mu state, mu agent list, etc.) deliberately
  don't carry nextSteps — the result IS the next-step.

  One verb stays text-only on purpose: `mu agent attach` prints a
  `tmux attach` command for a human to copy-paste; no
  machine-actionable output. Documented in the regression test
  allowlist.

  New regression test (`test/cli-json-universal.test.ts`) parses
  `src/cli.ts` and asserts every `.command(...).action(...)` block
  contains either `JSON_OPT` or a literal `"--json"` option (or is
  in the documented allowlist with a reason). Adding a new verb
  without `--json` now breaks the build. 544 tests total (+3 from
  the regression test).

  Friction surfaced and filed mid-commit: `nit_blocks_flag_naming`
  — the `--blocks <X>` flag on `mu task add` reads as outgoing in
  English ("this task blocks X") but is incoming in semantics
  ("X blocks this task"). Filed as a NIT; first occurrence, awaiting
  promotion.

  Closes selfdoc_verbs_round2 + selfdoc_json_universal in workstream
  roadmap-v0-2. Last impl piece before selfdoc_skill_cleanup.

- **Every typed error class carries actionable `errorNextSteps()`.**
  Second commit of the selfdoc track (after the infra commit). The
  bare error message identifies what failed; the structured
  resolutions tell the caller exactly what to try next, in
  expected-frequency order.

  Errors converted to `HasNextSteps`:
  - `TaskNotFoundError`        — list / search / find-the-workstream
  - `TaskExistsError`          — show / update / pick a different id
  - `TaskNotInWorkstreamError` — use actual ws / list expected ws
  - `TaskAlreadyOwnedError`    — see owner's tasks / release / show
  - `CycleError`               — show tree / show prereqs / unblock
  - `CrossWorkstreamEdgeError` — move task / merge ws / duplicate
  - `AgentExistsError`         — find ws / close+respawn / new name
  - `AgentNotFoundError`       — list / list-all / spawn now
  - `AgentNotInWorkstreamError`— use actual ws / list expected ws
  - `AgentDiedOnSpawnError`    — override command / disable liveness / doctor
  - `TmuxError`                — doctor / tmux info / repro the failing tmux call
  - `PaneNotFoundError`        — list-panes -a / mu agent list -w * / orphans
  - `WorkspaceExistsError`     — path / free / re-create
  - `WorkspaceNotFoundError`   — list / list-all / create
  - `ApprovalNotFoundError`    — list / list-all / filter by status
  - `ApprovalAlreadyDecidedError` — show existing / create new
  - `ApprovalNotInWorkstreamError`— use actual ws / list-all
  - `WorkstreamNameInvalidError` — sanitised name suggestion + list

  Several errors compute resolutions from their carried context:
  - `TaskNotInWorkstreamError` shows the actual workstream name
    (not just "the correct one").
  - `WorkstreamNameInvalidError` lowercases + strips `mu-` + replaces
    `.`/`:` with `_` to suggest a working name.
  - `ClaimerNotRegisteredError` (already converted in selfdoc_infra)
    pins the `$TMUX_PANE` id into the literal `mu adopt %<pane>`
    command.

  All resolutions surface in both human-prose stderr (dim indented
  block under "Next:") and JSON-error stderr (`nextSteps` array
  inside the `{error, message, nextSteps, exitCode}` record).

  Tests: `test/error-nextsteps.test.ts` covers all 18 error
  classes with a generic well-formed-steps assertion plus 5 class-
  specific structural assertions (e.g. ClaimerNotRegisteredError
  pins the pane id, WorkstreamNameInvalidError lowercases the
  prefix). 26 new tests; 541 total.

  Bug caught by dogfood during this commit:
  `WorkstreamNameInvalidError` originally matched `^mu-` case-
  sensitively, so `Mu-Foo.Bar` came out as `mu workstream init
  mu-foo_bar` — still invalid (mu- prefix). Fixed to lowercase
  before stripping. Test strengthened to use a mixed-case input.

  Closes `selfdoc_errors` in workstream `roadmap-v0-2`.

- **Self-documenting verb output: `nextSteps` hints + structured
  JSON errors.** Every successful invocation now answers "what
  changed AND what's the natural next step?"; every error answers
  "why AND what are the actionable resolutions?". Same data shape
  feeds both human-prose output (dim text after the success line)
  and `--json` output (structured `nextSteps: [{intent, command}]`).

  - New module `src/output.ts` with `printNextSteps(steps)`,
    `NextStep` type, `isJsonMode()`, and `hasNextSteps()` duck-type
    guard for typed errors carrying actionable resolutions.
  - The error handler in `src/cli.ts` is refactored: errors call a
    typed `errorNextSteps()` (when implemented) and the steps are
    rendered as dim indented lines in human mode or attached to a
    `{error, message, nextSteps, exitCode}` JSON record in
    `--json` mode.
  - `--json` JSON errors go to **stderr** (so stdout stays clean
    for the success-path JSON when piping); the JSON record
    carries the same `exitCode` the process exits with.
  - `ClaimerNotRegisteredError` is the first error converted to
    structured `errorNextSteps()`. Three resolutions in expected
    frequency order: `--self` for the orchestrator pattern,
    `--for <worker>` for dispatch, `mu adopt <pane-id>` for
    registration.
  - First batch of verbs grew next-step hints:
    `mu workstream init` (attach + plan + spawn + state),
    `mu agent spawn` (send + read + watch + close),
    `mu agent close` (workspace-kept hint + re-spawn),
    `mu adopt` (send + read + verify),
    `mu task add` (show + note + block + claim),
    `mu task claim` (note + close + release),
    `mu task release` (reclaim + show),
    `mu task close` (open + next + state).
  - `--json` extended to the four touched write verbs
    (`mu task add / claim / release / close`); each emits a
    success record with `nextSteps`. Read verbs that already had
    `--json` (e.g. `mu task show`, `mu task list`) continue
    unchanged in success mode but now emit structured errors when
    they fail.

  Live before/after for `mu task add`:

      $ mu task add foo --title "Foo" --impact 50 --effort-days 1
      Added task foo (workstream=ws, impact=50, effort=1)
      Next:
        Show this task  : mu task show foo -w ws
        Drop a note     : mu task note foo "..." -w ws
        Add a blocker   : mu task block foo --by <other-id> -w ws
        Claim and start : mu task claim foo -w ws --self  (or --for <worker>)

      $ mu task add foo --title "Foo" --impact 50 --effort-days 1 --json
      {"task": {...}, "blockers": [], "nextSteps": [
        {"intent": "Show this task", "command": "mu task show foo -w ws"},
        ...
      ]}

      $ mu task claim ghost --json   # error path, --json
      {"error":"TaskNotFoundError","message":"no such task: ghost",
       "nextSteps":[],"exitCode":3}
      # (-> stderr; exit 3)

  This is the first commit of the `selfdoc_*` track in workstream
  `roadmap-v0-2`. Follow-ups:
  - `selfdoc_errors`: every typed error gains `errorNextSteps()`.
  - `selfdoc_verbs_round2`: hints + `--json` for the rest of the
    write verbs.
  - `selfdoc_skill_cleanup`: `skills/mu/SKILL.md` shrinks (~770
    -> ~500 LOC) by moving per-verb tips into verb output where
    they belong.
  - `selfdoc_dogfood`: a fresh-agent walkthrough of plan / spawn /
    claim / note / close relying ONLY on verb output.

  See note #108 on the (now-CLOSED) `selfdoc_design` task for the
  full audit and design rationale.

- **`mu task claim --self` for the orchestrator pattern.** Two
  things mu has always conflated: a *worker* (a tmux pane mu
  spawned, with a row in `agents`, identity = pane title) and an
  *actor* (anything that causes a state change — may or may not
  be a worker; orchestrators, scripts, and humans are actors but
  not workers). The v2 schema migration tightened the FK on
  `tasks.owner` to `agents.name`, which exposed the conflation:
  bare `mu task claim` from an orchestrator pane (one not spawned
  by `mu agent spawn`) now had nowhere to write the claim.

  `--self` is the actor's opt-out:
  - `tasks.owner` stays NULL (no FK lookup; no synthetic agents
    row pollution).
  - The actor name is recorded in `agent_logs.source` for the
    auto-emitted `task claim` event — provenance is preserved,
    just attributed to the log instead of the FK column.
  - Resolution order for the actor name: `--actor <name>`, then
    pane title, then `$USER`, then the literal `unknown`.
  - Mutually exclusive with `--for` (they're alternative answers
    to "who's the actor for this claim?").
  - Workers are unaffected — they keep using bare
    `mu task claim` exactly as before. `--self` is opt-in for the
    unregistered-actor case.

  `mu task show` and `mu task show --json` now surface the actor
  for tasks where `owner IS NULL` by scanning recent `task claim`
  events, so 'who's working on this' is answerable from
  `mu task show` alone:

      $ mu task claim foo --self
      Claimed foo (--self by pi-mu; OPEN → IN_PROGRESS; owner=NULL)

      $ mu task show foo
      foo  —  ...
        owner      : (self: pi-mu)
        ...

  The `ClaimerNotRegisteredError` message (shipped in dbfc84d)
  has been updated to list `--self` as the first actionable next
  step, ahead of `--for` and `mu adopt`. Three actionable paths
  for an orchestrator who hits 'not a registered mu agent', in
  order of expected frequency.

  SDK: `claimTask({ self: true, actor?: string })` returns
  `{ owner: string | null, actor: string, ... }`. Existing
  `{ self: false }` callers are unchanged. The `ClaimResult.owner`
  type widens from `string` to `string | null`.

  **Vocabulary update:** `docs/VOCABULARY.md` adds canonical
  entries for **worker** (the registered side of identity),
  **actor** (the party that caused a state change), and
  **anonymous claim** (the `--self` operation). The **owner**
  entry now notes its NULL-on-self semantics. The **adopt** entry
  is updated from "deferred" to its current state.

- **`mu adopt <pane-or-title>` verb.** Register an existing tmux
  pane as a managed mu agent — the inverse of `mu agent list`'s
  "orphan" state. The orphan-list message has been advertising
  this verb since v0.1.0 ("`mu adopt` is on the roadmap"); now
  it ships.

  - Pane id form (`mu adopt %15`) or pane title form
    (`mu adopt worker-2`); both look up the pane and adopt it.
  - Defaults to using the pane's current title as the agent
    name; pass `--name <name>` to override (and retitle the
    pane in the process so the claim protocol invariant holds).
  - Idempotent: adopting the same pane twice is a no-op (returns
    `alreadyAdopted: true` from the SDK).
  - Scope-aware: pane must be in the matching `mu-<workstream>`
    tmux session, otherwise `AgentNotInWorkstreamError` (exit 4).
  - Emits an `agent adopt` event into `agent_logs` so the
    adoption is auditable.
  - SDK: `adoptAgent(db, opts)` in `src/agents.ts`; types
    `AdoptAgentOptions` and `AdoptAgentResult` exported.
  - New typed error `PaneNotFoundError` in `src/tmux.ts` for the
    "pane id doesn't exist on the tmux server" case (exit 5
    substrate).
  - Test cases mirror the design (`adopt_design` task note #100):
    8 unit cases (mocked tmux) + 2 integration cases (real tmux).

  The orphan-list message in `mu agent list` is updated to point
  at the new verb instead of the previous "is on the roadmap"
  copy. The `mu sql 'INSERT INTO agents ...'` workaround is
  removed from USAGE_GUIDE.md § "What's NOT in 0.1.0".

- **`mu task list --status <S>` filter.** Accepts case-insensitive
  `OPEN | IN_PROGRESS | CLOSED`. Invalid values exit 2 with a usage
  error. SDK gains a `ListTasksOptions` interface and an
  `isTaskStatus` type guard, both exported from `src/index.ts`.
  `listTasks` now takes an optional third argument; existing
  two-argument calls are unaffected.

### Fixed

- **`mu task claim` from an unregistered pane gives an actionable
  error instead of bare `FOREIGN KEY constraint failed`.** The v2
  schema migration tightened `tasks.owner`'s FK to `agents.name`,
  which surfaced a latent bug: claims from a pi session that
  wasn't itself spawned by mu (or invoked with `--for <ghost>`)
  failed with the unhelpful raw SQLite error.

  `claimTask` now does a `SELECT 1 FROM agents WHERE name=?`
  pre-check before the atomic CAS UPDATE, throwing a typed
  `ClaimerNotRegisteredError` (exit 4 conflict) when the claimer
  doesn't exist. The error message includes:
  - the resolved claimer name
  - the pane id (when resolved from `$TMUX_PANE`) plus the exact
    `mu adopt %<pane>` command to fix it
  - a fallback hint suggesting `--for` when the name came from
    `--for` itself

  Live before/after on the orchestrator's pane:

      $ mu task claim some-task                    # before v0.1.x
      error: FOREIGN KEY constraint failed

      $ mu task claim some-task                    # after
      conflict: claimer 'pi-mu' (pane %6441) is not a registered
        mu agent (no row in agents table).
        Register this pane with: mu adopt %6441
      exit: 4

  The pre-check adds essentially no overhead (one indexed lookup
  before the existing transactional UPDATE); the atomic CAS
  on `tasks.owner` is preserved end-to-end.

  `ClaimerNotRegisteredError` is exported from the SDK
  (`src/index.ts`) so programmatic callers can distinguish it
  from `TaskAlreadyOwnedError` / `TaskNotFoundError` without
  string-matching.

- **Workstream names with the `mu-` prefix are now rejected at
  init time.** `mu workstream init mu-foo` would have produced
  tmux session `mu-mu-foo` (because mu auto-prepends `mu-` to
  derive the session name). Almost never intended; same
  validation seam as the dot-mangle fix —
  `WorkstreamNameInvalidError`, exit 2, message names the
  resulting double-prefixed session so the gotcha is obvious.

- **Long task titles no longer blow out the terminal.** The
  `mu task list / next / ready / blocked / goals / owned-by`
  table views and the bare `mu` mission-control "Ready" table
  now compute a title-column budget from `process.stdout.columns`
  (default 100 when stdout isn't a TTY) and truncate titles with
  an ellipsis. **The `id` column is never truncated** — IDs are
  what callers copy to issue follow-up commands; titles are what
  callers visually scan. Symmetric with `git log --oneline`'s
  preserve-SHA / truncate-subject convention.

- **Task JSON output now includes `roi`** (impact ÷ effortDays).
  Previously `mu task next --json | jq 'sort_by(.roi)'` returned
  rows in arbitrary order because the JSON serialiser dropped the
  ROI that the table view computes inline. Affected verbs:
  `task list / next / ready / blocked / goals / owned-by / show`,
  `my-tasks`, `my-next`, bare `mu --json`, `mu state --json`.
  Tasks with `effortDays === 0` omit the field (JSON has no
  Infinity literal); callers can detect via `effortDays === 0`.
  The `TaskRow` SDK type is unchanged — ROI stays a
  CLI-rendering concern, decorated only on the JSON emit path.


- **`mu workstream init <name>` now validates the name.** Names
  containing `.`, `:`, `/`, uppercase, leading digit/hyphen, or
  >32 chars are rejected with `WorkstreamNameInvalidError` (exit
  2). The motivating bug: `mu workstream init roadmap-v0.2`
  succeeded, but tmux silently rewrote the session name to
  `mu-roadmap-v0_2` (because `.` is the window/pane separator in
  tmux's `session:window.pane` target syntax). Every downstream
  verb — `mu agent list`, `mu state`, bare `mu`, `mu agent
  spawn` — then failed with `can't find pane: 2` or `duplicate
  session` because mu queried the unmangled name. Fail loud at
  init time instead.
  - **Migration:** existing workstreams with invalid names need
    to be renamed via SQL: `INSERT INTO workstreams (name,
    created_at) SELECT '<new>', created_at FROM workstreams WHERE
    name='<old>'; UPDATE tasks SET workstream='<new>' WHERE
    workstream='<old>'; UPDATE agent_logs SET workstream='<new>'
    WHERE workstream='<old>'; DELETE FROM workstreams WHERE
    name='<old>';` (each statement separately; `mu sql` doesn't
    accept multi-statement scripts yet). Then
    `tmux kill-session -t <old-mangled-session>`.
  - The same regex applies to `ensureWorkstream` (the auto-create
    path on first `mu agent spawn` / `mu task add`), so the
    invariant holds even for callers that skip `mu workstream init`.
  - SDK: `WorkstreamNameInvalidError` and `isValidWorkstreamName`
    exported from `src/index.ts`.

### Breaking

- **`mu agent close` no longer touches the workspace.** Previously,
  closing an agent auto-freed its workspace dir; the
  `--keep-workspace` flag opted out. The default lost any
  uncommitted artifacts (benchmark output, profiles, scratch logs)
  produced into the workspace cwd. The new behaviour: closing an
  agent kills the pane and removes the registry row only. Run
  `mu workspace free <agent>` (or `mu workspace free <agent>
  --commit`) explicitly to remove the on-disk dir. The
  `--keep-workspace` and `--commit-workspace` flags on `agent
  close` are removed.
  - **Migration:** any script that did `mu agent close X` and
    relied on the workspace being cleaned up should add
    `mu workspace free X` after.
  - **Why:** mu has no `mu undo`; destructive defaults are bad
    form. The split also matches mu's general principle that each
    verb does one thing.

---

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
