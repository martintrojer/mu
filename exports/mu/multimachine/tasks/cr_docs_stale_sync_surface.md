---
id: "cr_docs_stale_sync_surface"
workstream: "multimachine"
status: REJECTED
impact: 60
effort_days: 0.4
roi: 150.00
owner: null
created_at: "2026-05-14T09:56:00.430Z"
updated_at: "2026-05-14T10:01:00.394Z"
blocked_by: []
blocks: []
---

# Code review: docs still advertise removed workstream import and omit new sync verbs

## Notes (2)

### #1 by "worker-1", 2026-05-14T09:56:00.690Z

```
FILE: docs/VOCABULARY.md:60; docs/USAGE_GUIDE.md:1728; CHANGELOG.md:1; docs/ARCHITECTURE.md:508
WHAT'S WRONG: The code removes mu workstream import and adds mu db export/import/replay plus mu archive restore, but the canonical docs are not updated consistently. VOCABULARY still defines import as mu workstream import; USAGE_GUIDE still has a Cross-machine + collab section instructing mu workstream import; CHANGELOG has no 0.4.0 entry for schema v8/new db verbs/removal; ARCHITECTURE removed src/importing.ts but does not add src/db-sync.ts/src/db-sync-replay.ts and the archive cluster row still omits restore.
WHY IT MATTERS: AGENTS.md says VOCABULARY and CHANGELOG are source-of-truth for verbs/schema/env. Users and future agents will copy commands that no longer exist, and reviewers cannot validate the intended schema/verb contract from the docs.
SUGGESTED FIX: Update VOCABULARY before code lands, rewrite the USAGE_GUIDE cross-machine section around mu db export/import/replay and mu archive restore, add CHANGELOG entries for schema v8/new verbs/removal, and add ARCHITECTURE rows for the db sync modules plus archive restore.
SEVERITY: medium
```

### #2 by "π - mu", 2026-05-14T10:00:59.327Z

```
ORCHESTRATOR REJECTION
=====================
Closing as REJECTED — DUPLICATE.

The docs_pass task already covers VOCABULARY + USAGE_GUIDE + CHANGELOG + ARCHITECTURE updates explicitly. This finding restates the same scope from a different angle. No separate work warranted.
```
