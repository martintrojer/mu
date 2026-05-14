---
id: "workstream_import_from_markdown"
workstream: "roadmap-v0-3"
status: CLOSED
impact: 65
effort_days: 0.7
roi: 92.86
owner: "worker-1"
created_at: "2026-05-10T05:29:46.705Z"
updated_at: "2026-05-10T07:12:52.313Z"
blocked_by: ["archive_phase4_export_renderer_unified"]
blocks: []
---

# feat: mu workstream import <dir> — inverse of export; markdown-only (no .db); cross-machine + collab via checked-in folders

## Notes (2)

### #1 by "π - mu", 2026-05-10T05:30:44.356Z

```
mu workstream import <dir> — INVERSE of mu workstream export.

═══ THE GAP ═══

Today: mu workstream export -w X --out d/ writes the workstream's task graph as plain markdown + manifest.json. There's NO inverse. To rehydrate a workstream:
  - on the same machine: keep the .db (snapshot/undo).
  - across machines: there's nothing.
  - with a collaborator: there's nothing.

Operator's use case (this filing): "checked-in workspace folders are a clean cross-machine + collab story". Push the export dir to git; teammate pulls + runs `mu workstream import path/to/exported-dir`; they have the workstream + tasks + edges + notes locally.

═══ KEY DESIGN CONSTRAINT (operator-stated, viable restriction) ═══

IMPORT MARKDOWN FOLDERS ONLY. Do NOT import .db files.

Why this is the right line:
  - .db is binary, opaque, machine-specific (paths, timestamps, schema-version coupling).
  - markdown is human-readable, diff-able, code-reviewable, conflict-resolvable in git.
  - the export already writes a self-describing tree (README.md + INDEX.md + tasks/<id>.md + manifest.json + sha256s). It IS the import format.
  - .db cross-machine = snapshot/undo + scp; that's a different operator workflow ("undo") and we don't need to reinvent it.

This restriction also keeps import simple: the parser is a directory walker over a known shape, NOT a SQLite reader.

═══ DEPENDS ON ═══

Phase 4 (archive_phase4_export_renderer_unified) — the bucket layout is finalized there. Import targets the bucket layout (bucketVersion: 2), NOT the legacy single-workstream layout. Do this AFTER Phase 4 lands; otherwise we'd implement against a soon-to-be-deprecated shape and have to rewrite.

═══ CLI SHAPE ═══

  mu workstream import <bucket-dir> [--workstream <name-override>] [--dry-run] [--json]

Behavior:
  - Walk <bucket-dir>; verify it has bucketVersion: 2 manifest at the top (refuse the legacy single-ws layout with a helpful error: "this is a pre-bucket export; rm -rf and re-export with mu 0.3+, OR run on the per-source-ws subdir if you only want one").
  - For each <source-ws>/ subdir under the bucket:
      * default: import as workstream named <source-ws> (the original name).
      * --workstream <name-override>: only valid if the bucket contains exactly ONE source-ws subdir. Errors otherwise.
  - Per source-ws:
      * If a workstream of that name already exists: ERROR (refuse to merge silently). Operator's recourse: rename the import via --workstream, or destroy the existing first. Anti-feature: no auto-merge.
      * Create the workstream (ensureWorkstream).
      * Parse each tasks/<id>.md frontmatter → reconstruct task row (id, title, status, impact, effort_days, owner, created_at, updated_at).
      * owner_name in frontmatter is preserved as a TEXT field on the task only if a matching agent exists in the workstream after import (which is impossible; agents aren't exported). So owner is dropped on import (set to NULL / no owner_id). The original owner survives in the markdown frontmatter and notes — that's the load-bearing audit trail. mu's owner_id column is an agent FK and the agent doesn't exist; setting it to NULL is honest.
      * Parse the body's "## Notes (N)" section back into individual task_notes rows (author, content, created_at; the rendered fence delimiters are reversible).
      * Parse blocked_by + blocks frontmatter arrays into task_edges. Defer edge creation until ALL tasks are imported (forward references).
      * Skip tasks with the deleted-banner ("> **Deleted from DB on …**") prefix — they're tombstones, not live tasks. Counted in the report as "skipped (tombstoned)".
  - --dry-run: walk + parse + validate; report what WOULD be created; no DB writes.
  - --json: per-bucket summary { workstreams: [{ name, tasksImported, edgesImported, notesImported, tombstonesSkipped }], errors: [...] }.
  - Idempotent if re-imported into a still-empty workstream OF THE SAME NAME after a destroy + import — but this is an explicit re-do, not a "merge into existing". No silent merge.

═══ WHAT GETS IMPORTED ═══

Per task: id (local_id), title, status, impact, effort_days, created_at, updated_at, blocked_by, blocks, the full notes body.

NOT imported (anti-features per existing export design + this filing):
  - agents (workforce, not memory).
  - workspaces (operational state, not memory).
  - approvals (low-value, not in export today).
  - agent_logs / agent_logs events (the export only renders task notes; the audit trail beyond the task notes is out of scope; if you want it, snapshot+undo).
  - archives (archive labels are operator-managed; an archive's ROW isn't in the export shape; if you want to round-trip an archive, that's a SEPARATE follow-up — see "future" below).

═══ ROUND-TRIP CONTRACT ═══

  mu workstream export -w X --out d/    →    rm/move the source DB    →    mu workstream import d/    →
    a workstream named X (or new name via --workstream) with every task + edge + note from the export.

NOT a perfect round-trip:
  - owner_id resets to NULL (agents aren't exported).
  - manifest.json's eventsSeqAtExport is informational only (we don't replay events).
  - timestamps in created_at/updated_at are PRESERVED from the markdown frontmatter (operator-visible audit truth).

═══ ERROR PATHS ═══

  ImportBucketInvalidError      → exit 2: directory missing manifest.json or wrong bucketVersion.
  ImportLegacyLayoutError       → exit 2: detected legacy single-ws layout; helpful migration hint.
  WorkstreamAlreadyExistsError  → exit 4: target workstream already in DB; suggest --workstream or destroy first.
  ImportFrontmatterParseError   → exit 2: a task .md has invalid frontmatter; report file path + line + raw error.
  ImportEdgeRefMissingError     → exit 2: a blocked_by/blocks references a task not present in the import; report which.

All errors typed; no partial commits (whole import in one transaction per source-ws; if any task in a ws fails, that ws is rolled back; other ws's still imported).

═══ FILES TO TOUCH ═══

  src/exporting.ts   : we'll have the bucket renderer in here post-Phase-4 — add a parser-side companion (or factor into src/importing.ts NEW file; pick whichever keeps each file under 800 LOC).
  src/workstream.ts  : new importWorkstream / importBucket SDK; mirror exportWorkstream's shape.
  src/cli/workstream.ts : new `import` subcommand (commander glue).
  test/importing.test.ts : NEW. Round-trip: export → wipe DB → import → assert task / edge / note count + sample-row equality.
  CHANGELOG.md       : v0.3.0 entry.
  docs/USAGE_GUIDE.md: cross-machine / collab workflow recipe.
  skills/mu/SKILL.md : verb list update + a "moving a workstream across machines" pattern.

═══ ANTI-FEATURES ═══

  - No .db file import. If you want that, use snapshots + undo.
  - No silent merge into an existing workstream. Errors loud.
  - No archive import (archives don't survive export today; separate follow-up).
  - No partial / interactive import. Whole-bucket-or-fail per source-ws.
  - No conflict resolution UI. The markdown is the operator's source of truth; conflicts get edited in the markdown before import.
  - No round-trip of agents / workspaces / approvals / agent_logs.

═══ FUTURE WORK (out of scope here; file as separate task if hit ≥1 more time) ═══

  - Archive import: round-trip an exported archive bucket back into the in-DB archive. Phase 4 ships archive export → bucket; the inverse would be `mu archive import <bucket-dir> --label <l>`. Mirrors workstream import's shape but writes to archived_* tables. Defer until promotion criteria met.
  - Partial import: --only <task-id-glob> to cherry-pick from a bucket. Defer until friction surfaces.

═══ PROMOTION ═══

  - Real-user friction: just hit (this filing). Operator wants checked-in workspace folders for cross-machine + collab. Today: zero way to bring an exported folder back.
  - Substrate: depends on Phase 4's bucket layout being final. After Phase 4, the parser is a directory walker + frontmatter parser + insert loop.
  - Fits in <300 LOC: yes (~200 LOC SDK + ~80 CLI + ~150 tests).

PROMOTE for v0.3 alongside the archive feature. Critical-path-coherent: the export shape and the import shape must be designed together (which is why this is blocked-by Phase 4, not Phase 2).
```

### #2 by "reaper", 2026-05-10T06:55:27.507Z

```
[reaper] previous owner worker-1 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```
