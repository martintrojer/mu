---
id: "workspace_orphans_misses_destroyed_workstreams"
workstream: "feedback"
status: CLOSED
impact: 30
effort_days: 0.4
roi: 75.00
owner: null
created_at: "2026-05-10T15:49:46.855Z"
updated_at: "2026-05-10T16:03:03.327Z"
blocked_by: []
blocks: []
---

# mu workspace orphans misses dirs from destroyed workstreams

## Notes (2)

### #1 by "π - mu", 2026-05-10T15:50:16.876Z

```
OBSERVED 2026-05-10 while orchestrating workstream feedback (post task wave).

REPRO (live state on this machine right now):
  $ ls ~/.local/state/mu/workspaces/
  dogfood-snap  feedback  infer-rs  mufeedback-v03  orphtest

  $ mu workstream list --json | jq -r '.[].name'
  beta  feedback  gamma  infer-rs  scratch  ws  ws2

  -> 3 workstream dirs on disk (dogfood-snap, mufeedback-v03,
     orphtest) have NO row in `mu workstream list`. Each holds
     orphan workspace dirs (_quarantine_1778249973, reviewer-1,
     ot1 respectively).

  $ mu workspace orphans
  error: workstream required: pass --workstream <name>, ...

  $ mu workspace orphans -w mufeedback-v03
  1 orphan workspace dir(s) in mufeedback-v03:
    reviewer-1   ...workspaces/mufeedback-v03/reviewer-1
  -> works only because the user knew to ask for that name.

  $ mu workspace orphans -w totally-nonexistent
  (no orphan workspace dirs in totally-nonexistent)
  -> SILENT FALSE NEGATIVE: zero output, exit 0, no warning that
     the workstream itself is unknown. A user typo here hides real
     orphans.

THREE FAILURE MODES IN ONE NIT:
  1. No --all flag. User must enumerate every workstream they can
     remember. Workstream dirs whose name they don't remember stay
     invisible.
  2. `workspace orphans -w <destroyed-ws>` happy-paths to "no
     orphans" when the workstream row is gone but the on-disk dir
     persists. The dirs are stranded forever.
  3. Bare `mu workspace orphans` requires -w. There is no
     scan-everything mode — even though the on-disk layout
     (~/.local/state/mu/workspaces/<workstream>/<agent>/) makes a
     full scan trivially cheap (one readdir of the parent).

WHY IT'S A NIT (not a bug):
  - Disk space on a few KB/MB of orphan node_modules / git checkouts
    isn't catastrophic, but it accumulates indefinitely.
  - I only noticed because I happened to `ls` the workspace root
    while triaging another issue. A user who trusts `mu workspace
    orphans` to surface everything is left with permanent garbage.
  - `mu workstream destroy` warns about workspaces (good) — but
    workstreams destroyed before that warning landed, OR destroyed
    via `mu sql DELETE FROM workstreams ...` (or by hand via tmux),
    leak silently.

FIX OPTIONS (smallest first):
  A. `mu workspace orphans --all` (NEW flag): scan every dir under
     <state-dir>/workspaces/, report orphans across ALL workstreams,
     INCLUDING workstreams whose row is gone (mark these "stranded:
     workstream destroyed"). Exits 0 even if non-empty (it's a
     report, not a check).
  B. `mu workspace orphans` with no -w and no current-tmux-ws-context
     auto-runs --all instead of erroring. Smaller behavioural change.
  C. `mu workspace orphans -w <unknown>` should error or warn,
     not silently say "no orphans". Same exit code as today's
     WorkstreamNotFoundError (3) feels right.
  D. `mu workstream destroy` already auto-exports + offers a workspace
     warning, but consider listing leaked workspace dirs in the
     destroy receipt so the operator can rm -rf in one paste.

LIKELY SMALLEST FIX: A + C. ~40 LOC: add a top-level scan in
src/workspace.ts (one readdir of <state-dir>/workspaces/, then
recurse one level), expose via --all, error on unknown -w.

VERIFIED: live system. Three orphan trees observable:
  ~/.local/state/mu/workspaces/dogfood-snap/_quarantine_1778249973
  ~/.local/state/mu/workspaces/mufeedback-v03/reviewer-1
  ~/.local/state/mu/workspaces/orphtest/ot1
None of which are reachable via any combination of `mu workspace
orphans` invocations short of trial-and-error guessing the dir name.
```

### #2 by "worker-1", 2026-05-10T16:02:39.930Z

```
FILES:
  src/workspace.ts (+73): new StrandedWorkspaceOrphan + listAllOrphanWorkspaces(db) — readdir <state-dir>/workspaces/, recurse one level, JOIN-filter against vcs_workspaces, mark stranded when parent ws has no row in workstreams.
  src/cli/workspace.ts (+70): cmdWorkspaceOrphans — --all branch (ignores -w; flat JSON array; grouped human render with red 'stranded: workstream destroyed' tag). Single-ws branch tightens resolution via tryResolveWorkstreamId → throws WorkstreamNotFoundError before scanning. wireWorkspaceCommands gains --all flag + extended description.
  src/index.ts (+2): re-export listAllOrphanWorkspaces + StrandedWorkspaceOrphan.
  test/workspace-sdk.test.ts (+166): listAllOrphanWorkspaces describe (3 it: empty / stranded-only / aggregate-mixed) + `mu workspace orphans` CLI describe (3 it: -w <unknown> exit 3 / --all aggregates / --all overrides -w).
  CHANGELOG.md (+30): [0.3.0] § Fixed entry covering both A + C, the documented --all-overrides-w choice, and the SDK seam.

COMMANDS:
  npm run typecheck   exit 0
  npm run lint        exit 0 (one biome --write format pass on src/cli/workspace.ts)
  npm run test        exit 0 (1071 tests passed across 59 files)
  npm run build       exit 0
  smoke: mu workspace orphans --all (against fake stranded ghost-ws)  → renders red stranded tag + Next: rm recipe
  smoke: mu workspace orphans -w totally-nonexistent                  → exit 3, 'no such workstream'
  smoke: mu workspace orphans --help                                  → mentions --all + stranded marker

FINDINGS:
  - listWorkspaces(db) without a workstream filter already JOINs to workstreams, so rows for destroyed workstreams are FK-cascade-gone — every such on-disk dir falls through to the orphan path naturally.
  - tryResolveWorkstreamId(db, name) is the existing tight resolution helper; bolting it onto the single-ws branch gives the typed-error path for free.
  - --all overrides -w (no error on the combo) — chosen because the bug repro itself shows users typing -w against the wrong/stale name; a hard error would punish the cleanup case. Documented in --help and pinned by the third CLI test.

DECISION:
  - Implement A + C; skip B (would silently change today's bare-no-arg semantics) and D (separate concern).
  - SDK split: listWorkspaceOrphans (single ws) untouched; new listAllOrphanWorkspaces is a separate function with a wider return shape (+ stranded). Avoids changing the existing function's contract or callers (mu state, etc.).
  - JSON shape per task spec: flat array of {workstreamName, agentName, path, stranded} for --all; the single-ws JSON shape is unchanged.

NEXT:
  - none required; D (workstream destroy receipt listing leaked workspace dirs) is filed in the bug note for later promotion if friction reappears.

VERIFIED:
  - all four green: typecheck + lint + test (1071/1071) + build.
  - regression tests cover listAllOrphanWorkspaces for stranded marker + aggregation.
  - CLI tests pin: -w <typo> → exit 3 / 'no such workstream'; --all --json → flat array with mixed stranded; --all + -w <typo> → not an error (documents the choice).
  - live smoke: --all renders red stranded tag; -w <unknown> exits 3; --help mentions --all + stranded marker.
```
