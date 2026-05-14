---
id: "tr_db_sync_error_inventory"
workstream: "multimachine"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-14T09:51:21.678Z"
updated_at: "2026-05-14T10:05:23.514Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: new db sync errors are missing from error coverage inventory

## Notes (3)

### #1 by "worker-2", 2026-05-14T09:51:21.979Z

```
FILE: test/cli-classify-error.test.ts: classifyError exit-code map; test/error-nextsteps.test.ts: typed errors all carry actionable errorNextSteps()
WHAT'S MISSING/WRONG: The diff adds db-sync/db-replay typed errors, but the tests only cover DbImport* classify mappings. DbExportTargetExistsError and DbReplayWorkstreamMissingError/DbReplayLocalIdConflictError are absent from classify-error cases, and error-nextsteps.test.ts does not import ../src/db-sync.js in its exported-error inventory nor include explicit Db* next-step cases.
WHY IT MATTERS: A future change could break export/replay exit-code mapping or ship empty/generic recovery hints for new DB sync errors without failing the typed-error inventory tests. In particular, the inventory currently gives false confidence because it never scans the module where these new HasNextSteps classes are exported.
SUGGESTED FIX: Add classifyError cases for DbExportTargetExistsError, DbReplayWorkstreamMissingError, and DbReplayLocalIdConflictError (plus any missing DbImport cases if desired). Import ../src/db-sync.js in error-nextsteps.test.ts inventory and add explicit expected-token cases for all exported Db* HasNextSteps classes.
SEVERITY: medium
```

### #2 by "worker-2", 2026-05-14T10:05:22.584Z

```
FILES: test/cli-classify-error.test.ts; test/error-nextsteps.test.ts
COMMANDS: npx biome check --write src test; npm run typecheck; npm run lint; npm run test:fast; npm run build; node dist/cli.js --help; node dist/cli.js db export /tmp/wave-b-smoke.db --force 2>&1 | grep -i 'next:' -A 5
FINDINGS: Db export/replay typed errors were under-covered in classifyError and nextSteps inventory.
DECISION: Added explicit DbExportTargetExistsError, DbReplayWorkstreamMissingError, DbReplayLocalIdConflictError coverage plus DbImport nextSteps cases; inventory imports db-sync and db-sync-replay.
NEXT: none
VERIFIED: commit 6d5825445c213d361f9dde3542ac069110c73065; typecheck/lint/test:fast/build and bundle smoke passed.
ODDITIES: none
```

### #3 by "worker-2", 2026-05-14T10:05:23.514Z

```
CLOSE: 6d5825445c213d361f9dde3542ac069110c73065 classifyError + nextSteps inventory now scans db-sync + db-sync-replay; explicit cases added
```
