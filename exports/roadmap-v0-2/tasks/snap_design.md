---
id: "snap_design"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 90
effort_days: 0.7
roi: 128.57
owner: "worker-1"
created_at: "2026-05-07T17:51:41.409Z"
updated_at: "2026-05-08T11:20:52.718Z"
blocked_by: []
blocks: ["snap_schema"]
---

# Design: snapshots — capture strategy, undo-graph, edge cases (cross-workstream, FK CASCADE, recovery)

## Notes (1)

### #1 by worker-1, 2026-05-08T11:20:48.113Z

````
DESIGN: snapshots + undo for v0.2

═══ CAPTURE STRATEGY ═══

WHEN: snapshot **only before destructive verbs**, not every write.
The destructive set (the only verbs whose data can't be reconstructed
from current state):
  - workstream destroy
  - agent close            (FK CASCADE may SET NULL on tasks.owner)
  - workspace free         (only the row; on-disk worktree is the
                            VCS backend's problem, out of snapshot scope)
  - task close / reject / defer / release / delete (state transition
                            irrecoverable; release wipes ownership)
  - task note ... only if we ever add note delete (today notes are
                            append-only; skip)
  - approve grant/deny     (terminal state transition)

Status flips that ARE recoverable from history (e.g. task add, edge
add, log append) DO NOT snapshot. The disk+perf trade-off says
"insurance, not version history": every busy↔needs_input flip would
balloon the snapshot dir for no recovery value.

WHAT: **whole-DB binary copy via SQLite Online Backup API**
(`better-sqlite3`'s `db.backup(path)` — already a peer of our existing
DB stack, no new dep). Rationale:
  - FK integrity guaranteed across the snapshot (page-level atomic);
    a per-workstream subtree dump is structurally broken because
    tasks ⇄ agents ⇄ workstreams cross every FK in the schema, and
    the workstream-destroy case CASCADES to other workstreams via
    nothing today but might tomorrow.
  - Online Backup runs concurrent with writes by design; no new lock
    contention vs SQLite's existing busy_timeout=1s.
  - Restore = `fs.copyFileSync(snapshot, mu.db)` + nuke `-wal` /
    `-shm` sidecars. One primitive, no replay machinery.
  - .sql dump rejected: format drift across SQLite versions, larger
    on disk for our text-heavy rows, slower on restore (parse +
    INSERT vs page copy), and we'd still need a sidecar table to
    label snapshots — same surface, more moving parts.

Mu DBs are sub-MB for the lifetime of any realistic workstream
(state is mostly TEXT IDs + timestamps). Whole-DB copy is cheap.

WHERE: **REVISE the roadmap sketch.** Roadmap says
`<state-dir>/snapshots/<workstream>/<ts>.sql`. I propose:
  `<state-dir>/snapshots/<id>.db`   (flat dir, autoincrement id)
Two reasons to flatten:
  1. Snapshots are whole-DB. Filing them under one workstream is
     a category error: a snapshot taken before `workstream destroy
     auth-refactor` also captures every other workstream's rows.
  2. Workstream-name path components are user-typed strings. Flat
     `<id>.db` keeps the filesystem layer dumb; the workstream goes
     in the row, not the path.

HOW LABEL: a single TEXT column `label` storing operation + target.
Free-form string, not JSON, because:
  - it's only displayed to humans in `mu snapshot list`;
  - `mu sql` covers structured queries if anyone ever needs them;
  - JSON-in-TEXT is an additive abstraction with no consumer.
Examples:
  "workstream destroy auth-refactor"
  "task close design"
  "agent close worker-3"

GC: opportunistic, inside the snapshot hook, **two caps applied
together**:
  - keep all snapshots <14 days old (age cap)
  - and at most 100 rows total (count cap)
Whichever is more permissive wins; rows beyond both caps get
deleted (DB row + .db file). No --gc verb, no daemon. Skip a
total-size cap: count cap × small-DB-size already bounds it.

═══ UNDO GRAPH ═══

**Linear stack, machine-wide.** Not per-workstream. Why:
  - snapshots are whole-DB → "undo workstream A" would still bring
    back state from workstream B if the snapshot was the latest;
    splitting per-workstream would lie about scope.
  - one ordered list (snapshots.id DESC) is the simplest model that
    matches "undo my last destructive action."
  - real friction can promote per-workstream stacks later (criterion
    1 in ROADMAP.md); design doesn't preclude it (workstream column
    is on the row).

**`mu undo`** = pop most recent snapshot, restore, reconcile.
**`mu undo --to <id>`** = restore a specific snapshot id.
**`mu snapshot list`** = id, label, created_at, workstream.

**`mu redo`** — punt with intent. The roadmap suggested
"replay-on-demand for redo" but mu verbs aren't pure: agent close
killed a tmux pane; workspace free called `git worktree remove`;
replay would need to re-perform side-effects we no longer have the
inputs for. The honest design is:
  - every restore IS itself a destructive op, so it gets its own
    pre-restore snapshot first → "redo last undo" is just
    `mu undo` again on that snapshot.
  - so snap_undo_verb ships `mu undo` only; `mu redo` is a future
    item if real use surfaces it. (Pillar 3 / VISION.md "schema-first;
    typed verbs over read views"; don't ship a verb whose semantics
    we can't honestly defend.)

Cross-workstream coupling: **non-issue under whole-DB snapshots.**
A FK CASCADE that ripples from workstream A into workstream B is
captured in the same snapshot; restore atomically reverts both
sides. This is exactly why we don't subtree-snapshot.

═══ EDGE CASES ═══

SCHEMA MIGRATIONS:
  - On restore, compare snapshot's schema_version (we read it from
    the .db file via a 1-line `Database(snapshotPath, {readonly:true})`)
    against the live DB's CURRENT_SCHEMA_VERSION.
  - If snapshot.version < current: **REJECT**, exit code 4
    (conflict) with message: "snapshot at v3, current DB at v4. mu
    does not auto-migrate snapshots; downgrade your binary or skip
    this snapshot." Auto-migration was considered and rejected:
    migrating a snapshot file in place mutates user-visible
    forensic data, and migrations are forward-only — we'd need
    rollback machinery we don't have.
  - If snapshot.version > current: **REJECT**, same exit code,
    message about a newer mu binary having written it.
  - If equal: proceed.
  - Migration that lands AFTER a snapshot was taken means that
    snapshot becomes un-restorable. That's an honest cost; doc it
    in `mu snapshot list` output ("[stale: v3 vs current v4]").

WORKSTREAM DESTROY:
  - destroyWorkstream() takes the snapshot **first**, then kills
    tmux, then runs the FK CASCADE. snap_destroy_safety just adds
    one line: `await captureSnapshot(db, "workstream destroy ${name}")`
    at the top.
  - If snapshot fails, abort destroy — better to refuse than to
    delete irrecoverably. (Same shape as the current "tmux first
    so we don't orphan rows" comment in workstream.ts:244.)
  - mu undo will re-create the rows. tmux session is **not**
    restored (see next bullet); the user has to re-spawn agents.
    Documented honestly in undo's output.

LIVE TMUX:
  - **Snapshots are DB-only. Tmux is not rolled back.** This is the
    biggest honesty point.
  - After restore, the DB references panes that may or may not
    exist; conversely tmux may have panes the restored DB doesn't
    know about.
  - Mitigation: `mu undo` runs `reconcile()` (the existing
    reality-wins routine in src/reconcile.ts) immediately after
    file swap. Ghost rows get pruned; orphan panes surface in the
    next `mu agent list`.
  - Output: print prominently "DB restored to snapshot N. Tmux
    state was not rolled back; X agents in DB no longer have live
    panes (pruned), Y panes in tmux are now orphans. Re-spawn or
    `mu adopt` as needed."
  - Rejected alternative: kill all panes during undo. Too
    aggressive; surprises the user; the roadmap-v0-2 workstream's
    own crew would self-destruct if you did this.

CONCURRENT WRITES:
  - SQLite Online Backup is concurrent-safe: it iterates pages and
    handles writers updating pages mid-copy.
  - Two `mu` processes both hitting destructive verbs: each gets
    its own snapshot id (AUTOINCREMENT); no collision. The
    snapshots dir tolerates parallel writes.
  - Restore is the dangerous spot. `mu undo` should:
      1. Take a pre-restore snapshot (the "redo target").
      2. Close its DB handle.
      3. fs.copyFileSync(<snapshot>.db, mu.db); unlink mu.db-wal,
         mu.db-shm if present.
      4. Re-open, reconcile.
    Other live mu processes will have stale handles; SQLite will
    surface that on their next write as a busy/disk-image-malformed
    error and they'll exit cleanly. **`mu undo` should print
    "stop other mu processes before continuing" and gate behind a
    confirmation OR a `--yes` flag.** Same shape as workstream
    destroy's existing confirmation gate.

SNAPSHOT OF A SNAPSHOT (undo-of-undo):
  - Falls out for free: restore captures a pre-restore snapshot, so
    `mu undo` after `mu undo` restores that one. No special case.

═══ PILLAR CHECK ═══

"no daemon" (VISION.md §5/§4) — **OK.** Snapshot capture is in-proc
inside the writer verb, before the mutation. GC is in the same hook.
No background process, no watcher.

"subtractive over additive" / "schema-first; typed verbs over read
views; SQL as escape hatch" (VISION.md §8) — **the snapshots TABLE
is the only additive surface.** Could we get away with just the
filesystem (read directory, parse filenames)? Considered; rejected:
  - filename labels are fragile (max-length, allowed chars,
    OS-specific case-folding);
  - listing requires a stat per file → O(n) syscalls vs one SELECT;
  - we need an autoincrement id anyway for stable reference, which
    a sidecar table gives us cleanly.
The table earns its keep.

"no anticipatory abstractions" (VISION.md §8) — **enforced.** Only
the three verbs in the snap_* tasks consume the table:
`mu undo`, `mu snapshot list`, and (later, if promoted) `mu redo`.
No "snapshot any state" generalization, no per-table snapshots,
no diff snapshots, no remote sync.

"<300 LOC promotion criterion" (ROADMAP.md §"Promotion criteria") —
**fits, with a minimal viable subset if it doesn't.** Estimate:
  - v3→v4 migration (single CREATE TABLE, no rebuild): ~25 LOC
  - src/snapshots.ts (capture, list, restore, GC): ~140 LOC
  - hook calls in workstream.ts/agents.ts/tasks.ts/approvals.ts: ~30 LOC
  - cli.ts wiring (mu undo, mu snapshot list): ~50 LOC
  - tests: separate budget
  Total ~245 LOC. Headroom present.
Smallest viable subset if budget busts:
  1. Drop GC; user manages disk manually. (-30 LOC)
  2. Drop `mu snapshot list` JSON; only print human table. (-15 LOC)
  3. Drop `mu undo --to <id>`; only most-recent. (-10 LOC)

═══ SHIP-LIST FOR snap_schema ═══

NEXT (what snap_schema implements first, in order):
1. v3→v4 migration in src/migrations.ts adding one table:
   ```sql
   CREATE TABLE snapshots (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     workstream  TEXT,                  -- nullable: workstream-destroy
                                        -- snapshots span all workstreams
     label       TEXT NOT NULL,         -- "workstream destroy foo"
     db_path     TEXT NOT NULL,         -- abs path to the .db file
     schema_version INTEGER NOT NULL,   -- snapshot_at_capture; for the
                                        -- restore-time version check
     created_at  TEXT NOT NULL
   );
   CREATE INDEX idx_snapshots_created_at ON snapshots (created_at);
   ```
   Note: NO FK on workstream — destroying a workstream must NOT
   cascade-delete its pre-destroy snapshot. (That's the whole point.)
2. Bump CURRENT_SCHEMA_VERSION to 4 in src/db.ts; add the table to
   EXPECTED_TABLES; mirror in CURRENT_SCHEMA.
3. New module src/snapshots.ts exposing:
   - `captureSnapshot(db, label, workstream?): Promise<{id, db_path}>`
     -- calls db.backup(); inserts row; runs GC.
   - `listSnapshots(db, opts?): SnapshotRow[]`
   - `restoreSnapshot(db, id): RestoreResult` -- file swap + sidecar
     unlink; caller is expected to be the short-lived `mu undo` proc.
4. Wire `captureSnapshot()` into the destructive verbs (workstream
   destroy first, then agent close, task close/reject/defer/release,
   workspace free, approve grant/deny). Each call is a one-liner
   at the top of the verb.
5. Tests: capture round-trip; restore version-mismatch reject;
   restore-then-list shows the pre-restore snapshot; GC honours
   both caps; whole-DB integrity (reconciled tmux state on a
   restored DB makes sense).

snap_undo_verb then wraps the SDK with `mu undo [--yes] [--to N]`,
`mu snapshot list [--json]`, and the reconcile-after-restore output.

═══ FILES ═══
docs/ROADMAP.md:171-194   (the seed sketch this design refines)
docs/VISION.md:71-86,§8   (DB-canonical pillar, no-anticipatory
                           abstractions; "Not undoable" line in
                           "What It Is NOT" — this design retires it)
docs/VOCABULARY.md:35      (the "snapshot" entry → update: drop
                            "deferred", point at v0.2 design)
docs/ARCHITECTURE.md:state-of-truth (the line "Writes go through
                            core/api.ts which validates, snapshots,
                            transacts" is currently aspirational; the
                            snapshot hook makes it real for the
                            destructive subset)
src/db.ts:170,196          (CURRENT_SCHEMA_VERSION bump; EXPECTED_TABLES;
                            CURRENT_SCHEMA add)
src/migrations.ts:25-32,~end  (MIGRATIONS map entry + migrateV3ToV4)
src/workstream.ts:230,244  (capture before tmux kill in destroy)
src/agents.ts (close)      (capture before pane kill / row delete)
src/tasks.ts (close/reject/defer/release/delete)
src/approvals.ts (grant/deny)
src/workspace.ts (free)
src/cli.ts:2089            (the "No undo — restore from backup if
                            needed" line in destroy's confirmation
                            text needs softening to "snapshot will
                            be taken; mu undo can revert")
src/snapshots.ts           (NEW)
test/snapshots.test.ts     (NEW)

═══ COMMANDS ═══
mu whoami
mu task show snap_design
mu task notes snap_design
mu task show snap_schema
mu task show snap_undo_verb
mu task show snap_destroy_safety
mu task show snap_dogfood

═══ DECISION ═══
ONE chosen design: whole-DB SQLite-backup files written to a flat
<state-dir>/snapshots/<id>.db, indexed by a single new table; capture
on the destructive-verbs subset only; linear machine-wide undo stack;
restore = file swap + sidecar nuke + reconcile; reject cross-version
restores; no redo verb in v0.2.

Rejected alternatives (one-liners):
  - per-workstream subtree .sql dumps          — breaks FK integrity.
  - .sql text dumps                            — slower restore, no win.
  - filesystem-only (no snapshots table)       — fragile filenames.
  - snapshot every write                       — disk balloon, no
                                                 recovery value.
  - DAG / per-workstream undo stack            — premature; whole-DB
                                                 snapshots make it lie.
  - mu redo via verb replay                    — verbs have side-effects;
                                                 can't replay honestly.
  - kill tmux panes during undo                — too aggressive; user
                                                 hostile.
  - auto-migrate stale snapshots               — mutates forensic data;
                                                 migrations are
                                                 forward-only.

═══ VERIFIED ═══
  - VISION.md §5 "no daemon" — capture is in-proc.
  - VISION.md §8 "subtractive over additive" — table justified by
    label durability + autoincrement need; no JSON-in-TEXT.
  - VISION.md "What It Is NOT" — "Not undoable" line is what this
    design retires.
  - ROADMAP.md §"Promotion criteria" — <300 LOC budget assessed
    (~245 estimated); fallback subsets identified.
  - ROADMAP.md §"Anti-feature pledges" — no daemon, no config file,
    no codegen, no plugin runtime; design adds one table + one
    module + ≤6 hook lines.
  - src/migrations.ts v2→v3 pattern — additive table needs no
    rebuildTable dance; just CREATE TABLE in the migration body.
  - src/db.ts:80 workstreamStateDir() — already reserved
    `<state-dir>/workstreams/<workstream>/` for forensics; the
    snapshot dir is parallel to this, not under it (flat layout).
  - src/workstream.ts:244 — destroy's "tmux first then DB" comment
    is the same shape we want for "snapshot first then mutate".

═══ ODDITIES ═══
  - VISION.md "What It Is NOT" explicitly says "Not undoable… No
    snapshots, no `mu undo`. … Snapshots are deferred past 1.0."
    This design ships them in v0.2, which is post-0.1 but pre-1.0.
    The framing in VISION.md should be updated as part of
    snap_docs (in scope of that task, not snap_design).
  - VOCABULARY.md "snapshot" row currently says "deferred; see
    ROADMAP.md". Update needed when snap_schema lands.
  - ARCHITECTURE.md §"State of truth" already names a fictitious
    `core/api.ts` that "validates, snapshots, transacts, and
    reconciles". That file doesn't exist (we're flat in src/). The
    snapshot hook actually makes the "snapshots" word in that line
    true; ARCHITECTURE.md should be tightened to name
    src/snapshots.ts and the per-verb hook pattern.
  - The roadmap snippet's `db_path` column means "path to the .db
    file on disk", not "the canonical mu.db path". Worth a comment
    in the schema body to avoid future confusion.
  - `db.backup()` in better-sqlite3 returns a Promise; this is the
    one async-from-sync surface in our otherwise sync DB layer.
    Capture functions therefore have to be `async`. Every existing
    destructive verb is already async (workstream.destroy is, agents
    talk to tmux, approvals don't but it's a one-line refactor).
  - SQLite WAL footgun: restoring while another mu process holds a
    handle to the live DB will leave that process with a corrupted
    view (-wal/-shm point at the wrong file). Mitigated by
    requiring `--yes` and a clear "stop other mu processes" warning.
    Real OS-level lock acquisition is a follow-up if this bites.
  - The roadmap drew the snapshot path as
    `<state-dir>/snapshots/<workstream>/<ts>.sql`. I'm REVISING to
    `<state-dir>/snapshots/<id>.db` (flat, binary). The workstream
    column in the table preserves the per-workstream queryability
    without the path-component fragility.
````
