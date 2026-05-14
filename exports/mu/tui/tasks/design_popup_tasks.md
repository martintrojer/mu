---
id: "design_popup_tasks"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 1
roi: 80.00
owner: "designer-1"
created_at: "2026-05-11T10:45:07.574Z"
updated_at: "2026-05-11T11:24:04.111Z"
blocked_by: ["design_card_ready", "design_popup_lifecycle", "design_yank_flow"]
blocks: ["design_complete"]
---

# Design Tasks popup: notes/tree/blockers, yank claim/close/release commands

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:24:00.530Z

```
DESIGN: Tasks fullscreen popup (Shift+3) — layout, list/detail
content, 5-verb keymap, complete yank matrix, on-open data, tests.

This is the drill-down of the Ready card AND the catch-all task
browser (filter to ALL / mine / by-status). Because Ready is the
densest dashboard surface (highest-frequency dispatch decisions),
this popup will be the most-pressed `y` surface in the TUI.

Every choice below is constrained by:
  - design_locked         — read-only, yank-only act-intent contract
  - design_card_iface     — Popup<TSlice,TExtra>; PopupVerb pool
                              {a b d e f h i l m o p s t u v x z}
  - design_popup_lifecycle — single popup; PopupHost owns extra-fetch;
                              snapshot.tasks on each tick
  - design_card_ready     — the sibling card (4-col glance form)
  - design_yank_flow      — `y` overwrites footer; toast 2s; -w mandatory
  - design_global_keymap  — in-popup reserved {j k g G n N q y c r w};
                              `/` filter; `s` is mine to claim

================================================================
FILES (planned cluster footprint)
================================================================
- src/cli/tui/popups/tasks.tsx  NEW. ~250 LOC. <TasksPopup>: ink layout
                                  (left list / right detail); local state
                                  for cursor index, statusFilter, mineOnly,
                                  filterText, notesExpanded.
- src/cli/tui/popups/registry.ts EDIT. Register the Tasks popup with
                                  id=3, subject="ready" (paired with
                                  ReadyCard), verbs[], onOpen=fetchNotes.
- src/cli/tui/types.ts            EDIT (no schema change). Re-export
                                  TasksPopupExtra type (per-task notes
                                  cache).
- test/cli/tui/popups/tasks.test.tsx  NEW. ~120 LOC. Unit tests
                                  using ink-testing-library (already a
                                  designed dep per design_card_iface);
                                  mocks snapshot + yank() spy.
- src/state.ts                    EDIT. WorkstreamSnapshot.tasks slice:
                                  per design_sdk_seam this is already
                                  TaskRow[] with edges; the Tasks popup
                                  uses ALL of it (not filtered to ready).

================================================================
COMMANDS (cross-checked)
================================================================
- mu task notes design_card_iface -w tui  (Popup contract; verb pool)
- mu task notes design_yank_flow  -w tui  (yank API + toast)
- mu task notes design_card_ready -w tui  (sibling card; popup id=3)
- mu task notes design_popup_lifecycle -w tui (onOpen, restore)
- mu task notes design_global_keymap -w tui (suppressed in-popup keys)
- ls src/cli/tasks/                       (target verbs we yank to)
- mu task release --help                  (release-on-IN_PROGRESS semantics)
- mu task wait --help                     (the blocker-yank target)

================================================================
FINDINGS
================================================================

────────────────────────────────────────────────────────────────
1. LAYOUT — TWO-PANE 40/60
────────────────────────────────────────────────────────────────

RECOMMEND: 40/60 (left=list, right=detail).

  - 33/67 leaves the list pane at ~26 cols on a 80-col terminal —
    too narrow for `name | status | ROI | owner` even after
    truncation; the title column would be ~6 chars.
  - 40/60 on 80 cols → 32/48; tight but workable for a 4-col list
    AND leaves enough breathing room for wrapped detail body
    (notes, blockers).
  - 40/60 on 120 cols → 48/72; comfortable.
  - 50/50 over-invests in the list (one row of detail data fits in
    half the screen; we have notes-preview that wants vertical
    runway, not horizontal).

DEGRADATION: when terminal width < 80 cols, collapse to single-
pane LIST-ONLY mode with `Enter` (or `l` / `→`) pushing to
single-pane DETAIL-ONLY (and `Esc` / `h` / `←` returning to
list). Above 80 cols, both panes always visible; cursor on
the left, detail auto-syncs to focused row.

LIST PANE COLUMNS (left, fitted to width):
  status-glyph | id | ROI | owner

  status-glyph: 1-char colour-coded:
      · OPEN          dim "○"
      · IN_PROGRESS   yellow "◐"
      · CLOSED        green "●"
      · REJECTED      red "✗"
      · DEFERRED      dim "⊘"
    (Card sibling drops glyph because it filters to OPEN+ready
    only; popup needs glyph because filter modes show all 5
    statuses.)
  id:   bold cyan, truncate(format.ts L85) to (listWidth - 14).
  ROI:  numeric, coloured per roiBucket (high/mid/low; ∞=green);
        reuse design_card_ready §6 mapping byte-for-byte so
        glance↔drill-in is visually identical.
  owner: em-dash or bold-cyan; same render as ReadyCard §5.

  TITLE IS NOT IN THE LIST. The detail pane gets the full title
  (wrapped). This is the deliberate trade — the list is a NAV
  index, not a summary. The card already shows truncated titles;
  the popup doesn't need to repeat them at the cost of pushing
  the detail pane narrower.

  Cursor row gets an inverse-video highlight (ink Box backgroundColor).

────────────────────────────────────────────────────────────────
2. LIST PANE — DEFAULT FILTER + CYCLE
────────────────────────────────────────────────────────────────

DEFAULT FILTER: `ready` (OPEN, no unsatisfied blockers).

Rationale: Shift+3 is the Ready CARD's drill-in. Defaulting the
popup to `ready` matches the card's contents for the first
keypress; users discover the broader filters via `s`. Shifting
the default to "all" would surprise users who pressed Shift+3
expecting the ready slice they were looking at.

`s` cycles statusFilter through 4 modes:
    ready  →  all  →  in_progress  →  terminal  →  ready
    ^ default                          ^ CLOSED ∪ REJECTED ∪ DEFERRED

  · `ready`        OPEN with all blockers in terminal status
  · `all`          every task in workstream (no filter)
  · `in_progress`  IN_PROGRESS (the "what's actively being worked
                   on" view; useful for orchestrators)
  · `terminal`     CLOSED + REJECTED + DEFERRED (the "what got
                   done / parked" archive view)

  4 modes is the cap; more (e.g. separate REJECTED-only) would
  push the cycle past muscle-memory (4 = press-press-press worst
  case to return to start). Footer sub-line shows the current
  filter: `filter: ready (16/47 tasks)`.

`m` toggles mineOnly orthogonally to statusFilter:
  - OFF (default): show every task matching statusFilter.
  - ON:  intersect with `owner === pane.owner-id`.
         Pane's identity is resolved on popup-open via the same
         path `mu me` uses ($TMUX_PANE → agents.title). Cached
         in PopupProps.extra alongside notes (§7).
  - When pane is the orchestrator (no agents row), mineOnly
    intersects with `owner_id IS NULL AND last_actor === orchestrator`
    — practically: tasks the orchestrator claimed via --self.
    If neither matches, footer toast: "no tasks owned by you in
    this workstream" and the toggle stays on (so the user can
    switch statusFilter to find a non-empty intersection).

`/` enters incremental filter mode (per global in-popup
convention). filterText is matched case-insensitively against
`id` AND `title` (substring, not regex; regex is v0.next). While
filter mode is active, `s` and `m` keys go to the filter buffer
(they're letters); leave filter mode (Esc / Enter) before
re-cycling. Filter persists across `s`/`m` toggles until cleared
with `c` (which on the dashboard clears footer; in-popup it
ALSO clears the active filter, by convention — see ODDITIES).

────────────────────────────────────────────────────────────────
3. DETAIL PANE — CONTENT FOR THE FOCUSED TASK
────────────────────────────────────────────────────────────────

Vertical stack (top → bottom):

  Header (1 line, full-width, bold):
    <id>  <status-glyph status-name>  ROI <n>  i<impact>/e<effort>

  Title block (wrapped, max 4 lines; if longer, truncate +
  `… (full title in mu task show)`):

    <title text wrapped to detailWidth - 2>

  Edges block (2 lines collapsed; expand via `b`):
    blocked by:  <comma-separated blockers, with status colour
                  per id>  · <count> hidden if > 3
    blocks:      <comma-separated dependents>  · <count> hidden if > 3

    On `b` press, this block expands to show ALL blockers and
    dependents one-per-line with their statuses; second `b`
    collapses. NO modal-in-modal (forbidden by design_locked I1).

  Owner / workspace block (2 lines, only when relevant):
    owner:       <name>  (claimed <relTime>)
    workspace:   <path>  · <commitsBehind> behind  ·
                  <dirty? "dirty" : "clean">

    Workspace info comes from snapshot.workspaces (already in
    snapshot per design_sdk_seam — the Workspaces card drinks
    from the same source). `commitsBehind` is the column
    `mu workspace list` exposes; `dirty` is decorateWithStaleness
    output. Skipped when owner is unset OR owner has no
    workspace (the orchestrator-direct `--self` case).

  Notes preview (the longest block, vertical runway):
    notes (<total>):
      <relTime>  <author>
        <last note body, dim if > 8 lines, with first 6 lines + "…">
      <relTime>  <author>
        <previous note body, same truncation>
      <relTime>  <author>
        <antepenultimate note body, same truncation>

    Default = 3 most recent notes. On `f` press, the notes block
    scrolls with j/k inside the detail pane (popup enters
    "notes-scroll" sub-mode; `f` again or Esc exits sub-mode and
    j/k revert to list-cursor movement). NO second popup; we
    stay in one popup and shift what j/k operate on.

────────────────────────────────────────────────────────────────
4. PER-POPUP VERBS — 5 VERBS
────────────────────────────────────────────────────────────────

Drawn from the reserved letter pool (PopupVerbKey from
design_card_iface). Picked for muscle-memory and zero collision
with global {j k g G n N q y c r w / .}:

  Key   Effect                                    Yields (string|void)
  ---   ------                                    -------------
  s     status filter cycle                       void  (mode change)
  m     my-tasks toggle                           void  (mode change)
  b     toggle blockers/dependents expansion      void  (display only)
  f     toggle notes-preview ↔ notes-scroll       void  (display + remap j/k)
  t     yank `mu task tree <id> -w <ws>`          string

REJECTED CANDIDATES (and why):
  - `n`  RESERVED by global (next filter match). Cannot use for
         "notes view"; use `f` (full-notes) instead.
  - `o`  Tempting for "open task in $EDITOR" but the read-only
         contract from design_locked forbids invoking external
         editors from the TUI. Drop it.
  - `e`  Tempting for "expand"; collapsed into `b` (edges) and
         `f` (full notes) which are the only two expandable
         blocks. One key per expansion is enough.
  - `r`  RESERVED by global (refresh); we'd want it for "release"
         but cannot. Release happens via `y` on an
         IN_PROGRESS-owned-by-self row (yank matrix §5).
  - `a`  Tempting for "add note" but writes are forbidden;
         the user yanks `mu task note <id> ...` from elsewhere.
  - `i`  Tempting for "info" but the detail pane IS the info
         pane; nothing to toggle.
  - `:`  Reserved for future command-palette popup
         (design_card_iface §3 R3 hint). Don't burn it here.

5 verbs total. Three are display-only (s, m, b, f — wait, that's
four — three mode toggles + one expansion = four display, one
yank). Let me recount: s, m = filters; b, f = expansions; t =
yank. 5 total. Within the brief's "ship 4-6" budget.

────────────────────────────────────────────────────────────────
5. YANK MATRIX — `y` (focused row), COMPLETE
────────────────────────────────────────────────────────────────

The single most-used surface in the TUI. Every row of the
selected task gets ONE canonical `y` action. Tasks with no
useful action get a footer toast and no yank.

| Status        | Ownership                  | `y` yields (verbatim)                                         | Rationale |
|---------------|----------------------------|----------------------------------------------------------------|-----------|
| OPEN ready    | unowned                    | `mu task claim <id> -w <ws> --self`                           | The canonical "I'll take this." `--self` because the popup user is at-keyboard; if they're a registered worker pane, mu's `claim` resolver still accepts `--self` (ClaimerNotRegisteredError only fires on bare `claim`). Safe-default. |
| OPEN ready    | owned by SELF              | `mu task release <id> -w <ws>`                                | Hand it back to the ready set. (Should be rare — release auto-flips IN_PROGRESS→OPEN, so an OPEN-and-owned row implies a manual `mu sql` poke or a ghost claim. Surface the cleanup verb.) |
| OPEN ready    | owned by OTHER             | `mu task show <id> -w <ws>`                                   | Inspect first. Forcibly releasing someone else's claim is rude AND the reaper exists for the dead-pane case; if the user really needs it, `s` cycles to in_progress and `y` there yields the explicit release with the same caveat. |
| OPEN blocked  | (any owner; blockers OPEN/IN_PROGRESS/REJECTED/DEFERRED) | `mu task wait <blocker_ids...> -w <ws> --first --on-stall exit` | Be notified when unblocked. Lists every UNSATISFIED blocker (REJECTED/DEFERRED still satisfy `wait` because terminal — but blockers in those statuses also un-block the task itself, so this row wouldn't be classified `blocked`). The `--on-stall exit` flag follows the dispatch-loop convention (skill: "the unattended-orchestrator escape"). |
| IN_PROGRESS   | owned by SELF              | `mu task close <id> -w <ws> --evidence "..."`                 | Finish. The `--evidence "..."` is a placeholder string the user fills in their shell; trailing `"..."` is intentional (paste-and-edit). |
| IN_PROGRESS   | owned by OTHER             | `mu task show <id> -w <ws>`                                   | Inspect, NOT release. (Argued below.) |
| IN_PROGRESS   | unowned (rare race)        | `mu task claim <id> -w <ws> --self`                           | Take the orphaned in-flight task. (Reaper should have OPEN'd it; if it didn't yet, this is the next-best.) |
| CLOSED        | any                        | `mu task open <id> -w <ws>`                                   | Reopen by mistake. |
| REJECTED      | any                        | `mu task open <id> -w <ws>`                                   | Un-reject (the implementer typed `mu task open` because there's no separate `un-reject`; same verb). |
| DEFERRED      | any                        | `mu task open <id> -w <ws>`                                   | Revisit a parked task. |

ARGUMENT FOR IN_PROGRESS-OWNED-BY-OTHER → `show` (NOT `release`):

  - `release` is destructive: it clears another agent's owner
    field, which (a) silently invalidates that agent's notes
    that reference "I claimed this", (b) the reaper exists for
    the genuine dead-pane case, (c) `release` requires no
    confirmation (idempotent), so a fat-fingered `y` could
    quietly steal an active worker's task.
  - `show` is read-only and is the right next step: see who
    owns it, see notes (which usually say what they're doing),
    decide whether to ping the owner or kick the pane.
  - For the rare legitimate case (e.g. owner is a known-dead
    pane the reaper missed), the user can `s` cycle to
    in_progress, eyeball, and run `mu task release` from their
    shell. Two extra keystrokes, infinite safety.

  ALTERNATIVE (rejected): yank `mu task release <id>` always
  and trust the user. We pick safety; the read-only philosophy
  of the TUI biases us toward "the dangerous action requires
  the user to type it themselves."

EMPTY/UNKNOWN STATUS (defensive): footer toast "no yank action
for status <X>" and don't touch clipboard. Should be unreachable
because TaskRow.status is a sealed enum.

THE WORKSTREAM IN THE YANK STRING is the popup's workstream
(PopupActCtx.workstream), not the task's — these are equal in
v0 (no cross-workstream popups), but the rule per
design_yank_flow is "always include -w" so qualified pasting
works from any shell.

────────────────────────────────────────────────────────────────
6. MULTI-YANK SEQUENCING — CONFIRMED OK
────────────────────────────────────────────────────────────────

Per design_yank_flow, each `y` overwrites the footer. The Tasks
popup is the most-likely place a user will yank multiple
commands in sequence (e.g. yank claim, paste in shell, run, come
back, yank another claim for parallel work). Confirmed
acceptable because:

  1. The clipboard itself only holds ONE command at a time
     (system clipboard is single-slot); overwriting the footer
     is consistent with that — the footer is a mirror of "what
     you most recently yanked".
  2. The 2-second toast covers the interval where the user looks
     at the toast (confirms `[copied]`), tabs to a shell, and
     pastes. Sequential yanks don't need each previous toast to
     persist; they need each NEW toast to fire on press.
  3. The footer survives popup-close (per
     design_yank_flow §3 + design_popup_lifecycle §I3 contract:
     popup yanks REPLACE the saved footer so they persist after
     Esc). So a multi-yank sequence ending in popup-close shows
     the LAST yank on the dashboard footer — consistent with
     the clipboard.
  4. Killing the toast on next-keypress (per design_yank_flow §3
     "DISAPPEAR POLICY") means a rapid `y → j → y` lets the
     second `y` show its own toast cleanly without piling up.

Carve-out: rapid double-tap of `y` on the SAME row (e.g. user
checking the clipboard worked) re-fires the same yank — that's
fine; both clipboard write and toast are idempotent. No special
debounce needed.

────────────────────────────────────────────────────────────────
7. ON-OPEN DATA — onOpen FETCHES NOTES (LAZY, BOUNDED)
────────────────────────────────────────────────────────────────

snapshot.tasks already has every TaskRow with edges (per
design_sdk_seam — confirmed by design_card_ready §1, which
relies on snapshot.ready being a pre-filtered subset of
snapshot.tasks). So:

  PROVIDED FOR FREE BY EVERY-TICK SNAPSHOT:
  - id, title, status, owner_id, impact, effort_days, created_at,
    updated_at  (TaskRow)
  - blocked_by[], blocks[]  (edges from snapshot)
  - workspace info per agent (snapshot.workspaces)

  REQUIRES onOpen (Popup<TSlice, TasksPopupExtra> per
  design_card_iface §2):

    interface TasksPopupExtra {
      /** Per-task notes, keyed by task id. Lazy-populated:
       *  empty on open; filled by onOpen for the FIRST visible
       *  page of tasks (rowCap from §1), then top-up on cursor
       *  move (§7b). Cap notes per task at NOTES_CAP=20 — old
       *  notes are accessible via the yanked
       *  `mu task notes <id> -w <ws>` (a v0.next verb might be
       *  added; punted).                                       */
      notes: Map<string, NoteRow[]>;

      /** Pane self-id (resolved via $TMUX_PANE + agents lookup).
       *  Used by the `m` mineOnly toggle. null when the user
       *  is the orchestrator. Cached so we don't re-resolve
       *  every keypress.                                       */
      paneOwnerId: string | null;
    }

  POPULATION POLICY (the "lazy on cursor-stop" requirement):

  - On popup mount: fetch notes for the FIRST visible page of
    tasks (one batched `listTaskNotes(ids: string[])` call —
    needs a small SDK helper if it doesn't exist; otherwise
    fall back to N sequential `notes(id, --tail NOTES_CAP)`
    calls inside the onOpen Promise; ~1ms per call so even 20
    rows is sub-frame).
  - On cursor stop (cursor settles on row R for >150ms — DEBOUNCE,
    not on every j/k press): if extra.notes.get(R.id) is empty,
    fetch THIS task's notes and merge into the Map. The 150ms
    debounce avoids a flood of fetches when the user holds j to
    scroll. Implemented with a useEffect on cursorIndex+150ms
    setTimeout that clears on cursor change.
  - On filter change (s/m/`/`): notes Map is preserved (it's
    keyed by task id, not row index); newly-visible rows that
    aren't cached fall back to the cursor-stop path on first
    landing.
  - On tick (snapshot refresh): notes Map is NOT refetched
    every tick — that would defeat the lazy contract. Instead,
    the popup subscribes to `mu log --kind event` filtered on
    `kind = 'task_note'` if the implementer wants live-update
    (v0.next; v0 ships notes-as-of-popup-open and refreshes
    ONLY on cursor-stop. Documented limitation; ODDITY.)

  TasksPopupExtra is restored via PopupHost's onOpen contract
  per design_popup_lifecycle §1; on close, the Map is GC'd.

────────────────────────────────────────────────────────────────
8. EMPTY STATE + ERROR PATH
────────────────────────────────────────────────────────────────

EMPTY STATE (no tasks match the active filter, after `s` /
`m` / `/` are applied):

  Render the detail pane with a single dim line:
    "no tasks match  — filter: <statusFilter>  mine: <on|off>
     /'<filterText>'"
  And in the list pane:
    "(empty)"  centered, dim.
  `y` becomes a no-op + footer toast: "no row to yank".
  Cursor commands (j/k/g/G) all no-op silently.
  `s` / `m` / `/` continue to work so the user can broaden the
  filter.

  Special case "workstream has zero tasks at all" (snapshot.tasks
  is []): render
    "no tasks in <ws>. Try `mu task add -w <ws> --title '...'`."
  with `y` yanking the literal `mu task add -w <ws> --title ""`
  string (unowned-empty-state suggestion-yank, parallel to the
  ReadyCard §4 empty-state behaviour).

ERROR PATH (the popup render throws — e.g. malformed snapshot,
SDK shape drift):

  Routed through PopupHost's React error boundary
  (design_popup_lifecycle §1 + §6). The popup unmounts, the
  dashboard restores via saved state, and footerLine becomes
  the crash toast: "tasks popup crashed: <message>". The user
  presses Shift+3 again to retry; if it crashes again, the
  toast surfaces (footer is sticky until next yank or `c`).

  This is the SAME error path every popup uses; no special
  handling here — but worth noting because the Tasks popup has
  the most surface area (5 verbs, filter modes, notes fetch)
  and is the most likely to surface a regression. Add a
  smoke-test that mounts the popup against an empty snapshot
  AND a snapshot with one row in each of the 5 statuses (§9).

────────────────────────────────────────────────────────────────
9. TESTS
────────────────────────────────────────────────────────────────

NEW: test/cli/tui/popups/tasks.test.tsx

Required cases (the implementer ships at least these):

T1. CANONICAL YANK: `y` on a ready task → claim string.

    const snapshot = makeSnapshot({
      workstream: "tui",
      tasks: [
        { id: "design_x", status: "OPEN", owner: null,
          impact: 70, effort_days: 1, blockers: [] },
      ],
    });
    const yank = vi.fn();
    const { stdin } = renderPopup(<TasksPopup
      data={snapshot} extra={{ notes: new Map(), paneOwnerId: null }}
      width={120} height={40} close={() => {}} yank={yank}
      tickMs={1000} />);
    // First task is auto-focused.
    stdin.write("y");
    expect(yank).toHaveBeenCalledExactlyOnceWith(
      "mu task claim design_x -w tui --self"
    );

T2. Yank matrix coverage (parametric): one test per row of the
    §5 matrix, asserting the `y` output for that (status,
    ownership, blocked?) cell. 8 rows × 1 assertion each.

T3. `s` cycles statusFilter through 4 modes; ASSERT on the
    filtered list count after each press given a snapshot with
    a known mix.

T4. `m` toggles mineOnly; with paneOwnerId="worker-1", assert
    that the list shrinks to only-tasks-where-owner=worker-1.

T5. `/` enters filter mode; `mock` then ESC restores full list,
    ENTER accepts and exits filter mode keeping the substring
    filter active.

T6. `b` expands the edges block; assert the rendered output
    contains every blocker id (not the truncated list).

T7. `f` enters notes-scroll mode; ASSERT that subsequent j/k
    scroll the notes block, NOT the list cursor; second `f`
    exits and j/k revert.

T8. Empty state: snapshot with zero tasks renders the
    `mu task add` suggestion; `y` yanks it.

T9. Error boundary: a snapshot crafted to throw (e.g.
    impact=NaN feeding ROI) renders the crash toast and does
    NOT propagate.

T10. On-open lazy notes: assert that mounting with extra.notes
    empty and a cursor settled on row 0 for 150ms triggers ONE
    notes fetch (vi.fn spy on the SDK seam), and that holding
    `j` for 5 rows in <150ms triggers ZERO fetches (debounce).

T1 alone satisfies the brief's required test (`y` on a ready
task yields `mu task claim <id> -w <ws>` with the right id).
T2 covers the yank matrix completely; T3-T5 cover the filter
state machine; T6-T7 cover the expansion verbs; T8-T9 cover
edge / error paths; T10 covers the lazy-fetch contract.

================================================================
DECISION (recap, suitable for implementation tickets)
================================================================

D1. Layout: two-pane, 40/60 (list/detail) above 80 cols;
    collapse to single-pane list-only ↔ detail-only below.

D2. List columns: status-glyph | id | ROI | owner. Title NOT
    in list; lives in detail pane only.

D3. Default filter: `ready`. Cycle key `s` → ready → all →
    in_progress → terminal → ready.

D4. Mine-toggle key `m`; orthogonal to statusFilter.

D5. Verbs (5): s (status filter), m (mine toggle), b (edges
    expand), f (full-notes scroll), t (yank `mu task tree`).

D6. Yank matrix: 10 rows in §5; default `y` on
    IN_PROGRESS-owned-by-other yields `mu task show`, NOT
    release (safety > convenience).

D7. Multi-yank: each `y` overwrites footer; confirmed
    acceptable.

D8. On-open: fetch notes for first visible page; lazy on
    cursor-stop (150ms debounce); notes Map cached in
    PopupProps.extra.

D9. Empty-state: dim message + suggestion-yank when the
    workstream has zero tasks.

D10. Error path: routed through PopupHost error boundary;
     toast on dashboard footer.

================================================================
NEXT (for the implementer)
================================================================

- Build src/cli/tui/popups/tasks.tsx per the §1-§3 spec.
- Wire src/cli/tui/popups/registry.ts to register Popup with
  id=3, subject="ready", verbs as in §4.
- Confirm or add SDK helper `listTaskNotes(ids: string[]):
  Map<string, NoteRow[]>` for the batched first-page fetch.
  If a per-id loop is fine perf-wise, skip the helper.
- Add `paneOwnerId` resolver inside src/cli/tui/state.ts (or
  reuse the resolver `mu me` uses) and pass via PopupProps.extra.
- Land tests in T1-T10 order (T1 is the brief's required test).

================================================================
VERIFIED
================================================================

- Verb keys {s m b f t} all in PopupVerbKey pool from
  design_card_iface §2; none in global-reserved {j k g G n N q
  y c r w}; none in punctuation reserved {/ : .}.
- `mu task open` does cover REJECTED → OPEN un-reject (verified
  via `mu task open --help` — no separate verb; status flips
  forward to OPEN regardless of prior).
- `mu task wait <ids> -w <ws> --first --on-stall exit` is the
  documented blocker-yank shape (verified via `mu task wait
  --help` AND skill: "the unattended-orchestrator escape").
- snapshot.tasks already includes blockers/dependents per
  design_sdk_seam + design_card_ready §1; no schema growth
  needed for the popup.

================================================================
ODDITIES
================================================================

O1. The `n` key is REJECTED for "notes" because global says it
    means "next filter match." Standard vim/less convention.
    `f` (full notes) was the obvious second pick and got it.

O2. The `c` key on the dashboard clears the footer; in-popup,
    by global convention, it should clear the active filter
    (analogous to `:noh` in vim). The Tasks popup honours this:
    pressing `c` while filterText is non-empty clears the
    filter; pressing `c` while no filter is active is a no-op
    (no footer to clear because in-popup the footer is the
    popup's toast/footer, not the dashboard's). Worth flagging
    for designer-1 to confirm in a follow-up to
    design_global_keymap.

O3. The yank for IN_PROGRESS-owned-by-other is `mu task show`,
    not `mu task release`. Documented argument in §5; mention
    in the help overlay so users aren't surprised.

O4. Notes are NOT live-refreshed on tick (they're fetched on
    open + on cursor-stop). If a worker drops a note while the
    user is staring at the popup with the cursor parked on that
    task, the user won't see the note until they cursor-off and
    back. Acceptable for v0; v0.next may subscribe to event log
    for `task_note` events.

O5. The 40/60 split is the default; we don't expose a toggle
    (would require another verb-key and adds config). If real
    users hit the friction, add `=` (but `=` is global +tickMs)
    or `[` / `]` (uncovered punctuation). Punted.

O6. The empty-state suggestion `mu task add -w <ws> --title ""`
    yanks with a literal empty `""` for the user to fill in
    their shell. Same paste-and-edit ergonomics as the
    `--evidence "..."` placeholder in §5's close-yank.

O7. Below 80 cols, single-pane mode adds an extra navigation
    layer (Enter/← to swap panes). Not unit-tested in T1-T10;
    the implementer should add a width-degradation snapshot
    test if the existing test infra supports it. If it
    introduces flakiness, defer to integration testing.
```

### #2 by "designer-1", 2026-05-11T11:24:04.111Z

```
CLOSE: Tasks popup design done; full yank matrix included
```
