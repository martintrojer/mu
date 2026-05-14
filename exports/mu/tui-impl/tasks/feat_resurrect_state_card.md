---
id: "feat_resurrect_state_card"
workstream: "tui-impl"
status: CLOSED
impact: 95
effort_days: 0.3
roi: 316.67
owner: null
created_at: "2026-05-11T13:13:29.690Z"
updated_at: "2026-05-11T13:39:48.126Z"
blocked_by: []
blocks: ["bug_card_header_inset", "feat_more_cards_umbrella", "feat_popup_enter_drill", "feat_responsive_layout", "feat_status_bar", "feat_tui_multi_workstream", "t42_vision", "t43_roadmap", "t45_changelog", "t46_usage_guide", "tui_impl_complete"]
---

# FEAT: resurrect old mu state card; TUI moves behind --tui flag

## Notes (3)

### #1 by "π - mu", 2026-05-11T13:14:15.243Z

```
SCOPE CORRECTION (post-Wave-3 retrospective).

The plan (docs/plans/2026-05-11-interactive-tui.md, Wave 3 Task 15)
moved the TUI to be the DEFAULT for `mu state` on a TTY:

    if (process.stdout.isTTY && process.stdin.isTTY && !opts.mission && !multi) {
      const { runTui } = await import("./tui/index.js");
      ...
    }
    return renderFullMode(perWs);  // static fallback only on non-TTY

This was wrong. The brainstorm only committed to removing `mu state
--hud`, not to demoting `mu state` itself. The static full card is
the single most useful at-a-glance view in mu and an important
reference surface for new users; making it conditional on isTTY
hides it for the dominant interactive case.

NEW MODEL:

    mu state            → static full card (legacy behaviour, ALWAYS)
    mu state --tui      → interactive TUI (new opt-in flag)
    mu state --json     → JSON (unchanged)
    mu state --mission  → mission card (unchanged; bare `mu` alias)
    mu                  → mission card alias (unchanged)
    mu state --hud      → still removed; --tui takes its slot conceptually

WHAT THIS TASK DOES:

1. src/cli/state.ts cmdState dispatch:
   - Drop the `process.stdout.isTTY && process.stdin.isTTY && !mission && !multi`
     branch that auto-routes to TUI.
   - Add an explicit `opts.tui` branch: when `--tui`, lazy-import
     ./tui/index.js and run; otherwise fall through to renderFullMode
     unchanged.
   - Keep --json and --mission branches unchanged.
   - --tui + --json mutually exclusive (TUI is render-only).
   - --tui + --mission mutually exclusive (mission is a static glance card).
   - --tui + multi-ws → error (TUI is single-ws today; same as the
     existing dispatch).

2. wireStateCommands: add `--tui` option with description
   "interactive TUI (rounded-border dashboard with cards + popups)".
   Update the verb description to mention --tui.

3. test/state-dispatch.test.ts:
   - Update the existing test that asserts non-TTY hits static (now
     trivial: --tui is the only TUI-enter flag).
   - Add a test for `--tui` + non-TTY: should still try to mount ink
     and either work or error cleanly (ink itself handles isTTY=false
     by writing to stdout sans raw-mode; for v0 we can document that
     --tui in a pipe is undefined behaviour).
   - Add tests for --tui + --json mutual exclusion, --tui + --mission
     mutual exclusion.

4. test/state-render.test.ts: existing tests against `mu state -w ws`
   should NOW return to passing as the static full card (they already
   were, since runCli pipes stdout → isTTY=false → static. So this
   change is effectively a no-op for the existing test suite — the
   default path is the same path tests have been hitting all along).

5. docs/USAGE_GUIDE.md (Wave 9 Task 46): update the new TUI section to
   say --tui is opt-in. The "what changed from --hud" callout still
   stands but the new framing is "--hud removed; --tui added as the
   interactive replacement; static `mu state` unchanged."

6. CHANGELOG.md (Wave 9 Task 45): under Removed: keep --hud removal.
   Under Added: `mu state --tui` (was previously "interactive TUI as
   the default on TTY"). Under Changed: nothing (the static card is
   unchanged).

7. docs/VISION.md amendment (Wave 9 Task 42): the "interactive readers"
   exception class still applies, but the activation predicate
   simplifies — `--tui` flag instead of TTY auto-detect. Update the
   bullet that lists "TTY-gated, with a static fallback" to "Opt-in
   via the --tui flag; the static card is always available."

8. docs/ROADMAP.md amendment (Wave 9 Task 43): pledge text unchanged
   (the ink-confined-to-TUI-subtree pledge stands; only the activation
   predicate changes).

9. docs/plans/2026-05-11-interactive-tui.md: add a one-line correction
   note in the Overview section pointing at this task.

WHY THIS MATTERS BEFORE LANDING:
- The current default-to-TUI dispatch makes `mu state` invisible to
  every TTY user without a flag to recover it. The static card is
  load-bearing for new users, screenshots, docs, "what does an LLM
  look at first" — none of which want a long-running ink process.
- --tui as opt-in matches lazygit/htop/k9s convention (you invoke
  the TUI explicitly; you don't get it as a side effect of the wider
  CLI verb).
- This is the kind of decision the design phase should have caught;
  promotion criterion 1 ("real friction in real use") fired on the
  first manual smoke. Cheap to fix now, expensive after CHANGELOG
  ships.

ESTIMATED EFFORT: 0.3 days (small; mostly cmdState + 2-3 tests + 4
doc tweaks). All inside the existing TUI subtree boundaries.
```

### #2 by "π - mu", 2026-05-11T13:26:18.131Z

```
IMPLEMENTATION HINT (post-grooming):

The old static card already exists in the codebase and is fully
intact — it's just been demoted from default to "fallback when the
TUI branch declines." The static-card render path is:

  src/cli/state.ts L242 renderFullMode(perWs)
                     L249 renderFullCard(d)
                     L329 renderMissionMode(perWs)

renderFullMode is what `mu state -w A,B` already produces today
(stacked per-ws cards). The "static card is gone" perception is an
artefact of the dispatch: cmdState branches into the TUI on TTY +
single-ws + !mission + !json BEFORE renderFullMode is reached.

THE ENTIRE FIX IS A 5-LINE CHANGE in cmdState:

  Today (src/cli/state.ts L222-229):
    if (process.stdout.isTTY && process.stdin.isTTY &&
        opts.mission !== true && !multi) {
      const { runTui } = await import("./tui/index.js");
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: …");
      await runTui(db, { workstream: single.workstreamName });
      return;
    }

  After:
    if (opts.tui === true) {
      // Mutual-exclusion guards:
      if (opts.json === true)    throw new UsageError("--tui and --json are mutually exclusive");
      if (opts.mission === true) throw new UsageError("--tui and --mission are mutually exclusive");
      if (multi)                 throw new UsageError("--tui currently supports a single workstream; pass exactly one -w");
      const { runTui } = await import("./tui/index.js");
      const single = perWs[0];
      if (single === undefined) throw new Error("invariant: workstreams non-empty");
      await runTui(db, { workstream: single.workstreamName });
      return;
    }

Then the existing fall-through to renderMissionMode / renderFullMode
runs unchanged, which restores the legacy behaviour for `mu state`,
`mu state -w A,B`, `mu state --mission`, etc.

WIRING SIDE:
  Add to wireStateCommands (src/cli/state.ts L351 area):
    .option("--tui", "interactive TUI (rounded-border dashboard with cards + popups)")
  Add to StateOpts (L154):
    tui?: boolean;

DELETE:
  - The current `process.stdout.isTTY && ...` auto-route block.
  - The supporting test in test/state-dispatch.test.ts that asserts
    "TTY + no flags hits the TUI dynamic-import" — replace with
    "TTY + no flags hits the static full card; --tui hits the TUI."

The multi-ws-via-TUI case is its own follow-up
(feat_tui_multi_workstream); for this task we ship the simplest
possible "one workstream, --tui flag" experience and let the legacy
multi-ws stacking work via the static card.

Net effect:
  mu state              → static full card (was the default before;
                          now back to being the default)
  mu state -w A,B       → static stacked per-ws cards (already works
                          today via the !multi guard; unchanged)
  mu state --mission    → mission card (unchanged)
  mu state --json       → JSON (unchanged)
  mu state --tui        → interactive TUI (NEW; this task)
  mu state --tui --json → UsageError (NEW)
  mu state --tui -w A,B → UsageError (NEW; relaxed by feat_tui_multi_workstream later)
  mu                    → mission card (unchanged)
```

### #3 by "worker-3", 2026-05-11T13:39:48.126Z

```
CLOSE: commit 4044096: cmdState now requires --tui to enter the ink TUI; static `mu state` is the default. Mutual-exclusion guards for --tui + --json/--mission/multi-ws. Tests updated; 4 greens clean.
```
