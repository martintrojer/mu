---
id: "feat_git_show_drill_color_and_tuicr"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: "worker-2"
created_at: "2026-05-13T05:10:28.703Z"
updated_at: "2026-05-13T05:44:06.597Z"
blocked_by: []
blocks: ["bug_drill_views_dont_refresh_on_tick", "feat_color_task_notes_drill"]
---

# FEAT: git show drill panes — render ANSI diff colors AND add 't' shortcut to launch 'tuicr -r REV' in project cwd (suspend/restore TUI alt-screen)

## Notes (2)

### #1 by "π - mu", 2026-05-13T05:11:59.444Z

````
MOTIVATION (verbatim user)
--------------------------
"for all the 'git show' panes. 1/ render colors 2/ a add shortcut 't', next to y/yank in the bottom bar that runs 'tuicr -r REV' in cwd"

CONTEXT
-------
There are TWO "git show" drill panes today:
  - Commits popup (Shift+0): Enter on a row → drill into `git show <sha>` body.
  - Workspaces popup (Shift+5): Enter on a workspace's commit row → same drill.

Both go through src/vcs.ts VcsBackend.showCommit(projectRoot, sha), which currently passes `--color=never` (or `--color never`):
  src/vcs.ts:721 (gitBackend):  ["show", sha, "--stat", "-p", "--color=never"]
  src/vcs.ts:1118 (jjBackend):  ["show", sha, "--color", "never"]
  src/vcs.ts:1364 (slBackend):  similar pattern (verify exact args)

The drill body is rendered by src/cli/tui/popups/drill.tsx as plain `<Text>` per logical line. ink's `<Text>` already FORWARDS ANSI escape sequences to stdout — so just enabling colors in the subprocess output is sufficient; no React component change needed.

LOCKED DECISIONS
----------------
1. Switch all 3 backends' showCommit() from `--color never` to `--color=always` (or backend-equivalent).
2. Add `t` shortcut in the drill keymap → suspend mu's TUI (alt-screen exit), spawn `tuicr -r <REV>` in the PROJECT ROOT cwd (not the orchestrator's cwd if different — use process.cwd() of the mu launch dir; tuicr respects its cwd for repo detection), wait for tuicr to exit, restore mu's TUI (alt-screen enter), force a re-render.
3. Surface `t` in the popup-drill hint cluster ("y yank · t tuicr · ? help · Esc back").
4. Surface `t tuicr` in the help overlay's "popup drill" pane (via keymap-spec.ts).

⚠️ READ-ONLY-TUI PLEDGE — RECONCILED ⚠️
The TUI has been read-only by design. `t` invokes another TUI tool that the user explicitly drives — same as "alt-screen → fork → restore" pattern from any vim-from-TUI flow. This is a USER-DRIVEN escape hatch, not a background mutation. Document the carve-out in the help text + commit message.

IMPLEMENTATION
--------------

PART 1 — render ANSI diff colors
---------------------------------
- src/vcs.ts:721 gitBackend.showCommit: change `--color=never` → `--color=always`.
- src/vcs.ts:1118 jjBackend.showCommit: change `--color`, `never` → `--color`, `always`.
- src/vcs.ts:1364 slBackend.showCommit: change to `--color=always` (or sl's equivalent — `sl show --pager=never` may need explicit color hint).
- ink renders ANSI escape sequences in `<Text>` content correctly — the drill body's `<Text key={...}>{ln}</Text>` should display colors with NO additional component changes.
- VERIFY: capture-pane after launching the TUI, navigating to a commits drill, and confirming red/green diff lines appear.

PART 2 — `t` shortcut → tuicr
------------------------------
- src/cli/tui/popups/drill.tsx (the useDrillKeymap hook): extend the keymap to recognize `t`. The hook already takes onYank — add an optional `onLaunchTuicr?: (rev: string) => Promise<void>` callback that the consumer wires.

  OR cleaner: add a generic `onCustomKey?: (key: string) => Promise<boolean>` hook so future single-key escape hatches plug in without bloating useDrillKeymap.

  RECOMMENDED: a dedicated `onTuicr` callback in useDrillKeymap. Single-purpose, easy to test, minimal API surface.

- The two consumers wire it:
  * src/cli/tui/popups/commits.tsx: pass onTuicr that calls runTuicrInteractive(focused.sha).
  * src/cli/tui/popups/workspaces.tsx: same for the focused commit's sha.

- New helper in src/cli/tui/tuicr.ts (NEW, ~40 LOC):
    ```ts
    import { spawnSync } from "node:child_process";
    import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

    export interface RunTuicrOptions {
      rev: string;
      cwd: string;  // project root
    }

    export function runTuicrInteractive(opts: RunTuicrOptions): { ok: boolean; error?: string } {
      try {
        process.stdout.write(ALT_SCREEN_EXIT);
        const r = spawnSync("tuicr", ["-r", opts.rev], {
          cwd: opts.cwd,
          stdio: "inherit",
          env: process.env,
        });
        process.stdout.write(ALT_SCREEN_ENTER);
        // Force a redraw — ink's render loop will repaint on next tick;
        // alt-screen restore wipes the screen so the redraw lands on
        // a clean canvas.
        if (r.error) return { ok: false, error: String(r.error) };
        if (typeof r.status === "number" && r.status !== 0) {
          return { ok: false, error: `tuicr exited ${r.status}` };
        }
        return { ok: true };
      } catch (err) {
        // Make sure we re-enter the alt screen even on hard failure
        // so the operator's terminal isn't stuck in a broken state.
        try { process.stdout.write(ALT_SCREEN_ENTER); } catch {}
        return { ok: false, error: String(err) };
      }
    }
    ```

  - On error (e.g. `tuicr` not on PATH): set the StatusBar footer to a dim red error message ("tuicr not found · install with cargo install tuicr" or similar). Don't crash the TUI.

⚠️ tuicr DETECTION ⚠️
If `tuicr` isn't installed (ENOENT from spawnSync), fall back to a footer hint instead of crashing. Don't probe at TUI startup (anti-feature: extra subprocess); just handle the failure path gracefully.

PROJECT ROOT
------------
Use the cwd from which `mu` was launched (process.cwd() captured at TUI startup). For workers this is their workspace dir (a git worktree → tuicr will see the worktree's HEAD; `-r REV` resolves against the same .git/objects so commits from main are visible).

For the orchestrator running from `~/hacking/mu`: tuicr opens with that as the cwd.

This matches the existing pattern: src/state.ts loadRecentCommits uses process.cwd() (per the comment at line 134).

WIRING
------
- src/vcs.ts: 3 backend changes (color flag).
- src/cli/tui/popups/drill.tsx: useDrillKeymap gains onTuicr param + `t` key dispatch. Drill bottom hint (or popup-drill cluster in keymap-spec.ts) surfaces `t tuicr`.
- src/cli/tui/popups/commits.tsx: wire onTuicr={() => runTuicrInteractive({ rev: focused.sha, cwd: projectRoot })}.
- src/cli/tui/popups/workspaces.tsx: same for the workspaces commits drill.
- src/cli/tui/tuicr.ts (NEW): the helper above.
- src/cli/tui/keymap-spec.ts: extend POPUP_DRILL_HINTS + the help-overlay "popup drill" pane with the `t tuicr` row.
- src/cli/tui/app.tsx: footer state for the success/error toast already exists (FooterState); use the same channel via setFooter from the popup-drill on tuicr return.

⚠️ COORDINATION ⚠️
Both workers idle right now. Solo dispatch (worker-2 has fresh context on TUI from the perf split + help overlay; either is fine).

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/vcs.ts test/vcs-commits-show.test.ts: extend to assert the showCommit body CONTAINS ANSI escape sequences (look for `\x1b[` in the output) when there's a diff. Use a real fixture repo per backend.
- src/cli/tui/tuicr.ts test/tui-tuicr.test.ts (NEW): unit-test the helper with a mocked spawnSync.
  * spawnSync called with cmd="tuicr", args=["-r", expectedRev], cwd=expectedCwd.
  * On success: returns {ok: true}, stdout written ALT_SCREEN_EXIT then ALT_SCREEN_ENTER.
  * On ENOENT: returns {ok: false, error: "..."}, ALT_SCREEN_ENTER still written for cleanup.
  * On non-zero exit: returns {ok: false, error: "tuicr exited N"}.
- test/tui-keymap-consistency.test.ts: assert `t tuicr` is in BOTH the popup-drill hint cluster AND the help overlay's drill pane.
- test/tui-popup-commits.test.ts and test/tui-popup-workspaces.test.ts: extend to assert `t` in drill mode dispatches to the tuicr handler (mock the helper).

VERIFY MANUALLY
---------------
1. Color test: cd /Users/mtrojer/hacking/mu, node dist/cli.js -w tui-impl, press Shift+0 (Commits popup), Enter on a row. EXPECTED: red `-` lines, green `+` lines, cyan @@ hunk headers. Press Esc to back out.

2. tuicr test: from the same drill, press `t`. EXPECTED: mu's TUI suspends, tuicr opens for that commit, you navigate tuicr normally, press q to exit tuicr, mu's TUI restores.

3. Failure test: temporarily rename tuicr (`mv ~/.cargo/bin/tuicr ~/.cargo/bin/tuicr.bak`), repeat step 2. EXPECTED: footer shows "tuicr not found" or similar, TUI keeps working. Restore the binary after.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual color smoke + manual tuicr smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge); the new tuicr.ts is fine under src/cli/tui/ (uses ALT_SCREEN_ENTER/EXIT from escapes.ts).
- 1500 LOC hard cap. New tuicr.ts ~40 LOC; drill.tsx ~190 LOC; commits.tsx ~210; all under cap.
- Conventional commit prefix: `tui:` (drill behaviour change).
- Suggested commit:
    tui: 'git show' drills render ANSI diff colors + 't' shortcut launches `tuicr -r REV` in project cwd (alt-screen suspend/restore)
- Four greens before commit + bundle smoke + manual color smoke + manual tuicr smoke.

DOCS
----
- CHANGELOG.md [Unreleased] under "Added":
  * "Commits/Workspaces popup drills now render the underlying VCS show output in color (red/green/cyan diff highlighting; the existing `--color=never` was disabling the natural ANSI output)."
  * "New `t` shortcut in any 'git show' drill: launches `tuicr -r <sha>` in the project root cwd, suspending mu's TUI alt-screen until tuicr exits. Carves out one user-driven escape from the read-only TUI pledge: invokes another TUI tool the operator explicitly drove."
- docs/USAGE_GUIDE.md TUI keymap: add `t  launch tuicr (in git show drills)` row.
- skills/mu/SKILL.md: same.

OUT OF SCOPE
------------
- No probe / detection of tuicr at startup (anti-feature: extra subprocess on every launch).
- No `t` in non-show drills (e.g. task notes drill — there's no diff to review).
- No interactive cherry-pick / apply (read-only otherwise).
- No tuicr theme integration (use whatever theme tuicr defaults to or its config — that's tuicr's surface, not ours).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name> (FRESHLY recreated, at HEAD with everything live including the perf split and help-overlay rerender).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual color smoke + manual tuicr smoke, close YOUR task with:
  mu task close feat_git_show_drill_color_and_tuicr -w tui-impl --evidence "<sha>: <one-line summary including 'verified colored diff rendering + tuicr launches and restores cleanly'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
````

### #2 by "worker-2", 2026-05-13T05:44:06.597Z

```
CLOSE: 5eaac42: color git-show drills and add t/tuicr shortcut; verified colored diff rendering + tuicr launches and restores cleanly
```
