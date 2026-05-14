---
id: "feat_color_task_notes_drill"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-13T05:39:30.097Z"
updated_at: "2026-05-13T07:02:31.772Z"
blocked_by: ["feat_git_show_drill_color_and_tuicr"]
blocks: []
---

# FEAT: TaskDetailDrill colour-codes note headers (── ts author ──) so multi-note timelines are easy to scan; reuse the ANSI-in-Text path the git-show colors task is establishing

## Notes (3)

### #1 by "π - mu", 2026-05-13T05:40:22.993Z

```
MOTIVATION (verbatim user)
--------------------------
"also add colors to the task detail view to make it easer to spot the start of a new note etc"

CURRENT STATE
-------------
src/cli/tui/popups/task-detail.tsx renderNotes() produces:
  ── 2026-05-12 14:30:15  worker-2 ──
  <free text content of the note>

  ── 2026-05-12 14:35:42  π - mu ──
  <next note content>

…joined by blank lines. Every line goes through DrillScrollView as plain `<Text>` — no per-line styling. Multi-note tasks (the orchestrator umbrella tasks especially) become a uniform wall of grey text.

COLOR DESIGN (locked)
--------------------
Three visual signals:
  1. **Note headers** (`── <ts>  <author> ──`) → bold cyan. Easy to spot mid-scroll.
  2. **Author name** within the header → bold + dim cyan to distinguish it (or omit — header colour is enough for v1).
  3. **Note content body** → default text colour (no ANSI). Quoted text / verbatim shell snippets render as the user typed them.

Match the existing visual language: TitledBox section headers are `bold color="cyan"` (lazygit/btop convention). The note headers should mirror that so the drill feels consistent with the popup chrome.

Per the git-show drill colors task (worker-2 is on it now): DrillScrollView already renders ANSI escape sequences in `<Text>` content correctly (ink forwards them to stdout). So this fix just emits ANSI in renderNotes — no React component change.

THE FIX
-------
src/cli/tui/popups/task-detail.tsx renderNotes:
  - Wrap the header line in ANSI bold+cyan: `\x1b[1;36m── ${ts}  ${author} ──\x1b[0m`.
  - Body content stays plain (no ANSI).
  - Empty-state remains "(no notes)" plain text.

ANSI COLOR CONSTANTS
--------------------
Define small constants near the top of task-detail.tsx (or factor into a shared src/cli/tui/ansi.ts helper if more sites need it):
  const ANSI_BOLD_CYAN = "\x1b[1;36m";
  const ANSI_RESET = "\x1b[0m";

(If src/cli/tui/ansi.ts already exists from the git-show task — check at cherry-pick time — reuse it. If not, inline.)

⚠️ COORDINATION ⚠️
- Worker-2 currently on feat_git_show_drill_color_and_tuicr — they're touching DrillScrollView and possibly adding ANSI helpers. After their commit lands, this task may be able to reuse a shared helper.
- Possible cherry-pick conflict on src/cli/tui/popups/task-detail.tsx if worker-2 also extends DrillScrollView's API (unlikely — they're focused on git-show drill specifically). Check before committing.
- This task GATES BEHIND feat_git_show_drill_color_and_tuicr to:
  (a) reuse any shared ANSI helper they introduce,
  (b) avoid double-edits to DrillScrollView,
  (c) confirm the ANSI-in-Text approach works in production before applying it to a second drill view.

WIRING
------
- src/cli/tui/popups/task-detail.tsx renderNotes: wrap the header line with ANSI cyan-bold.
- (Optional) Extract small ansi constants to src/cli/tui/ansi.ts if the git-show task didn't already create that file.
- DrillScrollView: NO changes (already renders ANSI correctly).

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js` in any tui/ file. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/cli/tui/popups/task-detail.tsx — extend test/tui-popup-tasks.test.ts (or wherever renderNotes is currently tested):
  * Single note: rendered output contains `\x1b[1;36m` and `\x1b[0m` around the header line.
  * Multiple notes: each header has its own ANSI wrapper.
  * Empty: returns "" (no ANSI codes).
  * Body content unchanged (no ANSI in the note text portion).

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Open Ready popup (Shift+3), navigate to a task with multiple notes, press Enter.
  # EXPECTED: each note header (── <ts> <author> ──) renders bold cyan.
  # Body content renders default text colour. Easy to scan top-to-bottom and pick out where each note starts.
  # Try same with all-tasks popup (t) → Enter on a noisy task (e.g. tui_impl_complete which has many notes).

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge); the ANSI string emission stays inside this module.
- 1500 LOC hard cap; task-detail.tsx is ~85 LOC; this is a ~10 LOC change.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: TaskDetailDrill colour-codes note headers (bold cyan) so multi-note timelines are easy to scan

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "TaskDetailDrill (the read-only drill that shows a task's note timeline) now renders each note's header (`── <ts>  <author> ──`) in bold cyan so multi-note tasks (especially umbrella tasks) are easy to scan top-to-bottom."

OUT OF SCOPE
------------
- No author-name colour scheme (worker-2 vs worker-3 vs system → distinct colours). Could be a follow-up.
- No body content colouring beyond what the note text itself contains.
- No fold/collapse of notes (defer; the drill's existing scroll handles long timelines).
- No diff-style background highlight on the header line.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual visual smoke, close YOUR task with:
  mu task close feat_color_task_notes_drill -w tui-impl --evidence "<sha>: <one-line summary including 'verified note headers render bold cyan, easy to scan'>"
```

### #2 by "worker-2", 2026-05-13T07:02:27.884Z

```
FILES: src/cli/tui/popups/task-detail.tsx; test/tui-popup-task-detail.test.ts; CHANGELOG.md
COMMANDS: npx vitest run test/tui-popup-task-detail.test.ts (pass); npm run typecheck (pass); npm run lint (pass); npm run test (initial transient sl cleanup ENOTEMPTY in vcs tests, rerun pass 153/153); npm run build (pass); node dist/cli.js --help (pass); node dist/cli.js --version (pass); scripted tmux TUI smoke via all-tasks drill (pass)
FINDINGS: renderNotes is the shared TaskDetailDrill note timeline formatter; no shared ansi.ts exists, so constants were kept local.
DECISION: wrap only note header lines in bold cyan ANSI and reset before body text; body content stays byte-for-byte unchanged.
NEXT: none.
VERIFIED: commit 716111b; tests/build/smokes above; tmux capture showed bold cyan SGR around both note headers and plain body lines.
ODDITIES: Ink/tmux capture normalizes \x1b[1;36m into separate bold + cyan SGR sequences in output, but renderNotes emits the requested combined code and the visual result is bold cyan.
```

### #3 by "worker-2", 2026-05-13T07:02:31.772Z

```
CLOSE: 716111b: TaskDetailDrill note headers render bold cyan; verified note headers render bold cyan, easy to scan
```
