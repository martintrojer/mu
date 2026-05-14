---
id: "drop_legacyexportlayouterror"
workstream: "feedback"
status: CLOSED
impact: 10
effort_days: 0.2
roi: 50.00
owner: null
created_at: "2026-05-11T09:09:02.297Z"
updated_at: "2026-05-11T09:16:06.146Z"
blocked_by: []
blocks: []
---

# drop LegacyExportLayoutError + ImportLegacyLayoutError + the v1 export bucket probe (pre-v0.3 format)

## Notes (2)

### #1 by "worker-droplegacy-1", 2026-05-11T09:15:58.712Z

```
FILES:
  - src/exporting.ts: removed LegacyExportLayoutError class; removed { kind: "legacy" } arm from ManifestProbe + readManifest (manifests not bucketVersion:2 now fall through to "corrupt"); removed `if (probe.kind === "legacy") throw` from renderToBucket; updated header comment near ExportManifest.
  - src/importing.ts: removed ImportLegacyLayoutError class; removed `if (probe.kind === "legacy") throw` in walkBucket; updated importBucket header comment.
  - src/cli/handle.ts: dropped LegacyExportLayoutError + ImportLegacyLayoutError imports; removed the two instanceof arms in classifyError; updated isUsageClassError doc.
  - src/index.ts: dropped both error class re-exports.
  - src/workstream.ts: dropped two stale doc-comment refs to LegacyExportLayoutError.
  - docs/USAGE_GUIDE.md: removed the "Pre-0.3 layouts refuse" bullet (line 1483).
  - CHANGELOG.md: added a "Removed" subsection to [Unreleased] documenting the cleanup.
  - test/exporting.test.ts: dropped the "refuses legacy pre-0.3 layout" describe + its mkdirSync/writeFileSync imports.
  - test/importing.test.ts: dropped the "ImportLegacyLayoutError on a pre-0.3 single-source manifest" it() and its import.
COMMANDS:
  - npm run typecheck (exit 0)
  - npx biome check --write src test (1 fix — import grouping in test/exporting.test.ts after removing two imports)
  - npm run lint (exit 0)
  - npm run test (1255 / 1255 passing across 70 files)
  - npm run build (exit 0; ESM + DTS both clean)
FINDINGS:
  - readManifest's old probe had four shapes (v2 / legacy / absent / corrupt). After removal it has three (v2 / absent / corrupt). The "legacy" shape was the only one with operator-facing semantics ("we recognize this but refuse"); the other consumers (renderToBucket, walkBucket) treat absent as "fresh export" and corrupt as ImportBucketInvalidError, so the contract for the no-legacy world is unchanged.
  - The cli/handle.ts changes only touched classifyError + the two doc paragraphs — no callers' typed-error contracts changed.
  - No other files referenced the dropped classes (grep confirmed).
DECISION:
  - Did NOT introduce a new NoManifestError as the task allowed; the existing { kind: "absent" } path is consumed by renderToBucket (treats as fresh) and by walkBucket (which already throws ImportBucketInvalidError with reason "manifest.json missing"). One typed surface for "no manifest", as the task required, already exists; adding another would be the wrong call.
NEXT:
  - None: feedback bucket complete for this item.
VERIFIED:
  - npm run typecheck && npm run lint && npm run test && npm run build all exit 0.
  - grep for LegacyExportLayoutError / ImportLegacyLayoutError / 'kind: "legacy"' in src/test/docs returns zero hits in code paths (only historical CHANGELOG entries + the new [Unreleased] description remain, which is expected).
ODDITIES:
  - None.
```

### #2 by "worker-droplegacy-1", 2026-05-11T09:16:06.146Z

```
CLOSE: all 4 green; Legacy*Error classes + probe branches gone; commit f6d24c9
```
