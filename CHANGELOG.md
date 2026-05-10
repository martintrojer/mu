# Changelog

All notable changes to mu are recorded here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 lands; pre-1.0 minor versions may include breaking changes
called out under "Breaking" in each entry.

---

## [Unreleased]

### Added

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

### Removed

- **`mu hud` removed; behavior moved to `mu state --hud`**
  (`merge_state_into_hud_render_mode`). The verb was a render-strategy
  variant of `mu state` (same data set; different presentation), so
  it collapses to a flag on the canonical card. Update tmux configs
  accordingly: `tmux display-popup -E 'mu hud -w X'` becomes
  `tmux display-popup -E 'mu state --hud -w X'`. Pre-1.0; no
  deprecation shim.

### Changed

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

- **`mu workspace create <missing-agent>` now throws a typed
  `AgentNotFoundError` (exit 3) instead of leaking SQLite's bare
  `NOT NULL constraint failed: vcs_workspaces.agent_id`**
  (`workspace_create_typed_no_agent_error`). The error message
  includes the agent name and workstream context so the operator
  knows which scope was searched. Surfaced during the parallel-
  fan-out spawn dogfood when an agent name was passed against the
  wrong workstream.

## [0.3.0] — unreleased

### Removed

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

### Added

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
  release (see the Breaking entry above).

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
  task notes; full table in [docs/OUTPUT_LABELS_AUDIT.md](docs/OUTPUT_LABELS_AUDIT.md).

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
  `audit_remove_task_*`. All scored 1/4 in
  [docs/VERB_AUDIT.md](docs/VERB_AUDIT.md); the underlying
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
