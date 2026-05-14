---
id: "task_show_blocked_by_renders_closed"
workstream: "feedback"
status: CLOSED
impact: 10
effort_days: 0.2
roi: 50.00
owner: null
created_at: "2026-05-10T14:34:15.571Z"
updated_at: "2026-05-10T15:01:24.394Z"
blocked_by: []
blocks: []
---

# task show 'blocked by' renders CLOSED blockers identically to OPEN ones

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T14:34:28.762Z

```
OBSERVED 2026-05-10 on workstream infer-rs (pre-cleanup):

  task test_full_check_current_stack had blocked-by:
    code_declenv_typed_keys, parity_latent_reporting_detail, review_recent_sil_trace_stack, sil_virtual_static_class_dispatch
  Three of those four were already CLOSED (and thus satisfied) — only the last actually gates work.

  `mu task show` rendered all four identically as a comma-joined list under "blocked by":
    blocked by : code_declenv_typed_keys, parity_latent_reporting_detail, review_recent_sil_trace_stack, sil_virtual_static_class_dispatch

  `mu state` correctly counted the task as gated (because at least one blocker is OPEN), but a reader of `mu task show` cannot tell from the rendering which blockers are genuine gates vs satisfied-and-stale.

WHY IT'S A NIT:
  - Hides graph rot: stale CLOSED blockers accumulate and make the DAG harder to read.
  - Silently weakens the "DAG is the project memory" promise — readers think more is gating than actually is.
  - I had to manually `mu task show <each-blocker-id>` to triage which were CLOSED.

UX SUGGESTIONS:
  1. Annotate per-blocker status in the rendering, e.g.:
       blocked by : sil_virtual_static_class_dispatch [OPEN]
       satisfied  : code_declenv_typed_keys [CLOSED], parity_latent_reporting_detail [CLOSED], review_recent_sil_trace_stack [CLOSED]
  2. Or just suppress CLOSED blockers from `task show` by default and add `--all-blockers` for the historical view.
  3. Or at least dim CLOSED entries in the table view (analogous to how `mu state` colors statuses).

Severity: low-medium. The cleaning verb (`unblock`) exists, but nothing nudges the operator to use it.
```

### #2 by "worker-4", 2026-05-10T15:01:11.846Z

```
FILES:
  src/tasks.ts (added getTaskEdgesWithStatus + TaskEdgeWithStatus / TaskEdgesWithStatus types next to existing getTaskEdges around L572-L660)
  src/index.ts (re-export new helper + types)
  src/cli/tasks/edit.ts (cmdTaskShow: switched to getTaskEdgesWithStatus; partitionEdges + formatEdgeList helpers; renders 'blocked by' + 'satisfied' (dimmed) + 'blocks' + 'no longer' (dimmed); each entry '[STATUS]' colour-coded via colorStatus)
  test/json-output.test.ts (updated existing 'task show --json' shape test: blockers/dependents are now {name,status} objects)
  test/cli-task-show-blocked-status.test.ts (NEW; 6 cases: all-open / all-closed / mixed / empty / dependents-side / JSON shape)
  CHANGELOG.md (entry under [0.3.0] Fixed)
COMMANDS:
  npm run typecheck   exit 0
  npm run lint        exit 0
  npm run test        58/58 files pass; 1048/1048 tests pass
  npm run build       exit 0
  smoke: MU_DB_PATH=/tmp/mu-smoke/x.db node dist/cli.js task show d -w demo
    -> 'blocked by : c [OPEN]'  +  'satisfied  : a [CLOSED], b [CLOSED]' (dimmed). Matches spec.
FINDINGS:
  Picked OPTION 1 (annotate per-blocker status inline) + MILD form of OPTION 3 (dim CLOSED). Did NOT pick OPTION 2 (suppress CLOSED + --all-blockers) per scope guard — too aggressive, and hides graph history some users want.
  Symmetric treatment on the dependents side: 'blocks' for still-blocked, 'no longer' for CLOSED dependents (also dimmed). Empty 'satisfied' / 'no longer' lines are OMITTED (no clutter). Empty 'blocked by' / 'blocks' kept as '—' for back-compat.
  REJECTED + DEFERRED stay in the still-gating bucket: src/tasks/status.ts is the source of truth — only CLOSED satisfies a 'blocks' edge. Operators need to see them in the gating list because they still gate downstream work.
DECISION:
  - SDK helper (getTaskEdgesWithStatus) lives next to getTaskEdges in src/tasks.ts (one batched JOIN per direction; no N+1). Old getTaskEdges left intact (still used by exporting.ts + tree.ts + 5 test files).
  - JSON shape: blockers/dependents become Array<{name,status}>. This IS a JSON-shape break, but pre-1.0 0.3.0 ships frequent shape changes; CHANGELOG documents it under Fixed. Scripts now get the gating-vs-satisfied distinction without a second query.
  - No new flag. The grouped rendering is the fix.
NEXT:
  - None planned. The 'mu task tree' verb already shows per-node status via colorStatus, so it doesn't suffer the same rendering ambiguity.
VERIFIED:
  - All 4 gates green (typecheck / lint / 1048 tests / build).
  - New file test/cli-task-show-blocked-status.test.ts (6 cases) covers all-open / all-closed / mixed / empty / dependents-side / JSON.
  - Smoke test against a fresh DB visually confirms 'blocked by : c [OPEN]' + dimmed 'satisfied  : a [CLOSED], b [CLOSED]'.
```
