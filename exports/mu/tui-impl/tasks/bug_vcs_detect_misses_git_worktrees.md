---
id: "bug_vcs_detect_misses_git_worktrees"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.2
roi: 400.00
owner: "worker-2"
created_at: "2026-05-12T16:05:30.195Z"
updated_at: "2026-05-12T16:30:43.319Z"
blocked_by: []
blocks: ["fix_card_slot_layout_recents_commits_split"]
---

# BUG: VCS detectBackend() misses git worktrees and jj nested workspaces — TUI Commits card empty in every worker pane (and any other tool launched from a non-root workspace dir)

## Notes (3)

### #1 by "π - mu", 2026-05-12T16:06:34.475Z

```
MOTIVATION (verbatim user)
--------------------------
"there is bug btw. the vcs card is always empty on all the current ws tui's"
"can we shell out to git root, sl/hg root, jj root for a reliable way?"
"you should start with jj, since they are almost git backed."

REPRO
-----
1. From the main repo dir, run `node dist/cli.js state --tui -w <ws>` → Commits card populated.
2. From a worker workspace dir, run the same → Commits card empty ("no commits").
3. Probed live: in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/worker-2/, detectBackend() returns `noneBackend` even though it's a git worktree.

ROOT CAUSE
----------
src/vcs.ts:518:  gitBackend.detect(root) checks `isDir(join(root, ".git"))`. But in git WORKTREES, `.git` is a REGULAR FILE containing a `gitdir: <pointer>` line, NOT a directory. Worker workspaces are created via `git worktree add` (per src/vcs.ts gitBackend.createWorkspace, line ~526), so every worker pane that runs the TUI fails detection → falls through to noneBackend → recentCommits=[] → empty Commits card.

src/vcs.ts:871:  jjBackend.detect(root) checks `isDir(.jj)`. jj nested workspaces also store the workspace state at the parent root with a per-workspace marker file rather than a per-workspace `.jj` directory in some configs — same false-negative class.

src/vcs.ts:1189: slBackend.detect(root) checks `isDir(.sl) || isDir(.hg)`. Sapling nested copies similarly may not have a top-level `.sl`.

THE FIX (use canonical "find root" commands)
--------------------------------------------
Each VCS exposes a built-in "find the repo root" subcommand that handles ALL the corner cases (worktrees, nested workspaces, submodules, bare repos, gitdir indirection, etc):

  jj  : `jj root`                              prints the workspace root absolute path
  sl  : `sl root`                              prints the repo root absolute path
  hg  : `hg root`                              same (sapling accepts both invocations)
  git : `git rev-parse --show-toplevel`        prints the repo root absolute path

Ordering (per user direction):
  1. jj first  — jj-on-git repos have BOTH a .jj and a .git dir; we want jj to win for jj's snapshot-everything semantics. Try `jj root` first.
  2. sl second — `sl root` handles plain sapling AND mercurial-compat (.hg). Don't bother with separate `hg root` probe; sl's CLI accepts the .hg case.
  3. git third — `git rev-parse --show-toplevel` handles worktrees, submodules, gitdir-pointer files, bare repos, etc.
  4. none — none of the above succeed → noneBackend.

DESIGN
------
1. **Replace each backend's `detect(projectRoot)` body** with a `<vcs> root`-style subprocess call. If the command exits 0 AND its stdout is non-empty, the backend "owns" projectRoot.

2. The existing isDir-based heuristic is FAST (no fork) but WRONG. Subprocess detection is ~5-30ms per backend. Worst case (all 3 probed): ~100ms total for detection. Acceptable cost given:
   - The detection result is cached by callers (loadWorkstreamSnapshot calls detectBackend ONCE per snapshot tick — every 1-2s).
   - Correctness > a 100ms cold-start.

3. **Don't change the VcsBackend.detect(projectRoot) interface**. The signature stays `(projectRoot: string) => Promise<boolean>`. Just swap the implementation.

4. Failure modes:
   - Command not on $PATH (e.g. `jj` not installed): treat as "not this backend". Catch ENOENT specifically; let other errors bubble (they'd be a real bug we want to see).
   - Command exits non-zero (e.g. `jj root` outside a jj repo exits 1 with "There is no jj repo in '.'"): treat as "not this backend".
   - Command exits 0 with empty stdout: treat as "not this backend" (defensive — shouldn't happen in practice).

5. **Bonus**: detectBackend currently returns the BACKEND only, not the discovered root. Many callers re-pass `projectRoot` (= process.cwd() or similar) to subsequent backend calls (recentCommits, showCommit, etc), but the WORKSPACE root is what those calls actually want — for git worktrees, recentCommits run against `.git/worktrees/<name>` doesn't return useful project history.

   ⚠️ DECISION NEEDED — do we ALSO want detectBackend to return the discovered root? The minimal fix is "no, keep the signature; let the user pass cwd and trust the backend to do the right thing in `<vcs> log` invocations". The richer fix is "yes, return { backend, root } so the Commits card / popup pin to the canonical repo root not the cwd". Recommend the minimal fix first; the richer fix can come later if the Commits card still misbehaves on worktrees.

   ACTUALLY — for git worktrees, `git log` from the worktree dir DOES return the full repo history (worktrees share the .git/objects). So the minimal fix is sufficient for git. For jj nested workspaces, `jj log` from a nested workspace also returns the full op log. Same for sl. So minimal fix should work in practice; if it doesn't, escalate to "return discovered root".

WHAT TO IMPLEMENT
-----------------
A small helper in src/vcs.ts:

  async function tryVcsRoot(cmd: string, args: string[], cwd: string): Promise<boolean> {
    try {
      const result = await run(cmd, args, cwd);   // existing helper; uses execa or similar
      return result.stdout.trim().length > 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;  // command not installed
      // Subprocess exited non-zero (most common: not in this kind of repo) → return false.
      return false;
    }
  }

Then per backend:

  jjBackend.detect  = (root) => tryVcsRoot("jj", ["root"], root);
  slBackend.detect  = (root) => tryVcsRoot("sl", ["root"], root);
  gitBackend.detect = (root) => tryVcsRoot("git", ["rev-parse", "--show-toplevel"], root);
  noneBackend.detect = always true (already the case, OR: detectBackend returns it as the final fallback regardless).

Inspect the existing `run()` helper in src/vcs.ts (line ~340 area; grep `function run\b`) to confirm it returns `{ stdout, stderr, exitCode }` and that ENOENT is recoverable. If the helper THROWS on non-zero exit (likely), the catch path above handles it.

TESTS (REQUIRED)
----------------
- src/vcs.ts: unit / integration tests for detect() per backend, EXERCISING:
  * Plain git repo → gitBackend.detect = true; jj.detect = false; sl.detect = false.
  * Git WORKTREE → gitBackend.detect = true (regression test for THIS bug).
  * Plain jj repo → jj.detect = true; git/sl false.
  * Plain sl repo (.sl) → sl.detect = true.
  * Mercurial-compat (.hg) repo → sl.detect = true.
  * Empty dir → all backends false → noneBackend.
  * Dir where the relevant tool isn't installed → ENOENT-handled, returns false (test by spawning a child process with a stripped PATH if portable; otherwise mock the run() helper).
- test/vcs-detect.test.ts (NEW): the worktree case is the headline regression test. Use `git worktree add` in a test fixture; assert detection works.
- Existing test/vcs-*.test.ts: no semantic change expected; they should keep passing.

VERIFY MANUALLY
---------------
  npm run build
  cd $(mu workspace path worker-2 -w tui-impl)
  node /Users/mtrojer/hacking/mu/dist/cli.js state --tui -w tui-impl
  # Commits card should now be populated.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build

CONSTRAINTS
-----------
- 1500 LOC hard cap; src/vcs.ts is ALREADY large (1430+ LOC) — at the refactor signal threshold. This change is small (~30 LOC swap). DO NOT also do a file split here; that's review_repo_core_files_past_refactor_signal's job.
- Conventional commit prefix: `vcs:` (or `cli:` if vcs prefix isn't established — grep recent commits with `git log --oneline | grep -i vcs:`).
- Suggested commit:
    vcs: detect repo via 'jj root' / 'sl root' / 'git rev-parse --show-toplevel' (was: .git/.jj/.sl isDir heuristic; missed git worktrees → empty Commits card in every worker pane)

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "VCS backend detection now uses each tool's canonical root command (`jj root` / `sl root` / `git rev-parse --show-toplevel`) instead of the .jj/.sl/.git isDir check, fixing git-worktree detection. The TUI Commits card was empty in every worker pane because git worktrees use a `.git` FILE (gitdir pointer), not a directory."
- docs/ARCHITECTURE.md src/vcs.ts row: short note on the detect mechanism (the subprocess cost is one fork per backend per cold detection; cached per snapshot tick by the TUI loop).

OUT OF SCOPE
------------
- DO NOT also return the discovered root from detectBackend (defer to a separate task if needed).
- DO NOT add a config to disable the subprocess probes (anti-feature).
- DO NOT cache the detection result inside src/vcs.ts (callers already cache; in-module caching introduces stale-state bugs).
- DO NOT split vcs.ts in this PR (review_repo_core_files_past_refactor_signal owns that).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/worker-2 (a GIT WORKTREE — perfect; you can verify the fix in your own workspace).

⚠️ FINAL ACTION ⚠️
After committing + four greens green, close YOUR task with:
  mu task close bug_vcs_detect_misses_git_worktrees -w tui-impl --evidence "<sha>: <one-line summary including 'verified in git worktree'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching this task.
```

### #2 by "π - mu", 2026-05-12T16:06:51.351Z

```
EXTRA UX NICETY (folded into this task)
--------------------------------------
The Commits CARD title and the Commits POPUP title should both show the detected VCS backend so users can SEE which one won detection (and confirm the bug fix landed).

Format suggestion (subtle, not noisy):
  Card title:  "Commits · git"     (or "Commits · jj" / "Commits · sl")
  Popup title: "Commits · git · <ws>"
  When backend = none: "Commits · (no vcs)"

Implementation:
  - The CommitsCard already accepts snapshot.recentCommits but not the backend NAME. Extend WorkstreamSnapshot or CommitsData to carry the backend name (string: "git" | "jj" | "sl" | "none").
  - src/state.ts loadRecentCommits: return { backend, commits } instead of bare CommitSummary[]. Update WorkstreamSnapshot.recentCommits → WorkstreamSnapshot.commits = { backend, items }. Or add a sibling field WorkstreamSnapshot.commitsBackend.
  - src/cli/tui/cards/commits.tsx: render the backend in the title (subtitle slot if cleaner — TitledBox already supports both).
  - src/cli/tui/popups/commits.tsx: same in the popup title.

The drill-down view (the per-commit `git show <sha>` body) ALREADY runs through the right backend (via VcsBackend.showCommit) so no change there. Just the card/popup HEADER lines.

Tests:
  - test/tui-card-commits.test.ts: extend the existing fixture to assert the backend name appears in the rendered title.
  - test/tui-popup-commits.test.ts: same.
  - The empty-state ("no commits") render should also show the backend (e.g. "no commits · git" — clarifies "the VCS works, the repo just has no commits" vs "(no vcs)" when detection found nothing).

This stays scoped: ~30 LOC change, and it makes the worktree fix visible.
```

### #3 by "worker-2", 2026-05-12T16:30:43.319Z

```
CLOSE: a681102: detected git worktree from /Users/mtrojer/.local/state/mu/workspaces/tui-impl/worker-2; commits card data populated with 25 entries; backend shown in header (Commits · git)
```
