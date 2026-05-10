---
id: "review_omnibus_minor_polish"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.2
roi: 125.00
owner: null
created_at: "2026-05-10T11:40:11.513Z"
updated_at: "2026-05-10T12:22:54.518Z"
blocked_by: []
blocks: []
---

# review: omnibus — small polish nits not worth their own task

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:40:11.616Z

```
FILES: see per-item below; six minor smells, none worth a dedicated task.

FINDINGS:

1. src/cli.ts:108 (resolveWorkstream) hard-codes `name.slice(3)` for stripping `mu-` prefix; the constant `RESERVED_WORKSTREAM_PREFIX = "mu-"` already exists in src/workstream.ts:48. Import the constant + use `name.slice(RESERVED_WORKSTREAM_PREFIX.length)` so the magic 3 doesn't get out of sync if mu-* prefix ever changes.

2. src/exporting.ts:262 (renderToBucket bottom comment): the long paragraph "Bucket-level scaffolding... To render the bucket INDEX we need TaskRow shapes for siblings we did NOT pass... Compromise: the bucket INDEX renders ONLY the sources whose data we have in input.sources" describes a known correctness gap (additive workstream export's INDEX.md shrinks to one source on a single-ws re-export). This is a real bug, not a comment — file as a roadmap item or fix it (read sibling source-ws task counts from manifest only and emit ID-only links for siblings without re-rendering them).

3. src/cli/sql.ts:117/154/183 — three identical `if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path")` checks. Hoist into a helper or restructure so `stmt` is locally narrowed without the triple check.

4. src/snapshots.ts:386-394 the pre-restore re-stamp uses INSERT OR IGNORE on the snapshot-id pre.id; but `snapshots.id` is INTEGER PRIMARY KEY AUTOINCREMENT — the freshly-allocated id from `captureSnapshot` is monotonically beyond any id in the snapshot file (which itself records pre-restore ids), so the IGNORE branch can't fire in practice. The defensive IGNORE is fine but the comment "may collide" is wrong — explain it as belt-and-braces or drop the OR IGNORE.

5. src/exporting.ts:678 (exportSourcesForArchive) — the cast `t.status as TaskRow["status"]` on archived task status accepts whatever string was in archived_tasks.status. If a future schema added a 6th task status, an old archive could surface an invalid status to the renderer. Acceptable today (the renderer doesn't validate, per comment) but worth logging a warning when the cast fails isTaskStatus.

6. src/cli/log.ts:175 (defaultLogTailIntervalMs) — comment says "50ms floor prevents a too-low explicit setting from doing the same" but the implementation `parsed < 50 → 1000` actually FALLS BACK to 1000 (the no-env default), not floors to 50. Slightly confusing: a user setting 49 expects "clamp to 50" but gets the default. Either rename the constant to "MIN_INTERVAL → reset to default" or actually clamp via Math.max(50, parsed).

FIX-SKETCH: Each line above carries its fix. Pick whichever 2-3 are highest-value; ignore the rest.
```
