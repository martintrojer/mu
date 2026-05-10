---
id: "hud_multi_workstream"
workstream: "mufeedback-v03"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: null
created_at: "2026-05-10T05:32:27.270Z"
updated_at: "2026-05-10T06:01:10.882Z"
blocked_by: ["cli_audit_plurality_uniformity"]
blocks: []
---

# feat: mu hud accepts multiple -w; status table gains 1 row/ws; other tables gain a workstream column (only if N>1)

## Notes (2)

### #1 by π - mu, 2026-05-10T05:33:40.569Z

```
mu hud — accept multiple workstreams; render compactly when N>1.

═══ THE GAP ═══

Today: `mu hud -w X` is single-workstream. Operator running multiple parallel workstreams (the v0.2 wave was 2 simultaneous: mufeedback + roadmap-v0-2; the v0.3 wave is 2: mufeedback-v03 + roadmap-v0-3) has to:
  - flip between two `watch -n 5 mu hud -w X` panes, OR
  - eyeball them sequentially.

There's no "show me everything" view. mu was designed around per-workstream isolation but the operator/orchestrator routinely supervises across the whole machine.

═══ THE SHAPE (operator-stated) ═══

  mu hud -w mufeedback-v03 -w roadmap-v0-3
  mu hud                                # (default: every workstream on this machine)

Single -w (or zero, resolving to one): TODAY'S BEHAVIOR EXACTLY (no regression).

Multiple -w (or zero resolving to N≥2 workstreams):
  - The first table (workstream-summary header) gains ONE ROW PER WORKSTREAM.
    Today's row shape (workstream | ready | in-progress | tracks | agents | status-histogram) becomes one such row per workstream. Same columns; different first cell. Cost: roughly +1 line per extra workstream (each table row in cli-table3 is ~2 lines with the borders, but they share the top/bottom borders so it's ~2N+1 total).
  - Every OTHER table (ready / in-progress / tracks / recent events) gains ONE NEW LEADING COLUMN: workstream.
    The new column is FIRST. Color it bold-cyan to match the header treatment.
    Sort rows BY workstream first, then by the existing intra-workstream sort key (ROI for ready, recency for events).
  - The new workstream column ONLY APPEARS WHEN N>1. Single-workstream call retains today's exact column shape (no width regression for the common case).

═══ FLAG SHAPE ═══

`-w, --workstream <name>` is currently single-valued via commander. Per AGENTS.md commander gotcha: use `program.command.option(...).action(function() { this.opts() })` etc. Two ways to gain plural:

  Option A: -w accepts a comma-separated list. `mu hud -w X,Y,Z`. Simple; matches existing -w semantics elsewhere being single. NO changes to other verbs (only hud parses CSV).
  Option B: -w can be REPEATED. `mu hud -w X -w Y -w Z`. Commander supports `.option('-w, --workstream <name...>', ...)` for variadic; but variadic interacts badly with mu's universal -w on every other verb. Risky.
  Option C: a NEW flag `-W, --workstreams <list>` (comma-separated) only on hud. -w stays single (back-compat). Cleanest separation.

  RECOMMEND C. -w stays exactly what it is today (single, with the resolution chain explicit > $MU_SESSION > tmux session). New: `-W mufeedback,roadmap-v0-2` OR a bare `mu hud --all` to mean "every workstream".

  Reject A: silently changing -w semantics on one verb is a footgun — operator expecting -w X to scope tasks gets a CSV split.

  Final shape:
    mu hud                       # today: resolves -w via env/tmux. one ws.
    mu hud -w X                  # today: explicit single ws.
    mu hud -W X,Y                # NEW: explicit multi-ws (comma-separated).
    mu hud --all                 # NEW: every workstream on this machine.
    Mixing -w + -W: error (mutually exclusive).
    Mixing -W + --all: error (mutually exclusive).

═══ EMPTY / EDGE CASES ═══

  - `-W` resolving to an empty list (e.g., `-W ,,`): error "no workstreams specified".
  - One -W entry that doesn't exist: error WorkstreamNotFoundError, listing the bad entry. (Strict — don't silently skip; you might typo "mufeedbck" and get half a HUD.)
  - --all with zero workstreams in the DB: print today's "(no workstreams)" empty hint.
  - --all with one workstream in the DB: render in single-ws mode (no extra column). Auto-collapses.
  - When N>1, the recent-events default of 10 lines is per-bucket; preserve the existing --lines flag semantics (cap on the union list).

═══ JSON SHAPE ═══

Today: --json emits one object with keys (workstreamName, summary, agents, orphans, tracks, ready, inProgress, recent).

For N=1, KEEP that exact shape (back-compat for any consumer like a tmux status-bar pipe).

For N≥2:
  {
    "workstreams": [
      { "workstreamName": "mufeedback-v03", "summary": {...}, "agents": [...], ... },
      { "workstreamName": "roadmap-v0-3", "summary": {...}, "agents": [...], ... }
    ]
  }

The N=1 / N≥2 shape divergence is a contract decision. ALTERNATIVE: always wrap in {workstreams: [...]} and bump JSON consumers. Pick:
  - If we treat --json output as a contract: KEEP back-compat (top-level keys for N=1; nested array for N≥2). Operator opts in to the new shape by adding -W or --all.
  - If we don't: always nest. Cleaner; one consumer change.

  RECOMMEND back-compat (N=1 unchanged, N≥2 wrapped). The operator's `tmux display-popup -E 'mu hud --json | jq ...'` shouldn't break on a mu upgrade if they didn't ask for the new flag.

═══ HUMAN-RENDER LAYOUT BUDGET ═══

The greedy top-down budget in cmdHud (src/cli/hud.ts) deducts each section's line count from `remaining`. With N>1:

  1. Workstream-summary table grows from 1 data row to N rows. Cost: 2N + 1 (vs today's 3).
  2. Each subsequent table gains a workstream column. Same row count; same line cost; just an extra column squeezing the title/payload column slack.

Greedy budget unchanged at the algorithm level: just wider top section. If the pane is too narrow to fit the new column, the existing truncate() helper handles the squeeze (mirrors formatTaskListTable today).

═══ DATA AGGREGATION ═══

For each table in the multi-workstream case, the SDK calls become per-workstream loops:

  for (const ws of workstreams) {
    const view = await listLiveAgents(db, { workstream: ws, mode: "status-only" });
    const tracks = getParallelTracks(db, ws);
    const ready = listReady(db, ws).sort(byRoiDesc);
    const inProgress = listInProgress(db, ws);
    const recent = listLogs(db, { workstream: ws, kind: "event", limit });
    perWs.set(ws, { view, tracks, ready, inProgress, recent });
  }

Then for each table:
  - Workstream-summary: render N rows.
  - Ready / in-progress / tracks: union all rows; sort by (workstream, intra-key); prepend workstream column.
  - Recent events: union; sort DESC by created_at (cross-workstream timeline view — so the operator sees what happened most recently across the whole machine); prepend workstream column.

Note: the recent-events table is the most semantically interesting in multi-mode. It becomes a cross-workstream timeline; the existing kind=event filter keeps it pruned.

═══ CLAIM SCOPE: ONLY hud (do NOT touch other verbs) ═══

This is a hud-only change. Do NOT:
  - generalise -w to multi-valued elsewhere (would break the single-name assertion in many SDKs).
  - touch the resolveWorkstream helper's signature (still returns one name when called from non-hud verbs).
  - add a new --workstreams flag to anything other than hud.

═══ SCOPE / SIZE ESTIMATE ═══

  src/cli/hud.ts: ~+200 LOC (new resolution helper for the -W / --all flags; per-workstream data loop; multi-row workstream-summary table; column-prepending wrapper around the existing table renderers).
  test/hud-cli.test.ts: ~+150 LOC (new cases: N=2 -W, N=3 --all, mixing flags errors out, JSON shape divergence at the boundary, empty -W errors, partial -W where one workstream doesn't exist).
  docs/USAGE_GUIDE.md: short paragraph on multi-workstream HUD.
  skills/mu/SKILL.md: update the hud bullet.

Hard cap: src/cli/hud.ts is at 544 LOC; +200 keeps it well under 1500.

═══ ANTI-FEATURES ═══

  - No interactive workstream-picker. mu hud is print-once-and-compose by design.
  - No per-workstream colour theming. Bold-cyan workstream column for every table; consistent with single-mode header.
  - No collapsing of repeating workstream cells (e.g., "second row in mufeedback skips the cell"). Verbose, copy-paste-friendly is the right call for a HUD that's piped into watch/tmux/jq.
  - No cross-workstream task dependency rendering. Cross-workstream edges are forbidden by mu's invariants; the union view is purely flat.
  - No --workstreams alias on every other verb. Hud is the one read-only multi-tenant view; other verbs stay scoped.

═══ PROMOTION ═══

  - Real-user friction: hit by operator running v0.3 wave (this filing, plus the v0.2 wave was 2 ws, plus the inflight wave is 2 ws). ≥2 hits → ✅
  - Substrate: existing per-workstream HUD code is the per-row template; the multi-mode wrapper is straightforward iteration + column-prepend.
  - Fits in <300 LOC: yes (~200 SDK + ~150 tests + small doc touches).

PROMOTE for v0.3. Standalone (no dependency on the archive feature); could ship at any phase boundary. Lives in mufeedback-v03 (friction-filing workstream), not roadmap-v0-3 — it's a friction observation, not part of the planned archive feature.
```

### #2 by worker-2, 2026-05-10T05:43:40.545Z

```
CONVENTION SETTLED (per cli_audit_plurality_uniformity): use commander variadic on the multi-workstream flag — declare as `--workstreams <names...>`, run values through parseCsvFlag(). Operator gets repeat OR comma-separate OR both for free. Drop -W; drop --all (or keep --all as a separate boolean if useful, but it is NOT needed for the multi-flag mechanism).
```
