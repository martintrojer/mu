---
id: "review_data_destroy_batch_snapshots"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: "worker-2"
created_at: "2026-05-13T12:45:48.092Z"
updated_at: "2026-05-13T13:31:33.573Z"
blocked_by: []
blocks: []
---

# REVIEW med: destroy --empty takes N+1 snapshots

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:45:48.375Z

```
FILE(S):
  src/workstream.ts:358-367
  src/cli/workstream.ts:604-620 (callsite, cross-shard context only)

FINDING (complexity):
  export async function destroyWorkstream(db: Db, opts: WorkstreamOptions): Promise<DestroyResult> {
    const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;

    // Pre-mutation snapshot ...
    captureSnapshot(db, `workstream destroy ${opts.workstream}`, null);
    ...
  }

WHY IT'S A PROBLEM:
  destroyWorkstream always captures its own snapshot and offers no SDK-level way for a batch caller to supply a single safety-net snapshot. The `mu workstream destroy --empty` path explicitly captures one snapshot for the whole sweep, then calls destroyWorkstream for each empty workstream, so the intended one-snapshot batch becomes N+1 snapshots. This contradicts the comment at the callsite, wastes disk, and makes the snapshot timeline noisy during cleanup sweeps.

PROPOSED FIX:
  Add a small internal option on WorkstreamOptions such as `suppressSnapshot?: boolean` (or split a private `destroyWorkstreamAfterSnapshot` helper) and have the batch caller pass it after taking its one sweep-level snapshot. Keep the default behavior unchanged for direct `destroyWorkstream` / `mu workstream destroy --yes` calls so destructive single-workstream verbs remain protected.

EFFORT NOTE:
  Fix touches src/workstream.ts plus the CLI callsite in src/cli/workstream.ts. This crosses into shard 3's CLI surface, but the missing SDK seam lives in this data shard. Add a regression asserting a --empty sweep with N victims creates exactly one snapshot labeled for the sweep, not one per victim.
```

### #2 by "worker-2", 2026-05-13T13:31:33.573Z

```
CLOSE: 444889c: suppressSnapshot opt added; --empty sweep takes 1 snapshot
```
