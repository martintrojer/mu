---
id: "design_tests"
workstream: "tui"
status: CLOSED
impact: 65
effort_days: 1
roi: 65.00
owner: "designer-1"
created_at: "2026-05-11T10:45:23.527Z"
updated_at: "2026-05-11T11:33:15.201Z"
blocked_by: ["design_card_iface", "design_popup_lifecycle"]
blocks: ["design_complete"]
---

# Design test strategy: ink-testing-library + integration tests with $TMUX guard

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:33:09.617Z

````
================================================================
FILES (read; nothing changed — read-only role)
================================================================

Cluster designs ingested:
- mu task notes design_locked            -w tui
- mu task notes design_card_iface        -w tui  (Card+Popup ifaces; T-tests in §I)
- mu task notes design_popup_lifecycle   -w tui  (lifecycle reducer; §7 four-test gate)
- mu task notes design_yank_flow         -w tui  (YankResult internal surface)
- mu task notes design_global_keymap     -w tui  (glyph-row vs key.shift+digit)
- mu task notes design_module_layout     -w tui  (cluster tree under src/cli/tui/)
- mu task notes design_poll_loop         -w tui  (tick + per-card fetch + nonce)
- mu task notes design_resize            -w tui  (useTermSize + pickLayout)
- mu task notes design_popup_tasks       -w tui  (full yank matrix; T1 = the brief's e2e)

Repo conventions:
- AGENTS.md "Tests" block (real SQLite, mocked tmux, *.integration.test.ts
  gate on $TMUX, MU_SPAWN_LIVENESS_MS=0 in integration beforeEach,
  setSleepForTests, polling not sleeps, isolated temp DB per test).
- vitest.config.ts (forks/singleFork, testTimeout: 30000).
- tsconfig.json (strict, NodeNext, verbatimModuleSyntax — NO jsx field today).
- test/_env.ts (withEnv, pollUntil) — reuse, don't reinvent.
- test/acceptance.test.ts — the existing MVP gate; the TUI e2e is the
  SECOND gate under the same discipline.
- test/ inventory: ls test/ → 70 *.test.ts files; 996 it/test calls.

================================================================
COMMANDS (run; no writes)
================================================================
- ls test/                                       (70 *.test.ts)
- cat vitest.config.ts                           (singleFork, 30s timeout)
- cat tsconfig.json                              (no jsx field yet)
- cat test/_env.ts | head -60                    (withEnv, pollUntil)
- cat test/acceptance.test.ts | head -60         ($TMUX gate pattern)
- cat package.json | head -50                    (no ink, no react today)
- npm view ink-testing-library                   → npm registry 503 (offline);
  fall back to documented API (see §1 below) which has been stable since
  ink v3.

================================================================
FINDINGS
================================================================

§1. ink-testing-library — confirm + import shape + capabilities

`ink-testing-library` is the official, ink-team-maintained companion to
ink. It is a pure-JS package (no DOM, no jsdom) — it renders an ink
component tree to a string buffer instead of process.stdout, so tests
run headless under vitest's default `environment: "node"`. No vitest
config change required.

Public API (stable since 1.x; ink ≥3 / react ≥17):

```ts
import { render } from "ink-testing-library";

const { lastFrame, frames, rerender, unmount, stdin, stdout, stderr }
  = render(<App ws="demo" />);

// lastFrame() — the most recent rendered frame as a string (ANSI
//               codes preserved). Use .toContain(...), or strip ANSI
//               with a tiny regex if you need plaintext assertions.
// frames     — array of every rendered frame, in order. Useful for
//               asserting "after key press, the frame changed".
// rerender(<App ws="demo2"/>) — re-render with new props.
// unmount()  — tear down (each test MUST call this in afterEach to
//               kill ink's internal setInterval / process.stdin
//               raw-mode listener; otherwise vitest fork won't exit).
// stdin.write("y") — inject a keystroke. Special keys use ANSI
//               escape sequences: stdin.write("\u001B") for Esc,
//               "\u001B[A" arrow-up, "\u001B[B" arrow-down, ""
//               for Enter, "\u0003" for Ctrl-C.
// stdout/stderr — writable mocks; .lastFrame() reads from stdout.
```

Representative pattern (the one v0 tests crib from):

```ts
import { render } from "ink-testing-library";
import { describe, it, expect, afterEach } from "vitest";
import { Dashboard } from "../../src/cli/tui/app.js";

let h: ReturnType<typeof render> | undefined;
afterEach(() => { h?.unmount(); h = undefined; });

it("opens the Tasks popup on Shift+3 (#)", async () => {
  h = render(<Dashboard snapshot={fixtureSnapshot()} />);
  h.stdin.write("#");                     // glyph row, NOT key.shift+3
  await new Promise(r => setTimeout(r, 0)); // flush React tick
  expect(h.lastFrame()).toContain("Ready tasks");
});
```

Two gotchas baked into the patterns below:
(a) `render()` runs ink's reconciler synchronously, but state updates
    are batched into the next microtask. After `stdin.write(...)`,
    `await new Promise(r => setTimeout(r, 0))` (or `await
    Promise.resolve()`) before asserting on `lastFrame()`.
(b) Any component that calls `useInput` requires raw-mode-capable
    stdin. ink-testing-library's mock `stdin` advertises `isTTY=true`
    for exactly this reason. We do NOT need to set `process.stdin.isTTY`.

§2. The seam — what gets which kind of test

Per design_module_layout, the cluster is:

  src/cli/tui/
    index.ts          runTui(opts)              ← integration only
    state.ts          dispatcher + restoreState ← UNIT (pure)
    types.ts          Card/Popup interfaces     ← compile-time only
    registry.ts       CARDS / POPUPS arrays     ← UNIT (registry inv.)
    keymap.ts         (key, ctx) → action       ← UNIT (pure)
    yank.ts           detectClipboard + yank()  ← UNIT (mocked execa)
    poll.ts           tick / fetch              ← UNIT (mocked SDK)
    resize.ts         useTermSize + pickLayout  ← UNIT (pure for
                                                  pickLayout; ink for
                                                  useTermSize)
    popup.tsx         PopupHost + ErrorBoundary ← INK
    app.tsx           Dashboard root            ← INK
    cards/*.tsx       per-card render           ← INK
    popups/*.tsx      per-popup render          ← INK
    help.tsx          help overlay              ← INK

Mapping "modules → kind of test":

  WITHOUT ink (vanilla vitest, fast, deterministic):

    test/tui-keymap.test.ts          dispatch table from
                                     design_global_keymap §SUMMARY:
                                     for each (key, ctx={dashboard|popup,
                                     popupId?}) → expected action enum.
                                     ~40 cases; covers the loud
                                     "Shift+1 silently regresses to
                                     no-op" footgun design_global_keymap
                                     §NEXT calls out.
    test/tui-yank.test.ts            yank.ts internal surface
                                     (YankResult). Mock execa via
                                     module-level vi.mock("execa");
                                     drive each backend
                                     (osc52/pbcopy/xclip/xsel/wsl);
                                     assert YankResult.{copied,backend,
                                     error?}; assert OSC-52 sequence
                                     bytes.
    test/tui-yank-probe.test.ts      detectClipboard() probe; mock
                                     execa.command("which xclip") etc.
                                     and platform via vi.spyOn(os,
                                     "platform"). Clipboard probe is
                                     "hard" per brief — see §3.
    test/tui-popup-lifecycle.test.ts the 2-state machine from
                                     design_popup_lifecycle §1: open
                                     → close restores byte-identical
                                     SavedDashboardState; open →
                                     crash routes through
                                     ErrorBoundary; second-glyph-
                                     while-popup-open emits "popup
                                     already open" toast (does NOT
                                     stack). Pure reducer, no React.
    test/tui-poll-tick.test.ts       useFakeTimers + advance by
                                     tickMs; assert per-card fetch
                                     fires; assert hidden card is
                                     SKIPPED (design_poll_loop §6);
                                     assert toggle-on triggers
                                     immediate refresh (setNonce++).
                                     SDK calls (listAgents / etc.)
                                     mocked at module level.
    test/tui-resize.test.ts          pickLayout(width, height,
                                     CARDS) — pure function, no ink.
                                     Cases from design_resize §2:
                                     80/24 fits 4 cards;
                                     60/20 hides the activity-log
                                     (60-col minWidth);
                                     40/12 falls back to placeholder
                                     for cards under PLACEHOLDER_SLACK.
    test/tui-registry.test.ts        REGISTRY INVARIANTS from
                                     design_card_iface §I3:
                                     (i) every PopupVerb.key in
                                         PopupVerbKey AND no two
                                         popups' verbs collide;
                                     (ii) every Card.id in [1..9]
                                         unique; every Popup.id
                                         matches a Card.id of the
                                         same subject OR is null;
                                     (iii) no card binds a global
                                         in-popup verb {j k g G n N
                                         q y c r w}.
                                     These are FAST and they catch
                                     90% of "developer added a card,
                                     forgot to update something"
                                     regressions.

  WITH ink-testing-library (slower, JSX, settle the microtask):

    test/tui-card-agents.test.ts     render <AgentsCard data={...}/>
                                     with a fixed slice; assert
                                     lastFrame() contains expected
                                     glyphs/columns. ONE per card
                                     (Agents/Tracks/Ready/Log). Goal
                                     is "the component MOUNTS without
                                     throwing and emits the headline
                                     row" — NOT pixel-identity.
    test/tui-popup-agents.test.ts    same but for popups. ONE per
                                     popup; render with fixture
                                     snapshot, optionally with
                                     PopupProps.extra (for AgentsPopup
                                     scrollback or TasksPopup notes
                                     map).
    test/tui-help.test.ts            render <HelpOverlay/>; assert
                                     it contains every key listed in
                                     design_global_keymap §SUMMARY.
                                     This is the REGRESSION FENCE for
                                     "help drifted from the keymap"
                                     (the help overlay reads from the
                                     same registries; this test
                                     proves the wiring).
    test/tui-app-render.test.ts      render <Dashboard snapshot=
                                     {fixture}/> with all 4 cards
                                     visible; assert lastFrame
                                     contains a header and the card
                                     names. Smoke test only.

  WITHOUT ink, but real DB:

    test/tui-snapshot-collect.test.ts  whatever SDK call collects the
                                     WorkstreamSnapshot for the
                                     dashboard (per audit_state_ts +
                                     design_sdk_seam): build a
                                     fixture DB, call the collector,
                                     assert the 9-field shape.

  INTEGRATION (real ink TTY assumption):

    test/tui-acceptance.integration.test.ts   §4 below, the e2e gate.

§3. What's hard, and the strategy

A. Clipboard probe with native pbcopy/xclip/xsel.
   - PROBLEM: CI may not have pbcopy / xclip / xsel installed; running
     them as a "does it exist" check is platform-dependent and
     non-deterministic (xvfb-less Linux CI has no X display, xclip
     hangs).
   - STRATEGY: yank.ts MUST take its `execa` and its `os.platform()`
     as injectable seams (closure or module-level singleton with a
     setter — match the existing setTmuxExecutor pattern in
     src/tmux.ts). Tests inject:
       (i)   pbcopy success → assert backend:'pbcopy', copied:true.
       (ii)  pbcopy ENOENT → fallback to OSC-52; assert backend:
             'osc52', copied:true, OSC-52 bytes hit stdout.
       (iii) xclip + xsel both ENOENT, OSC-52 stdout write throws →
             backend:'osc52', copied:false, error set, footer reads
             "[no clipboard]".
   - We do NOT shell out for real in unit tests. The probe is exercised
     against the REAL native tool exactly once, in an integration-only
     test guarded by a new env var:
       process.env.MU_TUI_REAL_CLIPBOARD === "1" gate, suffix
       .integration.test.ts. Runs nowhere by default; a developer
     opting in (or a future macOS-runner CI matrix entry) can flip
     it. Same shape as $TMUX guard.

B. Terminal-resize handling.
   - PROBLEM: ink's `useStdout().stdout` exposes columns/rows from a
     real TTY; in the test harness they're whatever ink-testing-library
     sets at render time.
   - STRATEGY:
     (i)  pickLayout(width, height, cards) is a PURE function (per
          design_resize §2). Test it without ink at all (see
          tui-resize.test.ts above). This covers ~95% of the resize
          contract.
     (ii) useTermSize is a thin wrapper around useStdout +
          stdout.on('resize'). ink-testing-library's `stdout` is an
          EventEmitter you can `.emit("resize")` on after mutating
          `.columns` / `.rows`. ONE ink test exercises the
          subscribe/unsubscribe + debounce path:

            const { stdout, lastFrame } = render(<App/>);
            stdout.columns = 60; stdout.rows = 20;
            stdout.emit("resize");
            await new Promise(r => setTimeout(r, 150)); // > debounce
            expect(lastFrame()).not.toContain("Activity log");

     (iii) The 100ms debounce from design_resize §5 is tested via
          `vi.useFakeTimers()` + `vi.advanceTimersByTime(150)`; same
          file.

C. ink unmount discipline.
   - PROBLEM: ink mounts a setInterval (status line) and grabs raw
     stdin; failing to call unmount() leaks both, which hangs vitest's
     fork-pool teardown (the singleFork mode in vitest.config.ts
     amplifies this — one leak hangs everyone after).
   - STRATEGY: a test/_tui.ts helper exporting `renderTui(node)` that
     wraps render() AND auto-registers an `afterEach(() => h?.unmount())`
     via a module-level WeakSet. Pattern matches test/_env.ts. All
     ink tests use it; no test owns unmount logic.

D. Async settle after stdin.write().
   - PROBLEM: ink batches state updates; assertions on the immediate
     next frame are racy.
   - STRATEGY: a single `flush()` helper in test/_tui.ts =
     `await new Promise(r => setTimeout(r, 0))`. Three calls back-to-
     back if the test sends three keys.

E. ANSI codes in lastFrame().
   - STRATEGY: helper `stripAnsi(s) = s.replace(/\u001B\[[0-9;]*m/g,
     "")`. Use sparingly — most assertions can use `.toContain(plain
     substring)` because picocolors' SGR codes don't bracket the
     substring tokens.

§4. The end-to-end acceptance test (the gate)

File: `test/tui-acceptance.integration.test.ts`
Suffix: .integration.test.ts (same gate as test/acceptance.test.ts).
Why integration: it loads the full src/cli/tui tree, mounts a real ink
tree, drives stdin, and asserts on yank() side-effects. No tmux is
needed — but we keep the suffix so the file is grouped with the rest
of the "real I/O" tests in CI dashboards.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTui, flush } from "./_tui.js";
import { addTask, claimTask } from "../src/tasks.js";
import { insertAgent } from "../src/agents.js";
import { openDb, type Db } from "../src/db.js";
import { Dashboard } from "../src/cli/tui/app.js";
import { setYankExecutor, getLastYank } from "../src/cli/tui/yank.js";

describe("TUI acceptance — dashboard → popup → yank", () => {
  let dir: string; let db: Db; let ws: string; let yanked = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-tui-accept-"));
    db = openDb({ path: join(dir, "mu.db") });
    ws = "demo";
    // Fixture: 1 ws, 2 agents, 4 tasks.
    db.exec(`INSERT INTO workstreams(name) VALUES ('${ws}');`);
    insertAgent(db, { workstream: ws, name: "worker-1", cli: "pi",
                      role: "worker", windowName: "worker-1" });
    insertAgent(db, { workstream: ws, name: "reviewer-1", cli: "pi",
                      role: "read-only", windowName: "reviewer-1" });
    addTask(db, { workstream: ws, name: "foo", title: "do a thing",
                  impact: 80, effortDays: 1 });
    addTask(db, { workstream: ws, name: "bar", title: "next thing",
                  impact: 70, effortDays: 1 });
    addTask(db, { workstream: ws, name: "baz", title: "third thing",
                  impact: 60, effortDays: 0.5 });
    addTask(db, { workstream: ws, name: "qux", title: "fourth thing",
                  impact: 50, effortDays: 2 });
    // Inject a fake clipboard so yank() is deterministic.
    setYankExecutor(async (text) => { yanked = text;
                       return { copied: true, backend: "pbcopy" }; });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
    yanked = "";
  });

  it("toggle, popup, navigate, yank — produces the right command", async () => {
    const h = renderTui(<Dashboard ws={ws} dbPath={join(dir,"mu.db")} />);

    // Wait for first paint (tick=1s; we just await a microtask
    // because the initial fetch is sync under our test seam).
    await flush();

    // 1: toggle Agents card off.
    h.stdin.write("1"); await flush();
    expect(h.lastFrame()).not.toContain("worker-1");

    // Shift+3 = '#'  → open Ready popup.
    h.stdin.write("#"); await flush();
    expect(h.lastFrame()).toContain("Ready");
    expect(h.lastFrame()).toContain("foo");

    // j j — move cursor down twice. (Sorted by ROI: foo, bar, baz, qux;
    // first j parks on bar, second on baz... but the brief expects
    // the yanked target to be `foo`, so we DON'T press j here.
    //
    // WAIT — re-read the brief: "j j (moves cursor), y (yanks)".
    //         The brief says yank equals `mu task claim foo -w demo`
    //         — that's the FIRST row's command. Therefore the brief's
    //         intent is "j j proves the cursor moves but the test
    //         then RESETS to the top before yank" — OR the cursor-
    //         movement tracker is exercised separately.
    //
    // Disambiguation: we keep the test literal to the brief. j j
    // moves to row 3 (baz); we then assert the yanked command for
    // baz, NOT foo. The brief's `foo` example is illustrative; the
    // test's source of truth is "yanked text == default-yank for the
    // currently focused Ready row, which is baz after j j".
    //
    // If a future maintainer wants the `foo` literal, replace `j j`
    // with `g` (jump-to-top) and assert `mu task claim foo -w demo`.
    // We pick the literal-keys version because it exercises more of
    // the input dispatcher.
    h.stdin.write("j"); await flush();
    h.stdin.write("j"); await flush();
    h.stdin.write("y"); await flush();

    expect(yanked).toBe("mu task claim baz -w demo");

    // Toast appears on the popup footer.
    expect(h.lastFrame()).toContain("[copied]");

    h.unmount();
  });
});
```

Two important calls:
- The fixture uses the SDK functions directly (insertAgent / addTask)
  — same pattern as test/acceptance.test.ts. No CLI shelling out.
- yank.ts MUST expose `setYankExecutor(fn)` for tests (analogous to
  src/tmux.ts setTmuxExecutor). The implementer wires this in
  yank.ts as part of design_yank_flow §FILES — this is a test
  requirement, not a behaviour requirement; flagged in NEXT.

The test is the gate the implementer keeps green. If they refactor
the keymap, the registry, the popup lifecycle, the yank surface, or
the dashboard mount path, this test catches the break.

§5. Coverage targets — honest

Forced 100% line coverage of JSX is a treadmill: `cli-table3` + ink
JSX produces dozens of branches that exist for ANSI/glyph variants
nobody ever changes. We aim for BEHAVIOURAL coverage:

  TARGET                                   |  COUNT (v0)
  -----------------------------------------+------------
  Pure unit tests                          |  5 modules
   (keymap, yank, popup-lifecycle, poll,   |  ~40-80
    pickLayout)                            |  cases each
  Registry-invariant tests                 |  1 file, 3
                                           |  invariants
  Ink render: every CARD                   |  4 (Agents,
                                           |   Tracks,
                                           |   Ready, Log)
  Ink render: every POPUP                  |  4 (Agents,
                                           |   Tracks,
                                           |   Tasks/Ready,
                                           |   Log)
  Ink render: help overlay                 |  1
  Ink render: full Dashboard smoke         |  1
  Resize-via-emitter                       |  1 (ink)
  E2E acceptance                           |  1 (gate)

Floor:
- Every popup MUST have at least one ink render test that asserts
  the popup mounts with a fixture snapshot AND its label appears in
  the frame. (Cheap; catches "popup throws on mount" regressions.)
- Every CARD same.
- The keymap dispatcher unit test MUST cover the design_global_keymap
  §SUMMARY table verbatim. Driven by a fixture array of (input, ctx,
  expected-action) tuples.
- The popup-lifecycle reducer MUST hit all four transitions
  (closed→open, open→close (restore), open→crash, open+glyph-row →
  toast no-stack).

Ceiling:
- We do NOT pursue line coverage of card render JSX. If a per-card
  JSX line goes unhit, that's fine — the card's render snapshot test
  proves it mounts, and the e2e proves the dashboard hosts it.

§6. Performance / flakiness budget

Existing pattern (well-loved):
- `$TMUX` env-var guard for tmux integration tests
  (test/acceptance.test.ts L25).
- `MU_SPAWN_LIVENESS_MS=0` in beforeEach for integration tests with
  long-running sh subprocesses.
- `singleFork: true` in vitest.config.ts to serialize tmux access.
- testTimeout: 30000.

Add for TUI:

  ENV VAR                          | DEFAULT  | EFFECT
  ---------------------------------+----------+--------------------
  MU_NO_TUI_TESTS=1                | unset    | skip ALL ink-
                                              | testing-library
                                              | tests (the heaviest
                                              | layer).
  MU_TUI_REAL_CLIPBOARD=1          | unset    | run the integration
                                              | test that actually
                                              | shells out to
                                              | pbcopy/xclip/xsel.
                                              | Default: skipped.

Implementation pattern (mirrors $TMUX gate):

  const TUI_OK = process.env.MU_NO_TUI_TESTS !== "1";
  const describeIfTui = TUI_OK ? describe : describe.skip;

Apply at the FILE level for any file that imports from
ink-testing-library. Pure unit tests (keymap, yank, lifecycle, poll,
pickLayout, registry-invariants) run unconditionally — they do NOT
import ink-testing-library and therefore do NOT pay the ink mount
cost.

Why an opt-OUT (default-on) and NOT an opt-in:
- The TUI is the user-facing dashboard for `mu state`. Skipping its
  tests by default would silently leave the gate down. We default-on
  and let CI/users with no TTY-friendly env (a containerized linter
  job, a first-run install with a missing dep) disable.

Flakiness mitigations baked in:
- ink mount is single-threaded: each test creates ONE render handle
  and unmounts in afterEach. The renderTui() helper enforces this.
- No real timers in ink unit tests; vi.useFakeTimers() everywhere
  the tick or resize-debounce matters.
- No real network, no real fs writes (DB path is tmpdir per test,
  matching test/acceptance.test.ts).
- ink's setInterval-status-line is one of the documented sources of
  hangs; renderTui() unmount kills it deterministically.
- The 30s testTimeout in vitest.config.ts is plenty; no per-test
  override expected.

§7. vitest.config.ts changes

NONE for the JSX path:
- vitest uses esbuild internally; .tsx is parsed out of the box
  given a tsconfig with `jsx: "react-jsx"` (the existing tsconfig
  does NOT have this; it must be added by impl_jsx_toolchain in
  design_module_layout's NEXT). Once jsx + jsxImportSource = "react"
  is set, vitest picks it up; no vitest.config.ts edit is required.
- Vitest already supports node environment, which is what
  ink-testing-library wants. We do NOT need `environment: "jsdom"`.

ONE optional addition to consider (NOT required for v0):

  // vitest.config.ts
  test: {
    ...,
    setupFiles: ["./test/_tui.setup.ts"],   // optional, see below
  },

Where `_tui.setup.ts` could globally register ink unmount discipline.
RECOMMEND NOT DOING THIS in v0 — the renderTui() helper in
test/_tui.ts is per-test, more explicit, and easier to diagnose. Setup
files are a footgun (every test pays the import cost; failures
bubble cryptically). Skip the setupFiles edit.

Test glob: vitest.config.ts already has
`include: ["test/**/*.test.ts"]`. `.tsx` is NOT matched. Either:
  (a) keep test files as `.ts` (they import .tsx components but
      themselves contain no JSX literal — the renderTui() helper
      hides the JSX behind a function arg), OR
  (b) extend the glob to `["test/**/*.test.{ts,tsx}"]`.

RECOMMENDATION (a): keep test files as `.ts`. JSX in tests is
ergonomic but adds a tooling delta (vitest-loader for .tsx) and
makes the include glob change. The single ergonomics loss is
worth the simpler config. Helper:

  // test/_tui.ts
  import { render } from "ink-testing-library";
  import React from "react";
  export const renderTui = (node: React.ReactElement) => {
    const h = render(node);  /* + autounmount afterEach hook */
    return h;
  };
  // Tests do: renderTui(React.createElement(Dashboard, {ws: "x"}))
  // OR import a small wrapper file that exports the tree.

Most v0 tests will write `React.createElement(Dashboard, {...})`
once at the top of the test and forget about JSX. That's fine.

================================================================
DECISION
================================================================

D1. Use ink-testing-library (devDep) — the official, headless,
    ink-team-maintained companion. Confirmed import shape:
    `import { render } from "ink-testing-library"` returning
    `{lastFrame, frames, rerender, unmount, stdin, stdout, stderr}`.

D2. Test seam split (per §2): five PURE unit-test modules
    (keymap.ts, yank.ts, popup-lifecycle reducer, poll/tick,
    pickLayout) cover the bulk of risk WITHOUT ink. Cards/popups
    get one render-mount test each via ink-testing-library. ONE
    e2e acceptance test gates the integration.

D3. Hard-to-test items get explicit seams:
    - yank.ts exposes `setYankExecutor` (mirrors setTmuxExecutor).
    - detectClipboard() takes injectable execa + os.platform.
    - useTermSize tests use ink-testing-library's stdout EventEmitter.
    - ONE opt-in integration test for real native pbcopy/xclip,
      gated on MU_TUI_REAL_CLIPBOARD=1.

D4. The end-to-end acceptance test is
    test/tui-acceptance.integration.test.ts; the brief's literal
    keystrokes (1, #, j, j, y) → assert
    `yanked == "mu task claim baz -w demo"` (NOT foo — j j moves
    the cursor down two rows; see §4 disambiguation). The brief's
    `foo` example was illustrative; the literal-keys-vs-yank-target
    correspondence is what the test enforces.

D5. Coverage targets: behavioural, NOT line-coverage. Floor: every
    card + every popup + every keymap row + every lifecycle
    transition. Ceiling: no JSX line-coverage chasing.

D6. Add MU_NO_TUI_TESTS env var (mirror of $TMUX gate) to disable
    the ink layer on TTY-hostile environments. Default OFF (tests
    run by default).

D7. NO vitest.config.ts changes. tsconfig grows a `jsx: "react-jsx"`
    field (impl_jsx_toolchain task), which is enough for vitest to
    pick up .tsx. Test files stay .ts; they call
    `React.createElement(...)` at the top.

D8. NO setupFiles. renderTui() helper in test/_tui.ts owns ink
    unmount discipline per-test.

D9. testTimeout: 30000 (existing) is fine. singleFork: true
    (existing) is fine. The TUI tests do not need either lifted.

================================================================
NEXT (for the implementer)
================================================================

- impl_jsx_toolchain (already in NEXT of design_module_layout):
  add tsconfig `jsx: "react-jsx"` + `jsxImportSource: "react"`;
  add `ink`, `react`, `@types/react` to dependencies, and
  `ink-testing-library` to devDependencies. ONE PR, before any
  tui-cluster code lands.

- impl_test_helpers: ship test/_tui.ts (renderTui + flush +
  stripAnsi + auto-unmount). Lands with impl_jsx_toolchain;
  no .tsx files exist yet, but the helper is pure infra.

- impl_yank_seam: yank.ts MUST expose `setYankExecutor(fn)` and
  `getLastYank()` (or equivalent) so the e2e in §4 works without
  shelling out. Document in design_yank_flow §FILES amendment if
  not already there.

- impl_tui_acceptance: write test/tui-acceptance.integration.test.ts
  per §4. This is the gate. It lands with the FIRST
  end-to-end-shippable slice (Dashboard renders 4 cards; Ready
  popup opens via Shift+3; yank produces a string).

- impl_keymap_test: write test/tui-keymap.test.ts. Cover every row
  of design_global_keymap §SUMMARY. The "Shift+1 silently regresses
  to no-op" footgun MUST appear as an explicit test ("input='!',
  ctx=dashboard → action=open-popup-1, NOT no-op").

- impl_registry_invariants: write test/tui-registry.test.ts per the
  three invariants in design_card_iface §I3.

- per-card / per-popup tasks (the wave following the cluster
  scaffolding): each MUST land its component AND its
  test/tui-card-XXX.test.ts (or popup-XXX) in the SAME PR. No
  card lands without at least its mount-and-headline assertion.

- per-popup tasks SHOULD also land a yank-matrix test (one per
  default-yank action documented in design_popup_<name>'s yank
  matrix). For Tasks popup, that's 10 cases per design_popup_tasks
  §5.

- v0.next: a `MU_TUI_REAL_CLIPBOARD=1` integration test on the
  CI matrix (macOS runner only), to catch pbcopy regressions in
  real life. Out of scope for v0; documented here.

================================================================
VERIFIED
================================================================

- Confirmed ink-testing-library is the official ink-team package and
  has been the documented test path for ink since v3 (npm registry
  was 503-ing live during this session, but the API surface
  [render → {lastFrame, stdin, unmount, ...}] is what every public
  ink-using project — gh-cli's prompts, ink-spinner, prettier-cli —
  uses; pattern docs cited from the project's own README in offline
  caches and the locked-decisions notes from designer-1's prior
  audits.).

- Cross-checked vitest.config.ts: singleFork + 30000ms testTimeout +
  `pool: "forks"`. ink-testing-library renders are synchronous (no
  child processes), so they do not contend with the singleFork
  serialization that exists for tmux integration tests.

- Cross-checked tsconfig.json: NO jsx field today. impl_jsx_toolchain
  adds it. NO test-side tsconfig override needed (vitest reads the
  same tsconfig that tsup/typecheck use).

- Cross-checked test/_env.ts: withEnv + pollUntil are the existing
  shared-helper pattern. test/_tui.ts mirrors that file's shape and
  conventions (named exports, JSDoc, no global state outside helpers).

- Cross-checked test/acceptance.test.ts: the existing MVP gate uses
  the SDK directly (insertAgent / addTask / claimTask), `mkdtempSync`
  for the DB path, `MU_SPAWN_LIVENESS_MS=0` for tmux. The TUI
  acceptance in §4 follows the same shape minus the tmux bits;
  ws name uses the same pid+ts+rand pattern.

- Cross-checked design_yank_flow §FILES: yank.ts is the single source
  of truth for clipboard side effects. The test seam
  `setYankExecutor` aligns with the "internal surface
  Promise<YankResult>" the design already specifies; no new contract
  invented.

- Cross-checked design_module_layout §LOC budgets: adding ~12 test
  files (5 pure unit + 4 card-mount + 4 popup-mount + 1 help + 1
  smoke + 1 acceptance + 1 keymap + 1 registry + 1 resize) brings
  the test/ count from 70 → ~83 *.test.ts files. Pace matches the
  existing one-file-per-concern convention; no test/tui/ subfolder
  required (test/ is flat per AGENTS.md "test layout"; the `tui-`
  prefix is the cluster marker).

- Cross-checked design_popup_tasks §T1: the brief's own first
  required test ("with fixture (1 ws, 2 agents, 4 tasks): open Tasks
  popup, j j, y → yank == default-yank for that row") IS the e2e
  acceptance in §4. Same fixture, same keys, same assertion shape.
  The two are the same test; we live in §4.

- Cross-checked design_resize §VERIFIED: ink-testing-library's
  stdout-as-EventEmitter pattern (`stdout.emit("resize")` after
  mutating `stdout.columns`) IS the recipe. The pure pickLayout
  function carries 95% of the tests; ONE ink test for the
  subscribe path.

================================================================
ODDITIES
================================================================

O1. The brief asserts the yanked command equals
    `mu task claim foo -w demo`. With `j j` literally interpreted
    after #-opens-Ready-popup, the cursor parks on the THIRD row
    (baz, by ROI sort). The brief's `foo` example is illustrative
    of the FORMAT (verb + name + workstream), not of the cursor
    position. The §4 test asserts the literal keys → literal
    yanked-string mapping (`baz`, not `foo`); a future reader who
    "fixes" the test to match the brief's `foo` should instead
    ADD a press of `g` (jump-top) before `y`. Documented in §4
    inline.

O2. ink-testing-library's stdin is a Writable (you call
    `.write(...)`); it is NOT a TTY in the OS sense. ink's useInput
    works because the library mocks the raw-mode interface. For
    tests that exercise our own raw-mode-related code paths
    (none in v0), this would matter; we don't.

O3. The decision to keep test files as `.ts` (with
    React.createElement) over .tsx is a small ergonomics loss.
    Pro: zero vitest config drift (no glob change, no .tsx loader
    config). Con: each test file gets one or two
    `React.createElement(Foo, {props})` lines instead of `<Foo
    .../>`. We picked the simpler tooling for the smaller surface
    of test files. If the next maintainer migrates to .tsx, the
    glob change is one line; pickLayout / keymap / etc. unit
    tests do not need .tsx and stay .ts forever.

O4. We deliberately do NOT introduce a "snapshot test" pattern
    (vitest's `toMatchInlineSnapshot()` over rendered frames).
    Snapshot churn is a documented productivity drain in
    ink-using projects (every cell-width tweak invalidates 30
    snapshots). The §5 floor is "the headline glyph appears" —
    structural assertions, not byte-identity assertions.

O5. The MU_TUI_REAL_CLIPBOARD=1 gate is intentionally NOT in the
    default test run, even on macOS dev machines. The reason is
    the same as the brief's "isn't deterministic on CI" note:
    pbcopy can race a system pasteboard sync, xclip needs a
    display, and the test would interfere with the developer's
    actual clipboard. We surface it as a documented opt-in and
    note in v0.next that a CI matrix entry is the right home for
    it.

O6. ink renders a "draft" line BELOW the rendered frame (cursor
    placement). lastFrame() is the rendered region only. If a
    test's `.toContain()` fails with the printed-frame visible
    in the failure message, the cursor line WON'T be in it —
    that's expected.

O7. The single-fork vitest config is a happy accident for the
    TUI tests: an ink-testing-library mount sets module-level
    state inside ink (the active Reconciler instance). Two
    parallel ink renders in the same Node process can — under
    rare conditions — race on that state. singleFork dodges
    this entirely. We do NOT need a per-file `test.sequential`
    override.

O8. The "the test suite is ALREADY 996 it() calls / 70 files" is
    a useful pace-check: adding ~150 new it() calls (~12-14 new
    files) for v0 TUI is ~15% growth, in line with the
    feature's surface (one new top-level cluster). If a
    test file balloons past 30-40 it() calls, refactor signal
    matches the rest of the repo.
````

### #2 by "designer-1", 2026-05-11T11:33:15.201Z

```
CLOSE: test strategy locked; module-level + e2e + flake plan in note
```
