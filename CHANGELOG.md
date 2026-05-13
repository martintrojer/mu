# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [0.5.0] — unreleased

### Breaking

- **Removed `mu state --mission`**. Bare `mu` is now the human TTY
  entrypoint for the all-workstream TUI; agents and scripts should use
  `mu state --json` instead. The full static snapshot is a superset of
  the old stripped mission JSON shape.
- **Removed the `mu state -n/--lines` alias for the recent-events cap**.
  Use `mu state --events <n>` instead.
- **Removed the dead `mu agent list --all` surface**. Agent listing stays
  explicitly workstream-scoped; list workstreams first, then run
  `mu agent list -w <workstream>`.

### Added

- Commits/Workspaces popup drills now render the underlying VCS show output in color (red/green/cyan diff highlighting; the existing `--color=never` was disabling the natural ANSI output).
- New `t` shortcut in any `git show` drill: launches `tuicr -r <sha>` in the TUI launch cwd, suspending mu's TUI alt-screen until tuicr exits. This is the one user-driven escape from the read-only TUI pledge: it invokes another TUI tool the operator explicitly drives, then restores mu.
- TUI mouse support: double-click a card to drill into its popup, scroll the mouse wheel inside a list/drill to navigate, double-click a row to drill into its detail. Esc/q remain the canonical 'back' (no mouse back binding by design).
- DAG popup gains per-status toggle keys (o/i/c/r/d) so you can compose the visible task set without leaving the popup. Filter strip shows current toggle state. Default all-on; reopening resets.
- TUI all-tasks popup (`t` keybind, no card slot — keybind-only like DAG). Per-status toggle keys (o/i/c/r/d) reuse the same useStatusFilter hook the DAG popup uses. Sort cycle key (`s`) walks roi → recency → age → id. Enter drills into TaskDetailDrill; `y` yanks `mu task show <id>`.
- **TUI responsive multi-column dashboard + dynamic card row budgets**
  (feat_responsive_layout). The dashboard now reads the live terminal
  width and reflows cards from the narrow stacked view into pair-aware
  2 / 3 / 4-column layouts at 120 / 180 / 240 columns: small cards
  (Agents, Tracks, Workspaces, Doctor), task-list cards (Ready,
  In-progress, Blocked), and stream cards (Activity log, Commits)
  stay visually stable as the pane resizes or cards are toggled.
  Each column also runs a pure row-budget allocator so every visible
  card gets its minimum body rows, large lists cap at their declared
  max, and overflow remains discoverable via the existing `+N more ·
  Shift+N` footer-inset hint.
- TUI initial-tab focus now uses a richer ladder: `$MU_SESSION` → tmux session name (`mu-<ws>`) → cwd inside a workspace → cwd equals the project root of any workstream's workspaces (tiebreak by most-recent activity) → tab 0. Means bare `mu` from the project root in any tmux pane lands on the most-relevant workstream instead of always tab 0.
- Tab strip is compact: it shows a windowed view around the active workstream with `‹N` / `›N` indicators when workstreams overflow the available width.
- **`mu task claim --for` and `mu agent send` warn before dispatching to a stale workspace**
  (feat_claim_warn_stale_workspace). Both dispatch surfaces now reuse
  the Workspaces card's ≥10-commits-behind-main definition via the
  shared `WORKSPACE_STALE_THRESHOLD`. Default behaviour is a yellow
  stderr `WARN:` plus a `mu workspace refresh <agent> -w <ws>` Next:
  hint while the claim/send still succeeds. Passing
  `--strict-staleness` refuses instead with typed
  `TaskClaimStaleWorkspaceError` (exit 4). JSON output includes a
  `staleness` object (`agentName`, `workstreamName`,
  `commitsBehindMain`, `isStale`) or `null` for agents without a
  workspace.
- **TUI Commits card + popup** (feat_tui_commits_card). The dashboard now has a lazygit-style recent-project-commits card (`<sha-7> <relTime> <subject>`) sourced from the project root where the TUI was launched, not from any per-agent worker workspace. The fullscreen Commits popup supports `/` filtering, cursor navigation, and `Enter` drilling into the backend's show view; `y` yanks the show command. The VCS seam now supports git, jj, and sl via `VcsBackend.recentCommits(projectRoot, limit)` and `VcsBackend.showCommit(projectRoot, sha)`, with the `none` backend rendering a graceful empty state. Current slot/key assignments are documented under Changed.
- **Bare `mu` launches the TUI when stdout is attached to a TTY**
  (feat_mu_bare_launches_tui). The human entrypoint now opens the
  read-only dashboard immediately with every workstream loaded as
  tabs; `$MU_SESSION` seeds the initial active tab when it names one
  of those workstreams, otherwise tab 0 wins. Non-TTY stdout, `--json`,
  and `MU_NO_TUI=1` deliberately stay on the help path so agents,
  scripts, pipes, and CI never boot Ink by surprise. An empty machine
  prints `mu --help` plus `Get started: mu workstream init <name>`.
  `mu state` remains the static card and `mu state --tui` remains the
  explicit TUI selector for back-compat.

- **Commits card and popup show the detected VCS backend**
  (bug_vcs_detect_misses_git_worktrees). The TUI Commits card and
  popup now include the active backend in their header/subtitle
  (`git`, `jj`, `sl`, or `(no vcs)`) so users can see which substrate
  won detection at a glance.

### Performance

- **TUI snapshot poll split into a fast SQL-only tick (1s) and a slow
  subprocess tick (10s).** Tmux liveness, per-workspace dirty status,
  and project recent-commits no longer block every fast tick. p50
  snapshot cost dropped from ~385ms to <1ms; the 10s slow tick handles
  the subprocess work in the background. `r`/F5 still refreshes
  everything immediately. Workstream tab switch triggers an eager slow
  tick so the new workstream's subprocess data is fresh within 1s.

### Changed

- README now opens with the shipped TUI dashboard screenshot so the flagship human surface is visible before install instructions.
- README positioning now drops anti-bloat boasting while keeping the load-bearing thesis: mu persists tasks, workspaces, panes, notes, and logs, but the model drives.
- Every TUI task-list popup and card now colour-codes the status column (OPEN cyan, IN_PROGRESS yellow, CLOSED green, REJECTED red, DEFERRED gray/dim) — matching the existing static `mu task list` / `mu state` table colouring. Was: rendered as plain dim text in TUI.
- TaskDetailDrill (the read-only drill that shows a task's note timeline) now renders each note's header (`── <ts>  <author> ──`) in bold cyan so multi-note tasks (especially umbrella tasks) are easy to scan top-to-bottom.
- DAG popup (`g`) nodes now render `<name>  <status>` only — the long task summary trailing each node was clipped or wrapped at narrow widths and added little signal beyond the name. `mu task tree` CLI keeps the full label for static prints. DAG popup also truncates long lines per popup width (no more wrap).

### Fixed

- TUI `?` help overlay is now scrollable. On low-row panes (e.g. 24 rows) the previous single-column render hid the bottom half of the keymap behind the StatusBar; now j/k/Ctrl-D/U/g/G/PgDn/PgUp scroll the body and a position indicator (`1-12/53`) sits inset into the title.
- TUI drill-down views (TaskDetailDrill notes, commits show body, agent scrollback) used to capture their content once on mount and stay frozen until the user closed and reopened the drill. They now refresh on the same tick the parent dashboard does — fast tick (1s) for SQL-derived content (notes); slow tick (10s) for subprocess-derived content (commits show, agent scrollback). r/F5 forces an immediate refresh.

- git-show drills (Commits popup + Workspaces popup) now wrap long lines by visual width instead of byte count. Previously the new `--color=always` ANSI escape sequences inflated Ink's wrap math, breaking lines mid-escape and corrupting the popup chrome / colours. Wrap-within-borders is now clean at any pane width.

- TUI keyboard popup-opens (`t`, `1`-`9`, `Shift+0`-`9`) no longer replay a stale mouse double-click event; the replay queue is consume-once via a ref. Symptom that's now fixed: pressing `t` on the dashboard could land the cursor on a random row + drill into TaskDetailDrill if you'd previously used a mouse double-click.

- **TUI mouse double-click hit-test no longer points at the wrong card.** Empty-state cards (for example Doctor with no warnings) now render at their allocated `chrome + rowBudget` height instead of shrinking to only their minimum padding, so dashboard hit-test rectangles stay aligned with the Ink-rendered card grid all the way down the pane.

- **All-tasks popup (`t`) now properly windows large lists.** Previously it rendered every task and let the cursor move off-screen because the rendered slice never advanced. Now uses `centredVisibleSlice` so the cursor stays mid-window and j/k/Ctrl-D/scroll-wheel actually move the visible window. Title gains a percent indicator (e.g. `23%`) when the list overflows the viewport.

- **TUI dashboard no longer renders interleaved card borders / overlapping content on low-row-count panes.** The row-budget allocator now culls low-priority cards (Doctor → Recent → Workspaces → …) until the surviving set fits the available rows; a `+N cards hidden · resize taller` hint replaces them at the bottom. An outer height clip on the dashboard container is the final safety net.

- **TUI dashboard 2-col layout no longer buries Commits**
  (bug_layout_slot_0_buried_after_slot_fix). Commits (slot 0) no
  longer lands below Recent (slot 8) in the middle of the right
  column. Dashboard columns now follow a slot-stable order: normal
  card runs are numeric, stream cards sit as natural trailers, and
  slot 0 trails as the lowest-frequency stream card. The 2-col split
  also rebalances stream cards across columns to 5/5 (was 4/6),
  aligning bottom edges with Activity log trailing the left column and
  Commits trailing the right column.

- **TabStrip no longer crashes the TUI on small panes**
  (bug_tab_strip_conditional_hook_crash). The component called a
  helper that wrapped `useStdout()` and that helper was invoked
  CONDITIONALLY (skipped when the `terminalColumns` prop was
  provided). React's rules of hooks then crashed ink with `Rendered
  fewer hooks than expected. This may be caused by an accidental
  early return statement.` whenever the prop flipped between defined
  and undefined across renders — the typical trigger was running
  bare `mu` in a small tmux pane. Fix: TabStrip is now a pure
  presentational component; the parent `<App>` reads `useStdout`
  once for its own column count and threads that down via the
  `terminalColumns` prop (now required, not optional).

### Tests

- **Test suite split into fast and full tiers.** `npm run test:fast`
  now runs the pure/in-process unit tier for the dev loop and
  concurrent worker checks, excluding `*.integration.test.ts` and
  `*.smoke.test.ts`. `npm run test` keeps the full suite gate,
  including integration tests that touch real tmux, git/jj/sl
  fixture repos, filesystem-heavy export/import/snapshot paths, or
  subprocess-style in-process CLI flows. The `.integration.test.ts`
  suffix is promoted to the full-only tier marker; slow/substrate
  tests that previously used plain `.test.ts` names were renamed
  accordingly. The four-greens pre-commit gate still requires the
  full `npm run test`.
- **Test suite flake population audited and remediated.** The
  previously intermittent ~1/run failure rate (different test each
  time, passes on isolated re-run) was driven primarily by
  multi-agent concurrent test runs — the repo's standard dogfood
  workflow runs multiple pi workers' `npm run test` in parallel on
  the same machine. Per-fix details live in
  `docs/test-flakes-audit.md`. New `npm run test:stress` runs the
  full suite 30× back-to-back by default, captures one log per run,
  enforces a per-run timeout, and can simulate concurrent-agent load with
  `MU_TEST_STRESS_MODE=parallel MU_TEST_STRESS_PARALLEL=2`.
- VCS fixture cleanup now uses a small retrying `rmFixtureDir()` helper
  for Sapling/git/jj temp dirs. This fixes the observed
  `test/vcs-commits-show.test.ts` `ENOTEMPTY` cleanup race where sl's
  `.hg/blackbox` file activity outlived the test body under load.
- `mu task wait` reaper integration tests no longer use fixed 100ms
  timers to kill panes or close tasks. The action now runs from the
  wait-loop sleep seam after the initial snapshot has seeded prior
  state, fixing the stress-only timeout where a pane died before the
  wait could observe the IN_PROGRESS → OPEN transition.
- Ink render tests no longer rely on a fixed 40ms sleep before reading
  captured stdout; shared test plumbing now waits for non-empty stable
  output, reducing timing sensitivity on loaded concurrent-agent
  machines.

### TUI internals

- **State/TUI dispatch + event-classifier tests are behaviour-backed**
  (testreview_static_source_assertions). `test/state-dispatch.test.ts`
  no longer reads `src/cli/state.ts` looking for the legacy
  multi-workstream TUI guard or a `runTui({workstreams: ...})`
  source shape. It lazy-mocks `runTui` and drives the real in-process
  CLI path (`mu state --tui -w ws,ws2`), asserting the TUI branch is
  invoked once with every resolved workstream and without booting Ink.
  `test/state-render.test.ts` drops the TypeScript-AST audit of every
  `emitEvent(...)` callsite; the replacement drives representative
  SDK mutating verbs, captures the actual `agent_logs` payloads they
  emit, passes the user-visible payloads through `classifyEventVerb`,
  and asserts every emitted verb prefix is recognised. The tests now
  fail on broken runtime dispatch/classification rather than harmless
  source refactors.

## [0.4.0] — unreleased

Feature theme: **interactive TUI**. `mu state --tui` opens an
ink-based dashboard (rounded-border cards, fullscreen popups,
live-updating, keyboard-driven, read-only). Default `mu state`
behaviour is unchanged — the static card stays the default; the TUI
is opt-in via the new `--tui` flag.

### Added

- **TUI DAG popup (`g`)** — the dashboard now has a keybind-only full task-DAG view for the active workstream. It renders every root task (no incoming `blocks` edge) as a `mu task tree --down`-style ASCII subtree, with blank lines between roots and diamond repeats collapsed with the existing `↻ already shown above` marker. New SDK/data seam `loadFullDag(db, workstream)` plus shared `renderForest(...)` keep the CLI tree renderer and TUI popup on the same box-drawing implementation. The popup is read-only and yanks `mu task tree <root-id> -w <ws>` for the root closest to the current scroll position (TODO: refine from scroll-root approximation to exact cursor-line task lookup when the text drill grows cursor-row plumbing).
- **TUI multi-workstream tabs (`mu state --tui -w A,B,C`)** — the
  TUI now accepts the same multi-value `-w` set the static card
  has always supported (and `--all`). N≥2 surfaces a one-row tab
  strip above the cards (`workstreams: ▸ active · next · …`)
  with the active tab in bold/cyan + a colour-blind-safe `▸ `
  marker; `Tab` cycles forward, `Shift-Tab` backward (suppressed
  while a popup is open so the same key still navigates inside
  popups that bind it locally). Cards / popups remain single-ws
  (they read the active tab's snapshot); per the design note in
  feat_tui_multi_workstream the Agents card does NOT grow a per-
  row workstream column — the active tab encodes ws identity, and
  a column would steal real estate from the actual signal columns.
  The status bar's right zone gains a `[<active-ws>]` prefix next
  to the tick rate so the active tab is visible without looking up
  at the strip. Single-ws TUI (N=1) is byte-identical to the
  pre-multi-ws frame: the strip renders nothing, the status-bar
  prefix is omitted. New `<TabStrip>` component in
  `src/cli/tui/tab-strip.tsx` (the only new file); `<App>` takes
  `workstreams: string[]` instead of `workstream: string`;
  `RunTuiOptions.workstream` becomes `RunTuiOptions.workstreams[]`;
  the legacy `--tui currently supports a single workstream`
  UsageError is removed from `cmdState`. Tab / Shift-Tab actions
  added to `dispatchGlobalKey` (`{ kind: "nextTab" }` /
  `{ kind: "prevTab" }`). Per the v0.4 anti-feature pledge,
  ink/react remain confined to `src/cli/tui/*`.
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
  - **Enter drills into the focused row** in every popup (read-only):
    Agents popup → inline scrollback view (`mu agent read -n 80`
    rendered with j/k scroll). Tracks popup → inline list of every
    task in that track's prerequisite subgraph. Tasks popup →
    inline rendering of all task notes. Log popup → inline view of
    the focused event's full untruncated payload (long
    workspace-refresh / claim / multi-line note payloads clip in the
    list view; the drill is the affordance for reading the full
    text); `y` yanks the single-event lookup
    `mu log --since <seq-1> -n 1 -w <ws>`. Esc / q from the drill view
    pops one level back to the popup list; a second Esc / q closes
    the popup back to the dashboard. The status bar surfaces the
    drill sub-mode (`drill · j/k scroll · Esc back`) so the
    multi-level state is unambiguous.
  - **Drill rows that ARE entities chain into a deeper drill**
    (per popup-drill recursion contract). Today: pressing `Enter`
    on a task row inside the Tracks-popup drill opens the SAME
    notes/details view the Tasks-popup drill renders — the shared
    `TaskDetailDrill` leaf in `src/cli/tui/popups/task-detail.tsx`.
    One `Esc`/`q` backs out per recursion level (task-detail →
    Tracks-drill task list → list of tracks → popup closed). When
    Card 6/7/8 popups (in-progress / blocked / recent) ship under
    `feat_more_cards_umbrella`, they pick up the same chain
    automatically by importing `TaskDetailDrill`.
  - **Workspaces popup commits-drill → Enter on focused commit
    drills again into `git show <sha>`** (per
    `feat_workspaces_drill_git_show`). Third level of the
    Workspaces popup state machine: list of workspaces → commits
    since fork → read-only inline view of `git -C <workspace> show
    <sha> --stat -p --color=never`, rendered via the shared
    `<DrillScrollView>` primitive (same one log.tsx's payload
    drill uses). Captured stdout is capped at 100_000 chars to
    avoid runaway memory on giant merges; the drill cap is the
    only thing the popup remembers between Esc cycles. Show-mode
    keymap mirrors the rest: j/k Ctrl-D/U PgUp/PgDn scroll, g/G
    jump top/bottom, `y` yanks the bare `git show <sha>` (the
    operator wants the COMMAND, not the captured output — same
    yank target as the commits-list level), Esc/q backs out one
    level (back to commits, NOT all the way to workspaces).
    Mode stays popup-local (`<App>`'s `PopupMode` union stays
    `"list" | "drill"` — the show level rides on a `showSha`
    sentinel inside drill mode), so no other popup is touched.
  - **Tick adjust live**: `+`/`=` faster, `-` slower, `0` reset (1s
    default; 100ms floor; 10s ceiling).
  - **Popup `/` search/filter** (lazygit / k9s convention): every
    list popup (Agents/Tracks/Tasks/Log) accepts `/` to enter an
    incremental case-insensitive substring filter that narrows the
    visible rows in real time. `Esc` cancels (clears the query),
    `Enter` commits (keeps the filter applied while letting `j/k`
    resume normal navigation), `Backspace` edits, printable chars
    append. Press `/` again to refine a committed filter. The
    filter blob is per-popup: agent name + status + cli + role;
    track head id + title; task name + title + status + owner; log
    verb + payload + source. Filter state is per-popup and dies
    with the popup. Implemented as a shared primitive in
    `src/cli/tui/use-popup-filter.tsx` (`usePopupFilter` hook +
    pure `popupFilterReducer` + `applyFilter<T>` + `<FilterPrompt>`)
    so the cards 5-9 popups under `feat_more_cards_umbrella` consume
    it in ~5 LOC each.
  - **Help overlay**: `?` shows the global + in-popup keymap.
  - **Alt-screen**: enters `\x1b[?1049h` on launch, restores on
    quit. Dashboard is flush with row 0; main scrollback is preserved.
  - **Column-aligned rows** with protect/clip clipping policy: task
    IDs / agent names / status tokens never truncate; titles /
    payloads / paths clip with `…`. Uses `string-width` for
    emoji + ANSI awareness.
- **TUI Doctor popup (Shift+9 / `(`)** — the matching popup for
  Card 9. Fullscreen drill-down of EVERY doctor check (OK + warn +
  fail), not just the non-OK subset Card 9 surfaces. Renders the
  Card 9 columns (glyph + check name + STATUS + detail) so the
  popup stays visually in sync; re-uses Card 9's pure helpers
  (`glyphFor`, `colorForStatus`). j/k navigation; `/` filter via
  the shared `usePopupFilter` primitive (blob =
  `${name} ${status} ${detail}`); `y` yanks an INFORMATIONAL
  remediation hint (e.g. `mu agent list`, `mu workspace orphans`,
  or a `# ...` no-op for schema-shape checks that have no
  actionable mutation an operator should yank) — read-only by
  construction, no mutating verb surfaces in the yank matrix.
  `Enter` drills into a small ad-hoc detail view of the focused
  check (name, status, detail, multi-line remediation paragraph)
  rendered via the shared `DrillScrollView` leaf — NOT
  `TaskDetailDrill` (rows are doctor checks, not tasks; the
  popup-recursion contract from
  feat_track_drill_chains_to_task_drill does not apply). New SDK
  seam `loadDoctorChecks(db, snapshot)` in `src/doctor-summary.ts`
  is a thin wrapper over `loadDoctorSummary` that returns the full
  check array — the popup needs every row, the card needs the
  warn+fail subset.
- **TUI Doctor card (slot 9)** — toggleable with `9`. One
  glanceable health-check summary so the operator notices a broken
  state without remembering to run `mu doctor`. Filters to non-OK
  rows for the body: glyph (✗ red fail / ⚠ yellow warn / ✓ green
  ok), check name, status, and a short remediation detail (e.g.
  `2 ghost panes; run \`mu agent list\``,
  `1 orphan dir; run \`mu workspace orphans\``). Subtitle is
  `all healthy` when every check passes (and a quiet "✓ K checks"
  body line confirms the card ran), or the warn+fail count
  otherwise. Reads `snapshot.doctor` populated by
  `loadWorkstreamSnapshot(db, ws, { withDoctor: true })`; the new
  `withDoctor` flag mirrors the `withDirty` opt-in pattern. New SDK
  helper `loadDoctorSummary(db, snapshot)` in
  `src/doctor-summary.ts` runs the cheap subset of `mu doctor`'s
  checks (synchronous DB pragmas + COUNT-shape SELECTs; reads
  ghosts/orphans/workspace-orphans straight off the snapshot).
  Tmux-binary presence is intentionally omitted from the per-tick
  card (the dashboard is already running inside a terminal so
  tmux's binary presence is implicit, and a per-tick subprocess
  fork on a polled dashboard is the wrong tradeoff). Slot-9 popup
  (Shift+9 / `(`) is not shipped yet; tracked by
  feat_more_cards_umbrella, and when it lands it MAY consume
  feat_popup_search_filter (`/` filtering check names) but NOT
  feat_track_drill_chains_to_task_drill (rows aren't tasks). After
  this card lands, all reserved digit slots (1–9) are filled; slot
  0 stays reserved by convention.
- **TUI Blocked popup (Shift+7 / `&`)** — the matching popup
  for Card 7. Fullscreen drill-down of every blocked task (OPEN
  with at least one still-gating blocker). Renders the Card 7
  glyph + id + STATUS + #blockers + ROI columns, plus a
  top-blocker id column the card is too narrow to fit. Re-uses
  Card 7's pure helpers (`glyphFor`, `stillGating`) so the popup
  stays visually in sync. j/k navigation; `/` filter via the
  shared `usePopupFilter` primitive (per feat_popup_search_filter;
  blob is `${id} ${title} ${blockerIds.join(" ")}` so search
  matches both the blocked task itself AND its still-gating
  prereqs); `y` yanks `mu task tree <id> -w <ws>` — the most
  actionable diagnostic for a blocked row ("show me what's
  blocking this"). `Enter` chains into the shared
  `TaskDetailDrill` leaf (rows ARE tasks, so the drill-recursion
  contract from feat_track_drill_chains_to_task_drill applies
  unchanged); `y` in drill mode yanks `mu task notes <id>` to
  match the leaf the user is reading. Read-only: no mutating
  verbs (no `mu task close / open / claim / release / reject /
  defer / block / unblock / delete` yank). Esc/q backs out one
  level (drill → list, then list → popup closed). Slot-6/8
  popups remain reserved and tracked by `feat_more_cards_umbrella`.
- **TUI Workspaces popup (Shift+5 / `%`)** — the matching popup
  for Card 5. Fullscreen drill-down of every per-agent workspace in
  the workstream. Renders the same five Card 5 columns (status
  glyph, agent name, backend, commits-behind, parent_ref short)
  plus two extras the card couldn't fit (dirty? and the on-disk
  path). Re-uses the card's pure colour/glyph helpers (`glyphFor`,
  `colorForGlyph`, `colorForBehind`, `formatBehind`) so the popup
  stays visually in sync with the card. j/k navigation; `/` filter
  via the shared `usePopupFilter` primitive (per
  feat_popup_search_filter — blob is
  `agent backend parent_ref [dirty]`); `y` yanks
  `cd $(mu workspace path <agent> -w <ws>)` (the canonical entry
  to a workspace per skills/mu's cherry-pick / inspection-workflow
  recipe). Read-only: no mutating verbs (no `mu workspace free` /
  `recreate` / `refresh` yank — surfaced as out-of-scope by the
  task brief). `Enter` drills into the per-workspace
  commits-since-fork list (`listCommitsForWorkspace` — the same
  data `mu workspace commits <agent>` surfaces). The drill is its
  OWN read-only list (NOT `TaskDetailDrill` — workspaces aren't
  tasks); columns are `<sha-short>  <subject>` newest-first; the
  drill ALSO consumes `usePopupFilter` so '/' substring search
  across (sha + subject) works in 30+-commit workspaces; `y` in
  drill mode yanks `git show <sha>` (cherry-pick discovery).
  Esc/q backs out one level (drill → list, then list → popup
  closed). Slot-6/7/8 popups remain reserved and tracked by
  `feat_more_cards_umbrella`.
- **TUI Recent card (slot 8)** — toggleable with `8`. One
  glanceable list of the most-recently CLOSED tasks in the
  workstream, newest first: heavy-check glyph (✓, green), task
  id, status, time-since-close (relative-time token with `ago`
  suffix), and title. Subtitle inlines `<N>` or
  `<N> · last <when>` where `<when>` is the time since the
  most-recent close — the actionable anchor for the operator's
  "did the wave just finish?" question. Reads
  `snapshot.recentClosed` directly (the existing `listRecentClosed`
  SDK helper, sorted by `updated_at DESC`); no SDK extension.
  Empty-state body is `(none recently closed)`. Surfaces "what
  just shipped" so the operator can cherry-pick / verify /
  cross-reference without bouncing to a separate `mu task list
  --status CLOSED -w <ws>` shell. Slot-8 popup (Shift+8 / `*`)
  is not shipped yet; tracked by feat_more_cards_umbrella, and
  when it lands it MUST follow feat_popup_search_filter (`/`)
  and feat_track_drill_chains_to_task_drill (Enter chains rows
  into TaskDetailDrill, since rows ARE tasks). Slot 9 stays
  reserved.
- **TUI Blocked card (slot 7)** — toggleable with `7`. One
  glanceable list of every OPEN task with at least one still-gating
  blocker (status ≠ CLOSED): chain-link glyph, task id, status,
  #blockers, ROI, title. Subtitle inlines `<N>` or `<N> · top
  blocker: <id>` where the top blocker is the still-gating prereq
  shared by the most visible rows (alphabetic tie-break) — the
  single task that, if closed, would unblock the most downstream
  work. Reads `snapshot.blocked` directly; per-row blocker counts
  come from `getTaskEdgesWithStatus` (≤8 cheap synchronous
  better-sqlite3 reads per tick — orders of magnitude cheaper than
  the per-row `git status` shellouts the Workspaces card already
  does). No SDK extension. Empty-state body is `(none blocked)`.
  Fills the diagnostic gap that previously forced the operator to
  walk the dependency tree manually via `mu task tree <id>`.
  Slot-7 popup (Shift+7 / `&`) is not shipped yet; tracked by
  feat_more_cards_umbrella, and when it lands it MUST follow
  feat_popup_search_filter (`/`) and
  feat_track_drill_chains_to_task_drill (Enter chains rows into
  TaskDetailDrill, since rows ARE tasks).
- **TUI In-progress card (slot 6)** — toggleable with `6`. One
  glanceable list of every IN_PROGRESS task with id, owner,
  time-since-claim (relative-time token), and title. Glyph is the
  cog (matches `STATUS_EMOJI.busy` so it reads the same as in the
  Agents card). Subtitle inlines `<N>` or `<N> · <K> stale` when
  any row's last lifecycle flip is ≥5min old (matches the
  `MU_IDLE_THRESHOLD_MS` default). Reads `snapshot.inProgress`
  directly — no SDK extension. Empty-state body is `(none in
  progress)`. Fills the cross-ref pain that previously forced
  the operator to read the Agents card AND the Ready card to
  figure out "what's actually running right now".
- **TUI Recent popup (Shift+8 / `*`)** — the matching
  fullscreen drill-down for Card 8 (per feat_popup_8_recent).
  Mirrors the card's columns (`glyph id STATUS closed-at title`)
  and adds `impact`, `effort`, and `ROI` columns the card was too
  narrow to fit. `j/k` nav, `/` filter (incremental
  case-insensitive substring over `id title owner` via the shared
  `usePopupFilter` primitive), `y` yanks `mu task open <id> -w
  <ws>` (the most likely act-intent for a recently-CLOSED row;
  matches the popups/ready.tsx CLOSED branch of the yank matrix —
  re-open is the typical "revisit a just-shipped task" flow),
  `Enter` chains into the shared `TaskDetailDrill` leaf rendering
  the focused task's notes timeline (per the recursion contract
  from feat_track_drill_chains_to_task_drill — rows ARE tasks).
  Drill-mode `y` yanks `mu task notes <id>`. Read-only: never
  executes a mutation. Re-uses Card 8's pure helpers (`glyphFor`,
  `formatWhen`, `ageMs`) so the popup stays in visual lockstep
  with the card. After this popup lands, only slots 5/7/9 remain
  unwired under feat_more_cards_umbrella.
- **TUI In-progress popup (Shift+6 / `^`)** — the matching
  fullscreen drill-down for Card 6 (per feat_popup_6_inprogress).
  Mirrors the card's columns (`glyph id STATUS owner since-claim
  title`) and adds an ROI column the card was too narrow to fit.
  `j/k` nav, `/` filter (incremental case-insensitive substring
  over `id title owner` via the shared `usePopupFilter` primitive),
  `y` yanks `mu task close <id> -w <ws> --evidence "..."` (the
  most likely act-intent for an IN_PROGRESS row; matches the Tasks
  popup yank matrix), `Enter` chains into the shared
  `TaskDetailDrill` leaf rendering the focused task's notes
  timeline (per the recursion contract from
  feat_track_drill_chains_to_task_drill — rows ARE tasks). Drill-mode
  `y` yanks `mu task notes <id>`. Read-only: never executes a
  mutation. Re-uses Card 6's pure helpers (`glyphFor`,
  `formatSinceClaim`, `ageMs`, `isStale`) so the popup stays in
  visual lockstep with the card.
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

- TUI `?` help overlay re-rendered as a single vertical column with bold section headers (was: 6 side-by-side rounded boxes that squished every effect string into a long thin strip on typical terminal widths).
- TUI status-bar hint clusters re-audited per mode (dashboard/popup-list/popup-drill/popup-filter/dag/all-tasks); each mode lists exactly the keys you can press in that mode. The `?` overlay is the superset. Drill and filter sub-modes get their own columns in the overlay (previously buried under "in popup"). Orphan-hint regression test enforces every key shown in the bar appears in the overlay.
- Recent restored to dashboard card slot 8 (was demoted to popup-only when Commits took the slot in v0.5 alpha).
- Commits promoted to dashboard card slot 0 (was reserved-by-convention).
- Dropped `l`/`L` alias for the Commits popup; Shift+0 ')' is the canonical key.

- **CLI handler exits are centralised in `handle()`**
  (review_repo_process_exit_inside_handlers). Leaf command handlers
  no longer call `process.exit()` themselves: bare `mu state` with no
  auto-resolvable workstream now throws `UsageError`, and `mu task
  wait` timeouts throw a small internal `CliExitError(5)` sentinel
  after rendering their normal stdout/JSON payload. `handle()` records
  the exit code, runs its `finally` block (including `db.close()`),
  then exits exactly once. This keeps typed-error exit-code mapping
  and cleanup in one place.
- Bare `mu state` outside a tmux session no longer prints the
  silent `(no workstreams)` line. With workstreams on the machine
  it now errors with the workstream list and three suggested fixes
  (`mu state -w <name>`, `mu state --all`, `mu --help`), exit 2.
  `--all` on a truly empty machine still prints a helpful hint.
  `--json` callers continue to get `{workstreams: []}` for back-compat.

### Repo cleanups

- Dropped the unused `zod` runtime dependency and refreshed the lockfile.
- Removed dead `mu agent list --all` documentation/next-step residue:
  `mu agent list` remains explicitly workstream-scoped, and typed hints
  now point users to `mu workstream list` before choosing a scope. The
  compatibility flag itself is removed in v0.5.0.
- Purged vestigial HUD-era helpers/comments: deleted the unused
  `currentPaneSize()` tmux helper, narrowed stale internal comments to
  the static-state/TUI model, and queued the `mu state -n/--lines` alias
  itself for v0.5 removal.
- `mu workspace commits --json` now keeps the collection envelope while
  preserving the metadata the SDK already computes:
  `{items,count,vcs,baseRef,workspacePath}`.
- Git workspace dirtiness now has one source of truth: `freeWorkspace`
  reuses `listGitDirtyFiles().length > 0`, and the duplicate
  `isGitDirty()` helper is gone.

### TUI internals

- **Tmux integration tests now poll observed state instead of sleeping**
  (testreview_fixed_sleep_flakes). The remaining fixed sleeps in
  `test/verbs.integration.test.ts`, `test/tmux.integration.test.ts`,
  and `test/cli-agent-kick.test.ts` now use the shared `pollUntil()`
  helper against real predicates (scrollback contains marker, pane
  disappeared, bash prompt/output visible, pane exists before kick)
  rather than assuming 200–600ms is enough under load. Deferred export
  mtime/cadence sleeps stay parked for v0.5+ per the task scope.

- **JSON shape tests now assert seeded semantics, not just arrays**
  (testreview_json_shape_weak_assertions). `state --json`, `agent
  list --json`, `task notes --json`, and workspace-commits tests now
  seed deterministic rows and assert representative content (task
  ids/titles/statuses/ROI, live agent name/status, note author/content,
  jj draft commit subject/body) instead of accepting any array-shaped
  output. No production behaviour change.

- **Yank OSC-52 branch + platform-conditional probe now have real
  coverage** (review_tests_yank_osc52_unverified). `src/cli/tui/yank.ts`
  had four backends — CLI (pbcopy/wl-copy/xclip/xsel/clip.exe), OSC-52,
  and null — but the OSC-52 path (the actual fallback for SSH users
  without an X server) wasn't exercised by ANY test, and the
  platform-conditional `probeClipboardBackend` only ran the host's
  branch (so a regression in the WSL or Wayland branch would be
  invisible). Added two narrow injection seams:
  (1) `yank(text, backend, { osc52Writer? })` accepts a stub writer
  for the OSC-52 branch (default still writes to `/dev/tty`), plus a
  new exported `osc52Sequence(text)` helper so the byte sequence is
  testable directly. (2) `probeClipboardBackend({ platform?, wayland?,
  x11?, isWsl?, hasCommand? })` accepts a synthetic env so every
  branch can run on any host (defaults still read `process.platform`
  / `WAYLAND_DISPLAY` / `DISPLAY` / `/proc/version` / `command -v`).
  `test/tui-yank.test.ts` grows: OSC-52 sequence framing
  (`ESC ] 52 ; c ; <base64> BEL`, base64 round-trip, BEL not ST
  terminator), writer-throws → `{copied:false,error}`, exactly-one-
  invocation, and 9 platform-conditional probe cases (darwin±pbcopy,
  WSL, linux+Wayland+wl-copy, linux+X11+xclip, linux+X11+xsel-only,
  Wayland-prefers-wl-copy-over-xclip, xclip-wins-over-xsel,
  linux-no-display → OSC-52, unknown platform → OSC-52). 21 tests
  total (up from 5); no production behaviour change.

- **Workspaces popup `git show` invocation extracted to a testable
  helper** (review_tests_workspaces_show_loadshow_unmocked). The
  `loadShow` callback in `src/cli/tui/popups/workspaces.tsx` previously
  shelled out via promisified `execFile` inline, with the arg vector,
  the `SHOW_MAX_CHARS` truncation, and the error-stringification all
  living in a `useCallback` body that no test ever called — the only
  coverage was static-source greps for the literal strings
  `"--color=never"` / `SHOW_MAX_CHARS = 100_000` / `"truncated at"`.
  A regression that swapped `--color=never` for `--color=always`
  (would inject ANSI into the popup body) or silently lowered
  `maxBuffer` to 100 would have passed. New `src/cli/tui/git-show.ts`
  module exports `runGitShow(path, sha)` returning a structured
  `{ text, truncated, error }`, plus a `gitShowArgs(path, sha)` arg-
  vector helper for cheap regression assertions and an `ExecFileFn`
  injection seam for tests. The popup's `loadShow` shrinks to state-
  setter glue. New `test/tui-git-show.test.ts` drives the helper
  against (a) a real `mkdtemp + git init + commit` fixture (asserts
  truncation fires at SHOW_MAX_CHARS, ZERO ANSI escape sequences in
  stdout, missing-sha returns a useful error string, non-repo path
  returns a useful error string) and (b) a stub `execFile` that pins
  the exact arg vector + maxBuffer≥2×SHOW_MAX_CHARS + the throw→
  `{error}` conversion. The popup's existing test suite is updated:
  the per-flag static-source assertions are replaced by a single
  guard that the popup wires `runGitShow(path, sha)` and never
  imports `node:child_process` or `execFile` itself.

- **Card footer-inset assertions collapsed to a single sweep test**
  (review_tests_inline_card_source_blocks). Seven test files
  (`tui-card-{blocked, doctor, inprogress, ready, recent, tracks,
  workspaces}.test.ts`) carried byte-for-byte copies of the same
  trailing block: `readFileSync(….tsx)` followed by a 2-it
  describe asserting (1) no `<Text>+{more} more…</Text>` in-body
  node and (2) that the source contained the literal string
  `bottomLabel={bottomLabel}`. The 7 copies are gone; one new
  sweep file `test/tui-card-footer-inset.test.ts` walks `cards/*.tsx`
  (mirroring the pattern already used by
  `tui-card-render-width.test.ts` for `<ListRow>`). The previous
  `bottomLabel={bottomLabel}` regex was trivially evadable by
  accident — a stale `let bottomLabel = undefined; <TitledBox
  bottomLabel={bottomLabel} …/>` would pass while silently
  disabling the inset — so the sweep additionally pins the
  computation shape: `const bottomLabel = <count> > 0 ? \`+${…}
  more · Shift+<digit>\` : undefined`. Net: -141 lines of test
  duplication, +112 lines of one centralised sweep, one place to
  update on the next refactor.

- **Status-bar hint cluster: single declarative token list, zero
  drift surface** (review_complexity_status_bar_hint_dual_render).
  `src/cli/tui/status-bar.tsx` previously maintained two parallel
  switches over `(mode, popupName, popupMode)`: `hintsPlain()`
  built a plain string for the LEFT-zone truncation budget, and
  `renderHints()` built the JSX with coloured `<Key>` tokens. The
  header comment honestly read "Keep in lockstep with
  renderHints()" — a maintenance burden guaranteed to silently rot
  on the next edit (a hint added to one but not the other quietly
  miscomputes the LEFT-zone budget on narrow terminals). Refactored
  to a single `buildHints()` switch that returns a `HintToken[]`
  (`{kind: "key"|"dim"|"label", text, color?}`); `hintsPlain()` is
  now `tokens.map(t => t.text).join(" ")`, `renderHints()` walks
  the same array interleaving `" "` separators so width matches
  byte-for-byte. The 20-test `tui-status-bar.test.ts` suite
  continues to pass unchanged.

- **Dropped three TUI dead-code lies**
  (review_dead_code_glyph_for_unused, review_dead_code_refresh_now,
  review_dead_code_workstream_picker). (1) `glyphFor(_t: TaskRow)`
  in `cards/{blocked,inprogress,recent}.tsx` was a const-returning
  helper whose `TaskRow` arg existed purely for plug-in symmetry no
  caller needed — exactly the anticipatory-abstraction pattern
  AGENTS.md bans. Argument dropped; popup/card/test call sites
  collapse to `glyphFor()`; the unused `TaskRow` import goes too.
  (2) The `r` / F5 refresh-now binding bumped a `refreshNonce`
  whose only consumer was a no-op `void refreshNonce` useEffect;
  the snapshot poll loop in `useDashboardSnapshot` had no
  refresh-now signal so the help-overlay-advertised binding did
  nothing. Wired through: hook now takes an optional `refreshNonce`
  param + lists it as an effect dep so a bump tears down the
  interval and re-runs `tick()` synchronously; the dead useEffect
  in `app.tsx` is gone. (3) The `w` workstream-picker binding
  emitted a `workstream picker: v0.next` toast and otherwise did
  nothing — a discoverable affordance shipping as a lie. Multi-ws
  Tab/Shift-Tab (feat_tui_multi_workstream) covers the use case
  now; the binding is gone from `keys.ts`, the suppression set in
  `app.tsx`, the help overlay row, and the `tui-keys.test.ts`
  expectation (replaced by a regression guard that pins `w` as a
  noop). If a real picker ever ships, restore the binding then.

- **Centralised pure formatters across cards/popups**
  (review_dedup_age_ms, review_dedup_color_for_bucket,
  review_dedup_format_roi, review_unify_format_when_since). Hoisted
  the four pure helpers that had quietly accumulated 12+ near-
  identical copies across the TUI cluster: `ageMs` (4 consumers),
  `colorForBucket` (3 byte-identical copies), `formatRoi` (3
  exported helpers + 2 inline `Math.round / Number.isFinite`
  duplicates), and the `formatSinceClaim` / `formatWhen` pair
  (which were each hand-rolled twice over the same
  `relTime`-shaped arithmetic). All four now live in one new
  `src/cli/tui/format-helpers.ts`; `formatSinceClaim` and
  `formatWhen` collapse onto `relTime` / new `relTimeAgo` in
  `src/cli/format.ts` so the static-CLI relative-time formatter
  and the TUI's are now the single source of truth. Cards
  re-export the helpers they used to define for back-compat with
  popup / test imports. Stale "intentionally duplicated; single
  call site per card, not worth a shared helper" comments deleted
  — they outlasted their truth as soon as the popups landed and
  bumped consumer counts to 4. New `test/tui-format-helpers.test.ts`
  pins the helpers directly so a future drift inside a card can't
  quietly reintroduce the duplication this commit removed.

- **Lifecycle-backed graph/acceptance tests**
  (testreview_acceptance_bypasses_lifecycle). The canonical
  acceptance test and graph-view/track tests no longer mark tasks
  `CLOSED` via raw SQL. They drive `closeTask()` instead and assert
  the side effects raw SQL skipped: status-event evidence, synthetic
  `CLOSE:` notes, and `updated_at` movement before checking ready /
  track projections. Status-filter setup now uses `setTaskStatus()` /
  `closeTask()` except where a test is intentionally constructing a
  corrupt or otherwise impossible DB state.

- **Colour-env test hygiene** (testreview_env_leak_no_color). The
  three colourless render test files that set `NO_COLOR=1` at module
  load now restore the original value in `afterAll`, preventing a
  Vitest worker from leaking the opt-out into later output-colour
  matrix tests.

- **Tasks-popup yank matrix tests** (review_tests_yank_matrix_per_state).
  `popups/ready.tsx` now exports the pure `yankCommandForTask`
  helper, and a table-driven regression test pins every row-state
  act-intent (OPEN unowned → claim, OPEN owned → release,
  IN_PROGRESS → close with evidence, CLOSED/REJECTED/DEFERRED →
  open, unknown → no yank) so the user-visible `y` behaviour cannot
  silently drift back to static source-only coverage.

- **Behavioural card-render tests** (review_tests_card_truthy_assertions).
  The nine `test/tui-card-*.test.ts` files now use a shared
  `renderCardToText()` JSX-walker helper (same recursion pattern as
  the status-bar and tab-strip tests) instead of truthy JSX smoke
  assertions, pinning card titles/subtitles, populated row cells,
  empty-state hints, and `+N more · Shift+X` truncation labels.

- **Post-v0.4 audit pass** (review_tui_code_and_tests). Ran the
  canonical code-reviewer + test-reviewer skills across the entire
  TUI surface (`src/cli/tui/**` + `test/tui-*.test.ts`). 26 findings
  filed as separate `review_*` tasks for triage — 15 code-reviewer
  (mostly duplication candidates for the next centralisation wave —
  popup `Shell` / `dispatchPopupKey` key-flag pack / drill keymap
  / formatRoi / colorForBucket / ageMs / formatSinceClaim ↔
  formatWhen ↔ relTime — plus two dead-code lies: `r` refresh-now
  and `w` workstream picker that show in the help overlay but do
  nothing) and 11 test-reviewer (the dominant theme is `expect(src).toContain(...)`
  static-source assertions standing in for behaviour tests across
  card/popup/acceptance suites; root cause is the missing
  ink-testing-library install). No in-line fixes — implementation
  ships per filed task.
- **Shared drill-mode keymap hook** (review_dedup_drill_keymap).
  `src/cli/tui/popups/drill.tsx` now exports `useDrillKeymap({body,
  viewport, onClose, onYank})`, centralising the repeated
  DrillScrollView leaf skeleton (body line count → `applyScroll`,
  Esc/q back, y delegate). The seven direct text drills
  (Agents/Ready/In-progress/Blocked/Recent/Log/Doctor) now simply
  call `drill.dispatch(action)` in drill mode; Tracks' task-detail
  leaf and Workspaces' git-show leaf use the same hook for their
  deeper scroll-based drill levels. Coverage in
  `test/tui-drill-keymap.test.ts` keeps future popups from
  reintroducing local `applyScroll` / `totalLines` drill switches.

- **Shared ink-key normalisation for TUI dispatchers**
  (review_dedup_popup_useinput). `src/cli/tui/keys.ts` now exports
  `dispatchPopupKeyFromInk(input, key)` and
  `dispatchGlobalKeyFromInk(input, key)`, centralising the explicit
  ink `Key` → local `KeyFlags` pick (including rarely-used fields
  like PgUp/PgDn/F5). The nine fullscreen popups and `<App>` now call
  the wrapper instead of carrying hand-rolled 13-field object literals
  in every `useInput` callback, so future key additions happen in one
  place and can't drift by popup.
- **Shared popup shell extraction** (review_dedup_popup_shell).
  The nine fullscreen popup modules now import one
  `src/cli/tui/popup-shell.tsx` `<PopupShell>` wrapper instead of
  carrying eight byte-identical local `Shell` components plus the
  near-identical `ready.tsx` `PopupShell` copy. The shared wrapper
  owns the cyan `<TitledBox>` chrome, `flexGrow={1}` fill invariant,
  and nullable bottom hint mapping; `test/tui-popup-shells.test.ts`
  now asserts each popup imports the shared shell rather than
  defining a local one.

- **Centralised drill cursor-centring + filter-editing bubble-up**
  (review_dedup_drill_centring_visible_slice,
  review_dedup_filter_editing_effect). Two follow-ups from the
  v0.4 audit pass that close out two more low-severity dedup
  findings. (1) The `Math.max(0, Math.min(items.length - viewport,
  cursor - Math.floor(viewport/2)))` cursor-centring formula was
  duplicated across three drill views (log events list, tracks
  task-list drill, workspaces commits-since-fork). Sibling helpers
  in `popups/scroll.ts` already owned `applyCursor` /
  `applyScroll`, but NOT the visible-slice math — obvious drift
  surface (`floor` vs `ceil`, half-window vs explicit). New pure
  `centredVisibleSlice(items, cursor, viewport): {start, visible}`
  in `popups/scroll.ts` collapses all three to one line each;
  `tui-scroll.test.ts` adds 7 cases pinning the boundary semantics
  including a sweep-test that locks the helper to the legacy
  inline formula. (2) The bubble-up `useEffect(() =>
  onFilterEditingChange?.(flt.editing), [flt.editing,
  onFilterEditingChange])` block that flips the StatusBar into
  popup-filter mode was hand-rolled identically in 8 popups
  (agents/blocked/doctor/inprogress/log/ready/recent/tracks). Now
  baked into `usePopupFilter` itself via an optional
  `onEditingChange` callback option; the 8 useEffect blocks
  collapse and `useEffect` import drops from 6 of them.
  workspaces.tsx still hand-rolls because it has TWO filter
  instances (list + drill) and chooses which `editing` flag to
  surface based on sub-mode; that exception is documented in the
  hook's JSDoc and pinned by a baseline test in
  `tui-use-popup-filter.test.ts`. The new test also enforces the
  no-hand-roll invariant across the eight collapsed popups so a
  future refactor can't quietly reintroduce the duplicated block.

- **Centralised scroll/navigation dispatch**
  (feat_centralize_scroll_navigation). Every popup's `useInput`
  switch over `dispatchPopupKey` used to carry its own copy of the
  same six `case` arms (`moveDown` / `moveUp` / `jumpTop` /
  `jumpBottom` / `pageUp` / `pageDown`); ~60 near-duplicate arms
  across 9 popups inevitably drifted (one consumer would forget
  Ctrl-D / Ctrl-U; another would only support `g`/`G` in list mode
  and not in drill mode; a third would lose the page-step formula).
  All six arms now collapse into a single `applyCursor` /
  `applyScroll` call (cursor-based vs scrollTop-based) wired
  through new pure helpers in `src/cli/tui/popups/scroll.ts`. The
  helper has zero ink/react imports and is covered exhaustively by
  `test/tui-scroll.test.ts`. `clampScrollTop` relocates from
  `popups/drill.tsx` into the new module (drill re-exports it for
  back-compat). Every list-mode AND drill-mode in every popup now
  trivially supports j/k/g/G/Ctrl-D/U/PgUp/PgDn with identical
  semantics, and a future popup author can't drift the keymap by
  re-implementing the switch.

- **Centralised list-row rendering** (feat_centralize_list_row_render).
  Every `popups/*.tsx` (9) and `cards/*.tsx` (9) row JSX block now
  routes through a single new `<ListRow>` primitive
  (`src/cli/tui/list-row.tsx`). The four invariants every row had to
  hand-code — outer `<Box width={contentWidth}>` (was
  bug_tui_log_popup_columns_misaligned), `wrap="truncate"` on the
  outer `<Text>` (was bug_tui_log_card_columns_misaligned), the
  canonical 2-space `COL_GUTTER` between cells, and the
  selected-row→`<CursorRow>` delegation — are now owned by ONE
  component. Per-cell colour palettes pass in declaratively as a
  `colors` array, sibling of `COLUMN_SPECS`. The previously-failing
  bug class (one popup forgets one attribute, the regression hides
  in 1-of-18 panes until somebody opens it) is gone by construction:
  no consumer can drift the gutter, forget the width pin, or skip
  `wrap="truncate"`. `test/tui-card-render-width.test.ts` is
  reframed to assert the new invariant ("every renderRow consumer
  routes through ListRow or CursorRow; no hand-rolled
  `<Box><Text wrap=...>` row remains"); `test/tui-list-row.test.ts`
  is the new unit test for the primitive itself.

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

### Fixed

- **VCS backend detection now uses each tool's canonical root command**
  (bug_vcs_detect_misses_git_worktrees). `detectBackend()` probes
  `jj root`, `sl root`, then `git rev-parse --show-toplevel` instead
  of checking whether `.jj` / `.sl` / `.git` is a directory. This
  fixes git-worktree detection: worker workspaces use a `.git` FILE
  (`gitdir:` pointer), so the old heuristic fell through to `none`
  and left the TUI Commits card empty in every worker pane.
- **`mu task wait --first --json` nextSteps no longer silently cherry-pick a worker's fork point**
  (`fb_wait_nextsteps_robust_no_commits`). The dispatch-pipeline hint
  now uses `mu workspace commits`' since-fork data before emitting an
  apply recipe. Workers with commits get inspectable, sha-pinned
  commands (`git cherry-pick <sha>` for one commit,
  `git cherry-pick <first>^..<last>` for multiple commits) instead of
  a brittle `$(cd $(mu workspace path ...) && git log -1)` shell
  substitution. Workers that close without committing now surface a
  manual-rescue NextStep (`closed without committing — apply by hand`)
  rather than a no-op cherry-pick of the base ref; missing/non-VCS
  workspaces degrade to manual inspection hints.
- **`mu task close` now reminds workers to commit dirty workspace edits**
  (fb_close_post_emit_commit_hint). After a real close (not an
  idempotent no-op), if the closing actor has a per-agent workspace
  with uncommitted edits, the success `Next:` block gains a best-effort
  `cd $(mu workspace path <actor> -w <ws>) && git commit -am '<task-title>'`
  hint. Clean workspaces, actors without a workspace, `none` backends,
  and failed VCS dirty probes silently omit the hint; the same entry is
  included in `--json` `nextSteps`.
- **TUI card body rows no longer collapse into the rounded bottom
  border, and bottom-label cards no longer grow a phantom blank row**
  (bug_tui_card_body_collapses_into_bottom_border). Follow-up to
  bug_tui_dashboard_top_card_scrolls_off: that fix correctly kept
  `flexShrink={1}` on the OUTER TitledBox so Yoga may shrink cards
  instead of scrolling the topmost card's chrome off-screen, but it
  also let the INNER border-body Box shrink below its body-row
  content. When the inner body under-allocated, ink painted the
  rounded bottom border on top of an overflowing child row
  (`╰─task text──╯`); when it over-allocated, cards with an inset
  `bottomLabel` showed a blank body row immediately above the
  `╰─ +N more · Shift+N ─╯` border. Fix: keep the outer shrink +
  app-level `overflow="hidden"` safety net, but pin the inner
  border-body Box to `flexShrink={0}` so its height stays tied to
  content and clipping happens at the card/dashboard boundary rather
  than inside the border chrome. Coverage adds an ink render
  regression in `test/tui-titled-box-render.test.ts` plus the
  existing TitledBox frame-height source guard. While there, the
  Tracks card now renders the singular `1 task` count instead of
  `1 tasks`.
- **Bucket-level export INDEX.md stays additive across one-workstream refreshes**
  (review_repo_export_bucket_index_not_additive). The renderer now
  writes `manifest_version: 2` and stores compact task summaries
  (`name` / `title` / `status` / `impact` / `effortDays`) in each
  `manifest.sources[].tasks[]` entry, so the top-level `INDEX.md`
  renders the union from the merged manifest instead of only the
  `input.sources` for the current call. v1 manifests are accepted
  on re-export by inferring summaries from existing task markdown
  where possible, then rewritten as v2.
- **Archive re-adds now document their snapshot-only contract**
  (review_repo_archive_events_not_incremental). `mu archive add`
  still targets end-of-milestone snapshot-and-destroy flows rather
  than incremental event mirroring; re-adding the same source is
  task-incremental only, and notes/events for already-archived tasks
  stay pinned to the original snapshot. The event payload and usage
  guide now say this explicitly instead of implying an event-stream
  refresh.
- **TUI DrillScrollView body lines now clip at the drill content
  width instead of wrapping** (bug_tui_drill_text_no_width_pin).
  Follow-up to bug_tui_drill_scrollview_wraps_long_lines: the body
  `<Text wrap="truncate">` was necessary but not sufficient because
  ink only truncates against a definite parent width. DrillScrollView
  now derives `contentWidth` from the same `termColsForLayout()` /
  `contentWidthFromCols()` helpers as cards and popups, and wraps the
  fallback plus `visible.map(...)` body lines in a single
  `<Box flexDirection="column" width={contentWidth}>`. That completes
  the width-pin trio with bug_tui_log_card_columns_misaligned and
  bug_tui_log_popup_columns_misaligned, covering every long-text drill
  (task notes, Workspaces git-show, Activity-log payload, agent
  scrollback, and Doctor remediation). While diagnosing the sibling
  Activity-log card report, the TUI log card/popup now run structured
  `task.claim\t...` events through `displayEventPayload()` before
  classification so the visible verb column is `task claim` instead
  of the raw `task.claim` sentinel.
- **TUI drill-mode bottom labels are yank-only again**
  (bug_tui_drill_double_hints). The Layer-2 contract from
  nit_tui_drill_inset_title_and_hints said `DrillScrollView`'s
  magenta bottom label should carry only the drill-specific yank
  recipe, while the j/k / Ctrl-D/U / Esc navigation cluster lives
  in the global StatusBar. Several popup drill views drifted and
  rendered the full nav recipe in their nested TitledBox, producing
  two stacked hint surfaces. All nine popup files now keep drill
  bottom labels to the yank recipe only (including Workspaces'
  commits and git-show drill levels); list-mode hints are
  unchanged. Static coverage in `test/tui-popup-shells.test.ts`
  bans renderable drill hints containing `j/k`, `Ctrl-D`, or
  `Esc back` so the duplication does not regress.
- **TUI dashboard topmost card no longer scrolls its top border
  off-screen on the single-ws dashboard**
  (bug_tui_dashboard_top_card_scrolls_off). Sibling of
  bug_tui_tab_switch_stale_render Layer 2: that fix added
  `overflow="hidden"` to the height-pinned root `<Box>` of all
  three frame branches (dashboard / popup / help), which catches
  the multi-ws case where the TabStrip adds one row over the nine
  cards and pushes total content to `rows+1`. The single-ws case
  has no TabStrip, but the nine cards' SUMMED natural height
  (especially Card 8 — Recent and Card 9 — Doctor, both with
  multi-row bodies) can still exceed `rows` on normal terminal
  sizes. Even with `overflow="hidden"` pinned, ink (via Yoga) gave
  every card its natural height first because Yoga's default
  `flexShrink` is **0** (unlike CSS's 1) — so the topmost card's
  chrome scrolled off the top of the terminal anyway. Fix: pin
  `flexShrink={1}` (named `TITLED_BOX_FLEX_SHRINK` for the
  next reader) on the outer `<Box>` of `TitledBox`, so Yoga
  distributes the deficit proportionally across cards and the
  bottommost card's body clips instead of the topmost card's
  chrome being lost. Outer Box also gains `overflow="hidden"` so
  the inner border-body Box clips cleanly when shrunk (otherwise
  the inner content overruns the now-shrunken outer slot and the
  visible artifact comes back even though Yoga did the math
  right). Belt-and-braces with the existing dashboard-root
  `overflow="hidden"`: the per-card `flexShrink` tells Yoga it MAY
  shrink cards, the root pin tells ink to clip if Yoga still
  didn't (e.g. a card with a hardcoded `height` prop). Coverage:
  `test/tui-app-frame-height.test.ts` grows two regression
  assertions — TitledBox's outer Box pins `flexShrink` AND
  `overflow="hidden"`, so a future refactor of TitledBox doesn't
  silently regress. The bottommost card already carries its own
  `+M more · Shift+N` truncation hint inset into its bottom border
  (feat_card_footer_inset) so the operator gets a visual cue when
  any card's body has been clipped.
- **TUI dashboard / popup / help frames clip overflow at the
  height-pinned root** (bug_tui_tab_switch_stale_render Layer 2).
  Multi-ws repro (`mu state --tui -w A,B`): the TabStrip adds one
  row above the nine cards; total content becomes `rows+1`. Ink's
  default overflow is "visible", so the overflowing row was
  emitted past the terminal bottom, the terminal scrolled, and
  the topmost card's `╭─ ¹ Agents … ─╮` top border vanished off
  the top edge. Fix: add `overflow="hidden"` to all three frame
  branches' height-pinned root `<Box>` (dashboard, popup, help).
  Ink then clips children to the box's computed bounds instead
  of overrunning, so nothing escapes above row 1. Single-ws TUI
  is byte-identical (no TabStrip → no overflow); the
  belt-and-braces sibling
  bug_tui_dashboard_top_card_scrolls_off above also covers the
  per-card variant where the cards' summed natural height alone
  beats `rows`.
- **TUI drill chrome insets into nested magenta border (was rendered
  as body rows nested inside the popup's cyan box)**
  (nit_tui_drill_inset_title_and_hints, Layer 2).
  `DrillScrollView` (`src/cli/tui/popups/drill.tsx`) previously
  rendered its title (`▸ mu task notes <id>`) + position indicator
  (`(1-72/311)`) as a row of body content and the optional `hint`
  (e.g. `loading…`) on the next row. After Layer 1 dropped the
  popup-level title row by inset-into-border, the drill view's
  in-body title row was the next-most-load-bearing chrome eater —
  visible as `▸ mu task notes <id> (1-72/311)` ABOVE the actual
  notes content inside the popup's cyan rounded box.
  DrillScrollView now wraps the visible slice in a nested
  `<TitledBox>` with magenta borders so:
    - title + position indicator inset into the top border
      (`╭─ mu task notes <id> · 1-72/311 ───╮`)
    - drill-specific yank-hint (e.g.
      ``y yanks `mu task notes <id>` ``) insets into the bottom
      border (`╰─ y yanks `mu task notes <id>` ───╯`)
  Magenta keeps the existing visual: the popup Shell's outer
  cyan border and the drill's inner magenta border distinguish
  nesting depth without doubled lines (TitledBox renders
  single-row borders only). DrillScrollView grows an optional
  `hint?: string` prop dedicated to the drill-specific verb
  recipe; the j/k/Esc/q nav cluster stays in the global
  StatusBar (popup-mode hint) so we never duplicate keys across
  surfaces. Per-consumer wiring:
    - `task-detail.tsx` (Tasks / Blocked / In-progress / Tracks
      task-detail leaf) passes `` `y yanks \`mu task notes ${id}\`` ``
    - `popups/log.tsx` drill passes
      `` 'y yanks `mu log --since N -n 1`' ``
    - `popups/doctor.tsx` drill passes the per-check remediation
      hint resolved via `yankCommandForCheck(focused)`
    - `popups/agents.tsx` drill keeps its `loading…` hint (no `y`
      bound in scrollback drill mode)
  `task-detail.tsx`'s outer `<Box flexDirection="column">` wrapper
  drops since `DrillScrollView` now owns the column layout. Layer 1
  bullet stays adjacent below.
- **TUI popup chrome insets into the rounded border (was rendered
  as body rows)** (nit_tui_drill_inset_title_and_hints, Layer 1).
  Every popup's local `Shell` / `PopupShell` previously rendered
  the popup-level title (e.g. `Tasks · popup (3/12)`) as the
  first body row inside its rounded box AND the per-popup hint
  (e.g. ``y yanks `mu task claim <id>` ``) as another body row
  near the bottom — two rows of chrome rendered as content inside
  the visible border, plus an extra dim margin between body and
  hint. The Shell now delegates to `<TitledBox>` (the same
  primitive the cards use) so the title insets into the top
  border line (`╭─ Tasks · popup (3/12) ─────╮`) and the
  per-popup hint insets into the bottom border line
  (`╰─ y yanks `mu task claim <id>` ─────╯`), matching the
  visual language already established for the dashboard cards via
  feat_card_footer_inset. TitledBox grows an optional
  `flexGrow?: number` prop applied to BOTH its outer column
  container and inner border-body Box so the popup Shells (which
  previously hand-rolled their own `<Box flexGrow={1} width={cols}>`
  per bug_tui_popups_fill_pane) keep filling the App-pinned popup
  region edge-to-edge through the delegate. All nine popup files
  (agents, blocked, doctor, inprogress, log, ready, tracks,
  workspaces) drop their hand-rolled rounded-box render and the
  in-body `Enter … · y yanks …` hint block. `popups/viewport.ts`'s
  `POPUP_CHROME_ROWS` budget drops from 6 to 3 (border 2 + filter
  prompt 1) since title and hint no longer cost body rows; popup
  bodies pick up ~3 extra visible rows for free on tall panes.
  Coverage: `test/tui-popup-shells.test.ts` flips its assertions
  from "Shell renders `<Box borderStyle="round">` with
  `flexGrow={1} width={cols}`" to "Shell delegates to `<TitledBox>`
  with `flexGrow={1}`"; `test/tui-popup-viewport.test.ts` updates
  the boundary cases for the new chrome budget. The Tasks-popup
  hint (yank-matrix per row state) re-resolves on cursor move so
  the bottom-border label stays in lockstep with the focused row.
  Layer 2 (DrillScrollView chrome insets too) ships separately.
- **TUI popup cursor-row highlight is now a solid full-width
  inverse line (was patchy — per-cell colours leaked through the
  outer `inverse`)** (bug_tui_popup_cursor_highlight_color_leak).
  Every list popup (`agents`, `blocked`, `doctor`, `inprogress`,
  `log`, `ready`, `tracks`, `workspaces`) used to render the
  cursor row by wrapping per-cell coloured `<Text>` chunks (color,
  bold, dimColor) inside a single `<Text inverse={sel}>`. ink
  emits an independent ANSI sequence per nested `<Text>`, and
  inner SGR sequences (color/bold/dim) RESET the outer `inverse`
  state — so cursor rows showed inverse video only on the bare
  whitespace cells while every coloured cell broke the highlight.
  Plus the row `<Box>` was content-sized, so the highlight ended
  at the last character of content rather than spanning the popup
  width. Fix: new `src/cli/tui/popups/cursor-row.tsx` exports a
  tiny `<CursorRow cells contentWidth>` helper that joins the
  already-padded cells with the canonical 2-space gutter
  (`COL_GUTTER`), padEnds to `contentWidth`, and wraps in a single
  `<Text inverse wrap="truncate">` on a width-pinned `<Box>` —
  the lazygit / k9s / btop convention (cursor row trades its
  per-cell palette for a solid full-width inverse line). Each
  popup's selected-row branch becomes a single `<CursorRow .../>`
  use; non-selected rows keep their per-cell palette unchanged.
  Tests: new `test/tui-cursor-row.test.ts` covers the helper
  (cells join with `COL_GUTTER`, padEnd to width, single `<Text
  inverse>` with no per-cell styling, edge cases for short cells /
  zero width / single cell) plus a static-source regression guard
  asserting every list popup imports `CursorRow` AND no longer
  carries an `inverse=` attribute on any `<Text>`.
- **TUI DrillScrollView body lines clip instead of wrapping**
  (bug_tui_drill_scrollview_wraps_long_lines). Every drill consumer
  (Tasks → notes, Workspaces → git show, Log → full payload, Agents
  → scrollback, Doctor → remediation) was rendering body lines as
  bare `<Text>`, which inherits ink's default `wrap="wrap"` and folds
  long lines onto a second terminal row. Two visible breakages: (1)
  the position counter (`L1-72/311`) counts logical lines, not
  terminal rows, so the magenta drill paints 90+ rows for the
  promised 8-line viewport and the bottom hint slides out of frame;
  (2) `j`/`k` stride matches logical lines but the cursor visually
  jumps multiple rows because previous wraps stretched the pane.
  Fix: the body-line `<Text>` in `src/cli/tui/popups/drill.tsx` now
  carries `wrap="truncate"` — TitledBox already pins the magenta
  inner box's width via its border layout, so truncate engages
  immediately. Completes the trio with sibling fixes
  bug_tui_log_card_columns_misaligned (cards) and
  bug_tui_log_popup_columns_misaligned (popup rows). Static-source
  regression guard in new `test/tui-drill-scrollview.test.ts`
  asserts the body-line `<Text>` carries `wrap="truncate"` (or
  `truncate-end`).
- **TUI card rows clip cleanly at contentWidth (was overflowing /
  wrapping due to gutter-accounting + ink-overflow bugs)**
  (bug_tui_log_card_columns_misaligned). Completes
  bug_tui_long_lines_overflow: even after every `layoutColumns` call
  site started passing `contentWidth`, rows in the Activity-log card
  (and to a lesser extent every other card / popup that renders
  tabular rows via `renderRow`) were still observed wrapping to a
  second terminal line / running past the rounded-border right edge.
  Two layers behind the symptom: (1) the protect/clip allocator's
  width math is correct, but consumers render padded cells joined by
  a literal `{"  "}` two-space gutter and any drift from that
  convention silently breaks alignment; (2) ink's default `<Text>`
  overflow behaviour is to WRAP, not truncate, so any 1-2 cell
  under-estimate by the allocator surfaces as a wrapped row instead
  of a graceful clip. Fix: defensive belt — every outermost row
  `<Text>` in `src/cli/tui/cards/*.tsx` and
  `src/cli/tui/popups/*.tsx` now sets `wrap="truncate"` so ink clips
  the joined row to the parent's width; static-source regression
  guard in new `test/tui-card-render-width.test.ts` asserts every
  `renderRow` consumer carries the prop AND uses the canonical
  `{"  "}` (2-space) gutter. Extra unit test in
  `test/tui-columns.test.ts` asserts `renderRow(...).join("  ")` ≤
  `totalWidth` for a synthetic protect+clip mix.
- **TUI in-progress + recent drill viewports no longer clip notes
  to 20 rows** (bug_tui_inprogress_recent_drill_viewport_clipped).
  When bug_tui_popup_data_doesnt_fill landed the dynamic
  `popupViewport(rows)` seam, six of the eight then-existing popups
  migrated; `inprogress.tsx` and `recent.tsx` were missed in the
  copy-paste sweep and kept their module-scope `const VIEWPORT = 20`,
  so on any pane taller than ~25 rows the drill body filled exactly
  20 visible lines and the rest of the popup chrome (cyan border)
  reached the pane bottom over a band of dead space — what the user
  saw as "popup covers viewport, content clipped". Both popups now
  use the dynamic viewport, and the centralisation work the user
  asked for ships alongside the bug fix: new `usePopupViewport()`
  ink hook in `src/cli/tui/popups/viewport.ts` wraps the
  `useStdout()` + `stdout?.rows ?? 24` + `popupViewport(...)` trio
  so every popup body is now one line (`const viewport =
  usePopupViewport()`) instead of three. All nine popups (`agents`,
  `blocked`, `doctor`, `inprogress`, `log`, `ready`, `recent`,
  `tracks`, `workspaces`) migrate in this commit; Workspaces drill
  passes its `WORKSPACES_DRILL_CHROME` override through the hook's
  optional argument. New `test/tui-popup-viewport-no-hardcode.test.ts`
  glob-walks `src/cli/tui/popups/*.tsx` (no curated list — that's
  exactly how the previous regression hid) and asserts no file
  re-introduces a `const VIEWPORT = …` literal; the existing
  `tui-popup-viewport.test.ts` was extended to cover the two
  previously-missed popups and to assert every popup imports the
  hook (not the raw helper) so the next regression can't slip
  through the same way.
- **TUI multi-ws frame no longer eats the topmost card's top border**
  (bug_tui_tab_switch_stale_render, layer 2). When the multi-ws
  TabStrip rendered above the cards, the strip's 1-row consumption
  pushed total content past the height-pinned root Box's `rows`
  budget; ink emitted the overflow past the terminal bottom, the
  terminal scrolled, and the topmost card's `╭─ ¹ Agents … ─╮`
  top border vanished off the top edge — the user saw what looked
  like a broken Agents card with naked body rows. `<Box height={rows}>`
  in all three frame branches (dashboard / popup / help) now also
  carries `overflow="hidden"`, instructing ink to clip children to
  the box's computed bounds rather than overrun. Single-ws TUI is
  byte-identical (the strip returns null, total height was already
  ≤ rows). New regression coverage in `test/tui-app-frame-height.test.ts`
  asserts every branch's root Box carries `overflow="hidden"` and
  that TabStrip lives INSIDE the height-pinned + clipping root (so
  flexbox accounts for its 1-row height when sizing the cards).
- **TUI multi-ws Tab no longer renders a mixed frame** (bug_tui_tab_switch_stale_render,
  layer 1). On `mu state --tui -w A,B`, pressing `Tab` flipped the
  TabStrip to ws B but the cards rendered ws A's data for one tick
  (the visible duration of the SQLite read in the new effect).
  `useDashboardSnapshot` now derives "the workstream prop changed"
  state-from-props during render via a `lastWsRef`, snapping the
  cached snapshot to `null` so cards immediately fall back to their
  loading-state path; the next tick repopulates fresh data within
  ~1 tickMs. New pure helper `shouldDiscardForWorkstream(prev,
  next)` exported for unit testing (and as a future seam for ws
  aliases / case-insensitive matching). New `test/tui-state-tab-switch.test.ts`
  covers the helper plus a static-source assertion that the hook
  wires the snap-to-null branch.
- **TUI per-row `<Box>` now pins `width={contentWidth}` so
  `wrap="truncate"` actually clips** (bug_tui_log_popup_columns_misaligned).
  Predecessor bug_tui_log_card_columns_misaligned added
  `wrap="truncate"` to every outer row `<Text>`, but ink only
  honours that prop when the parent `<Box>` has a defined width —
  Box width defaults to its content's intrinsic width, which IS
  the unbounded joined cells, so `truncate` had nothing to clip
  to. The user-visible regression: `Shift+4` Activity-log popup
  rows wrapping to a second terminal line and columns drifting
  across rows whenever any cell overflowed. Fix: every per-row
  outer `<Box key=...>` in `src/cli/tui/popups/*.tsx` (9 files)
  and `src/cli/tui/cards/*.tsx` (9 files) now carries
  `width={contentWidth}` so `wrap="truncate"` engages and rows
  clip at the rounded-border right edge instead of wrapping.
  Static-source regression guard added to
  `test/tui-card-render-width.test.ts` asserts every `renderRow`
  consumer's outer `<Box>` carries a `width={...}` attr.
- **TUI popup body data fills the whole popup, not the first 20 rows**
  (bug_tui_popup_data_doesnt_fill). After bug_tui_popups_fill_pane
  added `flexGrow={1}` + `width={cols}` so the popup Shell occupies
  the full pane edge-to-edge, the row data INSIDE the Shell was
  still capped at a hardcoded `const VIEWPORT = 20` in every popup
  file, leaving a band of empty space inside the popup border on
  panes taller than ~25 rows. New pure helper `popupViewport(rows,
  chromeOverride?)` in `src/cli/tui/popups/viewport.ts` (no ink/react
  imports) computes the body slice from `useStdout().rows` minus a
  6-row chrome budget (Shell border + title + hint margin + hint +
  filter prompt), with a floor of 8 rows so very-small terminals stay
  usable. Each popup (`agents`, `blocked`, `log`, `ready`, `tracks`,
  `workspaces`) now reads `useStdout().stdout?.rows` at render time,
  calls `popupViewport`, and threads the result through every slice /
  scroll-clamp / cursor-centring expression. Two per-popup nuances:
  Workspaces drill subtracts an extra row (the in-body title +
  indicator pair); Log popup uses the per-render viewport in BOTH the
  slice size AND the cursor-centring half-window. Tests:
  `test/tui-popup-viewport.test.ts` covers boundaries (default
  chrome, override, floor) plus a static-source regression guard
  asserting no popup file still contains `const VIEWPORT = 20`.
- **TUI long titles no longer overflow + wrap to a second line**
  (bug_tui_long_lines_overflow). `layoutColumns(rows, specs,
  totalWidth?)` short-circuits to natural widths when `totalWidth`
  is undefined; every card and popup body was calling it with two
  args, so the protect/clip remainder-distribution never ran and
  long titles in `Ready` / `Tasks` / `Blocked` / `In-progress` /
  `Recent` rows pushed past the rounded-border right edge and
  wrapped the trailing cells (owner, ROI, etc.) to a second
  terminal line. New `contentWidthFromCols(cols)` helper in
  `src/cli/tui/columns.ts` (subtracts the 4 cols of TitledBox /
  popup Shell chrome — 1 border + 1 padX per side) plus a sibling
  `termColsForLayout()` reading `process.stdout.columns` directly
  (bare property read instead of the `useStdout()` hook so card
  FCs called as plain functions in unit tests still work; ink
  re-renders the whole tree on SIGWINCH so the value is current).
  Threaded through every one of the 16 `layoutColumns` call sites
  in `src/cli/tui/{cards,popups}/*.tsx`. Static-source regression
  guard in `test/tui-columns.test.ts` asserts every caller passes
  a non-empty 3rd argument.
- **TUI dashboard no longer flickers on every tick**
  (bug_tui_flicker_on_every_tick). The `useDashboardSnapshot` hook
  was unconditionally calling `setSnap({ data, lastTickMs, error })`
  on every successful poll — even when nothing visible had changed —
  forcing React/ink to re-render every card 1×/sec. Two-layer fix in
  `src/cli/tui/state.ts`: (A) project the visible-affecting fields
  through a pure `snapshotKey()` and short-circuit `setData` when the
  JSON-encoded key is byte-equal to the previous one (returns the
  same `data` reference so ink's prop-diff bottoms out at the cards);
  (B) move `lastTickMs` into its own `useState` so the StatusBar's
  tick display can refresh without dragging the cards along. On a
  stable workstream the dashboard is now visually static between
  ticks; only the dim tick-rate indicator in the bottom-right may
  refresh, and ink diffs that down to ~3 cells of repaint.
- **TUI cards: `+M more` truncation hint inset into the bottom
  border** (feat_card_footer_inset). Previously each of the nine
  glance cards rendered the truncation hint as an extra body row
  inside the rounded box (e.g. `… +2 more · open Tracks popup
  (Shift+2)`), costing a full content row of the card's vertical
  budget AND still drawing the bottom border below it as a plain
  `─` fill. The hint now mirrors the top-border title: rendered
  INSIDE the bottom border line itself as `╰─ +2 more · Shift+2 ───╯`.
  TitledBox grows an optional `bottomLabel?: string` prop; when
  set, the inner Box's bottom border is suppressed and a single
  hand-rendered `<Text>` row is stacked below it. The geometry is
  shared with the top-border render path via the new pure helper
  `computeBorderRowDashes(cols, label)`. Per the design correction
  in the task notes, NO superscript/digit prefix on the bottom
  row — the label says "Shift+N" in plain text and the superscript
  is a top-edge convention only. All nine cards (agents, tracks,
  ready, log, workspaces, in-progress, blocked, recent, doctor)
  drop their in-body more-line render branches and pass
  `bottomLabel={truncated ? \`+${more} more · Shift+${cardId}\` :
  undefined}` instead. Coverage:
  test/tui-titled-box.test.ts grows `computeBorderRowDashes` cases
  (label-only, short-label dash-fill, empty-label, overflow floor,
  parity with `computeTopRowDashes`); each card test asserts the
  source no longer contains the in-body `\u2026 … + ... more` literal
  AND wires `bottomLabel` into the TitledBox call.
- **Test infrastructure: `openDb` refuses the user's real DB under
  VITEST** (Layer "db" of bug_test_flake_round_2). A new hard
  guard at the top of `openDb()` throws when called with a path
  that resolves to `<HOME or XDG_STATE_HOME>/mu/mu.db` while
  `process.env.VITEST` is set (or `NODE_ENV === "test"`). Tests
  MUST point at a per-test temp DB (via MU_DB_PATH — which
  test/_runCli.ts sets automatically — or an explicit `{ path }`
  argument). The previous regime relied on every test remembering
  to override the path; a slip silently mutated the dev box's live
  state (we observed a stray 'demo' workstream replicated from
  test/tui-acceptance.test.ts into ~/.local/state/mu/mu.db). The
  guard catches the leak source at the offending openDb() stack
  frame. Production code paths never set VITEST, so the guard is a
  complete no-op outside the test runner. Coverage:
  test/db-test-guard.test.ts (3 cases: HOME-rooted forbidden,
  arbitrary temp permitted, XDG_STATE_HOME-rooted forbidden).
- **Test infrastructure: `MU_TMUX_SOCKET` published at module load**
  (round-3 Part A of bug_test_flake_round_3). Previously the env
  publish lived inside `setup()` of `test/_global-teardown.ts`.
  vitest's globalSetup contract makes that work today (setup runs
  before fork), but the contract is fragile to pool changes and
  the failure mode is silent (sessions land on the user's default
  socket instead of the private `mu-test-<...>` one). The fix
  hoists `process.env.MU_TMUX_SOCKET = TEST_SOCKET` to the module
  body, which unambiguously runs before vitest spawns anything.
  `setup()` then bootstraps the actual tmux server and reverts the
  env publish on bootstrap failure for graceful fallback. Verified:
  3 back-to-back `npx vitest run` invocations leave zero `mu-*`
  residue on the default socket.
- **Test infrastructure: allowlist-based default-socket sweep**
  (round-3 Part B of bug_test_flake_round_3). The previous regex
  sweep `^mu-(acc|claim|kick|...)-` only matched sessions whose
  name started with a known fixture prefix followed by a dash, so
  bare-name leftovers like `mu-alpha`, `mu-demo`, `mu-ws`, `mu-ws2`,
  `mu-scratch`, `mu-beta`, `mu-gamma` (created by tests that hardcode
  short workstream names instead of using `freshWorkstream()`) lingered
  on the user's default socket forever. Replaced with an allowlist
  approach: the sweep computes the union of (1) `mu-*` sessions
  present at module-load time (the user's pre-existing tmux state)
  and (2) `mu-<name>` for every workstream in the user's REAL DB
  (read-only via better-sqlite3, bypassing the `openDb()` test
  guard). Anything starting with `mu-` and NOT in the union is
  killed by elimination. Verified by injecting a fake mid-suite
  `tmux new-session -s mu-injected-leak`: pre-existing `mu-alpha`
  survived; `mu-injected-leak` killed at teardown. Pure policy
  helper `sessionsToKill(allMuSessions, allowlist)` covered by
  test/global-teardown-allowlist.test.ts (6 cases).
- **Test infrastructure: allowlist drops the "pre-existing sessions"
  snapshot — DB-only** (round-4 of bug_test_flake_round_4_self_heal).
  The round-3 allowlist had a self-locking edge case: it snapshotted
  `mu-*` sessions present on the user's default socket at module-load
  time and never invalidated them, so test residue from a partially
  broken run got grandfathered in as protected forever. The
  orchestrator had to manually `tmux kill-session` 7 leaked sessions
  (`mu-alpha mu-beta mu-demo mu-gamma mu-scratch mu-ws mu-ws2`) that
  no future sweep would ever clean up. Replaced with a DB-only
  allowlist: `mu-<name>` for every row in the user's `workstreams`
  table, plus `mu-$MU_SESSION` if the orchestrator runs the suite
  inside a tmux pane. The pre-existing snapshot helper
  (`snapshotPreexistingSessions` + `PROTECTED_PREEXISTING_SESSIONS`)
  is gone. Cost: an ad-hoc `tmux new-session -t mu-foo` with no DB
  row gets killed by the sweep — the workaround is
  `mu workstream init foo` (which the user would have to do anyway
  to use it as a workstream). Pure-helper test coverage rebalanced:
  the "pre-existing overlap" case becomes "DB-row overlap" plus a
  new "ad-hoc with no DB row gets killed" case proving the
  self-heal contract holds.
- **Test infrastructure: `MU_*` env-var baseline scrub** (Layer
  "test" of bug_test_flake_round_2). vitest forks inherit the
  parent shell's environment; when a developer (or the
  orchestrator agent) runs `npm test` from a shell that exports
  `MU_PI_COMMAND=pi-meta` (Meta-internal pi wrapper),
  `MU_IDLE_THRESHOLD_MS=...`, etc., those values silently changed
  SDK behaviour underneath every test — 5 cli-agent-spawn-validation
  tests deterministically failed because `--cli pi` was being
  resolved to `pi-meta` (not on PATH outside Meta). New per-fork
  `setupFiles: ["./test/_setup.ts"]` hook deletes every `MU_*`
  env var at fork startup. Allowlist: `MU_TMUX_SOCKET` (set by
  `_global-teardown.ts` BEFORE fork spawn for Layer-3 isolation
  and inherited intentionally). Tests that need a specific value
  opt IN per-test via `process.env.X = "..."` or `withEnv()` from
  `test/_env.ts`. Verified by
  `MU_PI_COMMAND=pi-meta npm test` → 0 failures.
- **TUI dashboard renders flush with row 1 again** (bug_tui_topalign_v2).
  The alt-screen swap (`\x1b[?1049h`) inherits the cursor row from
  the prior buffer on iTerm2, Apple Terminal, and tmux's inner
  terminal, so the dashboard appeared mid-pane wherever the shell
  prompt happened to be. `ALT_SCREEN_ENTER` now extends to
  `\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l` (swap, clear, home, hide
  cursor) and `ALT_SCREEN_EXIT` to `\x1b[?25h\x1b[?1049l` (show
  cursor, restore prior buffer) — the lazygit/btop/htop convention.
  Constants moved to `src/cli/tui/escapes.ts` so they're unit-testable
  without booting ink.

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
| **utilities** (4)        | bare `mu` (human dashboard), `mu state` (canonical state card), `sql`, `doctor` |

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
