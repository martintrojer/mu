---
id: "snap_dogfood"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: "worker-1"
created_at: "2026-05-07T17:51:41.807Z"
updated_at: "2026-05-08T14:23:09.906Z"
blocked_by: ["snap_undo_verb"]
blocks: ["cross_workstream_claim_for", "snap_undo_reconcile_destroys_recovered_agents", "workspace_create_partial_dir_on_failure"]
---

# Dogfood: deliberately break things and recover

## Notes (1)

### #1 by worker-1, 2026-05-08T14:23:02.992Z

```
DOGFOODED snap_undo_verb against a real workstream (dogfood-snap on
the live ~/.local/state/mu/mu.db). 4 tasks, 3 notes, 2 edges, 1 agent,
1 git workspace. Ran the destructive sequence the brief sketched +
discovered 4 real findings; 3 filed as follow-up tasks.

═══ FILES ═══
None modified. Dogfood is observation-only by contract.
Three follow-up tasks filed (see NEXT).

═══ COMMANDS (the sequence I actually ran, exit codes inline) ═══

Setup:
  mu workstream init dogfood-snap                                  → 0
  mu task add design -w dogfood-snap --title "Design auth" --impact 80 --effort-days 1   → 0
  mu task add build  -w dogfood-snap --title "Build auth"  --impact 80 --effort-days 2 --blocked-by design   → 0
  mu task add ship   -w dogfood-snap --title "Ship auth"   --impact 90 --effort-days 1 --blocked-by build    → 0
  mu task add review -w dogfood-snap --title "Review docs" --impact 50 --effort-days 1   → 0
  mu task note design 'DECISION: jwt over sessions' -w dogfood-snap → 0
  mu task note design 'FILES: src/auth.ts, src/jwt.ts'  -w dogfood-snap → 0
  mu task note build  'BLOCKED on design'               -w dogfood-snap → 0
  MU_SESSION=dogfood-snap MU_SPAWN_LIVENESS_MS=0 mu agent spawn worker-1 -w dogfood-snap --command 'sh -c "read x"'   → 4 (Finding 1: name collision; worker-1 is in roadmap-v0-2)
  mu task claim design -w dogfood-snap --for worker-1              → 0  (Finding 1 actual bug: ALLOWED cross-workstream)
  mu task release design -w dogfood-snap                           → 0
  MU_SESSION=dogfood-snap MU_SPAWN_LIVENESS_MS=0 mu agent spawn dog-1 -w dogfood-snap --command 'sh -c "read x"'  → 0
  mu task claim design -w dogfood-snap --for dog-1                 → 0
  mu workspace create dog-1 -w dogfood-snap                        → (stalled; aborted) — Finding 4
  mu workspace create dog-1 -w dogfood-snap --project-root /tmp/dogfood-proj   → 0 (after manual cleanup of partial dir)

Section A — task delete + undo:
  mu task delete design -w dogfood-snap                            → 0
  mu undo                                                          → 0 (dry-run)
  mu undo --yes                                                    → 0
    Verified: design row back, owner=dog-1, status=IN_PROGRESS, 2 notes
    + edge (design → build) restored.

Section B — task close + undo round trip:
  mu task close review -w dogfood-snap                             → 0
  mu undo --yes                                                    → 0
    Verified: review.status OPEN→CLOSED→OPEN.

Section C — reject --cascade --yes + undo:
  mu task reject design --cascade --yes -w dogfood-snap            → 0
    Output: "Rejected design (→ REJECTED); cascaded to 2 dependent(s): build, ship"
  mu undo --yes                                                    → 0
    Verified: ALL FOUR rows restored to pre-cascade state (design IN_PROGRESS,
    build OPEN, ship OPEN, review OPEN). One snapshot covered the entire
    cascade — verified live (snap_schema design intent: "snapshot per
    user-facing verb, not per cascaded child").

Section D — workstream destroy + undo:
  mu workstream destroy -w dogfood-snap --yes                      → 0
    OUTPUT: "...workspaces=1/1; Next: Undo (a snapshot was taken before
    the destroy; DB only, tmux not rolled back) : mu undo --yes"
    [snap_destroy_safety has already shipped: the destroy CTA now
    advertises mu undo. Big polish win.]
  mu undo --yes                                                    → 0
    OUTPUT: "Restored snapshot #21 (workstream destroy dogfood-snap, ...)
             Reconcile (tmux NOT rolled back):
               agents pruned (DB row → dead pane) : 1
               orphan panes surfaced              : 0"
    Verified what came back: workstreams row, 4 tasks, 4 notes (yes 4 — see
    Finding 2), 2 edges.
    Verified what did NOT come back: tmux session, on-disk workspace dir.
      → DOCUMENTED CONTRACT MATCHES REALITY for tmux + on-disk.
    BUT: agents row + vcs_workspaces row ALSO did not come back.
      → THIS IS NOT THE DOCUMENTED CONTRACT. Filed as Finding 2 below
        (most-severe finding of the dogfood pass).

Section E — undo of undo (rolls forward via pre-restore snapshot):
  mu undo --yes                                                    → 0  (snapshot 22, pre-restore of 21)
    Workstream destroyed again; clean roll-forward, exactly as designed.
  mu undo --yes                                                    → 0  (snapshot 23, pre-restore of 22)
    Back to recovered state.
  mu snapshot list                                                 → 0
    Full chain visible: 24 / 23 / 22 / 21 / 20 / 19 / 18 / 17 / 16 / 15.

Verification commands:
  mu sql "SELECT ... FROM workstreams WHERE name='dogfood-snap'"
  mu sql "SELECT local_id, status, owner FROM tasks WHERE workstream='dogfood-snap'"
  mu sql "SELECT ... FROM agents WHERE workstream='dogfood-snap'"
  mu sql "SELECT ... FROM vcs_workspaces WHERE workstream='dogfood-snap'"
  mu sql "SELECT ... FROM task_notes WHERE task_id IN (...)"
  mu sql "SELECT ... FROM task_edges WHERE ..."
  sqlite3 ~/.local/state/mu/snapshots/21.db "SELECT name, ... FROM agents ..."
  sqlite3 ~/.local/state/mu/snapshots/21.db "SELECT agent, ... FROM vcs_workspaces ..."
  ls -d ~/.local/state/mu/workspaces/dogfood-snap/dog-1
  tmux has-session -t mu-dogfood-snap
  mu doctor

═══ FINDINGS ═══

FINDING 1 (correctness — cross-workstream claim coupling):
  `mu task claim design --for worker-1` succeeded with exit 0 even
  though `worker-1` lives in workstream `roadmap-v0-2` and `design`
  lives in `dogfood-snap`. The schema's tasks.owner FK is to
  agents(name) (no workstream qualifier), so the claim path doesn't
  validate "agent and task share a workstream". Filed as
  `cross_workstream_claim_for` (impact 60 / effort 0.3 / ROI 200,
  blocked by snap_dogfood).
  Workaround: spawn a uniquely-named agent per workstream (already
  the convention but not enforced).

FINDING 2 (correctness — most severe — undo + destroy is lossy):
  `mu workstream destroy --yes` followed by `mu undo --yes`
  recovers tasks + edges + notes + the workstreams row, but the
  AGENTS ROW and VCS_WORKSPACES ROW are silently dropped, even
  though the snapshot file ON DISK contains them.
  Verified by querying the snapshot directly:
    sqlite3 ~/.local/state/mu/snapshots/21.db
      → snapshots row "dog-1|dogfood-snap|needs_input"
      → vcs_workspaces row "dog-1|dogfood-snap|/Users/.../dog-1"
  But after `mu undo --yes`:
    mu sql "SELECT * FROM agents WHERE workstream='dogfood-snap'"
      → (no rows)
    mu sql "SELECT * FROM vcs_workspaces WHERE workstream='dogfood-snap'"
      → (no rows)
  Root cause: the post-restore reconcile pass in cmdUndo iterates
  every workstream and runs `reconcile()`. reconcile()'s ghost-prune
  step deletes any agent row whose pane no longer exists in tmux —
  AND the destroy killed the panes BEFORE the snapshot was even
  TAKEN. Wait, no — the snapshot is taken FIRST (pre-mutation). At
  capture time, dog-1's pane %2919 was alive. The DESTROY then
  killed the pane. Now we restore the snapshot (which has dog-1 +
  pane %2919 in its agents row). Then reconcile runs. Pane %2919
  no longer exists in tmux. Reconcile prunes the dog-1 row. The
  FK ON DELETE CASCADE on vcs_workspaces.agent then cascades the
  workspace row away too.
  Output: `agents pruned (DB row → dead pane) : 1`. The number IS
  in the output, but it's framed as diagnostic, not as "your
  recovered state was destroyed by the recovery itself".
  Severity: high. The output is honest but the DB-restore promise
  ("workstream + agents + workspaces row come back") is broken in
  the most common case (destroy + immediate undo).
  Filed as `snap_undo_reconcile_destroys_recovered_agents`
  (impact 70 / effort 0.5 / ROI 140, blocked by snap_dogfood).
  Possible fixes: skip the post-restore reconcile, OR make it a
  read-only "report drift, don't mutate" pass, OR distinguish "ghost
  from real-world drift" (legitimate, prune) vs "ghost from a
  restore" (suppress).

FINDING 3 (cosmetic — recovered task got a stray reaper note):
  After Section D's undo, `task_notes` for `design` includes:
    #361 [reaper] previous owner dog-1 gone (agent removed); status
         reverted IN_PROGRESS → OPEN, owner cleared
  This note was generated by the reaper that ran when reconcile
  pruned dog-1 (Finding 2). Two issues with it:
    (a) It's a write to the DB the user just restored — surprising.
    (b) It contradicts what `mu task list` shows: design's status
        in the table view IS OPEN (because reaper ran), but the
        snapshot we restored had design IN_PROGRESS owned by dog-1.
        The reaper's mutation effectively half-rolled-back the
        restore.
  Bound up with Finding 2; the fix for that closes this one too.

FINDING 4 (operational — none-backend cp -a is a HOME-dir footgun):
  The first `mu workspace create dog-1 -w dogfood-snap` (no
  --project-root) ran from cwd=$HOME. The `none` backend (or git's
  fallback) appears to run a recursive `cp -a` of the project root.
  cwd=$HOME means it started copying ~/Music, ~/.config, etc. into
  ~/.local/state/mu/workspaces/dogfood-snap/dog-1/. The macOS
  Music dir has DRM-protected perms that even `chmod -R u+w` can't
  unlock; I had to `mv` the partial dir aside to a quarantine
  before retry.
  The verb itself didn't error out cleanly — it stalled with no
  visible progress (I had to ctrl-C). After ctrl-C, the partial
  on-disk state was left behind AND the registry row was never
  inserted, so `mu workspace list` showed nothing while
  `mu workspace create` refused to proceed ("dir already on disk").
  Two interlocking issues:
    (a) `mu workspace create` should refuse to operate when cwd is
        $HOME without an explicit --project-root (footgun: someone
        will absolutely do this in a real workstream).
    (b) On interrupt/error mid-create, the partial on-disk state
        should be cleaned up OR the verb should print the
        recovery command. The error path was already pointing at
        `mu workspace orphans` and `rm -rf` recipes — those are
        good — but the orphan-detection path didn't surface the
        partial dir as an orphan ("(no workspaces in dogfood-snap)"
        even though dog-1's path was on disk).
  Filed as `workspace_create_partial_dir_on_failure`
  (impact 60 / effort 0.5 / ROI 120, blocked by snap_dogfood).

═══ DECISION ═══
  Did NOT fix any of the findings. Per brief: "Stay under ~0.3
  days. If you find a deep bug, file a follow-up task; do not fix
  it inside snap_dogfood scope." All 3 actionable findings are
  filed as separate tasks. Finding 3 is a symptom of Finding 2;
  no separate task.

═══ NEXT ═══
  - snap_undo_reconcile_destroys_recovered_agents — most-severe
    finding from this dogfood pass; should bump above the
    snap_destroy_safety / snap_docs polish work because it
    invalidates the destroy+undo recovery promise.
  - cross_workstream_claim_for — schema gap.
  - workspace_create_partial_dir_on_failure — operational gap.
  Plus snap_dogfood itself can close: dogfood ran end-to-end and
  surfaced what unit tests couldn't.

═══ VERIFIED ═══
  - mu workstream init / mu task add / mu task note / mu task claim:
    base flow works on the live ~/.local/state/mu/mu.db.
  - mu task delete + mu undo --yes: full round-trip clean (notes,
    edges, owner all back).
  - mu task close + mu undo --yes: status round-trip clean.
  - mu task reject --cascade --yes + mu undo --yes: 4-task cascade
    rolled back as one snapshot (single-snapshot-per-cascade
    invariant from snap_schema design verified live).
  - mu workstream destroy --yes + mu undo --yes: workstreams row,
    tasks (4), notes (3, +1 stray reaper note), edges (2) all
    recovered from disk snapshot. tmux session NOT recovered (per
    contract). on-disk workspace dir NOT recovered (per contract).
    Agents row + vcs_workspaces row NOT recovered (NOT per contract;
    Finding 2).
  - mu undo --yes followed by mu undo --yes: rolls forward via
    the pre-restore snapshot chain. Verified by going destroyed
    → recovered → destroyed → recovered through 3 consecutive
    undos.
  - mu snapshot list: shows the full chain newest-first, with
    pre-restore snapshots interleaved. <whole-DB> dim label for
    workstream-destroy snapshots renders correctly.
  - mu doctor on the post-restore state: schema_version=4, 10
    tables, journal_mode=wal, fk=on. No drift surfaced.
  - The snap_destroy_safety polish is ALREADY in main: destroy
    confirmation now ends with "Next: Undo (a snapshot was taken
    before the destroy; DB only, tmux not rolled back) : mu undo
    --yes". Honest text confirmed live.

═══ ODDITIES ═══
  - The orphan home-dir partial copy (Finding 4) is in
    ~/.local/state/mu/workspaces/dogfood-snap/_quarantine_<ts>/
    — left there because rm -rf can't remove the macOS Music dir.
    Next agent or human can decide whether to keep it as evidence
    or move it to /tmp.
  - The dogfood-snap workstream is left in the LIVE DB at the
    "recovered, but no agent" state per the brief's "leave it
    dirty for the next agent to inspect" option. Not destroyed.
    To clean: `mu workstream destroy -w dogfood-snap --yes`.
  - mu sql with double-quoted string literals fails with "no such
    column: dogfood-snap" — that's standard SQLite (double-quotes
    are identifiers, single-quotes are strings). Not a mu bug,
    but the error message could be friendlier ("did you mean
    single-quotes?" — actually it ALREADY says exactly that:
    "should this be a string literal in single-quotes?" Nice.).
  - `mu undo --yes` always reconciles every workstream, not just
    the one(s) the snapshot affected. For a workstream-destroy
    snapshot that's correct (whole-DB scope). For a per-workstream
    snapshot it's overkill. Not severe enough to file separately
    — bound up with Finding 2 anyway.
  - Snapshot file sizes are ~960 KB each on this DB. After 24
    snapshots that's ~23 MB. GC will eventually trim to 100, so
    the worst case is ~96 MB on the live DB. Worth a note in the
    docs once snap_docs runs.
  - The "agents pruned: 1" output line is exactly the diagnostic
    that surfaced Finding 2 — without it I would have just thought
    the agent row genuinely vanished during destroy. Honesty
    pays off.
  - `mu agent spawn` from a non-tmux pane refused to run until I
    set MU_SESSION=dogfood-snap. Expected behaviour, but worth
    noting that orchestrator-from-shell (not from tmux) is a
    common dogfood pattern that needs the env var.
```
