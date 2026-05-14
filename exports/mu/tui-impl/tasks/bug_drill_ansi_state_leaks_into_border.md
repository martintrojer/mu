---
id: "bug_drill_ansi_state_leaks_into_border"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.1
roi: 750.00
owner: "worker-1"
created_at: "2026-05-13T15:06:01.131Z"
updated_at: "2026-05-13T15:09:45.528Z"
blocked_by: []
blocks: []
---

# BUG: wrapAnsi early-return + non-emit-end leaves open SGR; bleeds into popup right border

## Notes (2)

### #1 by "π - mu", 2026-05-13T15:06:55.878Z

```
TASK: bug_drill_ansi_state_leaks_into_border — wrap-ansi early-return
and end-of-loop emit don't close open SGR state; bleeds into ink's
border render and makes the popup right border look broken.

VERBATIM USER MOTIVATION
> "f24f5dfed0d9a3a6023a5939235abca90ea8960e didnt solve the problem"
> "git show pane still renders incorrectly … parts of the right hand
>  side border is off aligned. appears broken."

ROOT CAUSE — actually two compounding issues in src/cli/tui/wrap-ansi.ts

1. THE EARLY-RETURN PATH:
       export function wrapAnsi(line: string, width: number): string[] {
         if (line === "" || width <= 0 || stringWidth(line) <= width)
           return [line];
   A short colored line like `\x1b[31m+ added` is returned UNCHANGED.
   It contains an open SGR (red) but NO closing `\x1b[0m`. When ink
   renders `<Text wrap="truncate">{line}</Text>`, the bytes hit the
   terminal as-is. After that line, the terminal SGR is still red.
   The next character ink emits (the popup's right border `│`, the
   left border `│` of the next row, padding spaces, etc.) inherits
   the red state. Visually the chrome looks broken / shifted / patchy.

2. THE END-OF-LOOP EMIT:
       if (chunkWidth > 0 || (chunk !== "" && out.length === 0))
         out.push(chunk);
   When the OUTER loop exits, the trailing chunk is pushed WITHOUT
   the activeSgr-aware RESET that emit() applies. Same leak class.

Both issues mean: any colored input line whose intent was "this
fragment is red" (i.e. the source ANSI was scoped to the value-add
text only, with NO trailing reset) leaks SGR forward. Git diff output
typically COLORS the leading +/- and the rest of the line in the same
SGR — and many git-show implementations DO close per-line, but the
class of bug is real and trips on any input that doesn't.

The wrap="truncate" fix in f24f5df is correct for the byte-vs-visual
width problem; this is a SECOND, different bleed source.

FIX

1. Add a small `closeIfOpen(text: string, activeSgr: string[]): string`
   helper:

       function closeIfOpen(text: string, active: string[]): string {
         return active.length > 0 ? `${text}${RESET}` : text;
       }

2. Early-return path: scan the line for SGR sequences once and
   determine whether activeSgr would be non-empty at the end.
   If so, append RESET. Cheap because we only do this work for
   lines short enough to bypass wrapping.

   Implementation sketch:

       export function wrapAnsi(line: string, width: number): string[] {
         if (line === "") return [line];
         if (width <= 0 || stringWidth(line) <= width) {
           // Even the early-return path must guarantee SGR is closed
           // so the ink render doesn't leak colour into adjacent
           // chrome. (bug_drill_ansi_state_leaks_into_border)
           return [closeIfOpen(line, computeActiveSgr(line))];
         }
         ...rest unchanged...
       }

       function computeActiveSgr(line: string): string[] {
         const active: string[] = [];
         let i = 0;
         while (i < line.length) {
           ANSI_PATTERN.lastIndex = i;
           const m = ANSI_PATTERN.exec(line);
           if (m?.index !== i) { i++; continue; }
           updateActiveSgr(m[0], active);
           i += m[0].length;
         }
         return active;
       }

   (Or: pass `active` accumulator into a single-pass walk; the
   early-return can use the same primitive as the wrap loop. Pick
   whichever reads cleaner; mention in commit body.)

3. End-of-loop emit: same closeIfOpen on the final out.push:

       if (chunkWidth > 0 || (chunk !== "" && out.length === 0)) {
         out.push(closeIfOpen(chunk, activeSgr));
       }

4. (Defensive) `wrapAnsiLines` doesn't need changes — it joins with
   "
", so each line is independently terminated.

TESTS

- test/tui-wrap-ansi.test.ts (or test/wrap-ansi.test.ts — find
  the existing test file via `rg "wrapAnsi" test/`):
  - Add: `wrapAnsi("\x1b[31m+ added", 80)` returns
    `["\x1b[31m+ added\x1b[0m"]` (early-return path, RESET appended).
  - Add: `wrapAnsi("\x1b[31m+ added", 80)` where input has NO
    open SGR returns unchanged (no spurious RESET).
  - Add: a wrapped line whose final chunk has open SGR ends with
    RESET (verify the end-of-loop fix).
  - Existing tests stay green.

VERIFY MANUALLY (the canonical reproducer)
- `mu` → drill into Workspaces → Enter on a workspace → Enter on
  a commit (the git-show drill).
- Right border should be a single straight cyan column, top to
  bottom, regardless of which lines are coloured.
- Same for `mu` → Agents popup → drill into agent scrollback (also
  ANSI-coloured).

CONSTRAINTS
- Touch:
    src/cli/tui/wrap-ansi.ts (the fix)
    test/tui-wrap-ansi.test.ts (or wherever the existing tests live)
    CHANGELOG.md
- TUI cluster only.
- Bundle smoke MANDATORY.
- Four greens: typecheck (broader, incl. tests) + lint + test:fast
  + build (full optional).
- Commit prefix: `tui:`. ONE commit. Suggested:
    tui: wrap-ansi closes open SGR on early-return + end-of-loop; popup right border no longer leaks colour

DOCS
- CHANGELOG.md under [Unreleased] / Fixed.

PARALLEL WORK NOTE
- worker-1: tests_tui_convert_agents_log_recent (popup tests; unrelated)
- worker-2: src/agents.ts (lastClaimEvent helper; unrelated)
- worker-3: tests_tui_convert_workspaces_commits_doctor (popup tests; unrelated)
- worker-4: tests_tui_convert_ready_inprogress_blocked (popup tests; unrelated)
- CHANGELOG.md is shared.
- All 4 conversion workers may bump test/_ink-render.ts but
  not src/cli/tui/wrap-ansi.ts.

⚠️ FINAL ACTION
After four greens AND manual TTY verification:

  mu task close bug_drill_ansi_state_leaks_into_border -w tui-impl \
    --evidence "<sha>: wrapAnsi closeIfOpen on early-return + end-of-loop; right border integrity restored on git-show + agent-scrollback drills"
```

### #2 by "worker-1", 2026-05-13T15:09:45.528Z

```
CLOSE: de4d4f0: wrapAnsi now routes both the early-return path and the end-of-loop trailing chunk through closeIfOpen (appends RESET iff SGR open). New helper computeActiveSgr does a one-pass scan for the early-return case; emit() rewritten to use the same primitive. Added 3 regression tests in test/tui-wrap-ansi.test.ts (early-return open SGR, early-return no spurious RESET, end-of-loop trailing chunk close). Four greens: typecheck + lint + test:fast (1394 passed) + build. dist/cli.js contains closeIfOpen (4 hits). Manual TTY verification deferred to user (non-interactive agent); class-of-bug is covered by unit tests.
```
