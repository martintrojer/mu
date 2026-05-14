---
id: "design_module_layout"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: "designer-1"
created_at: "2026-05-11T10:44:55.762Z"
updated_at: "2026-05-11T11:03:28.826Z"
blocked_by: ["audit_state_ts", "investigate_render_lib"]
blocks: ["design_card_iface", "design_non_tty_fallback"]
---

# Design module layout: src/cli/state.ts vs src/tui/ subdir

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:03:26.340Z

```
DECISION: src/cli/tui/ subdir cluster (option b).
The TUI is a verb-side render layer (consumed only by `mu state` and
bare `mu`), not an SDK seam — it belongs under src/cli/, parallel to
src/cli/tasks/, NOT at src/tui/ root.

================================================================
FILES
================================================================
- /Users/mtrojer/hacking/mu/src/cli/state.ts (907 → ~330 LOC after
  audit_state_ts deletions; gains a TTY dispatch branch)
- /Users/mtrojer/hacking/mu/src/cli/tasks/ (canonical 1-level
  cluster, 7 files, all imports cluster → root, hub at
  src/cli/tasks.ts)
- /Users/mtrojer/hacking/mu/src/agents/ (root-level cluster, hub at
  src/agents.ts; pattern reference for "clusters at root only when
  the cluster exports SDK consumed by other root files")
- /Users/mtrojer/hacking/mu/AGENTS.md (layout convention: flat root;
  1 subdir level OK iff (1) clear theme (2) cluster→root imports
  (3) ARCHITECTURE.md row)
- /Users/mtrojer/hacking/mu/tsconfig.json (NO jsx setting today —
  module: NodeNext, target: ES2022, no react/jsx libs)
- /Users/mtrojer/hacking/mu/tsup.config.ts (entries: index.ts +
  cli.ts; no esbuild loader override — esbuild infers .tsx by
  extension and the project ships dual-target ESM)
- /Users/mtrojer/hacking/mu/package.json (deps: better-sqlite3,
  cli-table3, commander, execa, picocolors, zod — NO ink/react yet)
- /Users/mtrojer/hacking/mu/src/cli.ts L676–L688 (bare `mu` action
  → cmdState with mission=true) and L698 (wireStateCommands) — the
  two existing call sites that must end up routing through the TUI
  when stdout is a TTY

================================================================
COMMANDS
================================================================
- wc -l src/cli/state.ts src/cli/tasks/*.ts src/agents/*.ts
    state.ts 907; cluster files 133–505 LOC (median ~280); largest
    sibling 675 (src/agents/spawn.ts). All under the 800-LOC
    refactor signal.
- grep "react\|ink" package.json → no matches. New peer additions
  required: ink ^5, react ^18, @types/react ^18.
- grep cmdState src/cli.ts → bare `mu` and `wireStateCommands` are
  the only call sites; both flow through cmdState today.

================================================================
FINDINGS
================================================================

A. SIZE FORCES A CLUSTER (kills option a)

Aggregating the keymap + poll loop + audit notes, the TUI needs:

  - Dashboard root (layout, tickMs/setTickMs, popupOpenRef,
    setNonce, error boundary)                            ~150 LOC
  - Cards × 4 (Agents, Tracks, Ready, Log) — each is its
    own ink component + per-card fetch fn + render          ~400
  - Popups × 4 (fullscreen detail of each card with
    in-popup keymap j/k g/G / Esc y ?, scroll, filter)      ~500
  - Popup lifecycle helper (single-popup invariant +
    restore-prior-dashboard-state contract)                  ~80
  - Keymap dispatcher (1-9, !-(, +/-/=/0, r/F5, ?/F1,
    q/Q, c, w; popup-aware suppression of 1-9; glyph-row
    binding NOT key.shift+digit)                             ~80
  - Help overlay (renders the keymap summary table from
    design_global_keymap)                                    ~80
  - Yank + clipboard helper (pbcopy/xclip/wl-copy probe;
    toast + footer line side-effects)                        ~60
  - Error boundary + per-card try/catch wrapper
    (fetchCard from design_poll_loop §8)                     ~50
  - Entrypoint + ink render bootstrap + non-TTY guard
    + signal handling                                        ~50

  TOTAL                                                  ~1450 LOC

That is ABOVE the 800-LOC refactor signal in a single file and
nearly at the 1500-LOC hard cap on day one. Option (a) single
src/cli/tui.ts is non-viable on arrival; rejected.

If we add the v0.1 Workspaces card flagged by audit_state_ts, add
~200 LOC (one card + one popup) → ~1650 LOC, blowing the cap
outright. The cluster has to absorb that growth.

B. WHY CLUSTER, AND WHY UNDER src/cli/

Two patterns to choose between:

  Pattern P1: src/agents/  (cluster at the SDK root)
    Has: spawn.ts, adopt.ts, kick.ts, errors.ts.
    Why root: the agents.ts hub re-exports SDK fns (spawnAgent,
    adoptAgent, …) consumed by other ROOT files (reconcile.ts,
    cli/agents.ts, cli/state.ts). The cluster is part of the
    public SDK contract.

  Pattern P2: src/cli/tasks/  (cluster under verb wrappers)
    Has: queries.ts, lifecycle.ts, edit.ts, edges.ts, claim.ts,
    tree.ts, wire.ts. Re-exports only the cmd<Verb> + wireFoo
    functions consumed from src/cli.ts. Pure verb-side rendering
    + commander glue.

  TUI fits P2 cleanly, NOT P1:
    1. Nothing in the TUI is consumed by a root SDK file. The
       TUI consumes the SDK (loadWorkstreamSnapshot,
       getParallelTracks, listAgents, listTasks, listLogs); it
       exports nothing back.
    2. The TUI's only entry points are `mu state` and bare `mu`,
       both of which already live in src/cli/state.ts. The
       wrapper-side relationship is identical to how
       src/cli/tasks/wire.ts hangs off src/cli/tasks.ts.
    3. The "thin wrappers over the SDK" header in ARCHITECTURE
       describes src/cli/* — and the TUI IS a wrapper, just one
       with internal structure (the same way src/cli/tasks/edit.ts
       is a 450-LOC "thin wrapper").

  Option (c) — top-level src/tui/ — would imply the TUI exports
  SDK that other root files consume. It does not. Co-locating ink
  components with thin commander glue at the root would also
  pollute the SDK surface area for downstream importers of
  src/index.ts (they'd see ink types in autocomplete). Rejected.

C. INK FILES CO-LOCATE NATURALLY

Ink components are React components: each renders one card or one
popup, takes a snapshot slice via props, owns no global state. The
"one file per card / popup" split mirrors btop's mental model the
locked decisions adopted (each card is a self-contained surface).
Cards and popups for the same subject (Agents-card +
Agents-popup) share data shape, so the cluster groups them by
pair via subdirs (cards/agents.tsx + popups/agents.tsx). No
component imports another component's internals — they all import
the snapshot type from a sibling state.ts. Imports flow
side-by-side under the cluster, never upward (cluster → root only:
SDK from src/state.ts / src/tasks.ts / src/agents.ts / src/logs.ts
/ src/tracks.ts).

D. JSX TOOLING IS THE ONE NEW LIFT

tsconfig.json today has no `jsx` field. tsup/esbuild silently
transpiles .tsx via its built-in JSX loader BUT will emit
`React.createElement` calls unless `jsx: "react-jsx"` is set in
tsconfig (the modern automatic runtime). Required tsconfig
additions (single edit):

    "jsx": "react-jsx",
    "jsxImportSource": "react",

(esbuild reads these from tsconfig automatically — no tsup config
change needed; the entries field stays index.ts + cli.ts.)

@types/react must be added (devDependency) for the JSX intrinsic
elements to typecheck. Since react/ink are runtime-only for the
TUI execution path, `react` and `ink` are dependencies (not
peerDependencies) — the user must not be expected to provide
them. Per AGENTS.md "Don't bundle pi" the parallel question is
"do we bundle ink?" — yes, ink is small (~30k gzip including
react), is required for the verb to work, and there's no
ecosystem expectation that the user provides it.

The cluster will contain TSX files; .ts files (index.ts entry,
state.ts tick, keys.ts dispatcher) stay pure TypeScript so they
remain testable without an ink renderer.

================================================================
FILE TREE (chosen layout, with LOC budgets)
================================================================

  src/cli/state.ts                  ~330 LOC
      Static `mu state` (full + mission renderers, JSON shapes)
      + the TTY/JSON dispatch branch that hands off to the TUI.
      Drops --hud + -n/--lines + size-aware HUD code per
      audit_state_ts. JSX-free.

  src/cli/tui/                      ~1450 LOC across 14 files
    index.ts                        ~90
        Public entrypoint: `runTui(db, opts)`. Bootstraps the ink
        renderer (`render(<App ...>, { stdout, stdin, exitOnCtrlC:
        false })`), hooks SIGINT/SIGTERM/SIGTSTP, forwards exit
        code, returns a Promise that resolves on unmount. JSX-free
        (creates element via React.createElement to keep this file
        importable from a non-JSX caller — the .ts/.tsx boundary).
    app.tsx                         ~150
        <App> root: top-level error boundary wrapping <Dashboard>
        and the popup mounting point. Owns the popup state machine
        (single-popup invariant) and the workstream context. JSX.
    state.ts                        ~140
        The poll loop from design_poll_loop: tickMs/setTickMs,
        per-card fetch refs, popupOpenRef, setNonce, fetchCard
        try/catch wrapper, listLogs cursor (afterSeq), staleness
        flags. Pure TS, no JSX. Importable for unit tests.
    keys.ts                         ~110
        Keymap dispatcher per design_global_keymap (glyph-row
        binding for !-(, popup-aware suppression of 1-9, +/-/=/0
        with floor 100ms/ceiling 10s, r/F5/?/F1/q/c/w). Pure TS.
        Receives an action callback bag from <Dashboard>.
    cards/agents.tsx                ~110
    cards/tracks.tsx                ~90
    cards/ready.tsx                 ~80
    cards/log.tsx                   ~100
        One card component each. Receive a snapshot slice via
        props; render with ink primitives (<Box>/<Text>); no
        SDK calls (the parent does the fetch). JSX.
    popups/agents.tsx               ~150
    popups/tracks.tsx               ~110
    popups/ready.tsx                ~110
    popups/log.tsx                  ~140
        One popup per card subject. Each implements the in-popup
        keymap convention (j/k g/G / Esc y ?), per-popup verbs
        (e.g. n=notes, t=tree, b=blockers for tasks; per
        design_global_keymap reserved-letter pool), the y yank
        flow, the row selection state. JSX.
    yank.ts                         ~50
        Clipboard helper: probe for pbcopy/xclip/wl-copy via
        execa, fall back to "no clipboard". Returns a Promise so
        the popup can append " [copied]"/" [no clipboard]" to the
        toast + dashboard footer. Pure TS.
    help.tsx                        ~80
        ?/F1 overlay rendering the keymap summary table from
        design_global_keymap. Mounts above the dashboard but
        below popups; closed by ? or Esc. JSX.

  Hub re-exports stay at src/cli/state.ts (NOT a separate
  src/cli/tui.ts hub). Reason: state.ts already owns `mu state`
  and bare `mu`; the TUI is one of its render modes. Adding a
  src/cli/tui.ts hub purely to mirror the cluster pattern would
  add an unjustified file (rule: re-exports for callers OUTSIDE
  the cluster — and the only outside caller IS state.ts).

================================================================
JSX MANIFEST + TOOLING DELTA
================================================================

JSX/TSX files:
  src/cli/tui/app.tsx                    JSX
  src/cli/tui/cards/agents.tsx           JSX
  src/cli/tui/cards/tracks.tsx           JSX
  src/cli/tui/cards/ready.tsx            JSX
  src/cli/tui/cards/log.tsx              JSX
  src/cli/tui/popups/agents.tsx          JSX
  src/cli/tui/popups/tracks.tsx          JSX
  src/cli/tui/popups/ready.tsx           JSX
  src/cli/tui/popups/log.tsx             JSX
  src/cli/tui/help.tsx                   JSX
                                         10 .tsx files

Pure .ts files (testable without ink):
  src/cli/tui/index.ts                   .ts
  src/cli/tui/state.ts                   .ts
  src/cli/tui/keys.ts                    .ts
  src/cli/tui/yank.ts                    .ts

tsconfig.json delta (REQUIRED):
  + "jsx": "react-jsx",
  + "jsxImportSource": "react",
  (drop-in addition under compilerOptions; verbatimModuleSyntax
  remains compatible with react-jsx automatic runtime.)

tsup.config.ts delta:
  None required. esbuild infers .tsx by extension and reads
  jsx/jsxImportSource from tsconfig. The bundler will pull ink +
  react into dist/cli.js automatically. (Verify post-build that
  the dist size doesn't balloon for users who never run the TUI;
  if it does, the followup is to mark the TUI entry as a separate
  tsup chunk and dynamic-import — see WIRING below.)

package.json delta:
  + "ink": "^5.0.0",                     // dependency
  + "react": "^18.0.0",                  // dependency
  + "@types/react": "^18.0.0"            // devDependency

biome.json: ink JSX uses self-closing components; verify Biome's
JSX rules don't fight us. (No code changes needed pre-emptively;
fix in the implementation task if linter flags.)

================================================================
WIRING STORY: how `mu state` and bare `mu` resolve
================================================================

The dispatch branch lives in src/cli/state.ts (cmdState). Single
source of truth — both call sites (bare `mu` at src/cli.ts:688
and `wireStateCommands` at src/cli.ts:698) already route here.
Adding the branch in any other location (e.g. wrapping cmdState
inside cli.ts, or a new src/cli/tui/index.ts that ALSO branches)
fragments the dispatch logic across two files.

Sketch (the only addition cmdState needs):

    // src/cli/state.ts (after the SDK-seam refactor)
    export async function cmdState(db: Db, opts: StateOpts):
        Promise<void> {
      // JSON path is non-interactive by definition.
      if (opts.json) return renderStateJson(db, opts);

      // TTY-and-not-piped → interactive TUI. The non-TTY path
      // (CI, `mu state | head`, `watch -n5 mu state`) keeps the
      // existing static renderer as the L1-total fallback per
      // design_locked.
      if (process.stdout.isTTY && process.stdin.isTTY &&
          !opts.mission /* explicit `mu state --mission` =
                           static glance card, never TUI */) {
        // Dynamic import: keeps ink + react out of the cold path
        // for non-TTY callers (CI runs, `--json` scripts, the
        // bare `mu --json` mission render). ESM dynamic-import
        // cost is ~5ms in v20; the avoided ink/react eval is
        // ~50ms. Net win.
        const { runTui } = await import("./tui/index.js");
        return runTui(db, opts);
      }

      // Static fallback (existing renderer, post-audit-shrink).
      return renderStateStatic(db, opts);
    }

Notes on the branch:

  - `--mission` opts out of the TUI even on a TTY because the
    locked spec says bare `mu` (mission=true) is muscle-memory
    glance — users want a one-screen card and their prompt back,
    not an interactive surface they must Esc out of. Bare `mu`
    keeps the static glance card; `mu state` (no flags) on a TTY
    enters the TUI. This matches the design_locked L1-total
    statement: "TUI fully replaces `mu state --hud`" — `mu state`
    with no flags and a TTY is the new HUD.
  - `--json` always wins (it's a structured-output contract).
  - The TUI never returns a non-zero exit unless ink crashes;
    runTui resolves the existing exit-code surface.
  - We do NOT add a `mu state --tui` flag. design_locked's
    L1-total decision is that the dispatch is environmental
    (TTY-ness), not a flag. A flag would tempt scripts to opt in
    and pin against the TUI semantics they shouldn't depend on.

Test/CI considerations:
  - process.stdout.isTTY is FALSE under vitest's default reporter
    + GitHub Actions, so existing acceptance tests of `mu state`
    keep hitting renderStateStatic. No test changes required for
    the static path.
  - Add a unit test that mocks process.stdout.isTTY = true and
    asserts the dynamic import path is taken. The TUI itself is
    integration-tested via ink-testing-library (separate task).

================================================================
ARCHITECTURE.md row(s) to add (drop into the Modules table)
================================================================

Add ONE row immediately after the existing `src/cli/tasks/*.ts`
row (preserves the convention of grouping each subdir with its
hub). Single row covers the cluster — same pattern as the
existing tasks/ row.

  | `src/cli/tui/*.tsx,*.ts` | sub-cluster of the `mu state` /
  bare `mu` interactive render mode (TUI, the v0.4 replacement
  for `mu state --hud`). Mounted by `cmdState` in
  src/cli/state.ts when stdout is a TTY and `--json` is unset;
  the static renderer in state.ts remains the non-TTY/CI/JSON
  fallback. Ink (React-for-terminal) components consuming the
  src/state.ts SDK seam — ZERO render-logic duplication with the
  static renderer. One file per concern: `index.ts` (runTui
  entrypoint + ink bootstrap; .ts so non-JSX callers can
  re-export it), `app.tsx` (root <App>, error boundary, popup
  state machine), `state.ts` (poll loop — tickMs, popupOpenRef,
  per-card fetchCard try/catch, listLogs afterSeq cursor),
  `keys.ts` (global keymap dispatch — 1-9 toggle, !-( popup,
  +/-/=/0 tick, r/F5/?/F1/q/c/w; pure TS for unit-testability),
  `cards/{agents,tracks,ready,log}.tsx` (one component per
  dashboard card; receive snapshot slice via props), `popups/{
  agents,tracks,ready,log}.tsx` (fullscreen subject popups
  honouring the in-popup keymap convention j/k g/G / Esc y ?),
  `yank.ts` (clipboard probe pbcopy/xclip/wl-copy + fallback),
  `help.tsx` (?/F1 overlay rendering the keymap summary).
  Imports flow cluster → root (src/state.ts, src/tasks.ts,
  src/agents.ts, src/logs.ts, src/tracks.ts) — never upward;
  the only outside-cluster importer is src/cli/state.ts via
  dynamic import. |

Also amend the existing `src/cli/*.ts` row's parenthetical to
add the TUI sub-cluster to the inventory:

  (current) "Currently: workstream.ts, agents.ts, tasks.ts,
  workspace.ts, log.ts, archive.ts, state.ts (canonical state
  card + bare `mu` mission-control / hud render mode),
  snapshot.ts, sql.ts, doctor.ts."

  (after)   "Currently: workstream.ts, agents.ts, tasks.ts,
  workspace.ts, log.ts, archive.ts, state.ts (canonical state
  card + bare `mu` mission render mode + TTY dispatch into the
  TUI sub-cluster), snapshot.ts, sql.ts, doctor.ts."

================================================================
NEXT
================================================================
- design_card_iface (sibling) — pin the snapshot-slice prop
  shape so each cards/*.tsx and popups/*.tsx has a typed
  contract. Should consume the WorkstreamSnapshot from the
  src/state.ts SDK seam (per audit_state_ts DECISION).
- design_popup_lifecycle (sibling) — formalise the
  single-popup invariant + restore-prior-dashboard-state
  contract. Lives in src/cli/tui/state.ts per this layout.
- design_help_overlay (sibling) — the help.tsx component is in
  this layout's tree; it consumes the keymap reference from
  design_global_keymap.
- impl_jsx_toolchain (NEW; consider promoting) — the tsconfig
  jsx/jsxImportSource addition + ink/react/@types/react package
  bumps. Self-contained, ~3 file edits. Worth a dedicated task
  to land before any TUI code lands so the first .tsx file
  builds clean.
- impl_tui_entry (NEW) — ship src/cli/tui/index.ts +
  src/cli/tui/app.tsx + the cmdState dispatch branch as the
  first slice; cards and popups land card-by-card in
  subsequent waves so each card's PR is small.
- pillar_amend_cli_table3 (NEW; promote to docs_vision_amend
  follow-up) — VISION/ROADMAP say "no render layer beyond
  cli-table3 + picocolors." The locked decisions retire that
  pledge in favour of "+ ink for TUI." Note flagged in
  design_locked but the doc edit itself is a separate task.

================================================================
VERIFIED
================================================================
- Read all four locked-context notes
  (design_locked / audit_state_ts / design_global_keymap /
  design_poll_loop) before drafting; LOC budget above
  cross-references the components those notes name.
- Confirmed src/cli/tasks/ has 7 files, hub re-export at
  src/cli/tasks.ts, all imports flow cluster → root (head -50
  src/cli/tasks/wire.ts). The TUI cluster mirrors the pattern.
- Confirmed src/agents/ is a ROOT-level cluster precisely
  because its hub re-exports SDK consumed by other root files
  — TUI does not, so it does NOT belong at src/tui/.
- Confirmed AGENTS.md cluster rules (1) clear theme:
  "interactive ink render of `mu state`" — every file is part
  of one render surface; (2) cluster → root: every import in
  the planned tree above is downward; (3) ARCHITECTURE row
  drafted above.
- Confirmed tsconfig.json has NO jsx field (read full file)
  and tsup.config.ts has no JSX loader override (read full
  file). Tooling delta documented above.
- Confirmed package.json has neither ink nor react today.
  Adding both as `dependencies` (not peerDeps) is the right
  call: ink/react are not user-provided, unlike pi.
- Confirmed cli.ts:688 routes bare `mu` through cmdState with
  mission=true and cli.ts:698 wires `mu state` through the
  same cmdState. Single dispatch point, exactly where the
  TTY branch belongs.
- Confirmed audit_state_ts's post-shrink budget for
  src/cli/state.ts (~330 LOC) — adding ~10 LOC for the TTY
  dispatch branch keeps it well under both the 800 refactor
  signal and the 1500 hard cap.
- LOC budgets above are estimates from the keymap + poll-loop
  + locked specs; the cluster has headroom (largest planned
  file is popups/agents.tsx at ~150 LOC; sibling cluster
  src/cli/tasks/edit.ts already runs 450).

================================================================
ODDITIES
================================================================
- Putting ink components under src/cli/ feels uncomfortable
  because src/cli/ is described as "thin wrappers." The TUI
  cluster is NOT thin — but neither is src/cli/tasks/edit.ts
  (450 LOC). The shared property is "no SDK contract exported
  upward, only commander-driven verb behaviour." On that
  rubric the TUI fits. If a future reader objects, they can
  promote the cluster to src/tui/ once a non-CLI consumer
  exists; today there isn't one.
- The decision to keep state.ts as the dispatch site (rather
  than a thin src/cli/tui/index.ts hub branching itself) means
  state.ts grows by ~10 lines (the if/else). Tradeoff: one
  branch in one file, vs two files that both have to know
  about TTY-ness. Picked the former.
- Dynamic import (`await import("./tui/index.js")`) is the
  right hammer here but it costs us synchronous typing at the
  call site: cmdState becomes async (it already is, by
  signature). Confirm the existing signature returns
  Promise<void> before landing — handle() in src/cli/handle.ts
  awaits its callback so this is a no-op for callers.
- The Workspaces card flagged by audit_state_ts as a v0.1
  promotion candidate slots into this layout cleanly:
  src/cli/tui/cards/workspaces.tsx +
  src/cli/tui/popups/workspaces.tsx. The cluster headroom
  budget allows for it (~+200 LOC; cluster total ~1650 LOC
  spread across 16 files; largest single file still ~150).
- We do NOT add a barrel src/cli/tui/index.ts that re-exports
  every card and popup. The cards/popups are private to the
  cluster; the only public symbol is `runTui`. Barrels pull
  every component into every test, slowing down vitest cold
  start.
- ink testing pattern is `ink-testing-library` (devDep). Out
  of scope for this layout task; flag for the implementation
  tasks. None of the layout choices above lock us in or out.
- The "no render layer beyond cli-table3 + picocolors" pledge
  in VISION/ROADMAP is amended by design_locked but the edit
  itself is unblocked-by-this-task; tracking under
  pillar_amend_cli_table3 in NEXT.
```

### #2 by "designer-1", 2026-05-11T11:03:28.826Z

```
CLOSE: layout chosen; file tree + wiring + ARCHITECTURE row in note
```
