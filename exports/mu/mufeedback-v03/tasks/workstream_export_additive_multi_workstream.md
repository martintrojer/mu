---
id: "workstream_export_additive_multi_workstream"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: null
created_at: "2026-05-09T17:04:43.497Z"
updated_at: "2026-05-10T06:55:46.783Z"
blocked_by: ["workstream_archive_verb"]
blocks: []
---

# feat: mu archive export (and mu workstream export) additive — accumulate multiple workstreams' tasks into the same out-dir over time

## Notes (3)

### #1 by "π - mu", 2026-05-09T17:05:49.766Z

```
SURFACED post-archive-design (per operator): export needs to mirror the archive's additive shape. Today `mu workstream export -w X --out d` writes only X's tasks to d/. The operator's pattern is "one exports/mu/ dir that accumulates every mu-related wave over time".

═══ THE GAP ═══

  # today (single-workstream, single-out)
  mu workstream export -w mufeedback --out exports/mufeedback
  mu workstream export -w roadmap-v0-2 --out exports/roadmap-v0-2

  # operator wants:
  mu workstream export -w mufeedback --out exports/mu      # creates exports/mu/mufeedback/...
  mu workstream export -w roadmap-v0-2 --out exports/mu    # adds exports/mu/roadmap-v0-2/...
  # next release:
  mu workstream export -w mufeedback-v03 --out exports/mu  # adds exports/mu/mufeedback-v03/...

Same shape as `mu archive add mu -w <ws>`: the out-dir is the bucket; each call adds a per-source-ws subdirectory. Idempotent.

═══ TWO VERBS, ONE PATTERN ═══

This task addresses the SAME additive pattern in TWO surfaces:

  PART A — `mu workstream export` becomes additive over multi-source out-dirs.
    - `--out d` becomes BUCKET-PATH semantics, not workstream-path.
    - Bucket layout:
        d/
          README.md           # bucket-level: 'multi-workstream archive', list of sources + dates
          INDEX.md            # bucket-level: union of all task tables; first column is source-ws
          manifest.json       # bucket-level: per-source-ws sha256 + last-added-at timestamps
          <source-ws>/
            README.md         # per-source-ws (today's shape)
            INDEX.md          # per-source-ws (today's shape)
            tasks/<id>.md     # per-source-ws task files (today's shape)
    - When d/ doesn't exist yet: create the bucket scaffolding + first source-ws subdir.
    - When d/ exists: append the new source-ws subdir; update bucket-level README + INDEX + manifest.
    - Re-export of a same-source-ws is idempotent: only changed files written; unchanged files mtime-preserved (via the existing manifest.json sha256 check).
    - Tasks deleted from a source-ws since last export STAY in the bucket with the existing 'banner' marker.

  PART B — `mu archive export` (Phase 4 of workstream_archive_verb) reuses PART A's bucket renderer.
    - mu archive export <label> --out d uses the same bucket layout.
    - Per-source-ws subdirs reflect the (archive_id, source_workstream) partitioning of the archive.
    - The bucket's manifest.json gains an extra field `archive_label` so the renderer knows it's archive-sourced (vs workstream-sourced) for accurate README text.

═══ MIGRATION OF TODAY'S exports/ DIR ═══

The existing exports/ dir we committed in cb23808 has the OLD layout (per-workstream top-level dirs). For the additive feature:
  - Option A: bump the manifest.json schema (add `bucketVersion: 2`); old layout still works for re-export, new layout is opt-in via a new `--bucket` flag or `--out` semantics auto-detect (if d/manifest.json exists at top, old shape; else new shape with subdirs).
  - Option B: just rewrite the layout. Pre-1.0; no third-party export-path consumers; one-line operator-side cleanup (`rm -rf exports/mufeedback exports/roadmap-v0-2 && mu archive export mu --out exports/mu`).
  
  Recommend B (per the v0.2 aggressive-migration pattern). The exports we committed are effectively snapshots in git history; they don't need forward compat.

═══ SCHEMA SHAPE — manifest.json ═══

Bucket-level manifest.json grows from per-task hashes to per-source-ws hashes plus the per-task hashes scoped under each:

  {
    "bucketLabel": "mu",                        // operator-chosen
    "bucketCreatedAt": "...",
    "bucketLastUpdatedAt": "...",
    "muVersion": "0.2.0",
    "sources": {
      "mufeedback": {
        "addedAt": "2026-05-09T...",
        "lastReExportedAt": "2026-05-09T...",
        "eventsSeqAtExport": 1616,
        "tasks": [{ "id": "...", "path": "mufeedback/tasks/...", "sha256": "..." }, ...]
      },
      "roadmap-v0-2": { ... },
      "mufeedback-v03": { ... }
    }
  }

═══ CLI SHAPE ═══

Both verbs gain identical bucket semantics:

  mu workstream export -w <ws> --out <bucket-dir>
    → if bucket-dir exists: add ws as a sibling source-ws subdir
    → if not: create bucket + first source-ws subdir

  mu archive export <label> --out <bucket-dir>
    → bucket auto-populates with every source-ws in the archive

Operator's mu-bucket workflow becomes:
  mu workstream export -w mufeedback --out exports/mu          # initial
  mu workstream export -w roadmap-v0-2 --out exports/mu        # add
  mu workstream export -w mufeedback-v03 --out exports/mu      # add (next release)
  
  # Or via archive (after archive ships):
  mu archive add mu -w mufeedback --destroy
  mu archive add mu -w roadmap-v0-2 --destroy
  mu archive export mu --out exports/mu                        # re-export the whole bucket

═══ ANTI-FEATURES ═══

  - Don't auto-detect "is this an archive label or a workstream name?" — separate verbs (workstream export vs archive export). Archive label namespace is separate from workstream name namespace.
  - Don't merge per-task .md files across source-workstreams. Tasks with the same name in different source-workstreams stay in separate subdirs.
  - Don't add a `--flatten` flag that puts all tasks under one tasks/ dir. Source-ws subdirs are load-bearing for "who owned this design".
  - Don't make the bucket renderer require running `mu archive export` first. Both entry points produce the same shape.

═══ DEPENDENCY ═══

Blocked by: workstream_archive_verb design (PART B references the archive surface; PART A could ship standalone but the bucket layout should be designed once for both).

PHASING:
  - Phase 1 (this task or split): PART A — workstream export additive bucket. ~80 LOC + ~50 LOC tests.
  - Phase 2 (lives in workstream_archive_verb's Phase 4): PART B — archive export bucket. ~30 LOC (reuses Phase 1's renderer).

═══ PROMOTION ═══

  - Real-user friction: just hit by operator post-v0.2 commit cb23808.
  - Substrate ready: existing exportWorkstream renderer + the proposed archive schema both inform the bucket layout.
  - Fits in <300 LOC: yes for PART A standalone (~130 LOC).

PROMOTE for v0.3 alongside the archive verb. They ship as a coherent feature pair.
```

### #2 by "π - mu", 2026-05-09T17:07:01.485Z

```
ADDENDUM (operator suggestion: move export under archive entirely): half-agree, half-pushback.

═══ THE OPERATOR'S CASE (which is right) ═══

Archive should be the CENTER of the design:
  - Archives are the durable in-DB bucket (the load-bearing concept).
  - Export is just a renderer: "take an archive's structured data, write it to disk as markdown".
  - The bucket-shape on disk (per-source-ws subdirs) IS the archive's structure mirrored.
  - Two verbs that both produce the same disk shape from different sources is a smell.

Honest: the renderer is shared substrate. Two CLI verbs that wrap the same renderer with different data sources is exactly the kind of redundancy the verb audit (audit_verbs_typed_vs_sql, just shipped) flagged elsewhere.

═══ MY PUSHBACK (where I disagree) ═══

Fully removing `mu workstream export` regresses a real one-shot use case:

  Today's flow (single command, 30 seconds total):
    mu workstream export -w mufeedback --out exports/mufeedback

  Archive-only flow (4 commands, archive label cognitive overhead):
    mu archive create temp-mufeedback-2026-05-09
    mu archive add temp-mufeedback-2026-05-09 -w mufeedback
    mu archive export temp-mufeedback-2026-05-09 --out exports/mufeedback
    mu archive delete temp-mufeedback-2026-05-09 --yes

The cliff is: the operator HIT the one-shot case 30 seconds before filing the archive feature. We literally just used `mu workstream export -w mufeedback --out exports/mufeedback` to commit cb23808 to main. Removing the verb would have made that commit ~3 minutes of cognitive overhead instead of 1.

Also: archives carry DB cost (schema migration v5→v6, archive label namespace management, the new tables in src/db.ts). Export today is zero-DB-cost — it just reads existing tables and writes files. Forcing every dump through an archive imposes the heavier infrastructure on the lighter use case.

═══ THE COMPROMISE — ARCHIVE IS THE CENTER, EXPORT IS A THIN SUGAR ═══

Keep BOTH verbs. The architectural truth:
  - Archive is the center: `mu archive create / add / export / show / list / delete` is the durable accumulation surface.
  - Export is sugar: `mu workstream export -w <ws> --out <bucket-dir>` becomes a thin wrapper that:
      1. Constructs an EPHEMERAL in-memory archive from the workstream's tasks/edges/notes/events.
      2. Calls the archive renderer on it.
      3. Writes the bucket layout to disk.
      4. Discards the in-memory archive (no DB writes).
  - The DISK SHAPE is identical to `mu archive export`'s output — same per-source-ws subdir, same manifest.json, same bucket README/INDEX.
  - Re-running `mu workstream export -w X --out <existing-bucket>` ADDS to the bucket (idempotent, per the additive design); the operator gets the additive accumulation without ever creating a named archive.

What this buys:
  - One-shot dumps stay one command.
  - The renderer ships once (in src/archive/export.ts or similar). Both verbs delegate.
  - Archives are honest about being durable + queryable + named.
  - Exports are honest about being throwaway + filesystem-only + ad-hoc.
  - Operators learn one disk shape; can mix workflows freely (start with workstream export, later promote to mu archive add for the same data).

═══ THE VERB TAXONOMY ═══

  mu workstream destroy [--archive <label>]    # destroy; optional in-DB archive first
  mu workstream export -w <ws> --out <bucket>  # one-shot dump to bucket (additive)
  mu archive create <label>                    # new durable archive
  mu archive add <label> -w <ws>               # add ws's content to archive (additive)
  mu archive export <label> --out <bucket>     # render archive to bucket
  mu archive list / show / search / remove / delete

Five verbs total; clear separation. The "renderer" lives in one place (~150 LOC); both export verbs are ~30 LOC of wiring on top.

═══ PUSHBACK ON THE PUSHBACK (concession) ═══

If operator still prefers archive-only (delete `mu workstream export` entirely):
  - Promotes the archive workflow from sugar to required.
  - Forces explicit naming (every disk dump has a label, even temp ones).
  - Reduces verb count by 1.
  - The ~3-min friction for one-shots is real but bounded.
  
  In the audit_verbs_typed_vs_sql framework: workstream export's score post-archive-shipping would be 1/4 (output value only — the SDK is just a renderer). That's a REMOVE candidate per the audit.

  So there's a defensible "no, remove it" position. I'd accept it if the operator's followup is "yes, remove it; the friction is acceptable". The compromise is the recommend; the removal is acceptable.

═══ DECISION REQUEST ═══

Operator picks:
  (a) RECOMMEND: keep mu workstream export as sugar over the archive renderer (5 verbs total, one-shot stays single-command).
  (b) PUSH HARDER: remove mu workstream export entirely; archive is the only path (4 verbs total, every disk dump goes via the archive surface).

Either way: the underlying renderer is unified, the bucket layout is identical, the additive semantics are the same. The CLI surface is the only difference.
```

### #3 by "π - mu", 2026-05-09T17:13:04.735Z

```
DECISION (operator, v0.3 kickoff): option (a) — keep mu workstream export as a thin sugar wrapper over the unified archive renderer. NOT removing the verb.

REASONING:
1. Real-friction signal: commit cb23808 used mu workstream export ~30s before this feature got filed. The verb is in active use; removing it now is high-cost / low-gain.
2. The mu workstream destroy auto-export path (pre-destroy snapshot to <state-dir>/exports/<ws>-<ts>/) also needs the renderer. The renderer factors out cleanly regardless; the second wrapper is ~30 LOC.
3. The bucket disk shape is identical between mu workstream export and mu archive export. Operators learn one shape and pick the entry point that matches intent (one-shot vs durable named accumulation).
4. Anti-feature pledge "no anticipatory abstractions" satisfied: both verbs have a real implementor on day 1; the renderer has two callers, not one with a placeholder.
5. Bounded cost: sugar wrapper is ~30 LOC of wiring; future audit can revisit if the verb sees zero use post-archive-shipping.

VERB TAXONOMY (final, 5 verbs):
  mu workstream destroy [--archive <label>]    # destroy; optional in-DB archive first (Phase 3)
  mu workstream export -w <ws> --out <bucket>  # one-shot dump to bucket (additive); Phase 4 PART A
  mu archive create / add / list / show / remove / delete    # durable in-DB archive (Phase 1 + 2)
  mu archive export <label> --out <bucket>     # render archive to bucket; Phase 4 PART B
  mu archive search <pattern>                  # Phase 4

DISK SHAPE (both verbs produce):
  <bucket>/
    README.md                # bucket-level: 'multi-workstream archive', source list + dates
    INDEX.md                 # bucket-level: union of all task tables; first column = source-ws
    manifest.json            # bucket-level: per-source-ws sha256 + lastAddedAt; bucketVersion: 2
    <source-ws>/
      README.md / INDEX.md / tasks/<id>.md   # today's per-workstream shape

MIGRATION: Option B from the design (aggressive rewrite). exports/mufeedback/ + exports/roadmap-v0-2/ are git-history snapshots and don't need forward compat. Pre-1.0; one-line operator-side cleanup at v0.3 release time.

EXECUTION ORDER (anchor-task phases drive this):
  Phase 1: schema v5→v6 + SDK (workstream_archive_verb)
  Phase 2: mu archive create/list/show/add/remove/delete CLI verbs
  Phase 3: mu workstream destroy --archive <label>
  Phase 4 PART A: mu workstream export bucket additive (this task)
  Phase 4 PART B: mu archive export bucket (this task)

This task ships PART A + PART B together, after the archive substrate (Phase 1+2) lands. ~130 LOC + tests.
```
