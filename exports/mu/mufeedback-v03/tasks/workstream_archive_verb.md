---
id: "workstream_archive_verb"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 1
roi: 60.00
owner: null
created_at: "2026-05-09T17:01:07.438Z"
updated_at: "2026-05-10T06:55:46.684Z"
blocked_by: []
blocks: ["workstream_export_additive_multi_workstream"]
---

# feat: mu workstream archive — preserve tasks + audit log in-DB before destroy; accumulator across related workstreams

## Notes (2)

### #1 by π - mu, 2026-05-09T17:02:27.382Z

```
SURFACED LIVE post-v0.2: after a big multi-wave session like the one that just shipped v0.2 (~150 closed tasks across mufeedback + roadmap-v0-2), the operator wants to:
  - tear down the live workstream (kill panes, free workspaces, free $MU_SESSION namespace)
  - PRESERVE the tasks + audit log because they're the durable design memory of the session
  - accumulate that memory across multiple related workstreams (mufeedback + roadmap-v0-2 → "v0.2 wave archive")

Today's options:
  - mu workstream destroy --yes        # snapshots DB + kills tmux + frees workspaces; tasks GONE from live DB
  - mu workstream export -w X --out d  # writes 1 .md per task to disk (just shipped); machine-grep-friendly but NOT queryable in-DB; lives outside mu

The export-to-disk path is the right shape for git-tracked humans-reading-it. But it's NOT what an operator wants for "I want mu sql across both archives next month".

═══ THE GAP ═══

We need an in-DB archive that:
  1. Preserves every task + edge + note + relevant agent_log row.
  2. Tags them with the source workstream + an archive label ("v0.2-wave").
  3. Makes them queryable via mu sql + a thin typed surface (mu archive list / show / stats).
  4. Frees the source workstream's name (so mu workstream init mufeedback works again next session).
  5. Is INDEMPOTENT — re-archive a workstream + new tasks just appends.
  6. Optionally cascades to destroy the source workstream after a successful archive.

═══ DESIGN QUESTIONS (need answers before implementation) ═══

Q1. SAME DB or SEPARATE archive DB?
  - Option A: same mu.db. Add tables: archives + archived_tasks + archived_edges + archived_notes + archived_agent_logs. Tags carry the source workstream name + archive label.
  - Option B: separate mu-archives.db. Same shape but filed under a sibling state-dir path; mu archive verbs open it.
  - Option C: archive ROW lives in workstreams with a status='archived' flag; tasks/edges/notes/logs stay in-place but get re-pointed to a new workstream_id.
  
  Recommend A for v1. C is too clever (the workstream surface implicitly grows a "list non-archived" filter for every read; high implicit cost). B adds open-two-DBs complexity. A is honest: archives are a separate first-class entity.

Q2. WHAT GETS ARCHIVED?
  - tasks: all rows from the workstream, regardless of status. Frontmatter intact.
  - task_edges: all edges where both ends are in this workstream's tasks. (Cross-workstream edges are forbidden anyway.)
  - task_notes: all notes for the archived tasks.
  - agent_logs: ALL rows for this workstream, OR just the kind='event' rows (state transitions; the audit trail).
    Recommend: just kind='event' for v1. The full chat-style log is huge and rarely queried; if needed, snapshot+undo is the escape hatch.
  - vcs_workspaces: NOT archived; workspaces are operational state, not memory.
  - approvals: archive (low volume; might matter for the "why did we go ahead with X" trail).
  
  agents: NOT archived. Agents are workforce; the task ownership is preserved via owner_name (TEXT) on the archived_tasks row, but the agent row itself doesn't survive.

Q3. ACCUMULATION ACROSS WORKSTREAMS?
  Per the operator: "accumulate tasks from related workstreams". The shape:
    mu archive create v0-2-wave              # creates the archive
    mu archive add v0-2-wave -w mufeedback  # add a workstream's content
    mu archive add v0-2-wave -w roadmap-v0-2  # add another (idempotent; no-op if already there)
  
  The label "v0-2-wave" is operator-chosen, per-archive-DB unique. archived_tasks rows carry (archive_label, source_workstream, original_local_id).
  
  Conflict: if two source workstreams both have a task named "design", they coexist in the archive (different (source_workstream, original_local_id) tuples). Re-export is straightforward.

Q4. SCHEMA SHAPE (post-v5 surrogate-id pattern)
  
  archives (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT UNIQUE NOT NULL,           -- operator-chosen, unique
    description   TEXT,                           -- optional one-liner
    created_at    TEXT NOT NULL
  )
  
  archived_tasks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id          INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
    source_workstream   TEXT NOT NULL,           -- intentionally TEXT (the source ws may not exist anymore)
    original_local_id   TEXT NOT NULL,
    title               TEXT NOT NULL,
    status              TEXT NOT NULL,
    impact              INTEGER NOT NULL,
    effort_days         REAL NOT NULL,
    owner_name          TEXT,                    -- snapshotted at archive time
    archived_at_status  TEXT NOT NULL,           -- in case we add re-open later
    archived_at         TEXT NOT NULL,
    original_created_at TEXT NOT NULL,
    original_updated_at TEXT NOT NULL,
    UNIQUE (archive_id, source_workstream, original_local_id)
  )
  
  archived_edges (
    archive_id        INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
    from_archived_id  INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
    to_archived_id    INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
    PRIMARY KEY (archive_id, from_archived_id, to_archived_id)
  )
  
  archived_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id  INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
    archived_task_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
    author      TEXT,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL                    -- original creation time
  )
  
  archived_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id  INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
    source_workstream TEXT NOT NULL,
    seq         INTEGER NOT NULL,                -- original seq from agent_logs
    source      TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )

Q5. CLI SURFACE
  
  mu archive create <label> [--description "..."]            # one-time setup
  mu archive list                                             # list every archive + summary
  mu archive show <label>                                     # detail: per-source-ws task counts
  mu archive add <label> -w <workstream> [--destroy]          # archive content; --destroy cascades to mu workstream destroy --yes after a successful archive
  mu archive remove <label> -w <workstream>                   # un-archive (rare; recovery)
  mu archive delete <label> [--yes]                           # blow away the archive (snapshot first)
  mu archive export <label> [--out <dir>]                     # uses existing export verb shape over archive contents
  mu archive search <pattern> [--label <l>]                   # search archived task titles + notes
  mu archive notes <archive-task-ref>                         # `<label>/<source-ws>/<original-id>` qualified ref

Q6. INTEGRATION WITH mu workstream destroy
  Today: mu workstream destroy --yes snapshots the DB then nukes the workstream + its rows.
  Proposed extension: --archive <label> flag.
    mu workstream destroy -w mufeedback --archive v0-2-wave --yes
  Order: snapshot first (per existing semantics) → archive → destroy. If the archive step fails, abort destroy.
  
  Recommend: ship the standalone `mu archive add <label> -w <ws> --destroy` flag first. The cross-cutting destroy --archive can come later.

Q7. SNAPSHOTS vs ARCHIVES
  Snapshots are whole-DB binary backups for undo. Archives are first-class queryable structured data. Different lifecycle, different consumers. Don't merge.

Q8. EXPORT-OUT-OF-ARCHIVE
  mu archive export <label> [--out <dir>] should reuse exportWorkstream's renderer. Per-source-ws subdirectories under <out>/<label>/<source-ws>/.

═══ PROPOSED IMPLEMENTATION PHASES ═══

PHASE 1 — schema + SDK (~200 LOC + ~150 LOC tests)
  - migration script v5 → v6 (4 new tables; aggressive migration per the v0.2 pattern)
  - SDK: createArchive / addToArchive / listArchives / getArchive / deleteArchive / removeFromArchive
  - test: full round-trip (create + add 2 workstreams + verify cross-source preservation; remove a workstream; delete archive cascades cleanly)

PHASE 2 — CLI verbs (~150 LOC)
  - mu archive create / list / show / add / remove / delete
  - --json shape for each (archives wholesale-rename pattern from output_json_keys_rename_v5)

PHASE 3 — destroy integration (~30 LOC)
  - mu workstream destroy --archive <label> shorthand for mu archive add + mu workstream destroy --yes
  - error: refuse if the archive doesn't exist (avoid silent data loss)

PHASE 4 — search + export (~80 LOC each)
  - mu archive search (LIKE over titles + notes)
  - mu archive export (reuse existing exportWorkstream renderer)

═══ ANTI-FEATURES ═══

  - Don't add re-import (un-archive into a fresh workstream). The archive IS the workstream's afterlife; if you need it live, copy via mu sql.
  - Don't auto-archive on destroy. Operator opts in per call.
  - Don't track "live" tasks alongside archives in the same surface. Archives are a separate entity-type with its own verb namespace.
  - Don't inherit workstream-name uniqueness into archives. Archive labels live in a separate namespace.
  - Don't add archive→archive merge. Archive labels are operator-managed; if you want to merge, mu sql + add to a third archive.
  - Don't store agent rows. Agents are workforce; their identity-as-actor is preserved via owner_name TEXT on archived_tasks.

═══ PROMOTION ═══

  - Real-user friction: this very session. ≥1 hit; the operator filed because the v0.2 cleanup made them HOLD ONTO the workstreams instead of destroying.
  - Substrate ready: the surrogate-PK pattern from v5 + the existing exportWorkstream renderer + the snapshots/undo machinery for safety. ~400 LOC across phases.
  - Fits in <300 LOC: NO as a single change, BUT phases 1+2 (the load-bearing new entity + CLI surface) fit; phases 3+4 are decoupled follow-ups.
  
  → PROMOTE FOR v0.3. This task ships the design + 4 follow-up tasks per phase.

═══ EDGES ═══

This is the v0.3 anchor task. Subsequent phases block on it. No upstream blockers (v0.2 substrate is ready).

═══ NEXT ═══

Operator decides: claim this design task (~0.3d to write the design doc + file phases) or defer until the cleanup pressure surfaces ≥1 more time. Recommend claim now while the context is fresh.
```

### #2 by π - mu, 2026-05-09T17:03:45.033Z

```
ADDENDUM (operator request): make the additive nature explicit and load-bearing. The use case is "I keep archiving every mu-related workstream into a single 'mu' bucket over time".

═══ THE ADDITIVE INVARIANT ═══

A single archive label is a long-lived bucket. Add to it whenever a related workstream completes:

  # initial v0.2 wave
  mu archive create mu --description "every mu-self-development workstream"
  mu archive add mu -w mufeedback --destroy
  mu archive add mu -w roadmap-v0-2 --destroy
  
  # weeks later, after v0.3 ships
  mu archive add mu -w mufeedback-v03 --destroy
  mu archive add mu -w roadmap-v0-3 --destroy
  
  # months later
  mu archive add mu -w mufeedback-v04 --destroy
  ...

Single 'mu' archive accumulates EVERY mu-self-dev workstream. mu sql / mu archive search / mu archive export operate over the whole bucket.

═══ WHAT MAKES THIS WORK ═══

1. Archive labels are STABLE across time. Operator picks the label once; subsequent adds use the same label. Archives don't auto-roll-over by date or version.
2. Source-workstream is part of the row identity. Two workstreams adding a 'design' task into the same archive coexist as ('mu', 'mufeedback', 'design') and ('mu', 'mufeedback-v03', 'design') — different rows.
3. Re-adding the same source workstream is IDEMPOTENT: tasks already present (matched on source_workstream + original_local_id) are skipped (or updated if their content drifted; behaviour TBD — recommend skip, with a separate `mu archive refresh` for explicit re-sync).
4. Removing one source workstream from the archive (mu archive remove mu -w mufeedback-v03) is surgical — peers stay intact.
5. The archive's `created_at` is the FIRST add; subsequent adds bump a separate `last_added_at` column for "when did this bucket grow most recently".

═══ SCHEMA REFINEMENT ═══

Add to archives table:
  last_added_at TEXT NOT NULL    -- bumped on every successful mu archive add

The README of mu archive show <label> shows BOTH timestamps + per-source-ws task counts (so the operator sees "mufeedback: 105 tasks (added 2026-05-09); mufeedback-v03: 12 tasks (added 2026-06-15)").

═══ TYPICAL LIFECYCLE PATTERNS ═══

Pattern A — single bucket per project family:
  mu archive add mu -w <each new mu wave>
  Single growing 'mu' archive. Easy to query "what did I learn building mu over the last year?" via mu archive search mu <pattern>.

Pattern B — per-release buckets:
  mu archive create mu-v0-2 ; mu archive add mu-v0-2 -w mufeedback
  mu archive create mu-v0-3 ; mu archive add mu-v0-3 -w mufeedback-v03
  Each release-wave has its own archive. Easier to compare "what shipped in v0.2 vs v0.3".

Pattern C — hybrid:
  Both — mu archive add mu -w X AND mu archive add mu-v0-2 -w X.
  Adds a row to BOTH archives (independent (archive_id, source_workstream, original_local_id) tuples).

The system supports all three. Operator picks per-call.

═══ ANTI-FEATURE GUARDRAIL ═══

Don't add an "auto-add to default archive" feature ("mu workstream destroy without --archive auto-adds to a 'misc' bucket"). Either the operator picked an archive deliberately, or they didn't want one. Silent default = anti-pattern.
```
