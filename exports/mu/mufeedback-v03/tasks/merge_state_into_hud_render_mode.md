---
id: "merge_state_into_hud_render_mode"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: null
created_at: "2026-05-10T08:14:33.966Z"
updated_at: "2026-05-10T08:44:28.016Z"
blocked_by: []
blocks: []
---

# feat: merge mu state + mu hud — one verb, render mode (state = JSON-first / structured; hud = dynamic-table-fit-pane)

## Notes (2)

### #1 by π - mu, 2026-05-10T08:15:38.139Z

```
Merge mu state + mu hud into one verb; render mode is the only difference.

═══ THE OBSERVATION (operator) ═══

mu state and mu hud do almost identical things. They read the same SDK surface (listLiveAgents + getParallelTracks + listReady + listInProgress + listBlocked + listRecentClosed + listWorkspaces + listLogs). They render to the same operator. The differences are pure RENDER-LAYER:

  state: JSON-first. Sections rendered top-to-bottom, no width-fit, no row-cap; each section gets its full table. Designed for one-shot 'what does an LLM look at first?'.
  hud:   Dynamic table layout that fills the terminal/pane height + width. Sections rendered greedy top-down; each section deducts its line cost from the budget; truncated tables get a `… +N more` footer. Designed for `watch -n 5 mu hud` / `tmux display-popup`.

Same data; different presentation strategy. That's a flag, not a verb.

═══ THE TARGET SHAPE ═══

  mu state                          # default render mode (today's mu state output)
  mu state --hud                    # dynamic-fit render (today's mu hud output)
  mu state --json                   # structured machine view (today's mu state --json + mu hud --json unified)

  mu hud                            # alias / sugar for `mu state --hud`. Keep for back-compat (1-line wrapper).
                                    # OR drop entirely (pre-1.0; pre-promotion). DECISION below.

The --hud flag (boolean) toggles the renderer. Other flags shared between today's verbs:
  -w, --workstream <names...>      (variadic per cli_audit_plurality_uniformity; works in both modes)
  --all                            (every workstream)
  --events <n> / -n <n>            (recent events cap; today's --events on state, -n on hud — UNIFY to --events for clarity; -n stays as a short alias on hud-mode for the dynamic-layout muscle memory)
  --json                           (machine view; orthogonal to --hud)

═══ DEEP DIVERGENCES TO RECONCILE ═══

state has, hud lacks:
  - blocked tasks section
  - recent-closed tasks section
  - workspaces section (with staleness decoration)
  - orphan agents listing
  - bare `mu` (no -w) discovery mode → list workstreams that exist + how to pick one (cmdMission's no-workstream branch)

hud has, state lacks:
  - dynamic budget per section (greedy fit; truncate with footer)
  - cross-workstream union with leading workstream column (post-hud_multi_workstream)
  - per-section truncate footer ("… +N more (<verb>)")
  - per-pane width-aware column sizing

Strategy: the merged verb's DEFAULT mode (--hud OFF) renders all of state's sections top-to-bottom (no budget, no truncate); --hud ON enables the budget fit AND switches to hud's section ordering (header/agents/ready/in-progress/tracks/recent — drops blocked/recent-closed/workspaces/orphans because those don't fit a glance-card; if --hud users want them, drop --hud).

═══ JSON SHAPE UNIFICATION ═══

Today's --json shapes:
  state --json: { agents, orphans, tracks, ready, blocked, inProgress, recentClosed, workspaces, recent }
  hud --json:    { workstreamName, summary, agents, orphans, tracks, ready, inProgress, recent }
  hud --json multi: { workstreams: [<above per ws>] }

Unified:
  state --json (single-ws): { workstreamName, agents, orphans, tracks, ready, blocked, inProgress, recentClosed, workspaces, recent }
  state --json (multi):     { workstreams: [<above>] }   # mirroring hud's multi shape
  state --hud --json: same as above (--hud is a render flag; doesn't change machine view)

Back-compat: today's hud --json consumers (tmux status-bar pipes) get the SAME shape they read today, just with extra fields they ignore. Today's state --json consumers same.

═══ DECISION 1: keep mu hud as alias or drop ═══

Option A (keep alias): mu hud → mu state --hud is a 1-line wrapper. Pre-1.0; cheap; preserves muscle memory.
Option B (drop hud): rm mu hud entirely. Operator types `mu state --hud` instead. Cleaner; one fewer verb in --help.

  RECOMMEND OPTION A. The aliasing cost is trivial; the muscle-memory + tmux-config-line ('display-popup -E "mu hud -w X"') break is non-trivial.

═══ DECISION 2: bare mu mission-control ═══

Today bare `mu` (no verb) calls cmdMission — a STRIPPED state card (5-col agents + tracks + ready). Two sub-decisions:

  (a) Bare mu maps to mu state (full card)? Or stays a separate stripped card?
  (b) Bare mu's no-workstream discovery branch (list every ws + how to pick one)?

  RECOMMEND: bare `mu` maps to `mu state` (full card; same renderer). The stripped 5-col version was always a 'glanceable' compromise; full-card-by-default is more predictable. The no-workstream discovery branch stays — but in mu state's cmd, gated on `if workstream === null`.

  This collapses cmdMission into cmdState entirely. Net 50+ LOC reduction.

═══ DELIVERABLE ═══

CONSOLIDATE:
  src/cli/state.ts: become the unified renderer. Add --hud branch that calls today's hud render. Drop cmdMission (or keep as a 1-line forward to cmdState).
  src/cli/hud.ts: become a ~30-LOC shim:
    - exports cmdHud(db, opts) that just calls cmdState(db, { ...opts, hud: true }).
    - keeps the wireHudCommands() registration so `mu hud` parses the same option set as `mu state` (auto-injects --hud).
  Or alternatively: dissolve src/cli/hud.ts entirely and inline the dynamic-fit renderer into src/cli/state.ts as a function `renderHudMode(...)`. Cleaner; one file.

STRUCTURE:
  src/cli/state.ts:
    - cmdState(db, opts: { workstream?: string|string[]; all?: boolean; json?: boolean; hud?: boolean; events?: number; lines?: number })
    - if hud mode: call renderHudMode(...) (today's dynamic-fit renderer; lifted out of src/cli/hud.ts)
    - else: call renderStateMode(...) (today's top-to-bottom renderer)
    - both modes share the data-load step (already shared today via the same SDK calls)

NEW SHARED HELPERS (extract from both files):
  - loadWorkstreamData(db, ws, eventLimit) → { view, tracks, ready, inProgress, blocked, recentClosed, workspaces, recent }  (state's full set; hud-mode just renders a subset)
  - The cross-workstream multi-loader that hud already has

CLI WIRING:
  src/cli.ts:
    - mu state command: gain --hud flag; reuse the hud's option set (--all, -n, etc.).
    - mu hud command: kept as a thin alias that injects --hud=true into cmdState.
    - bare `mu` (no verb): forward to cmdState with no workstream auto-resolved.

TESTS:
  - test/state.test.ts (extend) and test/hud.test.ts (extend / consolidate). The two test files cover the same data paths; merge into test/state-render.test.ts with mode-keyed it() blocks.
  - Assert: mu state renders all 7 sections; mu state --hud renders the budget-fit subset; both modes' --json have the same shape.
  - Assert: mu hud (alias) produces byte-identical output to mu state --hud.
  - Assert: cross-workstream works in both modes.

DOCS:
  - skills/mu/SKILL.md: drop mu hud from the verb list (or list as alias); keep mu state. Update the 'state is the source of truth' guidance.
  - docs/USAGE_GUIDE.md: rewrite the state + hud sections as one (mu state with the --hud renderer note).
  - CHANGELOG.md (v0.3 unreleased): one-line under either Changed or Added.

═══ SCOPE ═══

  src/cli/state.ts: ~+150 LOC (absorbs hud's renderer + dynamic-budget logic).
  src/cli/hud.ts: ~-720 LOC (becomes a 30-LOC shim, OR deleted entirely with its renderer inlined into state.ts).
  Net: ~-570 LOC src/, ~+50 LOC test consolidation.

═══ ANTI-FEATURES ═══

  - DON'T add a 'render style' flag with N enum values ('--style mission|state|hud|...'). Two modes is the right number; --hud boolean is the cleanest surface.
  - DON'T let --hud change the data SET (just the render strategy). State's sections are all relevant; hud-mode just shows a subset because of pane height. Operator drops --hud to get the rest.
  - DON'T deprecate mu hud with a runtime warning. Either keep as alias (option A) or drop hard (option B); pick one.
  - DON'T merge into mu state if it pushes any single file past 1500 LOC. Use the helper-extract pattern.

═══ PROMOTION ═══

  - Real-user friction: filed by operator after observing the duplication ('hud is really a flag to state to render differently').
  - Substrate ready: both verbs already share most of the SDK surface; the merge is a refactor of the rendering layer + the wiring.
  - Fits in <300 LOC: it's actually a NET removal (~-570 LOC); fits the anti-feature pledge by tightening the surface, not growing it.

PROMOTE for v0.3.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close merge_state_into_hud_render_mode -w mufeedback-v03 --evidence 'mu state + mu hud merged; --hud flag selects renderer; net -500 LOC; tests + docs'
```

### #2 by π - mu, 2026-05-10T08:16:49.777Z

```
DECISIONS (operator):

═══ DECISION 1: drop mu hud verb entirely (option B) ═══

Drop `mu hud` from the CLI. The behavior moves to `mu state --hud`. Pre-1.0; no migration shim; no deprecation warning.

Operator's tmux pane configs that today say `tmux display-popup -E 'mu hud -w X'` need to update to `mu state --hud -w X`. Document the swap in CHANGELOG (### Removed) so anyone with a config gets a one-line fix.

═══ DECISION 2: bare `mu` is an alias for `mu state` with the stripped-down view ═══

Bare `mu` (no verb) keeps today's stripped-down render — agents + orphans + tracks + ready (5 columns wide, glanceable). NOT the full card. Reasoning: bare `mu` is the muscle-memory orient call ('what's going on?'); a full card with blocked + recent-closed + workspaces + recent-events is too much for that intent.

Implementation: add a third render mode to cmdState beyond default + --hud:
  --mission                       # bare-mu's stripped view; not a default-set flag, but the mode bare `mu` invokes internally
The flag is internal-use; bare `mu` injects it. Operators can also call `mu state --mission` directly if they want the stripped card explicitly.

So the consolidated verb has THREE render modes:
  mu state                        # default: full card (today's mu state)
  mu state --hud                  # dynamic-fit budget renderer (today's mu hud)
  mu state --mission              # stripped 5-col glance card (today's bare mu)
  bare `mu`                       # alias for `mu state --mission`

═══ JSON SHAPE under --mission ═══

The --mission view's --json includes only the surfaced sections (agents, orphans, tracks, ready). NOT the full state shape (no blocked / recentClosed / workspaces / recent). Mirror today's bare-mu --json output so consumers don't break.

═══ NO RUNTIME WARNING / DEPRECATION ═══

mu hud just disappears. The error from `mu hud` becomes commander's standard 'unknown command' (exit code 1 already). Operators with stale configs see it once, swap to `mu state --hud`, move on.

═══ NEW VERB COUNT ═══

Before: mu state, mu hud, bare mu (3 verbs / call modes)
After:  mu state (with --hud and --mission flags), bare mu (alias) (1 verb + 1 alias + 2 flags)

CHANGELOG goes under ### Removed: "mu hud removed; behavior moved to mu state --hud. Update tmux configs accordingly."
CHANGELOG goes under ### Changed: "mu state gains --hud and --mission render flags. Bare `mu` (no verb) is now an alias for `mu state --mission` (today's stripped 5-col glance card)."

═══ DISPATCH PRIORITY ═══

Land AFTER the in-flight task_list_multi_status_union, task_wait_reconcile_dead_panes, and workspace_create_typed_no_agent_error workers — those touch unrelated files but the post-pick verify cycle is easier without simultaneous large refactors. This task touches src/cli/state.ts + src/cli/hud.ts + src/cli.ts + tests/state*.ts + tests/hud*.ts; no overlap with the in-flight three.
```
