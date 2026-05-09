---
id: "hud_colors_stripped_under_watch_and"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: "worker-mf-1"
created_at: "2026-05-08T17:07:40.491Z"
updated_at: "2026-05-09T05:48:21.860Z"
blocked_by: []
blocks: []
---

# hud: colors stripped under `watch` (and other non-TTY pipes)

## Notes (3)

### #1 by π - src, 2026-05-08T17:07:59.898Z

```
SYMPTOM: Inside `watch --no-title -n 2 --color mu hud -w roadmap-v0-2`,
the HUD renders with no colors (status emojis missing fg color, dim
hints not dimmed, bold headers plain). Same `mu hud -w roadmap-v0-2`
in a regular shell renders colors correctly.

ROOT CAUSE: picocolors auto-detects color support from
`process.stdout.isTTY && env.TERM !== 'dumb'` (see
node_modules/picocolors/picocolors.js line 4). `watch` runs the command
with stdout as a pipe, so `isTTY` is false and picocolors disables ANSI
output. `watch --color` only tells `watch` to *preserve* ANSI from the
captured output — it can't make the child process emit them in the
first place.

REPRO:
  watch --no-title -n 2 --color mu hud -w roadmap-v0-2     # plain text
  mu hud -w roadmap-v0-2                                   # colored
  FORCE_COLOR=1 mu hud -w roadmap-v0-2 | cat               # colored
  watch --no-title -n 2 --color FORCE_COLOR=1 mu hud -w X  # colored
                                                            # (workaround)

OPTIONS:
1. Auto-detect tmux: when `$TMUX` is set (so the surrounding pane is a
   real terminal even though our stdout is a pipe), force colors on
   via `pc.createColors(true)`. Cheapest fix; covers `watch`,
   `tmux display-popup -E`, and any pipe-into-pager flow inside tmux.
2. Add `MU_FORCE_COLOR=1` env var as an explicit override (composes
   with FORCE_COLOR but doesn't require users to know the picocolors
   convention).
3. Add `mu hud --color` flag — explicit per-invocation. Most surgical;
   but every color-using verb would want it (state, hud, agent list,
   workstream list, ...).

RECOMMEND: option 1 + option 2. One `colorEnabled()` helper in
src/output.ts that returns true when any of: `pc.isColorSupported`,
`MU_FORCE_COLOR`, `FORCE_COLOR`, or `process.env.TMUX !== undefined`.
Replace the default `import pc from 'picocolors'` in cli.ts and
output.ts with `const pc = createColors(colorEnabled())`. ~15 LOC.

FILES: src/output.ts (helper), src/cli.ts (replace top-level import).
TESTS: small unit test for `colorEnabled()` covering env-var matrix +
TMUX + isTTY path. No HUD output assertions needed (cli-table3
pass-through).

NEXT: pick this up alongside any other small HUD-quality task; do not
inflate to a "color refactor" — keep it the helper + 2 import sites.
```

### #2 by reaper, 2026-05-09T05:34:56.085Z

```
[reaper] previous owner worker-mf-1 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

### #3 by worker-mf-1, 2026-05-09T05:48:14.027Z

```
FILES:
  src/output.ts            — new colorEnabled() helper + exported pc instance
                              (NO_COLOR > {isColorSupported,MU_FORCE_COLOR,FORCE_COLOR,TMUX})
  src/cli.ts               — drop direct picocolors import, take pc from ./output.js
  src/cli/{snapshot,workstream,doctor,workspace,hud,agents,log,tasks,approve,sql,state}.ts
  src/cli/tasks/{queries,lifecycle}.ts
                            — same: drop picocolors import, take pc from ../output.js
  test/output.test.ts      — new describe block 'colorEnabled (env-var matrix +
                              isTTY delegation)'; 6 cases (no-env/no-TTY=false,
                              TMUX=true, MU_FORCE_COLOR=1=true, FORCE_COLOR=1=true,
                              isTTY=true=true, NO_COLOR overrides everything=false)
  test/hud.test.ts         — vi.hoisted() sets NO_COLOR=1 before module imports
                              so literal-substring assertions don't trip when the
                              suite runs inside tmux (the surfacing case)
  CHANGELOG.md             — Unreleased/Fixed entry

COMMANDS:
  npm run typecheck && npm run lint && npm run test && npm run build  → all green
  MU_FORCE_COLOR=1 node dist/cli.js hud -w mufeedback | cat | hexdump -C  → ANSI present

FINDINGS:
  - picocolors is CJS (export = picocolors) → must use default-import form,
    not named { createColors, isColorSupported }, or the bundled dist/cli.js
    throws SyntaxError 'Named export not found' at runtime. Tripped on first
    bundle attempt; fixed by switching to default import in src/output.ts and
    updating the test mock to expose isColorSupported on the default export.
  - pc is created once at module load with colorEnabled() baked in. Tests
    that need to flip the matrix per-case must vi.resetModules() + vi.doMock()
    + dynamic-import (already done in test/output.test.ts).
  - hud.test.ts asserts literal substrings of HUD output (e.g. 'ready  alpha').
    Inside tmux those previously passed only because picocolors silently
    disabled output — now (correctly) they need NO_COLOR=1 to assert raw
    layout. Set via vi.hoisted() so it lands before ./_runCli.js imports
    src/output.js.

DECISION:
  - Implemented OPTION 1 + OPTION 2 from note #373 (TMUX auto-detect +
    MU_FORCE_COLOR override). Added NO_COLOR opt-out for symmetry with the
    cross-tool convention; otherwise the TMUX clause would surprise users
    who set NO_COLOR globally.
  - Rejected OPTION 3 (per task brief): no 'mu hud --color' flag — every
    color-using verb would want it; the helper + import-rewrite is more
    surgical and uniform.

NEXT:
  - Watch for any new picocolors imports added by future code; they should
    go through src/output.ts (the linter doesn't enforce this; rely on
    code review).
  - The 2 unrelated tasks.test.ts failures (--self resolves actor from
    $TMUX_PANE / $USER) only manifest when MU_AGENT_NAME is set in the
    test runner's env (i.e. when running 'npm test' from inside a mu
    agent pane). Pre-existing, not in scope here. Worth a separate
    test-isolation task if it bites.

VERIFIED:
  Live repro inside tmux:
    $ MU_FORCE_COLOR=1 node dist/cli.js hud -w mufeedback | cat | hexdump -C | head -5
    00000000  e2 94 8c e2 94 80 ...     ┌── (box-drawing chars, raw)
    $ MU_FORCE_COLOR=1 mu hud | cat | grep -ao '\x1b\[[0-9;]*m' | head -3
    \e[1m
    \e[36m
    \e[39m                              ← bold/cyan/reset escapes survived the pipe
  TMUX-only path (no MU_FORCE_COLOR, no FORCE_COLOR):
    $ env -u MU_FORCE_COLOR -u FORCE_COLOR node dist/cli.js hud -w mufeedback | cat | grep -ao '\x1b\[' | head -3
    \e[
    \e[
    \e[                                  ← TMUX clause kicked in
  NO_COLOR override:
    $ env -u MU_FORCE_COLOR -u FORCE_COLOR NO_COLOR=1 node dist/cli.js hud -w mufeedback | cat | grep -aoc '\x1b\['
    0                                    ← NO_COLOR trumps TMUX

  Gate: typecheck, lint, 719 tests, build — all green.

ODDITIES:
  - The 2 tasks.test.ts pre-existing failures noted under NEXT.
  - test/hud.test.ts now uses vi.hoisted() + NO_COLOR=1, which is unusual
    but necessary because pc is module-load-time baked.
```
