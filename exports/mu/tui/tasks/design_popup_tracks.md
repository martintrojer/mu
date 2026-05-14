---
id: "design_popup_tracks"
workstream: "tui"
status: CLOSED
impact: 70
effort_days: 1
roi: 70.00
owner: "scout-1"
created_at: "2026-05-11T10:45:07.473Z"
updated_at: "2026-05-11T11:25:38.937Z"
blocked_by: ["design_card_tracks", "design_popup_lifecycle"]
blocks: ["design_complete"]
---

# Design Tracks popup: drill into a track's task tree + notes preview

## Notes (2)

### #1 by "scout-1", 2026-05-11T11:25:36.881Z

```
DESIGN: Tracks fullscreen popup (Shift+2 / `@`) — drill-down for the
Tracks card. Two-pane (track list ↔ task drill); per-popup verbs from
the reserved letter pool; yank intents per row state; one extra fetch
on open (per-track notes preview).

This note locks the popup so the implementer can encode it mechanically.
Builds on (does not contradict):
  - design_locked              (single-popup invariant; +/-/=/0 live; A3' yank)
  - design_card_iface          (Card+Popup contracts; PopupProps; PopupVerb pool)
  - design_popup_lifecycle     (PopupState 2-state; restore; on-open hook; tick)
  - design_card_tracks         (TracksSlice = {tracks, inProgress, ready};
                                ROI sum per track; diamond glyph ⋈; sort stable)
  - design_yank_flow           (PopupProps.yank; per-popup `y` shape;
                                "always include -w"; suppress with toast)
  - design_global_keymap       (in-popup convention; reserved-letter pool
                                {a b d e f h i l m o p s t u v x z})

================================================================
FILES (planned)
================================================================
  src/cli/tui/popups/tracks.tsx   NEW. ~140 LOC. <TracksPopup> component
                                  + Popup<TracksSlice, TracksPopupExtra>
                                  registry entry. Two-pane render; key
                                  handlers (Tab, e, t, o, s); per-row yank
                                  resolver.
  src/cli/tui/cards/tracks.tsx    EXISTING (designer-2). Shares TracksSlice
                                  via re-exported type — popups/tracks.tsx
                                  imports `TracksSlice` from cards/tracks.tsx
                                  per design_card_iface §3 R1 (sibling
                                  popups SHARE the slice type).
  test/cli/tui/popup-tracks.test.ts  NEW. ~80 LOC. Pure dispatcher tests
                                     (no ink; reduce + verb.act calls).

Read for context (no edits):
  - src/tracks.ts                 Track type {roots, taskIds, readyCount}
  - src/cli/tasks/tree.ts         tree-render idiom (├── └── prefix builder)
  - src/tasks.ts L83-105          TaskRow + TaskNoteRow shapes
  - src/tasks.ts L624             listNotes(db, taskLocalId, ws, {tail})
  - src/tasks.ts L431             getTask(db, localId, ws)
  - src/tasks.ts L452             listTasks(db, ws, {status: TaskStatus[]})
  - src/tasks.ts L782             getTaskEdges (for blockers preview)

================================================================
COMMANDS
================================================================
None — read-only design-only task. Cross-checks ran:
  mu task notes design_locked          -w tui
  mu task notes design_card_iface      -w tui
  mu task notes design_popup_lifecycle -w tui
  mu task notes design_card_tracks     -w tui
  mu task notes design_yank_flow       -w tui
  mu task notes design_global_keymap   -w tui
  mu task show  design_popup_tracks    -w tui

================================================================
FINDINGS
================================================================

1. The Tracks card shows the WHAT-and-HOW-MANY (per-track row of
   {merged glyph · goals · total · R/P/o · ROI}). The popup must answer
   "what's actually IN Track 1?" without forcing the user to remember
   `mu task tree <root> -w tui`. So the popup is a TASK BROWSER scoped
   to one track, with notes preview as the "why" surface.

2. Three layout candidates considered:

     (a) SINGLE LIST WITH COLLAPSIBLE SECTIONS — one cursor, j/k walks
         everything; `e` collapses/expands the focused track; tasks
         render as nested children when expanded.
     (b) TWO-PANE (track list LEFT, drill RIGHT) — left pane = static
         track summary list; right pane = expanded task list + notes
         preview for the focused track. Tab swaps focus; one cursor in
         the focused pane.
     (c) HYBRID — two-pane, but track-list pane is pure-static (no
         cursor; selection driven from right pane title).

   Picking (b) for these reasons:
     - DENSITY: the popup is fullscreen (typical 80×24 .. 200×60). With
       8 tracks × 30 tasks/track + notes preview, (a) becomes a
       3000-row scroll where you lose orientation. (b) keeps the track
       list always visible — you ALWAYS know which track context the
       drill is showing.
     - PARITY WITH MENTAL MODEL: the Tracks CARD is already a list of
       tracks; the popup IS that list with a drill-down attached. (b)
       mirrors the user's reading order from the dashboard.
     - SELECTION SEMANTICS ARE CLEAN: in (a), `y` on a track-header
       row vs `y` on a task row needs special-case branching that the
       user has to understand. In (b), the LEFT pane is "what to drill
       into" and the RIGHT pane is "things you can act on" — the verb
       table maps cleanly to focus.
     - (c) was rejected because losing the left-pane cursor means the
         user can't scroll past the visible track set without hopping
         into the right pane and back. With ≤8 tracks (see
         design_card_tracks §3 hard cap), the left pane fits without
         scroll in normal terminals; with >8, the cursor is essential.

3. Per-row notes preview (last 5 lines): the snapshot has
   inProgress/ready/blocked task rows but NO notes. listNotes() is
   the SDK call (src/tasks.ts L624; signature
   `listNotes(db, taskLocalId, workstream, {tail: 5})`). Two ways
   to wire it:
     (i)  on-open prefetch ALL notes for ALL tasks in ALL tracks → fast
          cursor-move, but expensive for a 200-task workstream and most
          rows are never inspected.
     (ii) on-cursor-move fetch the focused task's notes (with a small
          LRU cache to avoid re-querying the same row mid-popup
          session).
   Pick (ii). Justification: (a) listNotes for one task is a
   single-statement query (~sub-ms even for 200 notes); (b) the user
   only inspects ~5 rows per popup session in the median case; (c) the
   prefetch model would mean an open-time stall proportional to total
   task count, which violates the "popup opens crisply" UX intent.

   The popup MUST cap notes preview at the LAST 5 LINES (per the
   brief) — i.e. read the most recent note's content, split on 
,
   slice -5. listNotes({tail:1}) returns the most recent note row;
   the popup does its own line-split.

4. The "expand task tree inline vs jump to Tasks popup" question: there
   IS no Tasks popup in v0 (designer-1 named the popup
   `design_popup_lifecycle` but its render is the Agents popup; the
   "Ready" popup is design_popup_ready / Shift+3). So `t` cannot
   "jump to the tasks popup" — it doesn't exist as a separate popup.
   Two real options:
     (i)  `t` yanks `mu task tree <id> -w tui` (the task-tree CLI
          rendering — which is exactly what the brief says the user
          wants) and the user pastes it in their shell. Read-only
          pillar: act-intent only.
     (ii) Render the tree INLINE in the right pane when the focused
          row's blocker subtree is non-trivial. Cost: a second
          per-cursor-move query (getTaskEdges + recursion); render
          competes for the right-pane real estate with the notes
          preview.
   Pick (i). The right pane is busy enough with task list + notes
   preview; an in-popup tree visualisation is a v0.next concern. The
   `t` verb yanks the CLI command and the user gets the canonical
   ASCII tree in their shell. (Matches design_yank_flow's locked
   shape: `Tracks popup `y` → `mu task tree T -w <ws>`` — except
   the brief's locked default `y` for Tracks was "goal task T → tree".
   I'm REVISING that below; see §6.)

5. PopupVerbKey collisions check (from design_card_iface):
   Reserved per-popup pool: {a b d e f h i l m o p s t u v x z} +
   punctuation {: / .}. Verbs I'm proposing for v0:
     - Tab     (focus toggle; NOT a letter — Tab is unreserved by the
                in-popup convention; safe to claim)
     - h / l   (also focus toggle aliases — vim convention; both are
                in the reserved pool)
     - e       (expand/collapse focused track in left pane)
     - t       (yank `mu task tree <id> -w tui` — focused row)
     - o       (yank `mu task notes <id> -w tui` — focused row's
                full notes; "o" mnemonic = "open notes")
     - s       (cycle re-sort of LEFT pane: stable-id / ROI-desc /
                ready-desc — deferred from card to popup per
                design_card_tracks §2)
   None collide with global verbs {j k g G n N q y c r w} or with
   the global tick/help/refresh keys (+/-/=/0 r F5 ?). All letters
   are in the reserved pool.

6. YANK shape for `y`:
   design_yank_flow §1 locked the default Tracks-popup `y` as
   `mu task tree <id> -w <ws>`. That decision was made BEFORE
   focus-pane semantics existed. With Tab-focus, `y` must dispatch
   per-pane:
     - `y` while LEFT pane focused (cursor on track-header row):
       SUPPRESSED. Footer toast: "select a task to yank an action
       — Tab to switch focus, or press `o` to copy track summary".
       Rationale: the brief explicitly recommends suppression
       ("Probably nothing yankable") and the underlying truth is
       there's no single canonical command for "the track itself" —
       the merged-roots case has 2+ goal IDs.
     - `y` while RIGHT pane focused (cursor on task row): per-state
       mapping below (§6 of DECISION). The default lifecycle action
       wins: claim if ready+unowned, release if owned, open if
       closed/rejected/deferred, show otherwise.
   The locked-in-design_yank_flow shape (`mu task tree <id>`) MOVES
   to the explicit `t` verb. The default `y` action is now the
   lifecycle act-intent — which is what every other v0 popup's `y`
   does (Agents → close, Ready → claim --self). That's the
   convention; tree is the affordance behind a letter key.

7. Empty state: handled distinctly from "no tasks in a track" (which
   never occurs — getParallelTracks only emits tracks with ≥1 root).
   Empty = `tracks.length === 0`. The card already renders the
   "No goals yet — Try: mu task add ..." copy; the popup MUST keep
   the same wording so users get one message in two places.

8. Test surface: vitest + a pure reducer for the popup's selection
   state (separate from the dispatcher; the popup owns its
   focusedPane + leftCursor + rightCursor). The j/k advance + y-on-
   ready test asks the popup component's keypress handler directly,
   no ink renderer needed (we mock the keypress and assert the
   yank() callback receives the right string).

================================================================
DECISION
================================================================

================================================================
1. LAYOUT — TWO-PANE
================================================================

Fullscreen popup (single-popup invariant; design_card_iface §I1).
Layout (flex-row at root):

  ┌─────────────────────────────────────────────────────────────────┐
  │ Tracks   ⌘ tui · 4 tracks · 31 tasks · 6 ready    tick: 1.00s   │ header row (1)
  ├──────────────────────────┬──────────────────────────────────────┤
  │ ▸ ⋈ 1 design_complete    │ Track 1 — design_complete            │ pane title (1)
  │     31t  3R 1P 27o  ROI… │                                      │
  │   · 2 build_runtime      │ ▸ design_popup_tracks  IN_PROGRESS   │ task rows
  │     12t  1R 0P 11o  ROI… │     scout-1 · ROI 70 · 5 blockers    │  (group 1)
  │   ⋈ 3 ship_v0.1          │   design_popup_log     OPEN          │
  │     18t  2R 0P 16o  ROI… │     —      · ROI 60 · 1 blocker      │
  │   · 4 fix_workspace      │   design_help_overlay  IN_PROGRESS   │
  │     5t   0R 1P  4o  ROI… │     designer-1 · ROI 80 · ready      │
  │                          │                                      │
  │                          │ ── notes (last note, last 5 lines) ──│ separator
  │                          │ FILES: src/cli/tui/popups/log.tsx    │
  │                          │ DECISION: locked tail-pause via      │ notes
  │                          │ NEXT: design_card_log                │ preview
  │                          │ VERIFIED: vitest run --watch         │ (5 lines)
  │                          │ —                                    │
  ├──────────────────────────┴──────────────────────────────────────┤
  │ Tab focus  j/k row  e expand  t tree  o notes  s sort  y act    │ key hints (1)
  └─────────────────────────────────────────────────────────────────┘

Width split: LEFT pane = max(28, floor(cols * 0.30)); RIGHT pane =
remainder − 1 (separator column). Below cols=64, the left pane gets
the floor (28) and the right pane the rest; below cols=48 the popup
renders a "narrow-mode" with LEFT pane HIDDEN and right pane full
width — the user is implicitly always focused on the right pane,
and `e` collapses the current track header to navigate to the
adjacent track. (Edge case; spelled out for the implementer; the
single-pane fallback still satisfies §2 with focusedPane fixed to
"right" and Tab being a no-op + footer toast "narrow mode: left
pane hidden".)

LEFT pane row format (per track):
  `▸ <glyph> <N> <goal_names>`           (header line)
  `    <total>t  <R>R <P>P <O>o  ROI <r>` (subtotal line, dim)

Where `▸` is the cursor glyph (only on the focused row in the focused
pane; non-focused rows show ` `). All other cells follow
design_card_tracks §1 wordsmith: glyph `⋈`/`·`, cyan-bold N, cyan
goal names, ROI bucketed colour. Two-line per-track row; if `e` has
collapsed the track, only the header line is shown for OTHER tracks
(see §5 on `e`). When the focused track is expanded, its own subtotal
line is hidden (the right pane shows the breakdown more honestly).

RIGHT pane:
  - Pane title: `Track <N> — <goal_names>` (cyan bold).
  - Task list (one row per task in `track.taskIds`, rendered as the
    union of OPEN/IN_PROGRESS/CLOSED/REJECTED/DEFERRED filtered to
    that track):

      `▸ <local_id>  <STATUS>`                 (line 1, bold name)
      `    <owner|—> · ROI <r> · <edge_hint>`  (line 2, dim)

    where `<edge_hint>` is one of:
      "ready"               — task is in snapshot.ready ∩ track.taskIds
      "<N> blockers"        — task.blockers.length > 0 (cheap inline
                              count from getTaskEdges; see §7 fetch)
      "—"                   — closed/rejected/deferred or no edges
    `▸` is the cursor glyph; non-focused rows show ` `.

  - Separator: a horizontal `── notes (last 5 lines) ──` line below
    the task list, taking 1 row.
  - Notes preview: last 5 lines of the FOCUSED task's most-recent
    note. If task has no notes, render dim `(no notes — yank `o` to
    open in shell)`. The 5 lines are the LAST 5 lines after split
    on 
; if the note is shorter, render what exists.
  - Notes pane is SCROLLABLE inside the popup ONLY via Ctrl-D /
    Ctrl-U (the global half-page nav) when the right pane is focused
    AND the cursor is at the bottom-most task row. Otherwise j/k
    walks task rows. (Avoiding a third "focus" mode for "in-notes"
    keeps the model 2-pane, not 3-pane.)

If the right pane lacks the vertical room for both the task list and
the notes preview, the notes preview shrinks first (down to 1 line +
"…N more — `o` to open"); then the task list paginates with PgDn/PgUp
honouring the global half-page nav.

================================================================
2. SELECTION + FOCUS
================================================================

Two cursors, ONE FOCUSED at a time:
  - LEFT pane cursor: a track index 0..tracks.length-1.
    Default focus AT POPUP OPEN: LEFT pane, cursor at row 0.
  - RIGHT pane cursor: a task index 0..tasksInTrack.length-1.
    Auto-resets to 0 when the LEFT cursor moves (the right pane is
    reading "tasks in the LEFT-selected track").

Focus toggle: Tab (primary) AND `h` / `l` (vim-aliases; safe — both
are in the reserved letter pool and bind only inside this popup).
  - Tab        : swap focusedPane (left ↔ right)
  - `h`        : focus LEFT pane (no-op if already left)
  - `l`        : focus RIGHT pane (no-op if already right)
  - Shift+Tab  : same as Tab (swap)

Why default to LEFT pane: the user opened the popup to BROWSE tracks;
the first thing they want to do is move down the track list. If they
defaulted to RIGHT pane, the track-1 task list would already be
showing without any navigational gesture having selected track 1.
Defaulting to LEFT makes the first j keystroke advance the track
cursor (and re-render the right pane); defaulting to RIGHT makes the
first j keystroke advance the task cursor of an arbitrary track,
which is confusing.

j / k / ↓ / ↑ apply to the FOCUSED pane's cursor only.
g / G apply to the focused pane (jump to first / last row).
Ctrl-D / Ctrl-U apply to the focused pane (half-page).

Suppressed in the LEFT pane (no-op + footer toast):
  - `o` (no notes for a track header — toast "select a task to view
    notes")
  - `t` (no tree for a track-without-a-single-root case; toast
    "select a task to yank tree")
  - `y` (per §6; toast "select a task to yank an action — Tab to
    switch focus")

Suppressed in the RIGHT pane:
  - `e` (no-op + footer toast "expand/collapse acts on tracks — Tab
    to LEFT pane"). Justification: `e` mutates the LEFT-pane render
    (collapsed track shows header-only); applying it in the right
    pane would either be a no-op or introduce a "task-row collapse"
    semantic for which there is no underlying data (tasks don't
    have children inside this popup).

================================================================
3. PER-TRACK ROW FORMAT
================================================================

Re-stated from §1 layout for clarity (LEFT pane):

  HEADER LINE:    `<cursor> <glyph> <N> <goal_names>`
    cursor       : `▸` if focused row in focused pane else ` `
    glyph        : `pc.yellow("⋈")` if roots.length>1 else `pc.dim("·")`
    N            : `pc.bold(pc.cyan(String(i+1)))`
    goal_names   : `pc.cyan(truncate(roots.map(r=>r.name).join(", "), …))`

  SUBTOTAL LINE:  `    <total>t  <R>R <P>P <O>o  ROI <roi>`
    rendered with the EXACT colour conventions from
    design_card_tracks §6 (R=green-if-positive, P=yellow-if-positive,
    O=plain, ROI bucketed by ≥100/≥50/<50 / "—" if R=0).

  total = track.taskIds.size
  R     = track.readyCount
  P     = count(track.taskIds ∩ snapshot.inProgress.map(t=>t.name))
  O     = max(0, total − R − P)
  roi   = round(sum over (track.taskIds ∩ snapshot.ready)
                of t.impact / t.effortDays)
          → "∞" if any ready task has effortDays === 0
          → "—" if R === 0

These are IDENTICAL to design_card_tracks §1 derivations (the popup
SHARES the slice; the per-track derivation function lives in the
shared module so the card and popup don't duplicate the formula).
The header LINE is brief-spec-compliant ("⋈ Track 1: …") modulo
glyph placement (we surface "Track" implicitly via `N`; the brief's
literal `Track 1:` would force a 7-col left margin and we can't
afford it under 80 cols with the goal names alongside).

When `e` has COLLAPSED the track (see §5), only the HEADER LINE
shows; subtotal line is hidden. The currently-focused track in the
LEFT pane is AUTO-EXPANDED-IN-PLACE (i.e. its subtotal line shows
even if `e` hid it earlier — focusing a track always re-expands its
left-pane summary), but `e` toggles the persistent collapse for
non-focused rendering.

Hard wrap rule: never let a track row exceed 2 lines. If
goal_names truncates, ellipsis (`…`) goes BEFORE the right edge of
the LEFT pane, NOT inside the goal names mid-word. Reuse
`truncate()` from src/cli/format.ts.

================================================================
4. TASK DRILL (RIGHT PANE)
================================================================

Tasks shown for the LEFT-selected track:

  rows = listTasks(db, ws, { status: undefined })
           .filter(t => track.taskIds.has(t.name))
           .sort(byTrackTaskOrder)

byTrackTaskOrder: status bucket first (IN_PROGRESS, OPEN+ready,
OPEN+blocked, DEFERRED, REJECTED, CLOSED), then ROI desc within
bucket. (This puts "what someone is doing right now" at the top,
"what could be done next" second, "parked" further down.)

Per-row format:
  LINE 1: `<cursor> <local_id>  <colorStatus(status)>`
    cursor     : `▸` if focused row in focused (right) pane else ` `
    local_id   : `pc.bold(t.name)` (matches src/cli/tasks/tree.ts
                  `formatTreeNodeLabel`)
    colorStatus: imported from src/cli.ts (the canonical status
                  colourer — green/yellow/red/dim per
                  STATUS_COLORS in src/cli/format.ts).

  LINE 2: `    <owner|—> · ROI <roi> · <edge_hint>` (all dim except
          ROI value which uses the same bucketing as the card)
    owner      : `t.owner ?? "—"`
    roi        : round(impact / effortDays); "∞" if effortDays===0
    edge_hint  : "ready"      if t.name ∈ snapshot.ready
                 "<N> blockers" if N := count of non-terminal blockers
                                  (computed from getTaskEdgesWithStatus;
                                  see §7 for fetch policy)
                 "—"          otherwise

NOTES PREVIEW (below the task list, when focused row exists):

  Header:   `── notes (last 5 lines, n=last note) ──` (dim)
  Body:     last 5 lines of `listNotes(db, focusedTask.name, ws,
            {tail:1})[0]?.content?.split("
").slice(-5)`. Each line
            is rendered as-is (no further parsing); long lines wrap
            at right-pane width (ink default).
  Empty:    `pc.dim("(no notes — press \`o\` to copy: mu task notes <id> -w tui)")`

The SDK call cited verbatim:
  - `listNotes(db, t.name, ws, { tail: 5 })` — would return the LAST
    5 NOTES; we want the LAST 5 LINES of the LAST NOTE, so we use
    `{ tail: 1 }` and split. (Documented to avoid a future "why
    isn't tail=5 doing what the comment says" maintenance bug.)
  - The 5-line cap is a presentation choice; for "show the last 5
    NOTES instead" the user yanks `o` and reads in their shell with
    `mu task notes <id> --tail 5 -w tui`.

================================================================
5. PER-POPUP VERBS (v0)
================================================================

Bindings, listed in keymap-table form for the help overlay
(design_help_overlay reads PopupVerb.label):

  Key   Pane     Label              Effect
  ---   ----     -----              ------
  Tab   either   focus              swap LEFT ↔ RIGHT
  h     either   focus left         switch to LEFT pane
  l     either   focus right        switch to RIGHT pane
  e     LEFT     expand/collapse    toggle subtotal-line visibility
                                    for the focused track in LEFT
                                    pane (default: every track
                                    expanded; `e` hides subtotal of
                                    non-focused tracks one-by-one;
                                    `e` again re-expands).
        RIGHT    —                  no-op + footer toast "expand
                                    acts on tracks — Tab to LEFT"
  s     LEFT     sort               cycle LEFT pane order:
                                    stable-id (default) → ROI-desc →
                                    ready-desc → stable-id. Cycle
                                    indicator shown in pane header
                                    (e.g. "Tracks · sort: ROI ↓").
                                    Reset to stable-id on popup close
                                    (popup-local; not persisted).
        RIGHT    —                  no-op + footer toast "sort acts
                                    on tracks — Tab to LEFT"
  t     RIGHT    tree (yank)        yank `mu task tree <id> -w <ws>`
        LEFT     —                  no-op + footer toast (per §2)
  o     RIGHT    open notes (yank)  yank `mu task notes <id> -w <ws>`
        LEFT     —                  no-op + footer toast (per §2)
  y     RIGHT    yank act-intent    per §6 mapping (default verb)
        LEFT     —                  no-op + footer toast (per §2)

Design rationale for the verb choices:
  - `e` over `c` for expand/collapse: `c` is a GLOBAL dashboard verb
    (clear footer per design_yank_flow §4) — it's not bound inside
    popups but reserving it for the user's muscle memory matters.
    `e` is in the reserved letter pool, mnemonic ("expand"), and
    matches lazygit's expand idiom.
  - `s` over `r` for sort: `r` is a global refresh-now key
    (design_global_keymap) — it stays live inside popups. We can't
    rebind it. `s` is the standard "sort" letter (k9s, helix).
  - `t` for tree: matches design_yank_flow's locked Tracks-popup
    `y` shape (now moved here). One letter, one canonical CLI verb.
  - `o` for "open notes" via `mu task notes`: mnemonic "open". The
    reserved pool has `n` excluded (it's the global next-filter-match
    verb), so `o` is the next-best.
  - REJECTED additional verbs for v0:
    - `b` (blockers): the right-pane second line already shows "<N>
      blockers"; if the user wants the canonical chain they yank
      `t` for the tree. Adding a separate `b` verb that yanks
      `mu task show <id>` is redundant with `o` (notes include the
      blocker reasoning) and `t` (tree shows the structure).
    - `f` (filter): the global `/` already enters incremental
      filter mode (design_global_keymap in-popup convention). No
      need to rebind.
    - `r` (release / refresh): conflicts with global refresh.
      Released-when-claimed is handled by the per-state `y` (§6).
  - The verbs total 6 popup-specific (Tab, h, l, e, s, t, o, plus
    the default `y`). Comfortable; well under the 18-letter pool
    cap. Leaves room for v0.next additions (`b` blockers, `f` open
    in `$EDITOR`, etc.) under the promotion criteria.

================================================================
6. YANK INTENTS — PER-STATE MAPPING (RIGHT pane focused, default `y`)
================================================================

LEFT pane focused (cursor on track header):
  → SUPPRESSED. Footer toast: `select a task to yank an action — Tab
    to switch focus, or press \`o\` for notes (no-op here)`. Per
    design_yank_flow §1 the public PopupProps.yank IS called only
    when there's a string to copy; suppression means the popup
    short-circuits and writes a footer toast directly via the
    "no-op" footer-write path (the same path design_popup_lifecycle
    §2 uses for "popup already open" toasts).

RIGHT pane focused (cursor on task row):

  state                        →  yank string                                        rationale
  -----                            -----------                                        ---------
  status === "OPEN"
    ∧ owner === null
    ∧ rowId ∈ snapshot.ready   →  `mu task claim <id> -w <ws> --self`               canonical "I want
                                                                                     this one"; matches
                                                                                     Ready popup's
                                                                                     default y (yank flow §1)
  status === "OPEN"
    ∧ owner === null
    ∧ rowId ∉ snapshot.ready   →  `mu task show <id> -w <ws>`                       blocked → can't claim;
                                                                                     show explains why
  status === "OPEN"
    ∧ owner !== null           →  `mu task release <id> -w <ws>`                    claimed by someone;
                                                                                     release is the
                                                                                     orchestrator's lever
                                                                                     (`mu task release`
                                                                                     bare-form auto-flips
                                                                                     IN_PROGRESS→OPEN per
                                                                                     SKILL.md, but for OPEN
                                                                                     +owner it just clears
                                                                                     ownership)
  status === "IN_PROGRESS"     →  `mu task release <id> -w <ws>`                    flips to OPEN + clears
                                                                                     owner; matches the
                                                                                     SKILL.md "release a
                                                                                     stuck claim" pattern
  status === "CLOSED"          →  `mu task open <id> -w <ws>`                       reopen the closed task
                                                                                     (the brief's literal
                                                                                     ask)
  status === "REJECTED"        →  `mu task open <id> -w <ws> --evidence "<...>"`   reopen rejected; the
                                                                                     `--evidence` flag is
                                                                                     OMITTED from the yank
                                                                                     (user fills it in
                                                                                     before pasting; the
                                                                                     toast says "[copied —
                                                                                     add --evidence]")
  status === "DEFERRED"        →  `mu task open <id> -w <ws>`                       un-park the deferred
                                                                                     task

Toast/footer text uses the SAME [copied] / [no clipboard] suffix
machinery as design_yank_flow §3 — the popup just hands the string
to PopupProps.yank and the dispatcher handles the rest.

EDGE CASES:
  - `y` on a row whose status changed since the snapshot was taken
    (rare; the tick is 1s so most users won't observe this) yanks
    based on the SNAPSHOT state, not the current DB state. The
    paste-then-run is at the user's risk; mu CLI verbs report
    `TaskAlreadyOwnedError` / similar at run time. Acceptable; the
    alternative (re-fetch on every keypress) is a regression
    against the cached-snapshot model in design_popup_lifecycle §5.
  - Owner === current user (the orchestrator pi pane): the yank
    still produces `mu task release <id>` — the orchestrator may
    legitimately want to release their own claim (handing off, or
    clearing a no-longer-needed reservation). No special-case.
  - `--self` is appended ONLY for the `claim` shape. `release` and
    `open` and `show` do not take `--self`.

The mapping is encoded as a pure function in popups/tracks.tsx:

  function defaultYankFor(t: TaskRow, ready: Set<string>, ws: string)
    : string | null {
    if (t.status === "OPEN") {
      if (t.owner === null) {
        return ready.has(t.name)
          ? `mu task claim ${t.name} -w ${ws} --self`
          : `mu task show ${t.name} -w ${ws}`;
      }
      return `mu task release ${t.name} -w ${ws}`;
    }
    if (t.status === "IN_PROGRESS") return `mu task release ${t.name} -w ${ws}`;
    if (t.status === "CLOSED")      return `mu task open ${t.name} -w ${ws}`;
    if (t.status === "REJECTED")    return `mu task open ${t.name} -w ${ws}`;
    if (t.status === "DEFERRED")    return `mu task open ${t.name} -w ${ws}`;
    return null;
  }

`null` should be impossible (every TaskStatus is enumerated above),
but the popup defensively renders the LEFT-pane suppression toast
if it ever sees null.

================================================================
7. ON-OPEN DATA + PER-TICK FETCH POLICY
================================================================

The popup consumes the SAME TracksSlice as the Tracks card (sibling
contract; design_card_iface §3 R1):

  TracksSlice = {
    tracks:     Track[];
    inProgress: TaskRow[];
    ready:      TaskRow[];
  }

This is what `select(snapshot)` returns each tick. It is SUFFICIENT
for the LEFT pane (track summary lines need only Track + the
inProgress/ready joins). The RIGHT pane needs MORE:

  (a) The full task list per track (status + owner + ROI),
      including CLOSED/REJECTED/DEFERRED tasks (the snapshot's
      `inProgress`+`ready`+`blocked` covers OPEN/IN_PROGRESS only,
      not the parked/terminal ones).
  (b) The blocker count per task (for the "<N> blockers" edge_hint).
  (c) The most recent note per FOCUSED task (last 5 lines).

Fetch policy (per design_popup_lifecycle §4 + §5):

  ON OPEN (Popup.onOpen, runs ONCE on Shift+2 press):
    Fetch the full task list for the workstream:
      tasksAll = listTasks(db, workstream)
        // single SQL query; returns every task in the workstream
        // (≤ a few hundred typically); cheap enough to do at open.
        // NOT refetched per tick — the snapshot's per-tick refresh
        // already updates the open/in-progress/ready/blocked
        // categorisations; CLOSED/REJECTED/DEFERRED rows shift
        // rarely and a 1s drift is acceptable for the popup.
    AND fetch a Map of blocker-counts for tasks IN ANY TRACK:
      blockerCounts = new Map<string, number>()
      for each t in tasksAll where some track has t.name in taskIds:
        edges = getTaskEdgesWithStatus(db, t.name, workstream)
        blockerCounts.set(t.name, count of edges.blockers where
                                   blocker.status not in
                                   STATUSES_TERMINAL_OR_PARKED)
        // ~one query per OPEN task; for a 200-task workstream
        // with ~50 OPEN tasks, this is 50 sub-ms queries = ~25ms
        // total. Fits well under the design_popup_lifecycle §4
        // recommendation that onOpen be "fast or rendered behind
        // a 'loading…' state". For the rare 500+ task workstream
        // we accept a 100ms open delay.
    Returns:
      TracksPopupExtra = {
        tasksAll: TaskRow[];
        blockerCounts: ReadonlyMap<string, number>;
      }

  ON CURSOR-MOVE (right-pane j/k/g/G, OR left-pane j/k/g/G that
  changes the focused track):
    Fetch the focused task's most recent note:
      notes = listNotes(db, focusedTask.name, workstream, { tail: 1 })
      preview = notes[0]?.content.split("
").slice(-5).join("
")
        ?? null
    Cache the preview by task.name in a popup-local LRU (Map keyed
    by task.name, capped at 20 entries — the user is unlikely to
    revisit beyond 20 distinct tasks in one popup session). On
    cache hit, skip the query. The cache is ENTIRELY popup-local
    (lives in popup-component-local useState); no global cache;
    cleared on popup close (per design_popup_lifecycle §4 "no
    per-subject extra cache across popup open/close").

  PER TICK (popup tick, per design_popup_lifecycle §5):
    The TracksSlice is refreshed (same call path as the dashboard).
    The popup's `data` prop updates; React re-renders. Per-task
    notes preview is NOT refreshed (a new note arriving while the
    user's cursor is on the task is rare; if it matters, the user
    yanks `o` and reads in shell). Blocker counts ARE NOT refreshed
    per tick — they were captured at open. (Edge case: a task's
    blocker closing mid-popup means the right-pane edge_hint stale-
    reads "1 blockers" while the snapshot's `ready` set has updated.
    Acceptable because (a) the user typically opens the popup,
    looks for ~30s, closes; (b) the per-tick `ready` membership IS
    refreshed and drives the "ready" edge_hint case correctly; (c)
    a stale "<N> blockers" hint is harmless — yanking `t` shows
    the live tree.)

extra-loading state (per design_popup_lifecycle §4 "loading"):
  - Render the popup chrome (header, key hints, both pane outlines).
  - LEFT pane: render the track summary lines from `data.tracks`
    immediately (no extra needed).
  - RIGHT pane body: render `pc.dim("Loading task list…")` until
    `extra` is defined.
  - All keypresses (Tab, h, l, e, s) work normally during load;
    `t`, `o`, `y` show a footer toast `"loading — try again in a
    moment"` until extra resolves.

================================================================
8. EMPTY STATE
================================================================

When `data.tracks.length === 0`:

  Render: a centered single-message body (no pane split):

    pc.bold("No tracks yet.")
    pc.dim("Add tasks with: mu task add <title> --impact <1-100> "
           + "--effort-days <n>")
    pc.dim("Then open this popup again with Shift+2.")

  Key bindings: ONLY q / Esc / ? remain meaningful. Tab, j, k, e,
  s, t, o, y all show the footer toast "no tracks — add tasks
  with `mu task add`". This matches the brief.

NOT distinct from "all goals shipped" — same as the Tracks card
treatment (design_card_tracks §4): if every goal is CLOSED,
`getParallelTracks` returns `[]` and we render the same message.
The wording stands ("No tracks yet" reads correctly as both "no
goals defined" and "all goals shipped, you may add more").

================================================================
9. TESTS
================================================================

File: `test/cli/tui/popup-tracks.test.ts`. Pure (no ink). Tests
exercise the popup's pure reducer + the defaultYankFor function
+ the keypress handler.

Required tests (the brief's literal asks first):

  it("pressing j advances the right-pane selection by one row", () => {
    // Given a popup in initial state with focusedPane='right',
    // rightCursor=0, and a track with 3 tasks.
    const initial = makeState({
      focusedPane: "right",
      tracks: [{ ... }],
      tasksInFocusedTrack: [taskA, taskB, taskC],
      leftCursor: 0,
      rightCursor: 0,
    });
    const next = reduce(initial, { type: "key", key: "j" });
    expect(next.rightCursor).toBe(1);
    // And clamps at the bottom:
    const last = reduce(reduce(next, {type:"key", key:"j"}),
                        { type: "key", key: "j" });
    expect(last.rightCursor).toBe(2); // 3 tasks, max index 2
  });

  it("pressing y on a ready unowned task yanks `mu task claim <id> "
     + "-w <ws> --self`", () => {
    const ready = new Set(["task_alpha"]);
    const ws = "tui";
    const t: TaskRow = {
      name: "task_alpha", status: "OPEN", owner: null,
      impact: 70, effortDays: 1, /* ...other fields */
    };
    expect(defaultYankFor(t, ready, ws))
      .toBe("mu task claim task_alpha -w tui --self");

    // And via the keypress dispatcher (integration with PopupProps.yank):
    const yanks: string[] = [];
    const initial = makeState({
      focusedPane: "right",
      tasksInFocusedTrack: [t],
      rightCursor: 0,
      ready,
    });
    handleKey(initial, "y", { yank: (s) => yanks.push(s), ws });
    expect(yanks).toEqual(["mu task claim task_alpha -w tui --self"]);
  });

Additional tests to round out v0 coverage (each one a one-liner
expectation):

  - pressing j advances the LEFT-pane cursor and resets rightCursor to 0
  - pressing k decrements the focused-pane cursor; clamps at 0
  - pressing G jumps the focused-pane cursor to the last row
  - pressing Tab swaps focusedPane between left and right
  - pressing h focuses left; pressing l focuses right; both no-op when
    already there
  - pressing y in LEFT pane invokes a footer-toast write (NOT yank)
    with text matching /select a task to yank/
  - pressing y on a CLOSED task yanks `mu task open <id> -w <ws>`
  - pressing y on an IN_PROGRESS task yanks `mu task release <id>
    -w <ws>`
  - pressing y on an OWNED OPEN task yanks `mu task release <id>
    -w <ws>` (NOT claim)
  - pressing y on an UNOWNED OPEN task NOT in ready yanks
    `mu task show <id> -w <ws>`
  - pressing t in RIGHT pane yanks `mu task tree <id> -w <ws>`
  - pressing o in RIGHT pane yanks `mu task notes <id> -w <ws>`
  - pressing e in LEFT pane toggles the focused track's collapsed flag
  - pressing s cycles the LEFT-pane sort: stable → ROI → ready → stable
  - empty-state (tracks=[]): pressing j/k/y/t/o/e/s all produce a
    footer toast matching /no tracks/

These all live in popup-tracks.test.ts. NO ink rendering tests in v0
— per design_yank_flow §7, ink-testing-library is the broader-cluster
concern (blocked on the devDep landing; design_module_layout
ODDITIES). The popup's pure reducer + defaultYankFor + key handler
cover the testable surface without it.

================================================================
NEXT
================================================================

- impl_popup_tracks (v0 implementation): build src/cli/tui/popups/
  tracks.tsx + the test file. ~140 LOC source + ~80 LOC test = 220
  LOC total. Within the per-popup budget.

- design_card_tracks's seam-extension proposal (Track.statusCounts):
  REVISIT at impl time. The popup's right-pane "edge_hint" computes
  blocker counts via getTaskEdgesWithStatus per task on open (~50
  queries × sub-ms = ~25ms). If real users report the popup
  open-delay being noticeable (>200ms median), promote
  Track.statusCounts so the popup can read counts off Track instead
  of doing the per-task fetch loop. Promotion criteria: 2+ users
  report it AND the implementation fits in <30 LOC inside
  src/tracks.ts's existing scan loop. Until then, the per-task
  fetch on open is fine (one-time cost; not on the per-tick path).

- design_help_overlay: must include the per-popup verbs from §5 in
  its Tracks-popup section. Exact strings to include (verbatim):
    Tab/h/l   focus left/right pane
    e         expand/collapse focused track (LEFT)
    s         cycle sort (LEFT): stable / ROI / ready
    t         yank `mu task tree <id> -w <ws>` (RIGHT)
    o         yank `mu task notes <id> -w <ws>` (RIGHT)
    y         yank act-intent for focused row (RIGHT; per-state)

- design_popup_ready (Shift+3): the Ready popup will share parts of
  the per-task row format here (status / owner / ROI two-line). Aim
  to extract a shared <TaskRowTwoLine> ink component if both popups
  end up using the same shape. NOT a v0 blocker; a v0.next refactor.

- impl_tui_yank: ensure PopupProps.yank handles the LEFT-pane
  suppression case via the footer-toast-write path (not the yank
  path); currently designer-1's design_yank_flow §1 has the popup
  write the toast directly when it has nothing yankable. Confirm
  the implementer wires that non-yank toast surface.

================================================================
VERIFIED
================================================================

- Cross-checked design_locked: Shift+2 opens fullscreen popup, single-popup
  invariant, popup close restores prior dashboard state, +/-/=/0 stay
  live in popups, A3' yank flow — all preserved; popup binds Shift+2
  glyph (`@`) per design_global_keymap.

- Cross-checked design_card_iface: Popup<TracksSlice, TracksPopupExtra>
  shape honours the contract — id=2, subject="tracks", select reuses
  the same projection as TracksCard (R1 R4 pairing rule), verbs all
  drawn from PopupVerbKey {a b d e f h i l m o p s t u v x z} (we use
  e, s, t, o; Tab/h/l are non-letter or letter but not in
  PopupVerbKey-collision range — h and l ARE in the pool, fine), no
  shadowing of global {j k g G n N q y c r w}.

- Cross-checked design_popup_lifecycle: the popup uses ONE onOpen
  fetch (returning TracksPopupExtra), per-tick `data` refresh via the
  shared snapshot, popup-local cursor + cache state cleared on close,
  no `restoreState` mutations from the popup, error boundary in
  PopupHost catches render errors per §6.

- Cross-checked design_card_tracks: TracksSlice is identical (cards
  and popups for "tracks" share the slice). Per-track derivations
  (R/P/O/ROI) reuse the same formula. Sort defaults to stable-id
  (popup MAY cycle via `s`; the card stays stable as designer-2
  locked). The card's `Shift+2 for full list` truncation footer
  hint binds to this exact popup.

- Cross-checked design_yank_flow: PopupProps.yank is the only call
  the popup makes for clipboard side-effects (no direct execa /
  /dev/tty); LEFT-pane suppression flows through the footer-toast
  path, not the yank path. The "always include -w" rule is honoured
  in every yank string (taken from PopupActCtx.workstream). The
  brief's locked-default `y` (mu task tree) is RELOCATED to the `t`
  verb; this note flags the deviation for cross-doc consistency.

- Cross-checked design_global_keymap: in-popup convention preserved
  (j/k/g/G/Esc/q/y/c/r/w global; +/-/=/0 live; ?/F1 help; / filter;
  n/N filter-match nav). Per-popup verbs e/s/t/o/h/l/Tab DO NOT
  shadow any global key. Tab is unbound globally; safe to claim.

- Cross-checked tracks.ts: Track exposes only {roots, taskIds,
  readyCount}; per-task status / owner / ROI lookups go through
  listTasks + listNotes + getTaskEdgesWithStatus from tasks.ts, all
  existing SDK calls. No new src/tracks.ts SDK surface required for
  v0 (the statusCounts proposal is filed as NEXT, not blocking).

- Cross-checked src/cli/tasks/tree.ts: the popup does NOT render an
  inline tree; the `t` verb yanks the CLI tree command which uses the
  exact renderer in tree.ts. One source of truth for tree visualisation;
  the popup is the BROWSER, the tree CLI is the VIEWER. No
  duplication.

================================================================
ODDITIES
================================================================

- The brief's literal per-track header line ("⋈ Track 1: design_complete
  31 tasks · 3 ready · 1 in_progress · ROI sum 1430") was wordsmithed
  to fit a 2-line per-track LEFT-pane row at 28-col minimum width.
  The semantic content is preserved (glyph + N + goal_names + total
  + R/P/O + ROI); the literal "Track" word and ":" punctuation were
  dropped because cyan-bold `N` already serves as the track label
  and `:` adds no information at column-tight widths. design_card_tracks
  made the same call. If a real user reports "I miss the literal
  'Track' word", we restore it under the v0.next bar (the popup has
  more horizontal room than the card; affordance is cheap).

- The right-pane "<N> blockers" edge_hint uses a
  getTaskEdgesWithStatus fetch ON OPEN, snapshotted in extra and NOT
  refreshed per tick. This means a blocker closing mid-popup leaves
  the hint stale until the user reopens. Documented as acceptable
  in §7; if real users hit this, promote the seam extension
  (Track.statusCounts) and refresh the hint per tick from snapshot.

- The LEFT-pane `e` expand/collapse semantic is per-pane visual
  only; it does NOT change which track the right pane drills into
  (that's driven by the LEFT cursor, not by collapsed state). This
  is intentional — collapse is "compact the LEFT pane to fit more
  tracks on screen", not "select / unselect this track for drill".
  The implementer must NOT couple the two.

- I rejected an inline tree visualisation in the right pane (option
  4(ii) in FINDINGS) because the right pane is already busy with the
  task list and notes preview, and the tree CLI renderer is mature.
  v0.next can revisit: the popup could grow a third focus mode
  ("tree view of focused task") bound to a key from the reserved
  pool (`v` for "view"?). Promotion criterion: 2+ users complain
  about the Tab-out-and-paste workflow.

- `release` for both IN_PROGRESS and OPEN+owned uses the same yank
  string. The CLI's `mu task release` semantic differs slightly
  between the two (IN_PROGRESS auto-flips to OPEN; OPEN+owner just
  clears the owner field) per SKILL.md, but the user's INTENT is
  identical ("free this task from its current claim"). One yank
  string, one verb to learn. The user pastes; the CLI does the
  right thing per current state.

- For REJECTED tasks, the yank string `mu task open <id> -w <ws>`
  omits `--evidence`. Per `mu task open --help`, --evidence is
  optional; the user adds it before pasting if they want grounding.
  The toast shows "[copied — add --evidence]" suffix to remind. (v0
  may simplify this to "[copied]" for consistency; the suffix is a
  nice-to-have, not a blocker. Implementer's call.)

- Notes preview cap of 5 LINES (not 5 NOTES) is a deliberate
  presentation choice that contradicts a naive reading of the brief.
  5 NOTES would likely overflow the right pane vertically; 5 LINES
  of the LAST note gives the user the most-recent decision/finding
  in compact form. To inspect more, yank `o` and read in shell.

- The popup's per-popup state (focusedPane / leftCursor / rightCursor
  / collapsedTracks / sortMode / notesCache) lives in the popup
  component's local useState, NOT in the App's PreservedDashboardState.
  Per design_popup_lifecycle §3, we explicitly do NOT persist
  popup-local state across opens (no per-subject extra cache). User
  closes the popup at row 12 of track 3, reopens 30s later: cursor
  is back at LEFT pane row 0. Acceptable; the popup is a glance, not
  a workspace.

- LEFT pane "narrow mode" (cols<48) hides the LEFT pane and lets
  the user drive purely from the right pane. The implementer must
  disable Tab + h + l in narrow mode (footer toast) and the `e`
  collapse semantic becomes "navigate to next track" (Tab-equivalent
  via single-pane). This is a graceful-degradation case; if the
  implementer doesn't have time, ship the popup with the layout
  hidden below 48 cols and a "terminal too narrow — resize to ≥48
  cols" toast. Not a v0 blocker either way.
```

### #2 by "scout-1", 2026-05-11T11:25:38.937Z

```
CLOSE: Tracks popup design done
```
