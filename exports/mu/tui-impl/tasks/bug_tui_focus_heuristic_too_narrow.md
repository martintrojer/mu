---
id: "bug_tui_focus_heuristic_too_narrow"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: "worker-3"
created_at: "2026-05-12T16:56:37.614Z"
updated_at: "2026-05-12T17:34:01.648Z"
blocked_by: []
blocks: []
---

# BUG: TUI initial-tab focus only matches under <state-dir>/workspaces/<ws>/; needs tmux-session + project-root + most-recent fallbacks so 'mu' from any tmux split picks the right ws

## Notes (2)

### #1 by "π - mu", 2026-05-12T16:57:53.525Z

```
MOTIVATION (verbatim user)
--------------------------
"9d4c731997206b7308f5e594770ff6f5ad93790e doesnt do what I want. I want to run this from 'any' tmux split in the correct folder. it doesn't have MU_SESSION. you have to use more clever heuristic to guess the correct ws to focus on."

WHAT THE CURRENT IMPL DOES (commit 9d4c731 / src/cli/tui-launch-focus.ts)
------------------------------------------------------------------------
Three rungs:
  1. $MU_SESSION matches a resolved workstream → focus that.
  2. cwd is INSIDE a registered vcs_workspaces.path → focus that workstream.
  3. tab 0.

The bug: rung 2 only fires when cwd is `<state-dir>/workspaces/<ws>/<agent>/...` — i.e. the user is INSIDE A WORKER WORKSPACE. From the project root (e.g. `~/hacking/mu`) with no MU_SESSION, NOTHING matches and tab 0 wins. That's exactly the case the user is hitting.

NEW HEURISTIC LADDER (insert between rungs 1 and 2; locked unless flagged)
--------------------------------------------------------------------------
  1. $MU_SESSION matches a resolved workstream → focus that.
     [unchanged]

  2. **NEW**: tmux session name matches a resolved workstream.
     - Reuse the existing `resolveWorkstream()` chain logic (src/cli.ts:92):
         if (process.env.TMUX) {
           const name = (await tmux(["display-message", "-p", "#S"])).trim();
           if (name.startsWith("mu-")) return name.slice("mu-".length);
         }
     - If the resolved name is in `names`, focus that index.
     - Rationale: mu spawns workers into tmux sessions named `mu-<ws>`. If the
       user's pane lives in such a session (whether they spawned it or just
       attached), that's a strong signal of which workstream they care about.

  3. cwd inside a registered vcs_workspaces.path → focus that workstream.
     [unchanged from rung 2 in 9d4c731]

  4. **NEW**: cwd is the PROJECT ROOT of any workstream's workspaces.
     - For each workspace row in vcs_workspaces, derive its project root:
         git: `git rev-parse --git-common-dir` from the workspace path; the
              parent of that dir is the canonical project root. Works for
              git worktrees (cwd = worktree → common-dir = main repo .git
              → parent = project root).
         jj:  `jj root` from the workspace path returns the workspace root,
              not the parent project; for jj-on-git use the git resolution.
              For pure jj nested workspaces, the project root is the
              workspace's parent dir (jj workspaces are subdirs of the parent
              repo). Resolve via `jj workspace root` if available; else
              fall back to git resolution.
         sl:  `sl root` from the workspace path returns the repo root. For
              sapling there's no separate worktree concept like git; the
              project root is the same as the workspace root for the main
              checkout.
     - Build a map: project_root → set of (ws_name, ws_index).
     - If cwd === any project root in the map, focus the FIRST workstream
       in that set (in `names` order — deterministic tiebreaker).
     - Rationale: the user runs `mu` from `~/hacking/mu` (the actual project
       repo) and there are 1+ workstreams whose workers all worktree out of
       this repo. The orchestrator's natural tab is one of those.

     Optimisation: query the project-root for each workspace LAZILY. Don't
     spawn N git subprocesses on TUI launch unless rung 4 is actually
     reached. Cache the result per launch (it doesn't change mid-session).

  5. **NEW (TIEBREAKER)**: most-recent workstream activity.
     - When rung 4 produces multiple matching workstreams (the common case
       in this repo: every workstream's workers worktree out of ~/hacking/mu),
       break the tie by latest agent_logs.created_at across ALL of them.
     - Single SELECT: `SELECT workstream_name FROM agent_logs WHERE
       workstream_name IN (?, ?, ...) ORDER BY created_at DESC LIMIT 1`.
       (Or the equivalent via the existing logs SDK; grep src/logs.ts.)
     - If no logs exist for any of the candidates, fall through.

     Rung 5 is part of rung 4's resolution — not a separate ladder rung.

  6. tab 0.

DECISIONS LOCKED
----------------
- $MU_SESSION wins over everything (existing behaviour; explicit > implicit).
- Tmux session name BEATS cwd. Rationale: a user inside an mu-<ws> tmux
  session has explicitly chosen that workstream's pane; cwd is incidental.
- cwd-INSIDE-workspace BEATS cwd-IS-project-root. Rationale: a worker
  workspace match is more specific than "any workstream uses this repo".
- Project-root match uses VCS-derived canonical root (handles git worktrees
  correctly per bug_vcs_detect_misses_git_worktrees / commit 0ae0819).
- Tiebreaker for project-root match = most-recent workstream activity.
- Single-workstream TUI launch: only one tab; no resolution work needed
  (existing early-return).

WIRING
------
- src/cli/tui-launch-focus.ts: extend `resolveInitialTab`. The function
  becomes async (the tmux subprocess + git subprocess + db query are async).
  cmdBareTui already awaits other things; adapt the call site.
  - resolveInitialTab(names: readonly string[], db: Db): Promise<number>
- src/cli.ts cmdBareTui: await the new helper; no other change.
- src/cli/state.ts: same call-site update for `mu state --tui`.

PROJECT-ROOT RESOLUTION HELPER
------------------------------
Add a small async helper to src/workspace.ts (or a new src/project-root.ts):
  export async function workspaceProjectRoot(workspacePath: string,
                                             backend: VcsBackendName)
                                             : Promise<string | null>
Returns the canonical project root for a given workspace, or null if the
backend can't determine one (e.g. backend === "none"). Implementation:
  - git: realpath(dirname(`git rev-parse --git-common-dir`))
  - jj:  fallback to git resolution (jj-on-git) OR jj-specific subprocess
         if a clean way exists; otherwise use realpath(dirname(workspacePath))
         which is the parent of the nested workspace dir.
  - sl:  `sl root` from the workspace path; that IS the project root for sl.
  - none: null.

Cache per (workspacePath, backend) within a single TUI launch — pure mempo
inside resolveInitialTab. No on-disk caching.

⚠️ COORDINATION ⚠️
- Audit_status_bar_hint_consistency, feat_dag_popup_status_filters,
  feat_tui_all_tasks_popup are all in flight or queued. None touch
  src/cli/tui-launch-focus.ts. Safe to land in parallel.
- Don't introduce a `from "../../../cli.js"` import in tui-launch-focus.ts
  (would loop the bundle; SYMPTOM: silent `node dist/cli.js --help`).

TESTS (REQUIRED)
----------------
- test/tui-launch-focus.test.ts (NEW or extend existing): per-rung fixtures.
  * rung 1: $MU_SESSION wins over tmux session match.
  * rung 2 (NEW): tmux session "mu-foo" + foo in resolved set + no MU_SESSION
    → foo focused.
  * rung 2 (NEW): tmux session "mu-foo" + foo NOT in resolved set → fall through.
  * rung 2 (NEW): outside tmux ($TMUX unset) → skip rung 2.
  * rung 3: cwd inside vcs_workspaces.path → focused (existing tests stay).
  * rung 4 (NEW): cwd === project root of one workstream's workspace → focus that.
  * rung 4 (NEW): cwd === project root of MULTIPLE workstreams → tiebreaker
    (rung 5) picks the most-recently-active.
  * rung 5 alone: cwd === multi-ws project root + NO logs in any → tab 0.
  * rung 6: cwd unrelated, no tmux, no MU_SESSION → tab 0.
- Mock the tmux subprocess via setTmuxExecutor (existing pattern).
- Use real git fixtures for the project-root resolution (mirror
  test/vcs-detect.test.ts patterns).
- Existing test/cli-bare-launches-tui.test.ts: extend with a tmux-session-match
  fixture so the integration is covered too.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  unset MU_SESSION
  # In a tmux pane that is NOT mu-named:
  node dist/cli.js     # TUI should focus the most-recently-active ws
                       # (or whichever ws the project-root resolution + tiebreaker pick).
  # In an mu-tui-impl tmux pane:
  node dist/cli.js     # TUI should focus tui-impl.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke: node dist/cli.js --help && node dist/cli.js --version

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge); tui-launch-focus.ts
  stays under src/cli/ (no ink import).
- Conventional commit prefix: `tui:` or `cli:` (this is launcher logic).
- Suggested commit:
    tui: TUI initial-tab focus learns tmux-session + project-root + most-recent-activity rungs (was: only matched cwd inside <state-dir>/workspaces/<ws>/; missed bare 'mu' from project root)
- Four greens before commit + manual smoke from project root in non-mu tmux pane.

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "TUI initial-tab focus now uses a richer ladder: $MU_SESSION → tmux
    session name → cwd inside a workspace → cwd === project root of any
    workstream's workspaces (tiebreak by most-recent activity) → tab 0.
    Means bare `mu` from the project root in any tmux pane lands on the
    most-relevant workstream instead of always tab 0."
- docs/USAGE_GUIDE.md TUI section: update the focus ladder explanation.
- skills/mu/SKILL.md: same.

OUT OF SCOPE
------------
- No project-root → workstream pinning / config (anti-feature).
- No "ask the user which ws to focus" prompt (defeats one-keystroke launch).
- No mouse-driven tab switching as a pre-emptive UI (mouse_input is its
  own task).
- No persistence of last-active workstream across launches (anti-feature).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>
(a git WORKTREE — perfect for rung 4 testing).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + manual smoke from project root, close
YOUR task with:
  mu task close bug_tui_focus_heuristic_too_narrow -w tui-impl --evidence "<sha>: <one-line summary including 'verified bare mu from project root focuses on <X>'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
```

### #2 by "worker-3", 2026-05-12T17:34:01.648Z

```
CLOSE: f0035f1: expanded TUI focus ladder; four greens + help/version smoke passed; verified bare mu from project root focuses on tui-impl in non-mu tmux and mu-tui-impl panes
```
