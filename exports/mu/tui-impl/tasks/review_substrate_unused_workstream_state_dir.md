---
id: "review_substrate_unused_workstream_state_dir"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: "worker-1"
created_at: "2026-05-13T12:44:15.790Z"
updated_at: "2026-05-13T14:31:24.356Z"
blocked_by: []
blocks: []
---

# REVIEW low: workstreamStateDir + ensureWorkstreamStateDir have zero consumers

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:44:16.104Z

```
FILE(S):
  src/db.ts:69-79 (workstreamStateDir)
  src/db.ts:316-320 (ensureWorkstreamStateDir — comment "Unused today.")
  src/index.ts:98-100 (re-exports both)

FINDING (dead code):
  workstreamStateDir() and ensureWorkstreamStateDir() compute /
  create per-workstream state dirs that nothing in the codebase
  reads or writes to. The function comments admit it:

      /**
       * Per-workstream artifact directory: ...
       *
       * Created lazily by callers. 0.1.0 doesn't write to it yet —
       * reserved for future snapshots / tracing logs / forensic
       * pane captures. ...
       */
      export function workstreamStateDir(...)

      /** Test seam: ensure a workstream's artifact dir exists. Unused today. */
      export function ensureWorkstreamStateDir(...)

  Verified by `grep -rn workstreamStateDir src/`: only the
  function definition and the re-export.

WHY IT'S A PROBLEM:
  - AGENTS.md and ROADMAP.md anti-feature pledges include "no
    anticipatory abstractions (no traits with zero implementors)".
    These are the function-level equivalent: API surface
    reserved for a feature that hasn't shipped.
  - The functions sit on the public SDK (`src/index.ts`
    re-exports them), so removing them is technically a breaking
    change — the longer they're public, the harder to drop.
  - Tests don't exercise them; the "Test seam" comment is
    aspirational.

PROPOSED FIX:
  Delete both functions and their re-exports from src/index.ts.
  When a future feature actually needs per-workstream state
  dirs (snapshots already exist; their dir lives in
  src/snapshots.ts), add the helper alongside the consumer.

  Mention in the CHANGELOG under Removed (SDK breaking, but
  given zero in-tree consumers it's a paper change).

EFFORT NOTE:
  Trivial (~10 LOC across db.ts and index.ts). Run typecheck
  to confirm no surviving consumers in src/ or test/.
  CHANGELOG entry needed for SDK consumers.
```

### #2 by "worker-1", 2026-05-13T14:31:24.356Z

```
CLOSE: 577b25e: workstreamStateDir + ensureWorkstreamStateDir removed from src/db.ts; SDK re-exports dropped from src/index.ts; CHANGELOG noted under [Unreleased]/Removed; four greens (typecheck + lint + test:fast 1365/1365 + full test 2425/2425) + build + bundle smoke (openDb still exported; both helpers now undefined)
```
