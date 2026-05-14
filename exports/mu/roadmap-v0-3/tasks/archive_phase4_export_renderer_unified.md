---
id: "archive_phase4_export_renderer_unified"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 70
effort_days: 0.6
roi: 116.67
owner: null
created_at: "2026-05-09T17:14:41.835Z"
updated_at: "2026-05-10T06:28:32.587Z"
blocked_by: ["archive_phase2_cli_verbs"]
blocks: ["workstream_import_from_markdown"]
---

# Phase 4: unified bucket renderer; mu archive export + mu workstream export additive (sugar wrapper)

## Notes (1)

### #1 by "π - mu", 2026-05-09T17:17:31.274Z

```
Phase 4 — unified bucket renderer + additive mu workstream export + mu archive export.

DEPENDS ON: Phase 2.

OPERATOR DECISION (recorded on mufeedback-v03/workstream_export_additive_multi_workstream note 4): KEEP both verbs. mu workstream export becomes thin sugar over the archive renderer (constructs an EPHEMERAL in-memory archive from the workstream, calls the renderer, no DB writes). Archive is the center; export is the renderer.

═══ CRITICAL: ALSO UPDATE THE AUTO-EXPORT PATH IN destroyWorkstream ═══

`mu workstream destroy` auto-exports to <state-dir>/exports/<ws>-<ts>/ today (per the SKILL doc). That call site MUST migrate to the new bucket renderer too, otherwise the auto-export and the user-driven export produce different shapes.

═══ NEW DISK SHAPE — BUCKET LAYOUT ═══

  <bucket>/
    README.md           # bucket-level: 'multi-workstream archive', source list + dates + total tasks
    INDEX.md            # bucket-level: union of all task tables; first column = source-ws | id | status | ...
    manifest.json       # bucket-level: per-source-ws sha256 + lastAddedAt; bucketVersion: 2
    <source-ws>/
      README.md         # per-source-ws (today's shape, unchanged content)
      INDEX.md          # per-source-ws (today's shape)
      tasks/<id>.md     # per-source-ws task files

═══ MANIFEST.JSON SHAPE (bucketVersion: 2) ═══

  {
    "bucketVersion": 2,
    "bucketLabel": "<archive-label-or-null-for-workstream-export>",
    "bucketCreatedAt": "...",
    "bucketLastUpdatedAt": "...",
    "muVersion": "0.3.0",
    "sources": {
      "mufeedback": {
        "addedAt": "2026-05-09T...",
        "lastReExportedAt": "2026-05-09T...",
        "eventsSeqAtExport": 1616,
        "tasks": [{ "id": "...", "path": "mufeedback/tasks/...", "sha256": "..." }, ...]
      },
      ...
    }
  }

═══ MIGRATION OF OLD SHAPE: AGGRESSIVE (per workstream_export_additive note Option B) ═══

The exports/ dir we committed in cb23808 is OLD layout (per-workstream top-level dir, bucketVersion: 1 implied). Pre-1.0; no third-party consumers; one-line operator-side cleanup.

In code:
  - Detect bucketVersion in existing manifest.json. If 1 (or absent), treat the dir as a SINGLE-WORKSTREAM legacy export and refuse to migrate it in-place; error with a helpful message: "this dir was created with a pre-bucket export; rm -rf <dir> and re-run, or pick a different --out".
  - Alternative (simpler): just refuse if `manifest.json` exists at top level AND its workstream field !== this workstream AND no `bucketVersion: 2`. Fail loud. That's the v0.2 aggressive-migration pattern.

═══ RENDERER FACTOR-OUT (src/archive_export.ts or src/exporting.ts; pick the cleaner naming) ═══

Today's exportWorkstream in src/workstream.ts (~340 LOC) gets restructured:
  - Lift renderTaskMarkdown / renderIndexMarkdown / renderReadmeMarkdown / fenceForBody / yamlScalar / sha256Hex / readMuVersion / DELETED_BANNER_PREFIX / bannerFor / readManifest into src/exporting.ts (renderer module).
  - The renderer takes a UNIFIED INPUT: { sources: { name: string; tasks: TaskLike[]; edges: EdgeLike[]; notes: NoteLike[]; eventsSeqAtExport: number }[]; bucketLabel: string | null; outDir: string }.
  - exportWorkstream becomes ~30 LOC: build a single-source ExportInput from the live workstream, call renderToBucket(input).
  - exportArchive (NEW, ~50 LOC): build a multi-source ExportInput from archived_* tables, call renderToBucket(input).

KEEP src/workstream.ts under 1500 LOC; today it's 760 + ~340 export = 1100. After lift-out, ~760 stays. src/exporting.ts ends ~500 LOC. src/archive_export.ts ~50 LOC.

═══ ADDITIVE SEMANTICS ═══

Both workstream export and archive export to an existing bucket:
  - Re-export of same source-ws is idempotent (sha256 short-circuit, today's behavior).
  - Add a NEW source-ws to an existing bucket: append <bucket>/<new-ws>/, update bucket-level README/INDEX/manifest, leave existing source-ws subdirs untouched.
  - Tasks deleted from a source-ws since last export: STAY with the existing banner marker (today's behavior, preserved).

═══ TESTS (test/exporting.test.ts NEW, ~200 LOC) ═══

  1. New bucket from one workstream: bucket scaffolding + first source-ws subdir.
  2. Add a second source-ws: bucket scaffolding updated; first source-ws untouched.
  3. Re-export same source-ws: zero file rewrites (sha256 short-circuit).
  4. Re-export with a task deleted from DB: banner appears once; second re-export is no-op.
  5. mu archive export <label>: bucket per-source-ws layout matches the (archive_id, source_workstream) partitioning.
  6. Refuse to write into a legacy (bucketVersion: 1 / single-workstream manifest) dir.
  7. mu workstream destroy auto-export uses bucket layout (read-back the manifest).

═══ DOCS ═══

  docs/USAGE_GUIDE.md: rewrite the export section with the bucket layout.
  CHANGELOG.md: terse "Bucket exports — additive across workstreams; old single-ws layout no longer supported".
  skills/mu/SKILL.md: update the export bullet to mention bucket semantics.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close archive_phase4_export_renderer_unified -w roadmap-v0-3 --evidence '...'
```
