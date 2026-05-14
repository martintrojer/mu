---
id: "review_cli_state_tui_preloads"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: "worker-3"
created_at: "2026-05-13T12:38:45.939Z"
updated_at: "2026-05-13T13:05:49.381Z"
blocked_by: []
blocks: []
---

# REVIEW med: state --tui preloads unused static snapshots

## Notes (2)

### #1 by "worker-3", 2026-05-13T12:38:46.232Z

```
FILE(S):
  src/cli/state.ts:196-225

FINDING (complexity):
  const eventLimit = opts.events ?? 20;
  const perWs: PerWsData[] = [];
  for (const ws of workstreams) {
    perWs.push(await loadWorkstreamSnapshot(db, ws, { eventLimit }));
  }
  const multi = workstreams.length > 1;
  ...
  if (opts.tui === true) {
    const names = perWs.map((d) => d.workstreamName);
    const { runTui } = await import("./tui/index.js");
    await runTui(db, { workstreams: names, initialActive: await resolveInitialTab(names, db) });
    return;
  }

WHY IT'S A PROBLEM:
  The explicit `mu state --tui` path only needs the resolved workstream names, but it eagerly loads the full static state snapshot for every selected workstream and then discards it. `loadWorkstreamSnapshot` includes tmux/VCS subprocess work and status-title refreshes, so launching the TUI can be slow or fail before Ink even starts, especially with many workstreams. This is unnecessary work in the CLI wrapper and blurs the static-state/TUI dispatch seam.

PROPOSED FIX:
  Move the `opts.tui === true` branch before the `perWs` loading loop. Use `workstreams` directly for `runTui(db, { workstreams, initialActive: await resolveInitialTab(workstreams, db) })`; leave `eventLimit` and `loadWorkstreamSnapshot` only in the JSON/static render path. Add a dispatch test that mocks `loadWorkstreamSnapshot` or a tmux/VCS failure and asserts `mu state --tui -w a,b` still calls `runTui` without preloading static cards.

EFFORT NOTE:
  Small reorder, but tests may need a seam or module mock around `src/state.ts`. Keep TUI internals untouched; this is only the state verb dispatch decision.
```

### #2 by "worker-3", 2026-05-13T13:05:49.381Z

```
CLOSE: a6b2dd4: --tui dispatch moved before perWs loading; mock test added
```
