---
id: "feat_workspaces_drill_git_show"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-12T06:22:18.367Z"
updated_at: "2026-05-12T06:53:00.487Z"
blocked_by: []
blocks: []
---

# FEAT: Workspaces popup commits-drill — Enter on focused commit drills again into full 'git show <sha>' diff (rather than only yanking the command)

## Notes (2)

### #1 by "π - mu", 2026-05-12T06:42:22.647Z

```
MOTIVATION (verbatim user)
--------------------------
"feature; workspaces detail view, has yank for git show. add that
as an enter next-level drill-down."

CURRENT STATE
-------------
src/cli/tui/popups/workspaces.tsx already has list-mode → drill-mode
(commits-per-workspace). In drill mode, pressing 'y' yanks
`git show <sha>` for the focused commit. That's the one ask
upgraded: pressing Enter on the focused commit should drill ONE
MORE LEVEL into a read-only inline view of the actual `git show`
output — same affordance pattern as Log popup → Enter → full
event payload (commit 0e3f6db).

DESIGN
------
Three levels now:
  L1  Workspaces list   (workspaces popup, mode="list")
  L2  Commits list      (workspaces popup, mode="drill")  ← exists
  L3  git show diff     (workspaces popup, mode="show")   ← NEW

State machine:
  - Add a third mode value "show" alongside "list" and "drill".
    Update the PopupMode type or extend popups/workspaces.tsx's
    local mode union (current local type is "list" | "drill").
  - On Enter in drill mode (focused commit selected) → setMode("show")
    + spawn an async exec of `git show <sha> --stat -p` in the
    workspace's path; populate state with the captured stdout (or
    error).
  - In "show" mode, render a Shell with title `git show <short-sha>`
    and body = the captured diff text via DrillScrollView (j/k
    scroll, Ctrl-D/U half-page, g/G top/bottom).
  - Esc/q from "show" → back to "drill" (commits list).
  - 'y' in "show" mode yanks `git show <sha>` (the same as drill
    mode — operator wants the command, not the captured output).

DATA SOURCE
-----------
Use Node's child_process.execFile to run:

    git -C <workspacePath> show <sha> --stat -p --color=never

Capture stdout. Cap output at e.g. 100_000 chars to avoid runaway
memory on giant merges. If the command fails (workspace gone,
sha unknown), render the error inline.

This is a NEW shell-out from inside ink; check the existing
patterns. src/vcs.ts already has a VcsBackend abstraction; consider
extending it with a `show(sha): Promise<string>` method so the TUI
doesn't shell out directly. If the abstraction is over-kill, a
narrow execFile call inside popups/workspaces.tsx is acceptable
(file is already ~500 LOC; one helper).

STATE LIFECYCLE
---------------
Reset captured-show state on:
  - mode change away from "show"
  - focused commit change in drill mode
  - workspace change in list mode

SHELL TITLE / HINT
------------------
Mirror the Log popup's drill convention:
  - title:  `Workspaces · git show <short-sha>`
  - hint:   `j/k scroll · Ctrl-D/U half page · y yanks 'git show <sha>' · Esc/q back to commits`

KEY MAP (mode="show")
---------------------
  j/k Ctrl-D/U PgUp/PgDn  scroll
  g/G                     jump top/bottom
  y                       yank `git show <sha>`
  Esc / q                 back to commits (mode="drill")

WIRING IN APP.TSX
-----------------
The popup-mode StatusBar already shows a generic hint cluster.
The new "show" mode reuses the popup-mode bar (no new bar needed).
Verify popupMode propagation handles arbitrary string values OR
keep mode local to workspaces.tsx if PopupMode is currently a
union of "list" | "drill" only.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (workspaces.tsx is ~500; +50 max).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: Workspaces popup commits-drill — Enter on focused commit
         drills again into 'git show <sha>' diff (was yank-only)

DOCS
----
- CHANGELOG.md (under v0.4.0 features): bullet under TUI features.
- docs/USAGE_GUIDE.md TUI keymap: extend popup-mode line with the
  new Enter→show drill on Workspaces popup.
- skills/mu/SKILL.md: same.

TESTS
-----
- test/tui-popup-workspaces.test.ts: extend with the new mode='show'
  branch; mock execFile to return a synthetic diff; assert source
  contains the case branch + the DrillScrollView render with body
  = captured diff.

OUT OF SCOPE
------------
- Don't add per-line syntax colouring for the diff (out of scope;
  defer to v0.5 if real friction proves it).
- Don't add 'cherry-pick this sha' shortcut (read-only TUI pledge;
  the user yanks the command and runs it manually).
- Don't change the list-mode or drill-mode keymap.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_workspaces_drill_git_show -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-12T06:53:00.487Z

```
CLOSE: 443a827: Workspaces popup commits-drill — Enter on focused commit drills into 'git show <sha>' diff via shared <DrillScrollView>; popup-local showSha sentinel keeps PopupMode union binary; 100k char cap; new 8-case test suite; CHANGELOG/USAGE_GUIDE/SKILL updated; four greens (1806 tests)
```
