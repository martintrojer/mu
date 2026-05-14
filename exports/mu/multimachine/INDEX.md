# multimachine — task index

| id | status | impact | effort | ROI | title |
| --- | --- | --- | --- | --- | --- |
| [`archive_cleanup`](tasks/archive_cleanup.md) | CLOSED | 50 | 0.25 | 200.00 | Archive verb cleanup: help-text audit + round-trip test conversion (archive add → archive restore) |
| [`archive_restore`](tasks/archive_restore.md) | CLOSED | 65 | 0.75 | 86.67 | mu archive restore <label> --as <new-ws>: lossless un-archive (no bucket round-trip) |
| [`code_review`](tasks/code_review.md) | CLOSED | 70 | 0.5 | 140.00 | Code review: db-sync + archive-restore (file findings as new blockers of umbrella) |
| [`cr_db_import_nextstep_invalid`](tasks/cr_db_import_nextstep_invalid.md) | CLOSED | 50 | 0.1 | 500.00 | Code review: db export next step points to unsupported --dry-run flag |
| [`cr_docs_stale_sync_surface`](tasks/cr_docs_stale_sync_surface.md) | REJECTED | 60 | 0.4 | 150.00 | Code review: docs still advertise removed workstream import and omit new sync verbs |
| [`cr_import_owners_dropped`](tasks/cr_import_owners_dropped.md) | REJECTED | 70 | 0.3 | 233.33 | Code review: db import drops task owners despite lossless handoff goal |
| [`db_export`](tasks/db_export.md) | CLOSED | 70 | 0.5 | 140.00 | mu db export <file>: whole-DB copy + manifest |
| [`db_import`](tasks/db_import.md) | CLOSED | 80 | 1.5 | 53.33 | mu db import <file>: drift detection, sharp --force-source, sidecar park |
| [`db_replay`](tasks/db_replay.md) | CLOSED | 50 | 0.75 | 66.67 | mu db replay <sidecar>: manual cherry-pick of parked divergent state |
| [`docs_pass`](tasks/docs_pass.md) | CLOSED | 60 | 0.5 | 120.00 | Docs: USAGE_GUIDE + VOCABULARY + ARCHITECTURE + SKILL.md + CHANGELOG |
| [`remove_ws_import`](tasks/remove_ws_import.md) | CLOSED | 50 | 0.25 | 200.00 | Remove mu workstream import (replaced by mu db import + mu archive restore) |
| [`roadmap_entry`](tasks/roadmap_entry.md) | CLOSED | 70 | 0.25 | 280.00 | ROADMAP entry: multi-machine sync (db export/import + archive restore + workstream import removal) |
| [`schema_v8`](tasks/schema_v8.md) | CLOSED | 60 | 0.5 | 120.00 | Schema v8: machine_identity + workstream_sync tables |
| [`test_review`](tasks/test_review.md) | CLOSED | 70 | 0.5 | 140.00 | Test review: db-sync + archive-restore (file findings as new blockers of umbrella) |
| [`tr_db_import_lossless_rows`](tasks/tr_db_import_lossless_rows.md) | CLOSED | 75 | 0.4 | 187.50 | Test review: db import lacks lossless row-property assertions |
| [`tr_db_sync_error_inventory`](tasks/tr_db_sync_error_inventory.md) | CLOSED | 60 | 0.2 | 300.00 | Test review: new db sync errors are missing from error coverage inventory |
| [`tr_fast_tier_heavy_fs`](tasks/tr_fast_tier_heavy_fs.md) | CLOSED | 70 | 0.3 | 233.33 | Test review: filesystem-heavy sync tests are in fast tier |
| [`tr_import_replaces_local_agents`](tasks/tr_import_replaces_local_agents.md) | CLOSED | 65 | 0.25 | 260.00 | Test review: import does not test dropping destination machine-local rows |
| [`tr_sidecar_lossless_coverage`](tasks/tr_sidecar_lossless_coverage.md) | CLOSED | 70 | 0.3 | 233.33 | Test review: conflict sidecar test only checks task titles |
| [`umbrella`](tasks/umbrella.md) | CLOSED | 80 | 0.1 | 800.00 | Multi-machine sync: db export/import + archive restore (umbrella) |
