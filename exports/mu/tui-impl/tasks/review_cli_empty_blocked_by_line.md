---
id: "review_cli_empty_blocked_by_line"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-3"
created_at: "2026-05-13T12:39:22.871Z"
updated_at: "2026-05-13T12:49:10.754Z"
blocked_by: []
blocks: []
---

# REVIEW low: task add prints empty blocked-by line

## Notes (2)

### #1 by "worker-3", 2026-05-13T12:39:23.153Z

```
FILE(S):
  src/cli/tasks/edit.ts:153-160
  src/cli/tasks/edit.ts:218-225

FINDING (non-idiomatic):
  const blockedBy = parseCsvFlag(opts.blockedBy);
  const task = addTask(db, {
    ...
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  });
  ...
  if (blockedBy) console.log(pc.dim(`  blocked by: ${blockedBy.join(", ")}`));

WHY IT'S A PROBLEM:
  `parseCsvFlag()` always returns an array, and arrays are truthy even when empty. As a result, every successful human `mu task add` with no blockers prints a blank `blocked by:` line, adding noise to a high-frequency verb and making the output look like a field is missing. This is a small but real violation of clear CLI rendering: empty optional sections should be omitted.

PROPOSED FIX:
  Change the human render guard to `if (blockedBy.length > 0)` so the optional line only appears when the user supplied blockers. Add a focused CLI test that runs `mu task add foo ...` without `--blocked-by` and asserts stdout does not contain `blocked by:`, plus keep/extend an existing blocked-by test to assert the line appears when blockers are present.

EFFORT NOTE:
  Tiny CLI-only patch in `src/cli/tasks/edit.ts`; no schema or SDK changes. Existing tests around `task add --blocked-by` are the natural place to add coverage.
```

### #2 by "worker-3", 2026-05-13T12:49:10.754Z

```
CLOSE: ca24a2b: empty blocked-by line gated on .length>0; test added
```
