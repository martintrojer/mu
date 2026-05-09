# Verb audit — typed wrappers vs `mu sql` recipes

> Honest review of every verb shipped by `mu` (HEAD = `3e17bf3`, ~50
> verbs across 9 namespaces). Closes
> `audit_verbs_typed_vs_sql` in `mufeedback`.
>
> **This is an advisory document.** No verbs are removed by it. The
> audit's output IS this file plus the follow-up tasks filed at the
> bottom; the operator (or a follow-up wave) decides per-verb whether
> to ship a removal/merge.

## Method

For every verb below we score four dimensions, each 0 or 1, per the
spec in `audit_verbs_typed_vs_sql` note #398:

1. **ATOMICITY** — does the verb encapsulate ≥2 SQL statements that
   need transaction semantics (`UPDATE` + `INSERT INTO agent_logs`,
   `INSERT` + edge-creation, `VACUUM INTO` + delete)?
2. **SIDE-EFFECT BEYOND SQL** — does the verb call tmux, fs, vcs, or
   another non-SQL substrate?
3. **ERROR-MAPPING VALUE** — does the verb produce an actionable
   typed error (`AgentNotInWorkstreamError`,
   `TaskAlreadyOwnedError`, `CrossWorkstreamEdgeError`, …) that raw
   SQL would surface as opaque `FOREIGN KEY constraint failed`?
4. **NEXTSTEP / OUTPUT VALUE** — does the verb produce structured
   `Next: …` hints, status emoji, dim/yellow/red coloring, or
   cli-table3 column shaping that an LLM benefits from over raw
   rows?

A verb scoring 0/4 is REMOVE-with-sql-recipe. 1/4 is MERGE-candidate.
≥2/4 stays. **Irreversibility caveat**: any verb that wraps
`captureSnapshot` keeps even at 1/4, because the snapshot is safety
machinery the LLM cannot replicate via raw SQL.

**Contract-dependency caveat (added per the operator's
`agent_close_discipline_gap` finding):** verbs that depend on the
agent honouring a discipline contract (`mu task close --evidence …`
being called when work is done; `mu task claim --evidence …` being
called at claim time) are flagged below with `CONTRACT-DEPENDENT`.
Their typed-verb value is real, but their downstream value (e.g.
`mu task wait` unblocking on `CLOSED`) is contingent on the contract
holding at the other end. The audit does not penalise the verb for
this — the alternative is no contract at all — but documents it.

---

## Summary

- **Total verbs audited:** 58 (49 sub-verbs across 7 namespaces +
  9 top-level: bare `mu`, `whoami`, `my-tasks`, `my-next`, `state`,
  `hud`, `sql`, `undo`, `doctor`).
- **KEEP:** 51
- **MERGE candidates:** 4 (`task ready` → `task next -n 0`;
  `whoami` / `my-tasks` / `my-next` → `mu me [tasks|next]`)
- **REMOVE candidates:** 3 (`task search`, `task blocked`,
  `task goals`)
- **BUG (orphan code):** 1 — `cmdAdopt` exists in
  `src/cli/agents.ts:346` but is no longer wired by any
  `wireXxxCommands(program)`. The verb appears in `--help` strings
  and docs/skill ("Run `mu adopt <pane-id>`") but `node dist/cli.js
  adopt %15` errors with `too many arguments`. Filed as
  `bug_adopt_verb_unwired` (NOT a typed-vs-sql audit finding;
  surfaced incidentally during enumeration).

Each MERGE / REMOVE entry has a follow-up task filed with id
`audit_<disposition>_<verb_slug>` and the SQL recipe (or merge
target) inline in the note.

| Verb                       | Score | Disposition |
|----------------------------|------:|-------------|
| `mu` (mission control)     | 4/4   | KEEP        |
| `mu state`                 | 4/4   | KEEP        |
| `mu hud`                   | 4/4   | KEEP        |
| `mu doctor`                | 4/4   | KEEP        |
| `mu undo`                  | 4/4   | KEEP        |
| `mu sql`                   | 3/4   | KEEP (explicit escape hatch) |
| `mu workstream init`       | 4/4   | KEEP        |
| `mu workstream list`       | 2/4   | KEEP        |
| `mu workstream destroy`    | 4/4   | KEEP        |
| `mu workstream export`     | 3/4   | KEEP        |
| `mu agent spawn`           | 4/4   | KEEP        |
| `mu agent send`            | 3/4   | KEEP        |
| `mu agent read`            | 2/4   | KEEP        |
| `mu agent list`            | 4/4   | KEEP        |
| `mu agent show`            | 4/4   | KEEP        |
| `mu agent close`           | 4/4   | KEEP        |
| `mu agent free`            | 2/4   | KEEP        |
| `mu agent attach`          | 2/4   | KEEP        |
| `mu workspace create`      | 4/4   | KEEP        |
| `mu workspace list`        | 3/4   | KEEP        |
| `mu workspace free`        | 4/4   | KEEP        |
| `mu workspace path`        | 2/4   | KEEP        |
| `mu workspace orphans`     | 3/4   | KEEP        |
| `mu task add`              | 4/4   | KEEP        |
| `mu task list`             | 1/4   | KEEP (output value alone) |
| `mu task next`             | 2/4   | KEEP        |
| `mu task ready`            | 1/4   | **MERGE** into `task next` |
| `mu task blocked`          | 1/4   | **REMOVE-with-recipe** |
| `mu task goals`            | 1/4   | **REMOVE-with-recipe** |
| `mu task owned-by`         | 2/4   | KEEP        |
| `mu task search`           | 1/4   | **REMOVE-with-recipe** |
| `mu task note`             | 3/4   | KEEP        |
| `mu task show`             | 2/4   | KEEP        |
| `mu task tree`             | 2/4   | KEEP        |
| `mu task notes`            | 1/4   | KEEP (sibling of `show`) |
| `mu task close`            | 4/4   | KEEP (CONTRACT-DEPENDENT) |
| `mu task open`             | 3/4   | KEEP        |
| `mu task reject`           | 4/4   | KEEP        |
| `mu task defer`            | 4/4   | KEEP        |
| `mu task release`          | 4/4   | KEEP        |
| `mu task claim`            | 4/4   | KEEP (CONTRACT-DEPENDENT) |
| `mu task block`            | 3/4   | KEEP        |
| `mu task unblock`          | 2/4   | KEEP        |
| `mu task delete`           | 4/4   | KEEP (snapshot wrap) |
| `mu task update`           | 2/4   | KEEP        |
| `mu task reparent`         | 3/4   | KEEP        |
| `mu task wait`             | 4/4   | KEEP (CONTRACT-DEPENDENT) |
| `mu log` (read)            | 2/4   | KEEP        |
| `mu log` (write)           | 3/4   | KEEP        |
| `mu log --tail`            | 2/4   | KEEP        |
| `mu approve add`           | 4/4   | KEEP        |
| `mu approve list`          | 1/4   | KEEP (sibling of approve) |
| `mu approve grant`         | 3/4   | KEEP        |
| `mu approve deny`          | 3/4   | KEEP        |
| `mu approve wait`          | 3/4   | KEEP (CONTRACT-DEPENDENT) |
| `mu snapshot list`         | 1/4   | KEEP (paired with `undo`) |
| `mu snapshot show`         | 1/4   | KEEP (paired with `undo`) |
| `mu whoami`                | 2/4   | **MERGE** into `mu me` |
| `mu my-tasks`              | 1/4   | **MERGE** into `mu me tasks` |
| `mu my-next`               | 1/4   | **MERGE** into `mu me next` |

---

## Top-level verbs

### bare `mu` (mission control)

- SQL surface  : SELECT agents + reconcile + `getParallelTracks` +
  `listReady` (≥4 reads + a `status-only` reconcile)
- Atomicity    : 1 (status-only reconcile = read + conditional UPDATE)
- Side-effect  : 1 (tmux: `list-panes` per agent for status detect)
- Error-map    : 0 (no typed errors — discovery view tolerates
  unresolved workstream)
- Output value : 1 (composed table: agents + tracks + ready,
  status emoji, ROI sort, mu-`<workstream>` header)
- SCORE: 3/4 (+1 for being THE verb the LLM hits first → effective
  4/4)
- DISPOSITION: KEEP. Bare `mu` is the LLM's onboarding view.
  Workstream-discovery fallback when no `-w` resolves is operator
  empathy, not feature creep.

### `mu state`

- SQL surface  : SELECT across agents/tracks/ready/blocked/in_progress/
  recent_closed/workspaces/workspace_orphans/agent_logs (8 reads)
- Atomicity    : 1 (status-only reconcile + workspace-staleness
  decoration)
- Side-effect  : 1 (tmux + vcs `commitsBehindMain` per workspace)
- Error-map    : 1 (`WorkstreamRequiredError` from `resolveWorkstream`)
- Output value : 1 (cli-table3 sections: Agents / Tracks / Ready /
  In-progress / Blocked / Recent closed / Workspaces with stale
  warning / Workspace orphans / Recent events; JSON-first design
  documented)
- SCORE: 4/4
- DISPOSITION: KEEP. The "what does an LLM look at first?" verb.
  Eight reads + reconcile + vcs decoration is exactly the sort of
  composition `mu sql` cannot replicate one-shot.

### `mu hud`

- SQL surface  : same reads as `mu state`, dynamic table layout
  packed to terminal/pane width
- Atomicity    : 1 (status-only reconcile)
- Side-effect  : 1 (tmux for status detect; `tput`/`stty` for terminal
  size)
- Error-map    : 1 (`WorkstreamRequiredError`)
- Output value : 1 (dynamic-fit table layout; the explicit reason
  the verb exists separate from `mu state` — `state` is JSON-first,
  `hud` is "fill the pane")
- SCORE: 4/4
- DISPOSITION: KEEP. Composes with `watch -n 5 mu hud` and `tmux
  display-popup -E 'mu hud'`; the dynamic layout IS the value.

### `mu doctor`

- SQL surface  : `PRAGMA integrity_check`, schema_version row,
  snapshot dir scan, tmux server probe, vcs probes
- Atomicity    : 1 (multi-substrate sequential probes)
- Side-effect  : 1 (tmux, fs, vcs)
- Error-map    : 1 (typed warnings per check)
- Output value : 1 (✓/⚠/✗ status table per check + remediation hints)
- SCORE: 4/4
- DISPOSITION: KEEP. Diagnostic value scales with substrate count;
  this is exactly what raw SQL cannot reach.

### `mu undo`

- SQL surface  : `restoreSnapshot` (closes live handle, copies file,
  re-opens), then per-workstream `reconcile(mode: report-only)`
- Atomicity    : 1 (close + copy + reopen + reconcile is multi-step
  and irreversible without the auto-`pre-restore` snapshot)
- Side-effect  : 1 (fs file copy; tmux for reconcile)
- Error-map    : 1 (`SnapshotNotFoundError`,
  `SnapshotVersionMismatchError`, `SnapshotFileMissingError`)
- Output value : 1 (dry-run preview with size + label + workstream;
  post-restore drift report per workstream)
- SCORE: 4/4
- DISPOSITION: KEEP. Irreversibility makes this one of mu's
  highest-value typed verbs. Raw SQL has no concept of snapshots.

### `mu sql`

- SQL surface  : whatever the operator types
- Atomicity    : 1 (multi-statement path wraps in BEGIN/COMMIT with
  `--confirm-rows` rollback gate)
- Side-effect  : 0 (DB only, by design)
- Error-map    : 1 (`UsageError` for `--confirm-rows` mismatch +
  rollback)
- Output value : 1 (`muTable` row render with truncation safety;
  prepares-vs-execs split for change-count surface)
- SCORE: 3/4
- DISPOSITION: KEEP. The explicit, documented escape hatch — its
  raison d'être is to make REMOVE-with-sql-recipe verbs feasible.
  `--confirm-rows` is the safety lever that prevents typo cascades.

---

## `mu workstream`

### `mu workstream init <name>`

- SQL surface  : `INSERT OR IGNORE INTO workstreams` + initial
  log entries
- Atomicity    : 1 (DB row + tmux session create + border setup)
- Side-effect  : 1 (`tmux new-session`, `select-pane -T`, border
  enablement)
- Error-map    : 1 (`WorkstreamNameInvalidError`, `TmuxError`)
- Output value : 1 (Next: hints to spawn first agent, attach session)
- SCORE: 4/4
- DISPOSITION: KEEP.

### `mu workstream list`

- SQL surface  : `SELECT * FROM workstreams` LEFT JOIN per-workstream
  agent count + tmux `list-sessions` cross-reference
- Atomicity    : 0
- Side-effect  : 1 (tmux session enumeration)
- Error-map    : 0
- Output value : 1 (table with active/registered status; surfaces
  workstreams that exist in DB-only or tmux-only)
- SCORE: 2/4
- DISPOSITION: KEEP. The DB-vs-tmux cross-reference is the value.
  Raw SQL would miss the tmux side entirely.

### `mu workstream destroy`

- SQL surface  : pre-destroy export + `captureSnapshot` + cascade
  DELETE across agents/tasks/edges/notes/workspaces/approvals/logs
- Atomicity    : 1 (export + snapshot + cascade is transactional)
- Side-effect  : 1 (tmux kill-session, fs export dir, vcs workspace
  teardown)
- Error-map    : 1 (`WorkstreamNotFoundError` and friends)
- Output value : 1 (dry-run summary; failedWorkspaces list; pre-destroy
  export path printed for recovery)
- SCORE: 4/4
- DISPOSITION: KEEP. Most irreversible verb in the system.

### `mu workstream export`

- SQL surface  : SELECT every task + notes; render markdown + sha256
  + write per-file
- Atomicity    : 0 (read-only DB; fs writes are per-file idempotent
  by sha256)
- Side-effect  : 1 (fs write + manifest.json with `latestSeq` cursor)
- Error-map    : 1 (`WorkstreamNotFoundError`,
  `HomeDirAsProjectRootError`)
- Output value : 1 (idempotent re-render; deleted-task banner
  preservation; INDEX.md / README.md summary)
- SCORE: 3/4
- DISPOSITION: KEEP. The composition (markdown + sha-short-circuit +
  deleted-task preservation + manifest cursor) is too complex for
  one `mu sql` line.

---

## `mu agent`

### `mu agent spawn <name>`

- SQL surface  : `INSERT INTO agents` + log "agent spawn" + (optional)
  workspace create + (optional) workspace prestage
- Atomicity    : 1 (DB row + tmux pane + workspace + liveness check)
- Side-effect  : 1 (tmux split-window, send-keys initial command,
  vcs workspace, fs)
- Error-map    : 1 (`AgentExistsError`, `AgentDiedOnSpawnError`,
  `WorkspaceExistsError`, `TmuxError`)
- Output value : 1 (Next: hints; spawn liveness probe gate)
- SCORE: 4/4
- DISPOSITION: KEEP. Highest-orchestration verb in the codebase.

### `mu agent send <name> <text>`

- SQL surface  : 0 (read agent row, write log entry)
- Atomicity    : 1 (read + tmux send + log)
- Side-effect  : 1 (tmux bracketed-paste protocol — the canonical
  `send-keys` workaround for agent TUIs that interpret `/`, `?`, `f`)
- Error-map    : 1 (`AgentNotFoundError`, `AgentNotInWorkstreamError`,
  `TmuxError`)
- Output value : 0 (silent on success, dim summary)
- SCORE: 3/4
- DISPOSITION: KEEP. The bracketed-paste sequence is exactly the
  load-bearing protocol logic that AGENTS.md singles out: "Naive
  `tmux send-keys "<text>"` is broken — characters like `/`, `?`,
  `f` get interpreted by the agent's TUI."

### `mu agent read <name>`

- SQL surface  : SELECT agent row
- Atomicity    : 0
- Side-effect  : 1 (tmux `capture-pane`)
- Error-map    : 1 (`AgentNotFoundError`)
- Output value : 0 (raw scrollback to stdout; no formatting)
- SCORE: 2/4
- DISPOSITION: KEEP. The `capture-pane` substrate IS the value. SQL
  workaround would still need to shell out to tmux.

### `mu agent list`

- SQL surface  : SELECT agents + reconcile (ghost prune + status
  detect + orphan surface)
- Atomicity    : 1 (full reconcile pass)
- Side-effect  : 1 (tmux pane enumeration; status detect from
  scrollback)
- Error-map    : 1 (`WorkstreamRequiredError`)
- Output value : 1 (Agents table with status emoji + Orphan panes
  block with `mu adopt` hint — see BUG note above)
- SCORE: 4/4
- DISPOSITION: KEEP. The reconcile pass and orphan-pane surfacing
  are uniquely typed-verb territory.

### `mu agent show <name>`

- SQL surface  : SELECT agent row + scrollback capture + fresh-status
  detect + conditional UPDATE
- Atomicity    : 1 (read + tmux capture + detect + write under
  `shouldOverwriteAgentStatus` rule)
- Side-effect  : 1 (tmux `capture-pane`)
- Error-map    : 1 (`AgentNotFoundError`,
  `AgentNotInWorkstreamError`)
- Output value : 1 (composed: agent row + recent scrollback +
  fresh-status reconciliation; status-flip-on-show is the operator-
  empathy reason this verb earns its score over `agent list` +
  `agent read`)
- SCORE: 4/4
- DISPOSITION: KEEP.

### `mu agent close <name>`

- SQL surface  : `captureSnapshot` + DELETE agent + log "agent close"
  + (optional) workspace teardown
- Atomicity    : 1 (snapshot + DELETE + tmux kill + fs rm)
- Side-effect  : 1 (tmux kill-pane; fs workspace removal under
  `--discard-workspace`)
- Error-map    : 1 (`AgentNotFoundError`, `WorkspacePreservedError`)
- Output value : 1 (Next: hints incl. re-spawn; explicit
  workspace-preserved refusal with remediation)
- SCORE: 4/4
- DISPOSITION: KEEP. Snapshot wrap is irreversibility safety.

### `mu agent free <name>`

- SQL surface  : `UPDATE agents SET status='free' WHERE name=?` +
  log entry
- Atomicity    : 1 (UPDATE + log; idempotent)
- Side-effect  : 0
- Error-map    : 1 (`AgentNotFoundError`)
- Output value : 0 (one-line "Freed X" or dim no-op)
- SCORE: 2/4
- DISPOSITION: KEEP. Score is on the threshold, but the verb name
  `free` documents intent (vs raw `UPDATE … status='free'`) and the
  log entry preserves the "operator forced free" audit trail. The
  reconcile-flips-back-on-real-activity behaviour is the
  composition value.

### `mu agent attach <name>`

- SQL surface  : SELECT agent row
- Atomicity    : 0
- Side-effect  : 1 (tmux `capture-pane` for full scrollback;
  prints attach command)
- Error-map    : 1 (`AgentNotFoundError`)
- Output value : 0 (full scrollback dump + attach command line)
- SCORE: 2/4
- DISPOSITION: KEEP. The full-scrollback + attach-command-as-string
  composition is the value; raw SQL gets you neither.

---

## `mu workspace`

### `mu workspace create <agent>`

- SQL surface  : INSERT vcs_workspaces + log
- Atomicity    : 1 (DB row + vcs branch/clone + fs dir creation +
  cleanup-on-throw)
- Side-effect  : 1 (vcs: jj `new`, sl `clone`, git `worktree add`;
  fs)
- Error-map    : 1 (`WorkspaceExistsError`, `WorkspacePathNotEmptyError`,
  `HomeDirAsProjectRootError`)
- Output value : 1 (Next: hints; backend auto-detect; `--workspace-from`
  for ref-based)
- SCORE: 4/4
- DISPOSITION: KEEP.

### `mu workspace list`

- SQL surface  : SELECT vcs_workspaces + per-row vcs `commitsBehindMain`
  decoration
- Atomicity    : 0
- Side-effect  : 1 (vcs reads per workspace)
- Error-map    : 1 (`WorkstreamRequiredError`)
- Output value : 1 (cli-table with stale ⚠ column;
  bug_workspace_stale_parent_silent_drift is the reason this is
  decorated, not raw)
- SCORE: 3/4
- DISPOSITION: KEEP.

### `mu workspace free <agent>`

- SQL surface  : DELETE vcs_workspaces + log + (optional) auto-commit
- Atomicity    : 1 (commit + branch teardown + fs rm + DELETE)
- Side-effect  : 1 (vcs commit/teardown; fs rm -rf)
- Error-map    : 1 (`WorkspaceNotFoundError`)
- Output value : 1 (loss warning if pending changes; Next: hints)
- SCORE: 4/4
- DISPOSITION: KEEP.

### `mu workspace path <agent>`

- SQL surface  : `SELECT path FROM vcs_workspaces WHERE agent_name=?`
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 1 (`WorkspaceNotFoundError`)
- Output value : 1 (BARE path, no decoration — the `cd $(mu workspace
  path X)` shell-composition contract; this IS the output value)
- SCORE: 2/4
- DISPOSITION: KEEP. The bare-print contract is the value; raw SQL
  would print row decoration. (`mu sql` could do
  `--json` + `jq -r '.[0].path'` but that's a 3-step.)

### `mu workspace orphans`

- SQL surface  : LEFT JOIN fs scan vs `SELECT path FROM
  vcs_workspaces`
- Atomicity    : 0
- Side-effect  : 1 (fs scan of `<state-dir>/workspaces/<workstream>/`)
- Error-map    : 1 (`WorkstreamRequiredError`)
- Output value : 1 (cleanup-recipe Next: hints; surfaced by
  `bug_workspace_orphan_not_in_state` — that's exactly the
  "fs scan + sql LEFT JOIN that raw SQL can't do" case)
- SCORE: 3/4
- DISPOSITION: KEEP.

---

## `mu task`

### `mu task add [id]`

- SQL surface  : INSERT task + (optional) `addBlockEdge` per
  blocker (cycle check + cross-workstream check per edge)
- Atomicity    : 1 (multi-INSERT + cycle validation)
- Side-effect  : 0
- Error-map    : 1 (`TaskIdInvalidError`, `TaskExistsError`,
  `TaskNotFoundError` (for blocker), `CycleError`,
  `CrossWorkstreamEdgeError`)
- Output value : 1 (id-from-title slugify; Next: hints; ROI hint)
- SCORE: 4/4 (3 typed-error classes + slugify + edges = the verb
  that justifies the most typed surface in the codebase)
- DISPOSITION: KEEP.

### `mu task list`

- SQL surface  : `SELECT * FROM tasks WHERE workstream=? [AND status=?]
  ORDER BY <sort>`
- Atomicity    : 0 (one SELECT)
- Side-effect  : 0
- Error-map    : 0 (no typed errors beyond `WorkstreamRequiredError`
  shared with every -w verb)
- Output value : 1 (formatTaskListTable + status emoji + ROI
  computation + sort key with relative-time column when sort=recency
  or age)
- SCORE: 1/4
- DISPOSITION: KEEP. The `--sort recency|age` with auto-injected
  relative-time column (added by `nit_task_list_sort_by_recency`)
  AND the per-status emoji column AND the ROI synthesis are LLM-
  consumable in a way `mu sql "SELECT … ORDER BY …"` is not. Output
  value alone justifies the verb.
- SQL workaround: `mu sql "SELECT local_id, status, impact,
  effort_days, (impact*1.0/effort_days) AS roi FROM tasks WHERE
  workstream='X' [AND status='Y'] ORDER BY roi DESC"`

### `mu task next`

- SQL surface  : `SELECT * FROM ready WHERE workstream=? ORDER BY
  <sort> LIMIT k`
- Atomicity    : 0 (one SELECT against the `ready` view)
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (top-K render; Next: hints; ready-view
  encapsulation; the "what should I do?" semantic is itself the
  value)
- SCORE: 1/4 (+1 effective for being THE LLM dispatch verb →
  effective 2/4)
- DISPOSITION: KEEP. The `ready` view + ROI sort + top-K cap is the
  LLM's primary "what now?" verb. Removing it would force every
  `mu next` site to memorise the SQL.

### `mu task ready`

- SQL surface  : `SELECT * FROM ready WHERE workstream=? ORDER BY
  <sort>` (NO `LIMIT` — that's the ONLY difference from `task next`)
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (same renderer as `task next`)
- SCORE: 1/4
- DISPOSITION: **MERGE** into `task next`. **SHIPPED** in
  `audit_merge_task_ready_into_next`
  (audit_cleanups_post_schema_v5_wave). `mu task next -n 0` is now
  the unlimited shape (K=0 in `cmdTaskNext` skips the slice). The
  `task ready` Commander wiring + `cmdTaskReady` were deleted; the
  `ready` SQL view stays (used by `mu state` / `mu hud`).

### `mu task blocked`

- SQL surface  : `SELECT * FROM blocked WHERE workstream=?`
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (table with status emoji)
- SCORE: 1/4
- DISPOSITION: **REMOVE-with-recipe**. **SHIPPED** in
  `audit_remove_task_blocked` (audit_cleanups_post_schema_v5_wave).
  The `blocked` view + the SDK helper `listBlocked` survive
  (`mu state` consumes the latter); only the verb wiring is gone.
- SQL workaround: `mu sql "SELECT local_id, status, title FROM
  blocked WHERE workstream='X'"`.

### `mu task goals`

- SQL surface  : `SELECT * FROM goals WHERE workstream=?`
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (table)
- SCORE: 1/4
- DISPOSITION: **REMOVE-with-recipe**. **SHIPPED** in
  `audit_remove_task_goals` (audit_cleanups_post_schema_v5_wave).
  The `goals` view + the SDK helper `listGoals` survive
  (`src/tracks.ts` consumes the latter); only the verb wiring is gone.
- SQL workaround: `mu sql "SELECT local_id, status, title FROM goals
  WHERE workstream='X'"`.

### `mu task owned-by <agent>`

- SQL surface  : `SELECT * FROM tasks WHERE owner=? AND status NOT
  IN ('CLOSED','REJECTED','DEFERRED') ORDER BY workstream, local_id`
  (or with-closed variant)
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (cross-workstream table with workstream column
  injected — agent names are global, so this verb's row shape is
  different from `task list`)
- SCORE: 2/4 (the implicit-exclude-CLOSED-by-default semantics is a
  real bug-fix surfaced in dogfooding; raw SQL would return CLOSED
  rows by default and confuse the operator)
- DISPOSITION: KEEP. The default-excludes-terminal-states behaviour
  with `--include-closed` opt-in is the value — precisely the bug
  noted inline at `src/tasks.ts:380` ("Real bug found in real use").

### `mu task search <pattern>`

- SQL surface  : `SELECT * FROM tasks WHERE LOWER(title) LIKE ?
  OR LOWER(local_id) LIKE ?` (with optional UNION over `task_notes`)
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (cross-workstream table when `--all`; same
  row format as `task list`)
- SCORE: 1/4
- DISPOSITION: **REMOVE-with-recipe**. `--in-notes` is the only
  composition sugar (UNION over `task_notes`); even that is one
  `UNION ALL` away in `mu sql`. The case-insensitive LIKE wrap is
  trivial.
- SQL workaround:

  ```sh
  mu sql "SELECT local_id, status, title FROM tasks
          WHERE workstream='X' AND LOWER(title) LIKE '%foo%'"

  # with --in-notes:
  mu sql "SELECT t.local_id, t.status, t.title
          FROM tasks t LEFT JOIN task_notes n ON n.task_id=t.local_id
          WHERE t.workstream='X' AND
                (LOWER(t.title) LIKE '%foo%' OR LOWER(n.content) LIKE '%foo%')
          GROUP BY t.local_id"
  ```

  **SHIPPED** in `audit_remove_task_search`
  (audit_cleanups_post_schema_v5_wave). The SDK helper `searchTasks`
  survives as reusable surface (covered by unit tests in
  `test/tasks.test.ts`); only the verb wiring is gone.

### `mu task note <id> <text>`

- SQL surface  : INSERT task_notes + author resolution chain
- Atomicity    : 1 (auto-resolve author from
  `MU_AGENT_NAME > pane title > $USER`; INSERT under that author)
- Side-effect  : 0 (no tmux/fs)
- Error-map    : 1 (`TaskNotFoundError`, `TaskNotInWorkstreamError`)
- Output value : 1 (`unescapeNoteText` decoder for `\n`/`\t`;
  shell-quoting hint in Next: text)
- SCORE: 3/4
- DISPOSITION: KEEP. The author-resolution chain is the value
  (mufeedback note #176 documents the bug it fixed).

### `mu task show <id>`

- SQL surface  : SELECT task + edges + notes + (conditional)
  `lastClaimActor` from `agent_logs`
- Atomicity    : 0 (multi-read)
- Side-effect  : 0
- Error-map    : 1 (`TaskNotFoundError`,
  `TaskNotInWorkstreamError`)
- Output value : 1 (composed render: row + edges block + notes block
  + `(self: <actor>)` synthesis when `owner IS NULL`)
- SCORE: 2/4
- DISPOSITION: KEEP. The `(self: <actor>)` synthesis from `agent_logs`
  on `owner IS NULL` IS the composition value — a raw SQL would not
  surface "who anonymously claimed this".

### `mu task tree <id>`

- SQL surface  : Recursive CTE over `task_edges` (blockers or
  dependents)
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 1 (`TaskNotFoundError`)
- Output value : 1 (ASCII tree; diamond-collapse marker; `--down`
  flip; depth-aware indentation)
- SCORE: 2/4
- DISPOSITION: KEEP. The recursive CTE plus diamond-collapse plus
  ASCII renderer is the kind of composition that `mu sql` cannot
  meaningfully replace.

### `mu task notes <id>`

- SQL surface  : `SELECT * FROM task_notes WHERE task_id=? ORDER BY id`
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 1 (`TaskNotFoundError`)
- Output value : 1 (per-note formatted block with author + dim
  timestamp; matches the format in `mu task show`)
- SCORE: 1/4 (+1 effective for being the
  paired-with-`task show` view → effective 2/4)
- DISPOSITION: KEEP. Sibling of `task show` — operator wants to
  read the conversation without re-reading the row. Removing
  forces them to compose `mu sql` AND lose the format.

### `mu task close <id>`

- SQL surface  : `UPDATE tasks SET status='CLOSED' WHERE local_id=?`
  + INSERT agent_log "task close" + (with `--evidence`) INSERT note
- Atomicity    : 1 (UPDATE + log + optional note in one transaction)
- Side-effect  : 1 (tmux: `refreshAgentTitle(owner)` so the pane
  border/title updates)
- Error-map    : 1 (`TaskNotFoundError`,
  `TaskNotInWorkstreamError`)
- Output value : 1 (Next: hints; idempotent no-op message; previous-
  status shown for grounding)
- SCORE: 4/4
- DISPOSITION: KEEP. **CONTRACT-DEPENDENT**: the orchestrator's `mu
  task wait` only unblocks when this verb runs — the agent_close_
  discipline_gap finding (mufeedback) showed agents skipping the
  call. The verb itself is high-value; downstream value depends on
  the close-after-work contract holding.

### `mu task open <id>`

- SQL surface  : `UPDATE tasks SET status='OPEN'` + log entry
- Atomicity    : 1 (UPDATE + log + title refresh)
- Side-effect  : 1 (tmux title refresh — only if `owner` is set; we
  don't refresh on no-op)
- Error-map    : 1 (`TaskNotFoundError`)
- Output value : 1 (idempotent message; Next: claim/close hints)
- SCORE: 3/4 (atomicity is debatable since refresh is conditional;
  award full credit because the no-op-doesn't-refresh logic is
  itself a bug-fix)
- DISPOSITION: KEEP.

### `mu task reject <id>` / `mu task defer <id>`

- SQL surface  : multi-step: cycle through dependents to refuse
  if any are open OR (with `--cascade`) recursively walk descendants
  + UPDATE each + log per
- Atomicity    : 1 (cascade is multi-row UPDATE in one transaction;
  dry-run-then-`--yes` flow is the deliberate friction)
- Side-effect  : 1 (refresh title for every owner of an affected
  task)
- Error-map    : 1 (`TaskHasOpenDependentsError`,
  `TaskNotFoundError`, `UsageError` for `--yes` without `--cascade`)
- Output value : 1 (cascade dry-run preview with title +
  status per affected task; `bug_cascade_reject_too_aggressive`
  motivated this)
- SCORE: 4/4
- DISPOSITION: KEEP (both verbs).

### `mu task release <id>`

- SQL surface  : `UPDATE tasks SET owner=NULL` (+ optional `status=
  'OPEN'` with `--reopen`) + log + optional evidence note
- Atomicity    : 1 (UPDATE + status flip + log + note + title
  refresh)
- Side-effect  : 1 (tmux title refresh for previous owner)
- Error-map    : 1 (`TaskNotFoundError`)
- Output value : 1 (Next: reclaim hint; previous-owner shown;
  status transition arrow `(IN_PROGRESS → OPEN)`)
- SCORE: 4/4
- DISPOSITION: KEEP.

### `mu task claim <id>`

- SQL surface  : CAS `UPDATE tasks SET owner=?, status='IN_PROGRESS'
  WHERE local_id=? AND owner IS NULL` + log + optional evidence note
  + cross-workstream FK validation
- Atomicity    : 1 (the canonical CAS atomicity verb of mu)
- Side-effect  : 1 (tmux title refresh for new owner)
- Error-map    : 1 (`TaskAlreadyOwnedError`,
  `ClaimerNotRegisteredError`, `CrossWorkstreamEdgeError`,
  `TaskNotFoundError`, `UsageError` for `--self`+`--for` conflict)
- Output value : 1 (`--self` anonymous mode; Next: hints incl. note
  template; previous-status shown)
- SCORE: 4/4
- DISPOSITION: KEEP. **CONTRACT-DEPENDENT**: the
  `--evidence` opt-in is the audit trail; agents that skip it
  degrade audit but not orchestration. (Distinct from `task close`
  which orchestration depends on absolutely.)

### `mu task block <blocked> --by <blocker>`

- SQL surface  : INSERT task_edges + cycle check + cross-workstream
  check
- Atomicity    : 1 (validation + INSERT + cycle re-check)
- Side-effect  : 0
- Error-map    : 1 (`CycleError`, `CrossWorkstreamEdgeError`,
  `TaskNotFoundError`)
- Output value : 1 (Next: tree/unblock hints; idempotent message)
- SCORE: 3/4
- DISPOSITION: KEEP.

### `mu task unblock <blocked> --by <blocker>`

- SQL surface  : `DELETE FROM task_edges WHERE from_task=? AND
  to_task=?`
- Atomicity    : 0 (single statement; no log entry today)
- Side-effect  : 0
- Error-map    : 1 (`TaskNotFoundError` for either side)
- Output value : 1 (Next: tree hint; idempotent no-op message)
- SCORE: 2/4
- DISPOSITION: KEEP. Score is on the threshold but the verb is the
  obvious counterpart to `block` — removing it would force the
  operator to compose a DELETE that the other half doesn't require.

### `mu task delete <id>`

- SQL surface  : `captureSnapshot` + `DELETE FROM tasks WHERE
  local_id=?` (cascades to `task_edges`/`task_notes` via FK)
- Atomicity    : 1 (snapshot + delete + cascade)
- Side-effect  : 1 (snapshot file write)
- Error-map    : 1 (`TaskNotFoundError` — though `delete` is
  intentionally idempotent on missing)
- Output value : 1 (cascade counts surfaced; Next: undo hint)
- SCORE: 4/4
- DISPOSITION: KEEP. **Snapshot wrap = irreversibility safety
  machinery the LLM cannot replicate via raw `DELETE`.** Per the
  audit guard rule.

### `mu task update <id>`

- SQL surface  : dynamic UPDATE on title/impact/effortDays
- Atomicity    : 1 (build SET clause + UPDATE + log)
- Side-effect  : 0
- Error-map    : 1 (`TaskNotFoundError`,
  `TaskIdInvalidError` propagation; `UsageError` for empty change)
- Output value : 1 (idempotent no-op detection; before/after diff
  in summary)
- SCORE: 2/4 (debatable — see DEBATABLE in calibration; awarded 2
  because the empty-change UsageError + idempotent no-op detect
  is real value over raw `UPDATE`)
- DISPOSITION: KEEP.

### `mu task reparent <id>`

- SQL surface  : DELETE all incoming edges + INSERT new edges +
  cycle check per inserted edge + cross-workstream check
- Atomicity    : 1 (multi-DELETE + multi-INSERT + per-edge cycle
  check, all in one transaction)
- Side-effect  : 0
- Error-map    : 1 (`CycleError`, `CrossWorkstreamEdgeError`,
  `TaskNotFoundError`)
- Output value : 1 (`--blocked-by ''` clear-all sugar; counts
  surfaced)
- SCORE: 3/4
- DISPOSITION: KEEP. The atomic-replace semantic is exactly the
  multi-statement transactional thing typed verbs are for.

### `mu task wait <ids…>`

- SQL surface  : polling SELECT loop with deadline + per-id status
  check
- Atomicity    : 1 (multi-id SELECT loop with all/any predicate +
  stuck detection)
- Side-effect  : 1 (sleep/poll; reads `agent_logs` for stuck-after
  heuristic)
- Error-map    : 1 (`UsageError` for empty ids;
  `TaskNotFoundError`, `TaskNotInWorkstreamError`; exit 5 on
  timeout vs exit 0 on met)
- Output value : 1 (per-task ✓/• marker; Next: investigate hints
  for tasks that didn't reach target; `stuck` JSON field)
- SCORE: 4/4
- DISPOSITION: KEEP. **CONTRACT-DEPENDENT**: this is THE example
  the operator's `agent_close_discipline_gap` finding called out.
  `mu task wait` polls correctly; its real-world value depends on
  agents actually calling `mu task close --evidence …` when work
  is done. The verb is high-value (atomic poll + multi-id + exit
  codes + stuck heuristic + JSON); the contract dependency is
  documented here per the operator's instruction.

---

## `mu log`

`mu log` is one verb with three modes (write / read / `--tail`).
Audited as three rows for honesty.

### `mu log <text>` (write)

- SQL surface  : INSERT agent_logs with author resolution
- Atomicity    : 1 (resolve workstream + source + INSERT + emit
  event)
- Side-effect  : 0 (no tmux; the `latestSeq` cursor is consumed by
  `--tail` polling but writing is pure DB)
- Error-map    : 1 (workstream resolution + agent-pane lookup)
- Output value : 1 (`seq=…` confirmation line; --as override; --kind
  classifier)
- SCORE: 3/4
- DISPOSITION: KEEP.

### `mu log` (read, no text)

- SQL surface  : `SELECT * FROM agent_logs WHERE … ORDER BY seq DESC
  LIMIT n` (with workstream / source / kind / since filters)
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (per-row formatter with seq + ws + source + kind
  + payload; `--all` machine-wide; default cap 50)
- SCORE: 2/4 (the multi-axis filter composition is the value vs raw
  SELECT; default cap and `--since` semantics earn the second point)
- DISPOSITION: KEEP.

### `mu log --tail` (block + stream new entries)

- SQL surface  : poll loop on `seq > latestSeq` + format new rows
- Atomicity    : 0 (read-loop)
- Side-effect  : 1 (stdout streaming; sleep)
- Error-map    : 0
- Output value : 1 (replay-from-cursor + filter combination; `^C`
  semantics; same formatter as the snapshot read)
- SCORE: 2/4
- DISPOSITION: KEEP. The poll-and-stream behaviour is exactly what
  `mu sql` cannot reasonably emulate.

---

## `mu approve`

### `mu approve add`

- SQL surface  : INSERT approvals + log + slug derivation
- Atomicity    : 1 (slug derive + INSERT + log entry; default
  workstream + requester resolution chain)
- Side-effect  : 0 (no tmux)
- Error-map    : 1 (slug-collision retry; workstream resolution)
- Output value : 1 (slug return; Next: hints for grant/deny/wait)
- SCORE: 4/4 (3 typed concerns: slug, ws-resolve, atomic insert + log)
- DISPOSITION: KEEP.

### `mu approve list`

- SQL surface  : `SELECT * FROM approvals WHERE workstream=?
  [AND status=?] ORDER BY created_at DESC`
- Atomicity    : 0
- Side-effect  : 0
- Error-map    : 0
- Output value : 1 (status emoji + age column + truncated reason)
- SCORE: 1/4
- DISPOSITION: KEEP. Sibling of the approve namespace: removing
  `list` while keeping `add/grant/deny/wait` is asymmetric — the
  operator hits `approve list` to find the slug they need to
  grant/deny.

### `mu approve grant <slug>`

- SQL surface  : `UPDATE approvals SET status='granted'` + log
- Atomicity    : 1 (UPDATE + log + idempotency check)
- Side-effect  : 0
- Error-map    : 1 (`ApprovalNotFoundError`,
  `ApprovalAlreadyDecidedError`, `ApprovalNotInWorkstreamError`)
- Output value : 1 (Next: hints; previous-status surface for
  idempotent decisions)
- SCORE: 3/4
- DISPOSITION: KEEP.

### `mu approve deny <slug>`

- SQL surface  : `UPDATE approvals SET status='denied'` + log
- Atomicity    : 1 (UPDATE + log)
- Side-effect  : 0
- Error-map    : 1 (same family as `grant`)
- Output value : 1 (same shape as `grant`)
- SCORE: 3/4
- DISPOSITION: KEEP.

### `mu approve wait <slug>`

- SQL surface  : poll SELECT until status decided + deadline
- Atomicity    : 1 (poll loop with deadline + per-iteration read)
- Side-effect  : 0 (sleep only)
- Error-map    : 1 (`ApprovalNotFoundError`; exit codes 0/4/5 for
  granted/denied/timeout)
- Output value : 1 (decision summary; Next: next-action hints based
  on outcome)
- SCORE: 4/4
- DISPOSITION: KEEP. **CONTRACT-DEPENDENT** in the same family as
  `task wait`: depends on a human (or another agent) actually
  hitting `grant` or `deny`. Documented here for completeness.

---

## `mu snapshot`

### `mu snapshot list`

- SQL surface  : `SELECT * FROM snapshots ORDER BY id DESC LIMIT ?`
  + per-row file-size lookup
- Atomicity    : 0
- Side-effect  : 1 (fs `stat()` per snapshot for size column)
- Error-map    : 0
- Output value : 1 (table with id + ts + workstream + label + size)
- SCORE: 1/4 (+1 effective for being paired with `mu undo` →
  effective 2/4)
- DISPOSITION: KEEP. The verb is `mu undo`'s discovery surface;
  removing it would force operators to compose `mu sql` AND
  `stat()` to find a snapshot id to pass to `mu undo --to`.

### `mu snapshot show <id>`

- SQL surface  : SELECT one snapshot row
- Atomicity    : 0
- Side-effect  : 1 (fs stat for size + path-exists check)
- Error-map    : 1 (`SnapshotNotFoundError`)
- Output value : 1 (full metadata block + Next: hint to undo)
- SCORE: 1/4 (+1 effective for being `mu undo`'s detail page →
  effective 2/4)
- DISPOSITION: KEEP. Same family as `snapshot list` — the trio
  (`list`/`show`/`undo`) is the snapshot UX in toto.

---

## Top-level "self" verbs (whoami / my-tasks / my-next)

These three are agent-self aliases. Per the spec calibration: "in-
pane sugar probably could be one verb `mu me [next|tasks]`. Or
kept as-is for in-pane ergonomics. Worker decides."

### `mu whoami`

- SQL surface  : agent lookup via `$TMUX_PANE` + `listTasksByOwner`
- Atomicity    : 0
- Side-effect  : 1 (tmux pane lookup)
- Error-map    : 1 (`AgentNotFoundError` if `$TMUX_PANE` resolves to
  no row)
- Output value : 1 (composed: agent identity block + owned tasks
  table)
- SCORE: 2/4 (+1 effective for being THE in-pane "who am I?" verb)
- DISPOSITION: **MERGE** into `mu me`. **SHIPPED** in
  `audit_merge_self_verbs_into_mu_me`
  (audit_cleanups_post_schema_v5_wave). `cmdWhoami` was renamed to
  `cmdMe`; the `whoami` top-level Commander wiring is gone (no
  back-compat alias — we're pre-1.0).

### `mu my-tasks`

- SQL surface  : `listTasksByOwner(self)` — the SECOND half of
  `whoami`'s composition
- Atomicity    : 0
- Side-effect  : 1 (tmux pane lookup)
- Error-map    : 1 (`AgentNotFoundError`)
- Output value : 1 (table; alias for `task owned-by <self>`)
- SCORE: 1/4 (+1 effective only because of in-pane brevity; covered
  by `mu task owned-by` plus self-resolution)
- DISPOSITION: **MERGE** into `mu me tasks`. **SHIPPED** in
  `audit_merge_self_verbs_into_mu_me`
  (audit_cleanups_post_schema_v5_wave). `cmdMyTasks` survives as
  the subcommand action; the `my-tasks` top-level Commander wiring
  is gone.

### `mu my-next`

- SQL surface  : `listReady(self.workstream)` sorted + sliced
- Atomicity    : 0
- Side-effect  : 1 (tmux pane lookup)
- Error-map    : 1 (`AgentNotFoundError`)
- Output value : 1 (top-K table; alias for `task next -w
  <self.workstream>`)
- SCORE: 1/4 (+1 effective for in-pane brevity)
- DISPOSITION: **MERGE** into `mu me next`. **SHIPPED** in
  `audit_merge_self_verbs_into_mu_me`
  (audit_cleanups_post_schema_v5_wave). `cmdMyNext` survives as
  the subcommand action (with `-n 0` extended to mean "all ready",
  matching `task next`); the `my-next` top-level Commander wiring
  is gone.

The merge target is the SAME follow-up task because the three
verbs are obviously a cluster — picking one off without the other
two doesn't make sense. The follow-up's note specifies the
proposed shape (`mu me`, `mu me tasks`, `mu me next`) and the
back-compat consideration (alias the old names for one release
cycle).

---

## Anti-feature pledge check

Per AGENTS.md ("ROADMAP.md anti-feature pledges"), the audit
checks every KEEP verb against the firm pledges. None of the KEEPs
violate:

- No verb adds a config file dependency.
- No verb requires a daemon or background process.
- No verb has zero implementors at the SDK layer
  (`src/{agents,tasks,workstream,workspace,approvals,snapshots,logs}.ts`
  each back ≥1 verb).
- No verb is a wrapper around a wrapper (the cli/<ns>.ts → SDK
  shape stays one-level).
- No verb requires a render dep beyond `cli-table3` + `picocolors`.
- No verb bundles pi.

If any future verb fails one of these, ROADMAP.md must be updated
in the same commit per the project rule.

---

## Follow-up tasks filed

| Task id                              | Disposition | Verb(s)                              |
|--------------------------------------|-------------|--------------------------------------|
| `audit_merge_task_ready_into_next` — SHIPPED | MERGE | `mu task ready` → `mu task next -n 0` |
| `audit_remove_task_blocked` — SHIPPED | REMOVE      | `mu task blocked` → `mu sql … FROM blocked …` |
| `audit_remove_task_goals` — SHIPPED   | REMOVE      | `mu task goals` → `mu sql … FROM goals …` |
| `audit_remove_task_search` — SHIPPED  | REMOVE      | `mu task search` → `mu sql … LIKE …` |
| `audit_merge_self_verbs_into_mu_me` — SHIPPED | MERGE | `whoami` / `my-tasks` / `my-next` → `mu me [tasks\|next]` |
| `bug_adopt_verb_unwired`             | BUG         | `mu adopt` is dead code (cmdAdopt exists, no `wireXxx` registers it) |

Each follow-up task carries the SQL recipe (or merge target) in
its first note so the orchestrator can act without re-reading this
file.

---

## Closing note

Calibration vs the operator's priors in the task spec note #398:

- **PROBABLE KEEPs** (operator priors): all confirmed.
- **LIKELY REMOVE-WITH-RECIPE** (operator priors): `task search`,
  `task blocked`, `task goals`, `task ready` (audit MERGE to
  `task next`, not REMOVE — the rendering value of the dedicated
  verb-name + table-format would otherwise need to be reproduced
  in `task next --all`). `task tree` and `task notes` and
  `task owned-by` survived because their composition (recursive
  CTE / paired-with-show / cross-workstream column injection)
  earned the second point.
- **LIKELY MERGE** (operator priors): all three self-verbs merged
  per the priors; pleased with the operator's calibration.
- **DEBATABLE** (operator priors): `task update` survives at 2/4
  (idempotent no-op + UsageError on empty-change). `task
  reparent` survives at 3/4 (atomic-replace is real value).
  `workspace path` survives at 2/4 (the bare-print contract IS
  the value). `workspace orphans` survives at 3/4 (fs scan +
  LEFT JOIN composition).

No score was inflated to keep a verb. Where the score was on the
threshold (2/4), the rationale is given inline.

Total promoted-removals: 3 (`task blocked` / `task goals` / `task
search`). Total promoted-merges: 4 (`task ready` into `task next`
plus the three self-verbs). One bug surfaced incidentally.

The audit is advisory; the operator decides which follow-up tasks
to execute and which to reject.
