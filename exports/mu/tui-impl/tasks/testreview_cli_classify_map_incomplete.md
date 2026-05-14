---
id: "testreview_cli_classify_map_incomplete"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: "worker-3"
created_at: "2026-05-13T12:38:47.924Z"
updated_at: "2026-05-13T13:13:42.215Z"
blocked_by: []
blocks: []
---

# REVIEW med: classifyError test misses switch branches

## Notes (2)

### #1 by "worker-3", 2026-05-13T12:38:48.190Z

```
FILE(S):
  test/cli-classify-error.test.ts:45-84
  src/cli/handle.ts:222-329

FINDING (missing coverage):
  const cases: Array<[Error, number, string]> = [
    [new UsageError("bad flag"), 2, "error"],
    [new WorkstreamNameInvalidError("Bad-Name"), 2, "error"],
    [new AgentNotFoundError("alice"), 3, "not found"],
    [new TaskNotFoundError("foo"), 3, "not found"],
    ...
    [new TmuxError(["list-panes"], "no server", "", 1), 5, "tmux"],
    [new PaneNotFoundError("%999"), 5, "tmux"],
    [new Error("some other thing"), 1, "error"],
  ];

WHY IT'S A PROBLEM:
  `classifyError()` is the CLI's typed-error-to-exit-code map, but this test only covers a subset of the switch. It does not pin newer branches such as archive/import errors, spawn CLI/startup errors, stale-workspace claim errors, workspace dirty/VCS/conflict errors, snapshot file/version/prune errors, or wait exit codes 6/7. A future refactor could drop one of those imports or move a class below the wrong branch and the advertised exit-code contract would silently regress.

PROPOSED FIX:
  Add table rows for every class explicitly mentioned in `classifyError()`, including expected label and exit code for the special lanes (`spawn cli not found`, `spawn failed`, `spawn startup error`, `workspace conflict`, `reaper`, `stall`, `snapshot file missing`). Consider grouping the cases in the same order as the switch so additions to `handle.ts` naturally require test updates.

EFFORT NOTE:
  Test-only change. Constructing some errors requires small dummy objects (e.g. `TaskClaimStaleWorkspaceError` staleness shape), but no CLI subprocesses are needed.
```

### #2 by "worker-3", 2026-05-13T13:13:42.215Z

```
CLOSE: a4980db: every classifyError switch branch covered + ordered to match
```
