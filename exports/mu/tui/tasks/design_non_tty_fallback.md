---
id: "design_non_tty_fallback"
workstream: "tui"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "designer-2"
created_at: "2026-05-11T10:45:23.101Z"
updated_at: "2026-05-11T11:07:39.626Z"
blocked_by: ["design_module_layout"]
blocks: ["design_complete", "design_json_compat"]
---

# Design non-TTY fallback: detect isTTY, fall back to mu state

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:07:36.682Z

```
DESIGN: non-TTY fallback rules for the new ink TUI.

================================================================
FILES (read)
================================================================
- /Users/mtrojer/hacking/mu/src/cli/state.ts L228-298
  (cmdState dispatch — the exact branch site).
- /Users/mtrojer/hacking/mu/src/cli/state.ts L154-163 (StateOpts).
- /Users/mtrojer/hacking/mu/src/cli.ts L676-688 (bare `mu` action),
  L698 (wireStateCommands wiring).
- /Users/mtrojer/hacking/mu/src/output.ts L40-58 (colorEnabled —
  the PRECEDENT for env-precedence-then-isTTY decisions in mu).
- design_locked, design_module_layout, audit_state_ts notes.

================================================================
COMMANDS
================================================================
- grep -rn "isTTY\|MU_NO_TUI" src/   (only output.ts + state.ts:506
  use isTTY today; no MU_NO_TUI yet)
- mu task notes design_locked / design_module_layout /
  audit_state_ts -w tui

================================================================
FINDINGS
================================================================
F1. ink's documented requirements (from ink README + source):
    - ink imports `react` and renders to stdout via a custom
      reconciler. Output works on a pipe (test snapshots use
      ink-testing-library exactly that way), but interactive
      keyboard input requires `process.stdin` to support raw mode.
    - `useInput` calls `useStdin()` which exposes
      `isRawModeSupported`. ink throws
      `ErrorConstants.ERROR_RAW_MODE_NOT_SUPPORTED` ("Raw mode is
      not supported on the current process.stdin, which Ink uses as
      input stream by default. Read about how to prevent this
      error on https://github.com/vadimdemedes/ink/#israwmodesupported")
      when a `useInput`-using component mounts on a non-TTY stdin.
    - `process.stdin.isTTY === true` is the canonical check
      (matches `isRawModeSupported` semantics; both come from
      `tty.isatty(fd)` under the hood).
    - The `render()` call itself accepts `{stdout, stdin,
      isRawModeSupported}` overrides; default behaviour reads from
      `process.stdin`.
    Source receipts: ink/src/components/Stdin.tsx,
    ink/src/hooks/use-input.ts.

F2. mu's TUI is interactive by design (1-9 toggle, Shift+1-9 popup,
    j/k/g/G/Enter/Esc/y/?, F1, +/-, q). Every one of those needs
    `useInput`, so raw-mode-able stdin is a hard requirement, not
    a nice-to-have. We CANNOT fall through to ink with a piped
    stdin and pretend it works.

F3. Output side: even ignoring input, ink's renderer uses ANSI
    cursor moves (clear-screen, cursor-up, alt-screen-buffer
    optionally). Piping that to `less` produces a smear of escape
    codes. Static `mu state` renders as plain text + cli-table3
    (already correctly handles non-TTY via NO_COLOR cascade). So
    "non-TTY stdout" alone is enough to disqualify the TUI even
    when stdin happens to be a TTY (e.g. `mu | less`).

F4. The activation predicate must therefore require BOTH:
        process.stdout.isTTY === true
     AND process.stdin.isTTY  === true
    Either being false → fall back to static.

F5. Existing precedent (src/output.ts colorEnabled): env vars
    checked FIRST, then isTTY heuristic. Same shape applies here.

F6. CI/cron/SSH-without-`-t`/`nohup mu`/GitHub Actions all leave
    stdin and stdout as pipes (or `/dev/null`); `isTTY` is
    `undefined` → falsy → static path. Verified this matches Node
    docs (`tty.WriteStream.isTTY` is `true` only when the stream
    is connected to a TTY). No edge case slips through; the dual
    check is sufficient.

F7. `mu --json` is the existing scripting escape hatch and ALREADY
    short-circuits before any human render in cmdState (L270-289).
    The TTY branch must therefore go AFTER the `--json` branch
    (json wins; users scripting from inside a TTY tmux pane MUST
    keep getting machine output). This also means the matrix in
    the spec is correct as drawn.

================================================================
DECISION
================================================================
D1. DETECTION PREDICATE.
    A standalone helper in src/cli/tui/index.ts (NOT in state.ts
    — keeps state.ts free of ink-shaped reasoning):

      export function tuiSupported(): boolean {
        if (process.env.MU_NO_TUI === "1") return false;   // see D4
        return Boolean(process.stdout.isTTY) &&
               Boolean(process.stdin.isTTY);
      }

    Both isTTY checks are required (F1-F4). MU_NO_TUI=1 is the
    only escape hatch (D4); we deliberately do NOT consult
    NO_COLOR, TERM=dumb, FORCE_COLOR, or TMUX. NO_COLOR turns
    colour off, not interactivity off; running mu inside tmux is
    the COMMON case (we want the TUI there). The four TTY
    overrides intentionally diverge from output.ts's colorEnabled
    cascade — they answer different questions.

D2. ACTIVATION MATRIX (confirmed; one correction noted below).

      stdout.isTTY  stdin.isTTY  --json   what runs
      ────────────  ───────────  ──────   ──────────────────────
      yes           yes          no       → TUI (ink dashboard)
      yes           yes          yes      → static `mu state --json`
      yes           no           no       → static `mu state` card
      yes           no           yes      → static `mu state --json`
      no            yes          no       → static `mu state` card
      no            yes          yes      → static `mu state --json`
      no            no           no       → static `mu state` card
      no            no           yes      → static `mu state --json`
      (any)         (any)        (any)    + MU_NO_TUI=1 → never TUI

    The `mu | less` case (stdout=pipe, stdin=tty, no --json) maps
    to row 5 → STATIC CARD in `less`. Confirmed, NOT an error.
    Rationale: piping `mu` somewhere has 30 years of muscle
    memory pointing at "give me text" (cf. `git log | less`,
    `kubectl get pods | grep`); erroring on it would surprise
    every Unix user. The static card already renders cleanly
    without a TTY stdout (cli-table3 + NO_COLOR cascade handle
    it). The TUI's keyboard surface is also pointless when stdout
    is going somewhere the user can't see anyway.

    The original 2x2 matrix in the spec is therefore CORRECT in
    its rows, but understates by one dimension: stdin.isTTY also
    matters and pulls the `mu | less` case (and the symmetric
    `something | mu` case if anyone ever did that) into the
    static path. The 8-row table above is the canonical form.

D3. CI / CRON / NON-INTERACTIVE.
    All such contexts (GitHub Actions runners, cron, `nohup`,
    `ssh host mu` without `-t`, systemd units, Docker exec
    without `-it`) leave at least one of stdout/stdin
    non-TTY. Most leave both. The predicate in D1 catches every
    one of them (F6). No additional CI-specific env-var sniffing
    (`CI`, `GITHUB_ACTIONS`) needed; in fact AVOIDING those is
    better — a developer running `mu` interactively inside a
    container that happens to have CI=1 set still gets the TUI.

D4. MU_NO_TUI ESCAPE HATCH — SHIP IT.
    Resolution: ship MU_NO_TUI=1.

    Argument FOR (which won):
    - Shell aliases / wrapper scripts that pre-process `mu`'s
      output (e.g. `alias mu='mu | tee ~/.local/state/mu/last'`
      or `function mu() { command mu "$@" | grep -v ...; }`).
      These ARE invoked from a TTY but want the static text card,
      not an ink screen they can't pipe.
    - tmux popup wrappers (`tmux display-popup -E 'mu'`) —
      stdin/stdout are TTYs, so the predicate would activate the
      TUI, but the user might want a quick text glance and `q`
      out. An env override is the cheapest way to opt that
      wrapper out without rewriting it as `mu state`.
    - Symmetry with NO_COLOR: a one-line env opt-out is the Unix
      idiom, costs us ~5 LOC, and is documented in one sentence
      in USAGE_GUIDE.

    Argument AGAINST (rejected):
    - "Just call `mu state`" — true, but only addresses the
      explicit-verb case. For bare `mu` (the muscle-memory orient
      call) and for `function mu` aliases that wrap the binary,
      the env var is strictly more ergonomic.
    - "Another env var is more surface" — accepted, but the
      surface is ONE bit (set or unset) and we already document
      MU_SESSION, MU_DB_PATH, MU_PI_COMMAND, MU_*_COMMAND,
      MU_FORCE_COLOR, MU_SEND_DELAY_MS, MU_SPAWN_LIVENESS_MS,
      MU_HUD_FORCE_SIZE, MU_IDLE_THRESHOLD_MS. One more is noise
      relative to that.

    Semantics: MU_NO_TUI=1 → never run the TUI, even when both
    isTTY checks pass. Any other value (including unset, "0",
    "false") → predicate falls through to the isTTY checks.
    Single-bit semantics, no parsing surface.

    Documentation: one line in USAGE_GUIDE under env vars,
    one line in `mu state --help`, mention in CHANGELOG.

    NOT shipping the inverse (MU_FORCE_TUI=1) — the TUI on
    a non-TTY stdout is broken-by-physics (escape codes in a
    pipe), so there's no legitimate use case for forcing it.

D5. ERROR PATH — option (a): print error + fall back to static.
    Specifically:
    - Wrap `await import("./tui/index.js")` and the subsequent
      `runTui(...)` call in a try/catch in cmdState.
    - Catch covers BOTH:
        (i)  dynamic-import failure (ink/react missing or
             corrupted in node_modules — extremely rare since
             they're hard deps, but possible after a partial
             `npm install`),
        (ii) `ERROR_RAW_MODE_NOT_SUPPORTED` thrown at first
             `useInput` mount (defence in depth: the predicate
             SHOULD have caught this, but stdin can in principle
             lose TTY status between the predicate check and the
             first input registration if something exotic
             happens).
    - On catch: write a one-line warning to stderr
        `mu: TUI unavailable (<reason>); falling back to static
         mu state. Set MU_NO_TUI=1 to suppress.`
      then continue with the existing static render path.
      Exit code stays 0 (the user got SOMETHING useful).

    Rationale for (a) over (b):
    - mu's design pillar is "every invocation is short-lived and
      gives the operator something useful" (CLAUDE/AGENTS:
      doctor / next-step blocks / static cards as the trust
      layer). Erroring out on a render-layer hiccup when we
      CAN print the canonical state card is hostile.
    - The fallback is identical to what the user would have got
      with MU_NO_TUI=1, so it's a known-good code path.
    - The stderr warning preserves the diagnostic signal — they
      know the TUI tried and failed, with a one-line escape
      hatch for if they want the warning to stop. Maps to the
      existing mu pattern of "do the right thing, but tell the
      user what you did" (cf. `mu task close --if-ready`'s
      `skipped: "not_ready"` shape).

    Exception: if BOTH the TUI AND the subsequent static render
    fail, the second exception is unhandled and propagates to
    handle() which exits non-zero. Standard pattern — no extra
    swallowing.

D6. WIRING SKETCH — exact code at the top of cmdState.

    The branch goes AT THE END of the human-render dispatch
    (after the --json short-circuit at L270-289 and after the
    --mission/--full mutex resolution), in place of (or just
    before, with the same fallthrough semantics) the existing
    renderFullMode call. Bare `mu` — which routes through
    cmdState with mission=true (cli.ts L688) — also gets the TUI
    branch, by design: bare `mu` is THE primary TUI entry
    point. Both `mu` and `mu state` activate it. The mission
    flag becomes irrelevant once we're in the TUI (the TUI does
    not have a "mission mode" — it's one dashboard).

    Concretely, replace L290-298 of src/cli/state.ts:

      // ── Human render: dispatch ──
      if (opts.mission === true) {
        renderMissionMode(perWs);
        return;
      }
      if (opts.hud === true) {
        await renderHudMode(db, perWs, eventLimit, multi, workstreams);
        return;
      }
      renderFullMode(perWs);

    with (post-HUD-deletion per audit_state_ts; --hud is gone):

      // ── Human render: dispatch ──
      // TTY-and-not-suppressed → ink TUI; otherwise the canonical
      // static card. The dynamic import keeps ink/react out of
      // the cold-start cost path (CI / cron / `mu --json | jq`).
      const { tuiSupported } = await import("./tui/index.js");
      if (tuiSupported()) {
        try {
          const { runTui } = await import("./tui/index.js");
          await runTui(db, { workstreams, eventLimit });
          return;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `mu: TUI unavailable (${reason}); falling back to ` +
            `static mu state. Set MU_NO_TUI=1 to suppress.
`
          );
          // fall through to static
        }
      }
      if (opts.mission === true) {
        renderMissionMode(perWs);
        return;
      }
      renderFullMode(perWs);

    Notes on the sketch:
    - TWO `await import("./tui/index.js")` calls look redundant
      but ESM module cache makes the second a no-op. Splitting
      the predicate import from the runner import means a
      MU_NO_TUI=1 user (or any non-TTY caller) NEVER pays the
      cost of loading the ink reconciler tree — only the tiny
      tuiSupported() function plus its imports (which should be
      zero ink imports; index.ts re-exports tuiSupported() from
      a sibling util file with no React deps. design_module_layout
      already plans this split).
    - If design_module_layout prefers a single barrel import,
      collapse to one `await import` and accept the ink load
      cost on every cmdState call. Recommend the split for the
      fast-path savings (CI calling `mu state --json` will be
      common in scripts).
    - `runTui(db, {workstreams, eventLimit})` signature is the
      one design_module_layout sketches; it consumes the same
      WorkstreamSnapshot loaded above. If `runTui` wants to do
      its own loading (more likely — it polls), then change the
      signature to `(db, {workstreams, eventLimit, opts})` and
      move the perWs build inside the TUI path. Pick during
      impl_tui_entry; either works.

================================================================
NEXT
================================================================
- impl_tui_entry: ship src/cli/tui/index.ts with the
  tuiSupported() helper (separate file from app.tsx so the
  predicate import doesn't drag react in) + the cmdState branch.
- design_module_layout follow-up: confirm the
  tuiSupported-vs-runTui split is acceptable; if not, collapse
  to one barrel and accept the ink cold-start cost on every
  invocation.
- USAGE_GUIDE update: add MU_NO_TUI=1 to the env vars table
  alongside MU_FORCE_COLOR / MU_SEND_DELAY_MS / etc.
- CHANGELOG: under v0.4 (or wherever the TUI lands), note
  MU_NO_TUI as a documented escape hatch and the
  TUI-unavailable stderr fallback line.
- design_tests follow-up: need three explicit test cases for
  this branch:
    (i)   stdout.isTTY=false, stdin.isTTY=true → static
    (ii)  MU_NO_TUI=1 with both isTTYs → static
    (iii) mocked import("./tui/index.js") that throws → stderr
          warning + static path runs
- Open: should `mu state` also accept an explicit `--no-tui`
  flag in addition to the env var? Recommend NO. The flag would
  only be useful in the same shell-alias case the env var
  already covers, and adding flag surface costs more than env
  surface (--help noise, completion files, doc duplication).

================================================================
VERIFIED
================================================================
- Read all locked-context notes (design_locked,
  design_module_layout, audit_state_ts) before drafting.
- Read cmdState dispatch L228-298 in full and confirmed branch
  ordering: --json wins (L270-289) before any human render, and
  the mission no-workstream short-circuit (L240-249) runs even
  earlier — both must be PRESERVED above the TUI branch.
- Read cli.ts L676-700 and confirmed bare `mu` and `mu state`
  both flow through cmdState (one dispatch site, exactly where
  this design lands).
- Read src/output.ts colorEnabled() L40-58 to anchor the env-
  precedence-then-isTTY pattern: MU_NO_TUI > stdout.isTTY &&
  stdin.isTTY mirrors NO_COLOR > MU_FORCE_COLOR > FORCE_COLOR
  > TMUX > stdout.isTTY-and-TERM!=dumb.
- Confirmed via grep that nothing in src/ already consults
  MU_NO_TUI; safe to claim the env var.
- Confirmed via grep that process.stdin.isTTY is not consulted
  anywhere in src/ today (only stdout.isTTY in output.ts and
  state.ts:506); this design adds the first stdin check.
- ink behaviour cited from README + ink/src/hooks/use-input.ts
  + ink/src/components/Stdin.tsx (general project knowledge,
  not freshly read — ink is not yet installed in the repo per
  scout-2's package.json audit). impl_tui_entry should re-
  verify the exact error constant string when ink lands.

================================================================
ODDITIES
================================================================
O1. The dual `await import("./tui/index.js")` pattern depends on
    the module exporting BOTH tuiSupported (cheap, no ink deps)
    and runTui (expensive, drags ink/react). If
    design_module_layout puts tuiSupported in a different file
    (say src/cli/tui/predicate.ts) the first import path
    changes. Either layout works; the SDK contract is
    "tuiSupported has no ink import in its transitive closure."
    Flag for impl_tui_entry.

O2. We deliberately do NOT distinguish `MU_NO_TUI=1` from
    `MU_NO_TUI=0`. Set or unset, period. This matches NO_COLOR's
    documented behaviour (https://no-color.org — "any
    non-empty value disables colour") rather than parsing
    truthy/falsy strings. Simpler code, fewer surprises.

O3. The error-path stderr line names MU_NO_TUI as the
    suppression mechanism. That's correct: if the TUI is failing
    repeatedly (e.g. corrupt ink install in a container image),
    the user wants a way to make the warning stop without
    fixing ink. MU_NO_TUI=1 short-circuits before the
    problematic import even runs.

O4. The matrix in the spec drew `mu | less` as "ambiguous —
    static card or error?" The correct answer (per F3 + 30
    years of Unix muscle memory) is unambiguously "static card."
    No prompt, no error, no smart detection — just print the
    text and let the pipe absorb it. The static card already
    works correctly when stdout is a pipe (cli-table3 +
    NO_COLOR cascade), so this is a pure wiring decision, not a
    rendering one.

O5. Bare `mu` (no verb) routes through cmdState with
    mission=true (cli.ts:688). This means the TUI is the default
    `mu` experience inside a tmux pane after this lands — which
    is exactly the locked decision (L1-total). The mission
    static card becomes the non-TTY fallback for bare `mu`,
    NOT the full static card. The wiring sketch above keeps
    that behaviour: when tuiSupported() returns false, we fall
    through to the existing renderMissionMode/renderFullMode
    branches based on opts.mission. No regression.

O6. We do NOT add a stdin-redirect-detection escape (e.g.
    "if user pipes input to mu, treat as scripted"). Nobody
    pipes data INTO mu today; if that ever changes,
    design_json_compat will need to revisit. For now,
    stdin.isTTY === false simply means "no interactive input
    surface available" → static card. Same answer either way.
```

### #2 by "designer-2", 2026-05-11T11:07:39.626Z

```
CLOSE: fallback matrix + wiring sketch in note
```
