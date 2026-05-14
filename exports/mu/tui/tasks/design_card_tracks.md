---
id: "design_card_tracks"
workstream: "tui"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: "designer-2"
created_at: "2026-05-11T10:45:07.059Z"
updated_at: "2026-05-11T11:15:40.508Z"
blocked_by: ["audit_state_ts", "design_card_iface"]
blocks: ["design_complete", "design_popup_tracks"]
---

# Design Tracks card: parallel-track tree (port from current state.ts)

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:15:38.021Z

```
FILES:
- read: src/cli/state.ts L688-732 (formatHudTracksTable — to be deleted)
- read: src/cli/state.ts L540-595 (formatHudAgentsTable — colour/idiom reference)
- read: src/cli/format.ts L216-228 (formatTracks — static fallback; the
  one-liner-per-track this card replaces in the TUI)
- read: src/cli/format.ts L29-40 (STATUS_COLORS / statusIcon — palette source)
- read: src/tracks.ts (Track type: roots, taskIds, readyCount; getParallelTracks)
- read: src/tasks.ts L83-96 (TaskRow.impact/effortDays)
- read: src/cli.ts L319-322 (byRoiDesc / roi helper)
- read: design_locked / design_card_iface / design_poll_loop / design_sdk_seam /
        audit_state_ts notes (full prior context)
- (no shell mutations; design-only role)

COMMANDS:
- mu task show design_card_tracks -w tui
- (zero edits; ~30 min)

FINDINGS:

1. Existing renderings to dethrone:
   - Static fallback (src/cli/format.ts:formatTracks):
       Track 1: design_complete (31 tasks, 1 ready, merged)
     One line per track. Plain. No status counts beyond `readyCount`.
   - HUD (src/cli/state.ts:formatHudTracksTable, dies with --hud):
       multi-col: [ws?] track N | goal_names (cyan) | N tasks | N ready | track|merged
     Uses pc.cyan for the goal column, pc.green for readyCount when >0
     and pc.dim for "0", pc.yellow for "merged", pc.dim for "track".
     This is the colour idiom to MATCH (per brief §6 cognitive-load rule).
   - Both renderings expose only what `Track` carries today: roots,
     taskIds.size, readyCount. Neither shows in-progress, ROI, or
     diamond-merge count of contributing goals.

2. Seam check (per design_card_iface §1 + design_sdk_seam):
   - The card consumes `snapshot.tracks: Track[]` (already in
     WorkstreamSnapshot — no seam change for the basic counts).
   - To render in_progress / ROI per track WITHOUT new SDK exports,
     the card joins `snapshot.tracks[i].taskIds` against
     `snapshot.inProgress` and `snapshot.ready` — both already in
     WorkstreamSnapshot. Pure card-side derivation; no async; O(tracks
     × ready+inProgress). Sub-µs at any realistic size.
   - There is NO `closed` count derivable from the snapshot today —
     `recentClosed` is a tail of length 5, not a per-track histogram.
     Showing "closed" honestly per track requires a new SDK call
     (e.g. `listTasks(db, ws, { status:"CLOSED" })` then intersect),
     OR a Track-side enrichment (see §3 SEAM EXTENSION).
   - The brief explicitly asks for "total, ready, in_progress, closed".
     For the CARD I substitute `closed → other` (total − ready −
     inProgress), which is a precise card-side derivation and reads
     well as "how much of this track is parked/blocked/done".
     The breakdown closed-vs-blocked-vs-deferred is the POPUP's job.

3. SEAM EXTENSION (proposal, NOT required for v0 to ship):
   - Add `statusCounts: Readonly<Record<TaskStatus, number>>` to
     `Track` in src/tracks.ts. getParallelTracks already loads every
     prerequisite TaskRow via `getPrerequisites`; the histogram is one
     extra Map.set in the existing scan loop. ~10 LOC, zero new SDK
     surface.
   - Two callers ≥ promotion bar: (a) this Tracks card (would let it
     show closed/blocked precisely without a join), (b) the Tracks
     popup tree (design_popup_tracks) needs the same histogram for
     its per-track header line.
   - DEFERRED: I do NOT block on it. v0 card uses the join. Filed as
     a NEXT for design_popup_tracks to confirm and either implement
     in tracks.ts at popup-design time OR re-do the join card-side.

DECISION:

================================================================
TRACKS CARD — design contract
================================================================

Subject id     : "tracks"
Card.id        : 2 (per design_card_iface §3 R5)
Open key       : digit 2 toggles dashboard visibility; Shift+2 (`@`)
                 opens TracksPopup (drill-down; design_popup_tracks).
minWidth       : 48 cols (5 columns + 1 truncated goals column;
                 below 48, the goals column has < 8 cols and the row
                 reads as garbage — dashboard hides per Card contract).
minHeight      : 4 rows (header + ≥1 data row + truncation footer).

────────────────────────────────────────────────────────────────
1. PER-ROW FORMAT (denser than the static one-liner)
────────────────────────────────────────────────────────────────

Six visual cells, in order, single ink Box per row:

  ▸  CYAN_BOLD(N)   GLYPH   CYAN(goal_a, goal_b)…   12t   3R 1P 8o   ROI 110

  ┌────┬────┬─────┬──────────────────────────┬─────┬────────────┬─────────┐
  │ ▸  │ N  │ ⋈/· │ goal_name(s) (truncated) │ 12t │ 3R 1P 8o   │ ROI 110 │
  └────┴────┴─────┴──────────────────────────┴─────┴────────────┴─────────┘
    │    │    │             │                  │        │            │
    │    │    │             │                  │        │            └─ ROI
    │    │    │             │                  │        │              sum
    │    │    │             │                  │        │              over
    │    │    │             │                  │        │              ready
    │    │    │             │                  │        │              tasks
    │    │    │             │                  │        │              in this
    │    │    │             │                  │        │              track
    │    │    │             │                  │        └─ counts
    │    │    │             │                  │           R=ready,
    │    │    │             │                  │           P=in-progress,
    │    │    │             │                  │           o=other (total
    │    │    │             │                  │           − R − P)
    │    │    │             │                  └─ total tasks suffix `t`
    │    │    │             └─ goal name(s); join roots[*].name with ", "
    │    │    │                truncated to fill leftover width budget
    │    │    └─ diamond-merge glyph: ⋈ (pc.yellow) when roots.length > 1,
    │    │       · (pc.dim) otherwise. Glyph chosen because it's the
    │    │       standard "join" symbol; degrades to a dot for the
    │    │       common case so the column stays at a fixed 1-char
    │    │       width and the merged tracks visually "pop".
    │    └─ Track index (1-based; pc.cyan, pc.bold). Matches HUD idiom.
    └─ Row marker; static `▸` (no per-row focus on card; popup handles
       selection). Could be omitted to reclaim 2 cols on narrow
       terminals — keep for v0 to mirror the popup's selection cursor
       column (zero-cost visual alignment when the user opens the
       popup via Shift+2).

CELL DETAILS:
  - `N`             : `pc.bold(pc.cyan(String(i+1)))`
  - GLYPH           : merged → `pc.yellow("⋈")` ; single → `pc.dim("·")`
  - GOAL NAMES      : `pc.cyan(truncate(roots.map(r=>r.name).join(", "),
                       budget))` ; budget = width − fixed cells width.
                       Use ink's wrap or a manual truncate matching
                       cli/format.ts:truncate (ellipsis "…").
  - TOTAL           : `${taskIds.size}` + `pc.dim("t")`. Right-aligned
                       in a 4-col cell.
  - COUNTS BLOCK    : `${R > 0 ? pc.green(R) : pc.dim("0")}${pc.dim("R")}
                       ${P > 0 ? pc.yellow(P) : pc.dim("0")}${pc.dim("P")}
                       ${O}${pc.dim("o")}`
                       Where:
                         R = readyCount (already on Track)
                         P = ∑ inProgress filtered to this track's taskIds
                         O = max(0, total − R − P)
                       Colour rationale: green=actionable now, yellow=
                       in-flight matches agent-status colour, dim=
                       neither.
  - ROI             : `pc.dim("ROI ") + colour(roi)` where
                       roi = round(sum over ready ∩ taskIds of
                       (impact / effortDays)) ; ∞ if any ready task
                       has effortDays === 0 (display "∞").
                       Colour matches formatHudTasksTable:
                       roi ≥ 100 → green ; ≥ 50 → yellow ; else dim.
                       When R === 0, render `pc.dim("ROI —")`.

ROI ARGUMENT (brief asks): YES, include ROI. Rationale:
  - Tracks card's headline purpose is "how many agents should I
    spawn?" → R answers "is there work?" but not "is the work
    worth doing first?". ROI sum across ready tasks ranks tracks
    by "value sitting on the launchpad right now".
  - ROI is already the canonical scoring number (used in
    listReady ordering, mu task next, formatHudTasksTable
    colouring). Reusing it is zero new vocabulary.
  - Cost is one map+reduce over `track.taskIds ∩ snapshot.ready`
    (sub-µs).
  - Stability concern is real but bounded: ROI of a track changes
    only when (a) a ready task closes (drops from sum) or (b) a
    blocker closes and a new task becomes ready (adds to sum).
    Both are user-meaningful events, so the visual flicker IS
    signal, not noise.
  - Counter-argument considered: "ROI is an aggregate, can mislead
    when one big-impact task dominates". Acceptable: the popup
    drills into per-task ROI; the card is a glance.

────────────────────────────────────────────────────────────────
2. SORT ORDER
────────────────────────────────────────────────────────────────

KEEP the SDK default: `getParallelTracks` already returns tracks
sorted by `roots[0].name.localeCompare(roots[0].name)` (deterministic
goal-id order). The card does NOT re-sort.

Justifications:
  - STABILITY: The card refreshes every tick (1 s default). If we
    sorted by ROI desc, every closed task would re-shuffle the row
    order and the user can't build muscle memory ("track 2 is the
    auth one"). Stable order is the glanceability win.
  - TRACK NUMBER IS THE LABEL: index `N` is the visible identifier;
    re-sorting per tick would mean "Track 2" jumps positions in the
    visual list, defeating the whole point of numbering.
  - ROI is ALREADY visible in the rightmost column. The user can
    eyeball "highest ROI" without the rows moving. (Eye scan over 8
    rows is faster than re-locating the previously-#1 track that
    just dropped to #5.)
  - "Most-ready-first" has the same instability problem as ROI desc.
  - The POPUP (design_popup_tracks) MAY offer in-popup re-sort
    bound to the reserved letter pool (e.g. `s` cycles
    track-id / ROI / ready-desc). Card stays stable; popup is the
    drill-down where re-sorting makes sense.

────────────────────────────────────────────────────────────────
3. TRUNCATION
────────────────────────────────────────────────────────────────

Cap at `K = min(8, height − 2)` rows.

  - height − 2 reserves the header line and one truncation-footer
    line. Card minHeight=4 ⇒ K ≥ 2 in pathological narrow-vertical
    layouts (still useful: top 2 tracks).
  - Hard ceiling at 8: ≥9 parallel tracks in one workstream is itself
    a workstream-shape smell ("you have too many goals; collapse
    some"). Cards are glanceable; the popup is the unbounded view.

When `tracks.length > K`, render footer line:
  `pc.dim(`  …${tracks.length - K} more — Shift+2 for full list`)`

Cites the open-popup binding inline so the user learns the gesture
the first time they hit truncation. Matches the static fallback's
"see `mu state --mission` for full" affordance.

────────────────────────────────────────────────────────────────
4. EMPTY STATE
────────────────────────────────────────────────────────────────

When `tracks.length === 0`:

  pc.dim("No goals yet")
  pc.dim("Try: mu task add <title> --impact <1-100> --effort-days <n>")

Two-line minimum. The hint command is COPYABLE (no
rich-text overlays); the user can yank with the global `y` if we
extend the yank handler to read the focused card's empty-state hint
in v0.next (out-of-scope for v0 — flagged as ODDITY).

Empty-state distinct from "tracks computed but all goals CLOSED" —
that case ALREADY produces tracks.length === 0 because
`getParallelTracks` filters to `STATUSES_TERMINAL_OR_PARKED`-rejecting
goals. So the same message covers both "no goals defined" and "all
goals shipped". For v0 that's fine — the user reads the message and
either adds a new goal or celebrates.

────────────────────────────────────────────────────────────────
5. DIAMOND-MERGE HINT
────────────────────────────────────────────────────────────────

The brief mentions a `mergeRoot?` field — that field does NOT exist
on the current `Track` type. Diamond-merge is detected card-side via
`track.roots.length > 1` (which is what
formatHudTracksTable already does on src/cli/state.ts L678).

GLYPH: `⋈` (pc.yellow) when merged ; `·` (pc.dim) when single. Glyph
chosen because:
  - Standard mathematical join symbol; recognisable.
  - 1-char width ⇒ fixed column ⇒ clean row alignment.
  - Falls back to `·` (also 1-char) so the column doesn't shimmer
    width-wise as tracks merge/split between ticks.
  - The yellow vs dim contrast pulls the eye to merged tracks
    without screaming (matches the existing HUD's pc.yellow("merged")
    cell, just denser).

Alternate considered: word "merged"/"single" (5–6 chars). REJECTED
— eats horizontal budget the goal-names cell needs.

If a future Track gains a `mergeRoot` field (e.g. "this is the
shared prereq that caused the merge"), the popup can surface it
("⋈ merged via shared_setup"). Card stays glyph-only.

────────────────────────────────────────────────────────────────
6. COLOUR (matches static fallback + HUD conventions)
────────────────────────────────────────────────────────────────

  Track index N         : pc.cyan + pc.bold              (HUD: same)
  Diamond glyph         : pc.yellow when merged, pc.dim else
                                                          (HUD: yellow
                                                          on "merged")
  Goal names            : pc.cyan                         (HUD: same)
  Total tasks suffix    : "12" plain, "t" pc.dim         (HUD: dim)
  R count               : pc.green if >0 else pc.dim "0" (HUD: same)
  P count               : pc.yellow if >0 else pc.dim "0" (matches
                                                          STATUS_COLORS.busy
                                                          for in-progress)
  O count               : plain (no colour)              (NEW; HUD has
                                                          no in-progress
                                                          column)
  ROI prefix "ROI "     : pc.dim                         (HUD: same)
  ROI value             : green ≥100, yellow ≥50, dim <50, "—" if R=0
                                                          (HUD: same
                                                          buckets per
                                                          formatHudTasksTable)
  Truncation footer     : pc.dim                          (matches
                                                          empty-state)
  Empty-state           : pc.dim both lines               (matches HUD
                                                          empty-state)

NO new colour vocabulary. Every colour is already used somewhere in
the static or HUD path → the user's eye-training transfers.

────────────────────────────────────────────────────────────────
7. DATA SLICE
────────────────────────────────────────────────────────────────

Per design_card_iface §1 (the Card contract), declare:

  // src/cli/tui/cards/tracks.tsx
  import type { Track }     from "../../../tracks.js";
  import type { TaskRow }   from "../../../tasks.js";
  import type { WorkstreamSnapshot } from "../../../state.js";
  import type { Card, CardProps } from "../types.js";

  interface TracksSlice {
    tracks: Track[];
    /** Joined card-side from snapshot.inProgress; lets us count P
     *  per track without a second SDK call. */
    inProgress: TaskRow[];
    /** Joined card-side from snapshot.ready; lets us compute ROI
     *  sum per track. */
    ready: TaskRow[];
  }

  const TracksCardComponent = ({ data, width, height }:
    CardProps<TracksSlice>) => {
    // Per-track derivations (pure, sync, sub-µs):
    //   const idsP = new Set(data.inProgress.map(t => t.name))
    //   const readyById = new Map(data.ready.map(t => [t.name, t]))
    //   for each track:
    //     const total = track.taskIds.size
    //     const R     = track.readyCount
    //     const P     = count(track.taskIds ∩ idsP)
    //     const O     = max(0, total − R − P)
    //     const roi   = round(sum over (track.taskIds ∩ readyById)
    //                         of t.impact / t.effortDays)
    //   render the rows per §1.
    return null as never; // body deferred to v0 implementation
  };

  export const TracksCard: Card<TracksSlice> = {
    id: 2,
    subject: "tracks",
    label: "Tracks",
    select: (snap: WorkstreamSnapshot) => ({
      tracks:     snap.tracks,
      inProgress: snap.inProgress,
      ready:      snap.ready,
    }),
    minWidth: 48,
    minHeight: 4,
    render: TracksCardComponent,
  };

WHAT THE CARD NEEDS THAT IS NOT IN `Track`:
  - Per-track in-progress count (P) → derived card-side from
    snapshot.inProgress (already in slice).
  - Per-track ROI sum across ready tasks → derived card-side from
    snapshot.ready (already in slice).
  - Per-track closed/blocked/deferred breakdown → NOT exposed; folded
    into `O = total − R − P`. Precise breakdown is the popup's job.

SEAM-EXTENSION OPPORTUNITY (filed as NEXT, NOT v0 blocker):
  Add `statusCounts: Readonly<Record<TaskStatus, number>>` to
  `Track` in src/tracks.ts. ~10 LOC inside the existing
  componentTaskIds scan. Two callers: this card (drops the
  card-side join, simpler render) + the Tracks popup
  (design_popup_tracks needs the same histogram for its per-track
  header). Promote at popup-design time.

────────────────────────────────────────────────────────────────
8. CARD vs POPUP SPLIT
────────────────────────────────────────────────────────────────

The CARD answers: "how many independent tracks of work are open,
and which has the most actionable value sitting in it RIGHT NOW?"
That's what the orchestrator uses to decide spawn count.

The CARD does NOT:
  - Show per-task lists (that's the popup tree).
  - Show blockers / blocker chains (popup).
  - Show task notes preview (popup).
  - Allow row selection or yank (popup).
  - Re-sort interactively (popup may; card is stable).
  - Display the closed/blocked/deferred status breakdown (popup).

The POPUP (design_popup_tracks, sibling task) inherits:
  - Same TracksSlice projection (cards and popups for the same
    subject SHARE the slice type per design_card_iface §3 R1).
  - extra:onOpen-fetched per-track full task tree (TaskRow[] for
    each track.taskIds, plus blocker edges; or use existing
    listTasks per workstream and filter — implementer's call).
  - In-popup verbs from the reserved letter pool: probably `t`
    (open task tree), `b` (blockers), `s` (re-sort cycle), `e`
    (open most-ready-task in editor / show notes). All within the
    {a b d e f h i l m o p s t u v x z} pool.

NEXT:
  - design_popup_tracks: copy the AgentsPopup template; consume
    the SAME TracksSlice; add an onOpen that fetches per-track
    full task lists; bind verbs from the reserved pool.
  - At popup-design time, RE-VISIT the Track.statusCounts seam
    extension proposal (§3) — if both card AND popup want
    closed/blocked counts, promote it then.
  - v0 implementation MUST add a unit test asserting that
    TracksSlice's card-side join produces (R, P, O) consistent
    with track.readyCount + filtered inProgress + total math
    (no silent off-by-one between Track.readyCount and
    snapshot.ready counted within taskIds).
  - v0 implementation MUST cap rows per §3 truncation rule and
    render the "…N more — Shift+2" footer.

VERIFIED:
  - Cross-checked against design_locked: 4 cards (Tracks is one),
    Shift+2 opens fullscreen popup, no per-card focus, no
    persistence — all preserved.
  - Cross-checked against design_card_iface: stateless Card
    component (no useState), pure `select` projection, declared
    minWidth/minHeight, ComponentType<CardProps<TracksSlice>>
    render — contract honoured exactly.
  - Cross-checked against design_poll_loop: TracksSlice is built
    from three snapshot fields (tracks/inProgress/ready), all
    refreshed on the unified tick; cardEnabled.tracks gate skips
    `getParallelTracks` and reuses `prev.tracks` per §1 of that
    note. Toggle-on triggers the immediate-refresh path.
  - Cross-checked against design_sdk_seam: zero new SDK exports;
    every field consumed is already in the 9-field
    WorkstreamSnapshot. The seam-extension proposal (§3) is
    explicitly DEFERRED, not snuck in.
  - Cross-checked against audit_state_ts: this card replaces the
    bullet "✓ Tracks → covered (Tracks card)" + the deletion of
    src/cli/state.ts L688-732 formatHudTracksTable. Static
    `mu state` continues to use formatTracks (cli/format.ts:216)
    which is untouched.
  - Cross-checked against tracks.ts: confirmed Track exposes
    {roots, taskIds, readyCount} only — no `mergeRoot` field;
    diamond-merge derived from `roots.length > 1`. Confirmed
    getParallelTracks already returns deterministic order
    (roots[0].name.localeCompare).

ODDITIES:
  - Brief mentioned `Track.mergeRoot?` — does not exist today.
    Substituted `roots.length > 1` derivation; flagged the future
    `mergeRoot` field as a popup concern (where "merged via
    <shared task>" is more useful than a glyph).
  - "Closed" count per track is not honestly derivable from the
    current snapshot (recentClosed is a length-5 tail, not a
    histogram). Resolved by substituting `O = total − R − P` on
    the card; honest closed/blocked/deferred breakdown lives in
    the popup. The brief's literal request for "closed" is
    addressed via the §3 SEAM EXTENSION proposal (Track.statusCounts)
    rather than a card-side lie.
  - The `▸` row-marker column is a 2-col cost the narrow-terminal
    case might want back. v0 keeps it because the popup uses the
    same column for the selection cursor and visual continuity
    helps when popping in/out via Shift+2. v0.next may make it
    a Card.minWidth-sensitive optional cell.
  - ROI rounding: I specified `round(sum)` not `toFixed(1)` (which
    formatHudTasksTable uses via toFixed(0)). Aligns with
    formatHudTasksTable's `.toFixed(0)` choice; an integer ROI
    column reads denser and the card's headline use case ("rank
    tracks") doesn't need fractional precision. Per-task ROI in
    the popup MAY use toFixed(1).
  - Diamond glyph `⋈` is a Unicode mathematical operator
    (U+22C8). Renders fine in every modern terminal font; falls
    back to a question-mark box only on truly ancient setups.
    Acceptable risk — same regime as the ⊕ glyph the Agents card
    already uses (cli/state.ts L560).
```

### #2 by "designer-2", 2026-05-11T11:15:40.508Z

```
CLOSE: Tracks CARD design done
```
