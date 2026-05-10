---
id: "review_export_archive_double_resolves_label"
workstream: "mufeedback-v03"
status: CLOSED
impact: 20
effort_days: 0.05
roi: 400.00
owner: null
created_at: "2026-05-10T11:39:23.583Z"
updated_at: "2026-05-10T11:57:15.099Z"
blocked_by: []
blocks: []
---

# review: cmdArchiveExport pre-resolves label twice + duplicates totalTasks math

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:39:23.687Z

```
FILES: src/cli/archive.ts:445-484 (cmdArchiveExport); src/exporting.ts:723-751 (exportArchive)

FINDING: Two minor smells stacked: (1) cmdArchiveExport calls `getArchive(db, label)` for the typed-error precheck, and exportArchive then calls `listArchivedTasks(db, opts.label)` which ALSO throws ArchiveNotFoundError (its own internal precheck). The CLI's comment claims "double-checking here keeps the JSON and prose error paths identical" — but classifyError handles both shapes uniformly, so the second resolve is dead. (2) `totalTasks` is computed via `Object.values(result.manifest.sources).reduce((acc, s) => acc + (s as { tasks: unknown[] }).tasks.length, 0)`. The cast to `{ tasks: unknown[] }` is non-idiomatic — manifest.sources is `Record<string, ExportSourceManifest>` already typed; the cast suggests the author lost the type chain. Equivalent line: `Object.values(result.manifest.sources).reduce((acc, s) => acc + s.tasks.length, 0)`.

WHY: The type cast is a noUncheckedIndexedAccess workaround that should be a typed import (ExportSourceManifest is exported). The double-precheck adds latency on the SAD path (rare, but the comment is wrong).

FIX-SKETCH: 1) Drop the redundant `getArchive(db, label)` precheck; rely on exportArchive's internal listArchivedTasks throw. Update the comment. 2) Drop the `as { tasks: unknown[] }` cast — `s` is already typed as ExportSourceManifest via Record<string, ExportSourceManifest>.

DONT-FIX: Don't add yet another precheck wrapper.
```
