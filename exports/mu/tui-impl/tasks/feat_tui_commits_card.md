---
id: "feat_tui_commits_card"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.4
roi: 162.50
owner: "worker-2"
created_at: "2026-05-12T12:51:19.082Z"
updated_at: "2026-05-12T15:30:53.720Z"
blocked_by: ["bug_tui_card_body_collapses_into_bottom_border", "feat_mu_bare_launches_tui"]
blocks: []
---

# FEAT: TUI top card showing the last N commits on the project (lazygit style); selectable list → Enter drills into 'vcs show <sha>'; supports git, jj, sl backends

## Notes (3)

### #1 by "π - mu", 2026-05-12T12:51:19.442Z

```
MOTIVATION (verbatim user)
--------------------------
\"feat; add a top tui card that shows the last commits lazygit style. should be selectable to list view and then enter to 'show' that commit. needs to support all 3 vcs\"

CURRENT STATE
-------------
- src/vcs.ts has VcsBackend interface with git/jj/sl/none impls.
- Existing CommitSummary type (sha/subject/body/authorDate) used by commitsSinceBase.
- Workspaces popup already drills 3 levels (workspace list → commits-since-fork → 'git show <sha>') via runGitShow in src/cli/tui/git-show.ts (commit b7460ac); that path is GIT-ONLY today.
- No top-level 'last N commits on project' view exists. Workspaces popup's commits-drill is per-workspace + filtered to since-fork.

DESIGN
------
NEW TOP-LEVEL CARD: 'Commits' (lazygit-style log card).
- Renders the last N commits on the PROJECT root (not per-workspace; not since-fork).
- Columns: short-sha (8 chars) + relative-time + author-initials + subject (clip).
- Sortable by date desc (newest first).
- Same TUI primitives as every other list card: TitledBox + ListRow + cursor-row.
- Card rows go through ListRow → consumer card pulls data from snapshot.

NEW POPUP (Shift+<slot>): 'Commits' fullscreen.
- Full list (more rows than the card's ROW_LIMIT).
- usePopupFilter for / search.
- Enter on focused commit → drill into the actual commit text via DrillScrollView.
- Drill body = full 'vcs show <sha>' output (diff + stat + body).

KEY MAP
-------
Pick an unused slot. Slot 0 was 'reserved by convention' per keys.ts. Two pending features want it:
  - feat_tui_dag_popup wants 'g' OR slot 0.
  - feat_tui_commits_card wants a slot too.

PROPOSED SLOTTING:
  - Slot 0 (key '0' on dashboard, ')' for popup) → DAG (per feat_tui_dag_popup).
  - Add a new symbol-key for Commits: 'l' (log, mnemonic) for dashboard toggle, 'L' (Shift-L) for popup. Or a numeric key once we promote a 10th card slot.

ACTUALLY simpler: don't add a CARD (the dashboard is full at 9). Add ONLY the popup, bound to a non-numeric key. Recommend 'l' / Shift-L. The reason cards 1-9 are numbered is the digit-toggle convention (btop/htop); the 'l' commits popup is separately bound, like 'g' for the DAG popup.

REVISED DESIGN: NO new dashboard card. Only a new popup, bound to 'l' (mnemonic 'log').

Actually re-reading user: \"add a top tui card that shows the last commits\" — they want it ON the dashboard. So:
  - Dashboard card needed.
  - All 9 slots taken.
  - Either bump ROW_LIMIT down on an existing card to fit, OR scroll the dashboard, OR consolidate.

PROPOSED RESOLUTION: defer to user. File two sub-options, ask which:
  (A) NEW Commits card slot — promotion requires demoting another card (which one? Doctor? Recent?). Probably Doctor (lowest visit rate).
  (B) NO new card; popup-only on 'l' key. Add a small 'l: commits' hint to the status bar.

VCS BACKEND ADDITIONS
---------------------
src/vcs.ts VcsBackend interface gets a new method:

  /** Last N commits on the project (newest first). NOT since-fork — the
   *  whole project log. Used by the TUI Commits card / popup. */
  recentCommits(projectRoot: string, limit: number): Promise<CommitSummary[]>;

Backend impls:
  - git: 'git log --max-count=N --format=...'
  - jj:  'jj log --no-graph -r ::@ --limit N --template ...'  (or some jj equivalent)
  - sl:  'sl log -l N --template ...'
  - none: returns [] (empty). Card renders empty-state hint.

Plus a sibling 'showCommit(projectRoot, sha): Promise<{text, truncated, error}>' that wraps each VCS's 'show' equivalent. Generalize the existing src/cli/tui/git-show.ts:runGitShow into vcs.ts:VcsBackend.showCommit so jj/sl works too.

DATA SEAM
---------
Add to src/state.ts loadWorkstreamSnapshot:
  - withRecentCommits?: { limit: number }
  - snapshot.recentCommits: CommitSummary[]

Card consumes snapshot.recentCommits like every other card consumes its slice.

POPUP
-----
src/cli/tui/popups/commits.tsx (NEW). Mirrors popups/log.tsx structurally:
  - usePopupFilter for /.
  - applyCursor + scroll.ts for j/k/etc (already centralised).
  - useDrillKeymap for the show-drill body (already centralised).
  - showCommit-via-vcs in a useCallback (mirrors loadShow in workspaces.tsx; CAN PROBABLY EXTRACT a shared 'useShowCommit' hook to dedupe with workspaces).

Yank matrix:
  - list mode 'y' yanks 'git show <sha>' (or jj show / sl show; based on detected backend).
  - drill mode 'y' yanks the same.

TESTS
-----
- src/vcs.ts: per-backend test for recentCommits + showCommit.
- New test/tui-popup-commits.test.ts: source-level + behavioural assertions.
- Extend test/state-render.test.ts: snapshot.recentCommits surfaces.
- Extend test/tui-keys.test.ts: 'l' opens commits popup.

WIRING
------
- src/cli/tui/keys.ts: 'l' → openPopup(commits) variant.
- src/cli/tui/app.tsx: PopupId widened, renderPopup branch.
- src/cli/tui/help.tsx: new key row.
- src/cli/tui/cards/commits.tsx (NEW) IF user picks option A.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- All three VCS backends MUST work (no jj-only / sl-only fallbacks).

DOCS
----
- CHANGELOG.md (under v0.5.0 features): bullet under TUI features.
- docs/USAGE_GUIDE.md TUI keymap: extend with 'l' / Shift-L.
- skills/mu/SKILL.md TUI keymap: same.
- docs/ARCHITECTURE.md src/cli/tui/popups/ row: extend with commits.tsx; src/vcs.ts row: mention recentCommits + showCommit additions.

OPEN QUESTIONS (decide before claiming)
---------------------------------------
1. Card AND popup, or popup-only? (See PROPOSED RESOLUTION above — user wants 'a top tui card'.)
2. If a card, demote which existing card? (Doctor / Recent are the lowest-visit candidates.)
3. Mnemonic key: 'l' (log) or something else?
4. Generalize runGitShow → VcsBackend.showCommit (refactor) or duplicate per backend?

OUT OF SCOPE
------------
- Don't add an interactive commit picker / cherry-pick UI (read-only TUI pledge).
- Don't add per-commit branch / tag annotations (would need jj-bookmark + sl-bookmark + git-tag plumbing).
- Don't add ANSI-colour highlighting in the diff (dim text via DrillScrollView is fine).

⚠️ ORDERING ⚠️
This task lands in v0.5.0. Gate behind:
  - feat_mu_bare_launches_tui (the human-mode shift this builds on)
  - bug_tui_card_body_collapses_into_bottom_border (don't add a 10th card while card layout is buggy)

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_tui_commits_card -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-2", 2026-05-12T15:30:53.401Z

```
FILES: src/vcs.ts; src/state.ts; src/cli/tui/{app,keys,state,status-bar,help,git-show}.tsx/ts; src/cli/tui/cards/commits.tsx; src/cli/tui/popups/commits.tsx; tests under test/tui-* and test/vcs-commits-show.test.ts; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md; CHANGELOG.md; skills/mu/SKILL.md
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test (0); npm run build (0); node dist/cli.js --help (0, non-empty); node dist/cli.js --version (0, non-empty)
FINDINGS: Added VcsBackend.recentCommits/showCommit for git/jj/sl/none and TUI snapshot opt-in from process.cwd(), so the card uses the project root rather than worker workspaces.
DECISION: Used preferred Option A: slot 8 dashboard card is now Commits; Recent remains popup-only on Shift+8/* because recent task activity is still visible through Activity log while project commits had no dashboard surface. Added l/L as mnemonic commits popup opener.
NEXT: none.
VERIFIED: 2093 vitest tests passed; lint/typecheck/build passed; bundle help/version smoke produced output.
ODDITIES: Existing source-level popup tests required widening PopupId regex because the mnemonic commits popup adds a string popup id.
```

### #3 by "worker-2", 2026-05-12T15:30:53.720Z

```
CLOSE: 9a5c76b: lazygit-style commits card + l popup with git/jj/sl show support; typecheck/lint/test/build + bundle smoke green
```
