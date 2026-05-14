---
id: "feat_tui_cwd_focus_and_tab_overflow"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: "worker-3"
created_at: "2026-05-12T16:09:42.381Z"
updated_at: "2026-05-12T16:36:13.637Z"
blocked_by: []
blocks: []
---

# FEAT: bare 'mu' / 'mu state --tui' best-effort focus the workstream matching cwd; tab strip handles overflow when N workstreams won't fit

## Notes (3)

### #1 by "π - mu", 2026-05-12T16:10:59.245Z

```
MOTIVATION (verbatim user)
--------------------------
"feature. when launching the tui, make best effort to place the focus on the ws given the folder you are currently in. also think about scenarios where there are many ws, more than can easily fit in the pane title."

TWO RELATED FEATURES (single task, since the second only matters when N workstreams is large)

==================================================================
PART 1 — CWD-BASED INITIAL TAB FOCUS
==================================================================

CURRENT BEHAVIOUR
-----------------
src/cli.ts cmdBareTui (lines ~629-650):
  const envWs = process.env.MU_SESSION;
  const envIndex = envWs === undefined ? -1 : names.indexOf(envWs);
  const initialActive = envIndex >= 0 ? envIndex : 0;

Only $MU_SESSION drives initial focus. If unset, tab 0 wins regardless of where the user is.

DESIRED BEHAVIOUR
-----------------
Focus precedence (first match wins):
  1. **$MU_SESSION** — if set AND it names one of the resolved workstreams. (Operator override; explicit > implicit.)
  2. **CWD-based detection** — walk up from process.cwd() and match against the workspace SDK's known paths.
  3. **Tab 0** — fallback (current behaviour).

CWD DETECTION ALGORITHM
-----------------------
Two complementary paths, in order:

  (A) Workspace dir match (the common worker/orchestrator-recreate-workspace case):
      For each ws in `names`, check the convention path
      `<state-dir>/workspaces/<ws>/` (use `workspacesRoot(ws)` from src/workspace.ts:238).
      If process.cwd() starts with that path, focus that ws.

      Even better: query the live `vcs_workspaces` table (listWorkspaces across all workstreams)
      and check if cwd is === or startsWith(row.path). This handles non-default state-dir,
      non-conventional paths, etc.

  (B) Project-root match (for the orchestrator running `mu` from the actual project repo):
      The project root is the repo where the orchestrator manages everything. Today there's no
      explicit "this workstream is anchored to this project root" mapping.
      → DEFER this. The (A) match handles every spawned worker; the orchestrator falling back
        to tab 0 is fine and matches today's behaviour. Explicit `-w` or $MU_SESSION still wins.

So just (A): match cwd against vcs_workspaces.path for each ws. First match wins. If no match,
fall through to tab 0.

DECISION POINTS (locked unless flagged)
---------------------------------------
- $MU_SESSION takes precedence over cwd. Explicit env > implicit detection.
- Non-prefix matches don't count (don't try to handle "I'm two dirs up from a workspace").
- If multiple workspaces would match (one workspace nested inside another's path — pathological),
  the FIRST match in the workstream order (alphabetical / discovery order) wins.
- This is a BEST EFFORT enhancement. Detection failure is silent — no warning, no error. The user
  gets tab 0 and can Tab/Shift-Tab to switch.

WIRING (PART 1)
---------------
- src/cli.ts cmdBareTui: extend the precedence resolution. Add a small helper:
    function resolveInitialTab(names: string[], db: Db): number {
      // 1. $MU_SESSION first (existing behaviour).
      const envWs = process.env.MU_SESSION;
      const envIdx = envWs ? names.indexOf(envWs) : -1;
      if (envIdx >= 0) return envIdx;
      // 2. CWD match against vcs_workspaces.
      const cwd = process.cwd();
      const all = listWorkspaces(db);  // across all workstreams; or per-ws loop
      for (let i = 0; i < names.length; i++) {
        const ws = names[i];
        const rows = all.filter(r => r.workstreamName === ws);
        if (rows.some(r => cwd === r.path || cwd.startsWith(r.path + sep))) {
          return i;
        }
      }
      // 3. Default tab 0.
      return 0;
    }

- ALSO wire this into `mu state --tui -w ws1,ws2,...`. The user might pass an explicit set; cwd
  detection should still apply within that set.
- ALSO wire when single-ws TUI is launched: no-op (only one tab; no choice to make), but the same
  helper can be called for consistency.

TESTS (PART 1)
--------------
test/cli-bare-launches-tui.test.ts (extend) and test/state-dispatch.test.ts (if `mu state --tui`
also takes the new logic):
  * cwd inside a known workspace path → that ws is focused, regardless of $MU_SESSION not being
    set.
  * $MU_SESSION set + cwd inside a different ws → $MU_SESSION wins.
  * cwd inside a workspace NOT in the resolved set → tab 0.
  * cwd outside any workspace → tab 0.
  * Pathological: two workspaces with overlapping path prefixes — the first-match wins
    deterministically (assert order).

==================================================================
PART 2 — TAB STRIP OVERFLOW
==================================================================

CURRENT BEHAVIOUR
-----------------
src/cli/tui/tab-strip.tsx renders ALL workstream names as a single row: `workstreams: A · B · C
(Tab / Shift-Tab)`. The current comment header explicitly notes "never truncates; wraps onto a
second line". With many workstreams (10+) on a narrow terminal (80 cols), the row wraps multiple
times — eats vertical space and the active marker `▸ <ws>` may not even be visible without
scrolling.

DESIRED BEHAVIOUR
-----------------
Compact, single-line tab strip that ALWAYS shows the active workstream, with a windowed view of
the surrounding tabs. When tabs don't fit:
  - Truncate from the EDGES with `‹` / `›` indicators that count of hidden tabs.
  - Keep the active tab visible (centred where possible).
  - Keep the colour-blind-safe `▸ <name>` active marker.

LAYOUT EXAMPLES
---------------
Width = 80, 5 workstreams, A active:
  workstreams: ▸ A · B · C · D · E (Tab / Shift-Tab)         ← all fit; no overflow

Width = 40, 12 workstreams, F active:
  workstreams: ‹3 D · E · ▸ F · G · H ›4 (Tab/Shift-Tab)    ← window of 5; "‹3" = 3 hidden left,
                                                                    "›4" = 4 hidden right.

Width = 40, 12 workstreams, A active (head edge):
  workstreams: ▸ A · B · C · D · E ›7 (Tab/Shift-Tab)

Width = 40, 12 workstreams, L active (tail edge):
  workstreams: ‹7 H · I · J · K · ▸ L (Tab/Shift-Tab)

Width = 25, 12 workstreams, F active (extreme narrow):
  workstreams: ‹5 ▸ F › 6                                    ← just the active + counters.

ALGORITHM
---------
A pure function `layoutTabStrip(workstreams, active, availableCols)` returning a structured row
spec the React component renders:

  interface TabStripLayout {
    leftHidden: number;        // count to the left of the rendered window
    rightHidden: number;       // count to the right
    visible: { name: string; isActive: boolean }[];
  }

Algorithm:
  1. Estimate the chrome cost (the `workstreams: ` prefix + trailing `(Tab / Shift-Tab)` + the
     `‹N` / `›N` counters when needed).
  2. Available cols for tabs = availableCols - chrome.
  3. Always include the active tab (cost = `▸ <name>` + ` · ` separator).
  4. Greedily expand the window outward from active (one tab left, then one right, alternating)
     while the running cost stays ≤ available cols.
  5. Return the spec; the strip component renders it.

  Edge case: a single workstream — return without the strip (existing behaviour preserved by the
  early-return on `workstreams.length <= 1`).
  Edge case: even the active tab + counters won't fit — degrade to JUST `▸ <name>` (truncate the
  workstream name to the available width with an ellipsis).

WIRING (PART 2)
---------------
- src/cli/tui/tab-strip.tsx:
  * Read available cols via useStdout (already used elsewhere in the TUI; see src/cli/tui/state.ts
    for the pattern).
  * Call layoutTabStrip(workstreams, active, availableCols) to compute the spec.
  * Render the spec with `‹N` / `›N` counters as small dim Text elements; active tab as the
    existing `▸ <name>` bold cyan; siblings as dim names; ` · ` separators dim.
- src/cli/tui/tab-strip-layout.ts (NEW; pure helper): the layoutTabStrip function above.

TESTS (PART 2)
--------------
test/tui-tab-strip-layout.test.ts (NEW): pure-function fixture tests for layoutTabStrip:
  * 1 ws → strip not rendered (early return higher up, but test the layout fn returns a no-op
    spec gracefully).
  * 5 ws @ 200 cols → all visible, no counters.
  * 12 ws @ 80 cols → window of ~5 around active; counters reflect hidden counts.
  * Active at index 0 → no leftHidden; rightHidden = N - visibleCount.
  * Active at last index → mirror.
  * 12 ws @ 25 cols → degrade to active-only with ellipsised name + counters.

test/tui-tab-strip-render.test.ts (extend the existing one if there is one; grep): assert the
React render uses the layout spec; assert the active marker `▸ ` is always rendered.

DECISIONS (locked)
------------------
- Window is symmetric around active where possible; biased to keep active centred.
- Counters use `‹` and `›` (single guillemet chars). Use the SAME glyphs the rest of the TUI uses
  for left/right hints (grep src/cli/tui/ for prior art).
- No keyboard binding to "scroll the tab strip independently" — Tab / Shift-Tab still cycle
  through workstreams; the strip just reflows around whatever the active one is.
- No mouse interaction (mouse_input is its own task).

==================================================================
SHARED CONSTRAINTS
==================================================================

- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; refactor signal at 800. tab-strip.tsx is currently 73 LOC; the layout helper
  goes in its own file (~80 LOC). cmdBareTui is small; the new resolveInitialTab helper is ~30 LOC
  and goes in src/cli.ts (or a small src/cli/tui-launch-focus.ts if cli.ts is past the signal).
- Conventional commit prefix: `tui:` (TUI focus + tab strip are both TUI behaviour).
- Suggested commit:
    tui: cwd-aware initial-tab focus; compact tab strip with overflow indicators ‹N / ›N
- Four greens before commit + bundle smoke (node dist/cli.js --help && --version).

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js` in any tui/ file. SYMPTOM if cycle introduced:
`node dist/cli.js --help` exits 0 silently. The new src/cli.ts logic is fine to import the
workspace SDK (src/workspace.ts) directly; that's not a cycle.

DOCS
----
- CHANGELOG.md [Unreleased] under "Added":
  * "Bare `mu` and `mu state --tui` now best-effort focus the workstream whose workspace path
    contains the current cwd, falling back to $MU_SESSION (if set) and then tab 0."
  * "Tab strip is compact: it shows a windowed view around the active workstream with `‹N` /
    `›N` indicators when workstreams overflow the available width."
- docs/USAGE_GUIDE.md TUI section: short note on the new precedence + the tab strip behaviour.
- skills/mu/SKILL.md: same.

OUT OF SCOPE
------------
- No project-root → workstream mapping (defer; only spawned-workspace cwd matches).
- No "scroll the tab strip" keybinding (Tab cycles workstreams — that drives the window).
- No mouse interaction with the tab strip (mouse_input is its own task).
- No persistence of last-active tab across launches (anti-feature).

ORDERING
--------
This is independent of the in-flight VCS bug fix and slot-fix tasks. No file overlap with
fix_card_slot_layout (slot wiring) or bug_vcs_detect (vcs.ts + state.ts.commitsBackend).
Touches src/cli.ts (cmdBareTui) + src/cli/tui/tab-strip.tsx + a new layout helper.

⚠️ MIND THE GATING ⚠️
This task does NOT need to be gated behind anything. Dispatch in parallel with the slot-fix
when ready.

FINAL ACTION
------------
After committing + four greens green + bundle smoke, close YOUR task with:
  mu task close feat_tui_cwd_focus_and_tab_overflow -w tui-impl --evidence "<sha>: <one-line summary>"
```

### #2 by "worker-3", 2026-05-12T16:36:13.304Z

```
FILES: src/cli.ts; src/cli/state.ts; src/cli/tui-launch-focus.ts; src/cli/tui/tab-strip.tsx; src/cli/tui/tab-strip-layout.ts; test/cli-bare-launches-tui.test.ts; test/state-dispatch.test.ts; test/tui-tab-strip.test.ts; test/tui-tab-strip-layout.test.ts; docs/USAGE_GUIDE.md; CHANGELOG.md; skills/mu/SKILL.md
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test (first full run hit one tmux.integration flake, targeted retry passed; final full run 0); npm run build (0); node dist/cli.js --help (0); node dist/cli.js --version (0); git commit (0)
FINDINGS: Added shared TUI launch focus helper with MU_SESSION > cwd workspace path > tab 0 precedence; both bare mu and state --tui pass initialActive. Tab strip now uses pure layout helper and terminal columns to render overflow counters around active tab.
DECISION: Kept focus helper outside src/cli/tui to avoid ink/react imports outside TUI subtree and avoid cli bundle cycles; pure layout helper owns truncation/windowing for testability.
NEXT: None.
VERIFIED: npm run typecheck && npm run lint && npm run test && npm run build; bundle smoke help/version.
ODDITIES: One full-suite run had a transient tmux.integration prompt poll timeout; immediate targeted retry passed and subsequent full suite passed.
```

### #3 by "worker-3", 2026-05-12T16:36:13.637Z

```
CLOSE: a955122: cwd-aware TUI initial tab focus plus compact overflow tab strip
```
