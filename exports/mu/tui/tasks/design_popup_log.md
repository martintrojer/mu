---
id: "design_popup_log"
workstream: "tui"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "scout-2"
created_at: "2026-05-11T10:45:07.674Z"
updated_at: "2026-05-11T11:26:01.099Z"
blocked_by: ["design_card_log", "design_popup_lifecycle"]
blocks: ["design_complete"]
---

# Design Log popup: full event timeline with filter by kind/agent

## Notes (2)

### #1 by "scout-2", 2026-05-11T11:25:58.243Z

```
Activity-log fullscreen popup (Shift+4) — full design.

================================================================
FILES
================================================================
- src/logs.ts            (listLogs / afterSeq cursor / latestSeq /
                          EVENT_VERB_PREFIXES / displayEventPayload /
                          parseClaimEventActor)
- src/cli/log.ts         (current `mu log` reader; behaviour parity ref)
- src/cli/state.ts L630-686 (formatHudRecentTable + colorEventPayload —
                              the static HUD widget being deleted; this
                              popup absorbs every column it dropped)
- design_locked          (Shift+4 = popup; in-popup convention; F1 poll)
- design_card_iface      (Card<TSlice>/Popup<TSlice,TExtra> contract;
                          PopupProps; onOpen; verbs; PopupVerbKey pool)
- design_popup_lifecycle (single-popup invariant; saved-state restore;
                          on-open useEffect; ErrorBoundary; popup tick)
- design_card_log        (sibling card; what the CARD gives up — scroll,
                          pause, kind, actor, full payload, ISO ts —
                          and that this popup MUST surface them)
- design_yank_flow       (PopupProps.yank signature; toast+footer; the
                          "no yank for this row" footer-toast convention)
- design_global_keymap   (in-popup conv: j/k g/G / Esc y ?; reserved-
                          letter pool {a b d e f h i l m o p s t u v x z};
                          / opens filter mode by default)
- design_sdk_seam        (WorkstreamSnapshot.events: LogRow[];
                          classifyEventVerb co-located with EVENT_VERB_PREFIXES
                          in src/logs.ts; LoadWorkstreamSnapshotOptions.eventLimit)
- design_poll_loop       (afterSeq cursor; popup owns its own setInterval
                          driven by shared tickMs; freeze-on-hide is
                          irrelevant when popup is open)

================================================================
COMMANDS
================================================================
- mu task notes design_locked            -w tui
- mu task notes design_card_iface        -w tui
- mu task notes design_popup_lifecycle   -w tui
- mu task notes design_card_log          -w tui
- mu task notes design_yank_flow         -w tui
- mu task notes design_global_keymap     -w tui
- read src/logs.ts  src/cli/log.ts  src/cli/state.ts L630-686

================================================================
FINDINGS
================================================================
1. The card already commits to a 1-column "+ago + verb-coloured payload"
   tail. Everything else — full ISO ts, seq, kind, actor (source),
   full payload, scroll, pause, filtering — is the popup's job.

2. listLogs(db, {workstream, kind:"event", afterSeq, limit}) is a
   sub-ms call (seq is AUTOINCREMENT PK). The popup can fetch a far
   larger window than the card (~1000 events) at open without breaking
   the 100ms tick floor. Then it stays on the SAME afterSeq cursor as
   the dashboard: incremental deltas only.

3. EVENT_VERB_PREFIXES (src/logs.ts L346-393) covers every verb the
   SDK emits today. classifyEventVerb (per design_sdk_seam) is the
   colour seam; the popup uses it identically to the card.

4. Event rows carry seq / source / kind / payload / createdAt. The
   payload tail format depends on emitter; for `task.claim	...`
   structured payloads we use displayEventPayload(payload) (the same
   helper the static HUD already uses) before colourising.

5. Yank: events are records of past actions, not active commands.
   But the FIRST TOKEN of every payload is a verb in the form
   "<noun> <action> <id>" (e.g. "task close X", "agent spawn Y",
   "workspace refresh Z"). We can extract <noun, id> robustly by
   prefix-matching EVENT_VERB_PREFIXES + grabbing the next whitespace
   token. That gives us a "jump to" CLI command for task-* and
   agent-* verbs; everything else is no-yank.

6. design_popup_lifecycle §5 says popups own their own setInterval at
   the shared tickMs. design_poll_loop §1 says listLogs in the
   snapshot is incremental (afterSeq seeded at first tick). The
   popup's "tick" therefore needs no extra fetch beyond the snapshot
   composer — it just consumes snapshot.events as the snapshot
   refreshes, EXCEPT for the on-open backfill which is one-shot.

================================================================
DECISION
================================================================

────────────────────────────────────────────────────────────────
1. LAYOUT — single-pane scrollable list. NOT split-pane.
────────────────────────────────────────────────────────────────

Rejected: list-left + selected-event-detail-right. Three reasons:
  (a) Event payloads today are SHORT (median <80 chars per
      `mu log -n 50` sampling). A right-pane "detail" view of a
      one-line payload is wasted real estate.
  (b) The split-pane pattern needs a stable "selected row" identity
      across tick refreshes (new events arrive, indices shift). That
      complexity has zero value when the detail itself is one line.
  (c) design_popup_lifecycle §5 says popup tick refreshes the SAME
      snapshot — the right pane would have to track "did the selected
      event scroll out of the window?" and recover. Single-pane
      sidesteps the entire question.

If a future event payload grows multi-line (e.g. structured note
contents), a right-pane preview is a v0.next promotion. v0 ships
single-pane.

Layout sketch (full terminal width × full height, minus 2 rows of
chrome):

  ┌─ Activity log — workstream: tui ─────────────────────────[?]┐
  │ #seq  ts                  agent       kind   payload         │   ← 1 header row
  ├──────────────────────────────────────────────────────────────┤
  │ 1247  10:42:17  worker-1    event  task close X-7  [cyan]    │   ← list area
  │ 1248  10:42:19  reviewer-1  event  task open  X-8  [cyan]    │   ← (height - 4)
  │ 1249  10:43:01  system      event  agent spawn s2  [cyan]    │     scrollable rows
  │ ...                                                          │
  ├──────────────────────────────────────────────────────────────┤
  │ tail: live | 248/1003 events | filter: -- | / e m t y G ?    │   ← 1 footer row
  └──────────────────────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────
2. PER-ROW FORMAT
────────────────────────────────────────────────────────────────

Five columns, left-aligned, fixed-width except payload:

  #seq    ts        agent (source)   kind     payload
  ────    ────────  ──────────────   ─────    ──────────────────────
  6 ch    8 ch      14 ch            6 ch     fill-width

Field details:

  #seq    : right-pad 6 (today's max real-world is ~10⁴; reserve to
            10⁵ which gives us ~7 ch but 6 is fine for UI; on overflow
            the column auto-grows, layout reflows once and sticks).
            Dim ANSI (not the user's primary attention).
  ts      : "HH:MM:SS" local time (NOT ISO). Reasoning: events shown
            here span minutes-to-hours, day boundaries are surfaced
            via "+ago" tooltip on selection (see §5 verbs). Ink
            <Text dimColor>.
  agent   : source field from LogRow. Truncate to 14 with ellipsis if
            longer. Colour: green if source === self (per `mu me`),
            dim otherwise. (See §5 `m` verb for filter on this.)
  kind    : column SHOWN here even though the card hides it, because
            this popup is the place where users notice
            broadcast/message vs event noise. v0 uses kind="event"
            ONLY (matches design_card_log fetch), so this column
            today shows "event" on every row. The column EXISTS so
            that a future multi-kind feed (info+event+broadcast)
            renders correctly without a layout reflow. Hidden by
            default; auto-shown when the snapshot contains ≥2 distinct
            kinds. (See §5 `e` verb.)
  payload : displayEventPayload(payload) → classifyEventVerb → split
            into <verb-token, rest>. Verb token rendered in cyan
            (per design_card_log §6 uniform-cyan rule); rest in
            default fg. Wrap at column boundary; overflow lines
            indented by (5 columns left margin + 2) chars so the
            wrap is visually attached to its parent row.

Selected row is reverse-video (ink <Text inverse>) across all 5
columns. The selection cursor exists EVEN when tail-mode is "live"
(tail just keeps the cursor visually anchored at the bottom row;
see §4).

────────────────────────────────────────────────────────────────
3. FILTERING — `/` enters filter mode
────────────────────────────────────────────────────────────────

Per the in-popup convention, `/` opens filter mode. For the LOG
popup, the filter is a SINGLE substring match against a synthesised
"haystack" string per row, which is the concatenation:

  haystack = source + " " + kind + " " + displayEventPayload(payload)

Match is case-INSENSITIVE substring. No regex (premature; v0.next
if a real user asks). No fuzzy (Levenshtein in a hot poll loop is
the wrong place to spend cycles).

The single-string approach lets users type:
  `/task          → matches any payload starting with task.*
  `/worker-1`     → matches any row from worker-1 OR any payload
                    mentioning worker-1 (claim/release/spawn). This
                    is the more useful behaviour than two separate
                    filters.
  `/spawn         → matches "agent spawn worker-1", "agent spawn s2"
  `/event         → matches every kind=event row (today: all of them)

Filter mode UX (per design_global_keymap):
  - `/` opens an inline input on the footer row:
        " /text_so_far▮                                    Esc=cancel"
  - Typing narrows the LIST live (incremental). The list shows ONLY
    matching rows; non-matching rows are hidden (NOT greyed out —
    that wastes vertical space). The "248/1003" footer counter
    updates live: "12/1003 (filter: task)".
  - Enter accepts the filter and exits input mode (filter STAYS
    applied; cursor returns to the list).
  - Esc CANCELS the filter (clears it AND exits input mode). Second
    Esc closes the popup. (Per design_global_keymap.)
  - n / N (per the convention) jump to next/prev match WITHIN the
    visible list — but since non-matches are HIDDEN, n/N degrade to
    "move down/up by one matching row" which is just j/k. Acceptable
    redundancy; the convention requires n/N exist.
  - Filter survives tail-arriving rows: new events that don't match
    are not surfaced; new events that DO match append to the list as
    normal (and trigger auto-scroll if at-bottom; see §4).

PER-AGENT and PER-KIND fast paths: see §5 (`m` and `e`). They're
not part of the `/` filter contract; they're separate toggles that
COMPOSE with `/` (`/` runs against the post-`m`/`e` filtered set).

────────────────────────────────────────────────────────────────
4. AUTO-TAIL — scroll-pause contract
────────────────────────────────────────────────────────────────

State machine (popup-local; lost on close, per lifecycle):

  type TailState = { mode: "live"; cursor: "bottom" }
                 | { mode: "paused"; cursor: number /* row index */ };

  - Initial state on popup open: { mode: "live", cursor: "bottom" }.
    Cursor is rendered on the LAST row of the visible window; the
    list scrolls so the last row is at the bottom of the viewport.

  - On poll tick (tickMs), the popup receives a fresh snapshot. New
    rows arrived iff snapshot.events.length > prev.events.length OR
    snapshot.events[last].seq !== prev.events[last].seq.

      if (mode === "live"):
        - append new rows to the visible list.
        - keep cursor anchored at the new bottom (cursor = "bottom").
        - viewport scrolls so newest row is the last visible row.

      if (mode === "paused"):
        - append new rows to the visible list (they exist; user
          can scroll DOWN to see them, OR `G` to jump and resume).
        - DO NOT change viewport scroll position.
        - DO NOT change cursor row index.
        - footer toast updates: "tail paused; G to resume — N new
          events since pause" where N = snapshot.events.length -
          (the prev.events.length captured at pause-time).

  - Transition live → paused: any of the following keypresses while
    mode === "live":
        k        (move cursor up)
        ↑
        Ctrl-U   (half-page up)
        PgUp     (full-page up)
        g        (jump to first row)
    All of them mean "user scrolled up"; we capture
    pause_baseline = snapshot.events.length, then set
    { mode: "paused", cursor: <new index> }.

  - Transition paused → live: any of the following:
        G        (jump to last row — explicit "back to tail")
        Shift+G  (alias for G; keymap doesn't bind this but consistent
                  with vim muscle memory; safe to alias)
    Sets mode = "live", cursor = "bottom"; viewport scrolls to the
    new bottom; toast clears.

  - j / ↓ / Ctrl-D / PgDn while mode === "paused": move cursor
    down. If the cursor reaches the LAST row of the snapshot AND
    the user is at the bottom of the viewport, AUTO-PROMOTE to
    { mode: "live", cursor: "bottom" }. (Reaching the bottom is
    the implicit "I want to tail again" gesture; matches `less +F`
    behaviour.)

  - Filter changes (§3) preserve mode. If the filter eliminates all
    rows below the cursor, the cursor moves to the last visible row;
    mode stays paused (because the user is not at the snapshot
    bottom in the unfiltered sense). G resumes tail in either case.

Footer copy:

  mode="live"   : "tail: live | 248/1003 events | filter: -- | …"
  mode="paused" : "tail: PAUSED (G to resume — 12 new) | 248/1003 …"
                  (the "12 new" count is computed from
                   snapshot.events.length - pause_baseline; updates
                   live as new events arrive)

Implementation note: the popup MUST NOT clone snapshot.events into
a local list. It always renders snapshot.events directly; the tail
state only controls VIEWPORT (scroll offset) and cursor position.
This guarantees no drift between popup and dashboard data and means
re-entering live mode is just "scroll to end", not a re-fetch.

────────────────────────────────────────────────────────────────
5. PER-POPUP VERBS
────────────────────────────────────────────────────────────────

From the reserved-letter pool {a b d e f h i l m o p s t u v x z}
plus the global G/n/N already in the convention.

  Key   Action
  ───   ───────────────────────────────────────────────────────────
  t     toggle tail mode (force-pause / force-resume).
        - If currently mode="live" → set mode="paused", capture
          pause_baseline.
        - If currently mode="paused" → set mode="live",
          cursor="bottom", scroll to end.
        Useful for: pause-without-scrolling-up (e.g. "I want to
        read the current bottom row carefully without it vanishing").
  
  e     cycle event-kind filter. v0 the snapshot is hardcoded to
        kind="event" (per design_card_log + design_poll_loop §1),
        so this verb is a NO-OP today and shows footer toast:
        "kind filter: only 'event' available in v0; v0.next adds
        message/broadcast." RESERVE the key now for muscle memory.
  
  m     toggle "my events" filter (filter to source === self).
        - "self" resolves via getAgentByPane($TMUX_PANE) at popup
          open AND cached on the popup props (NOT re-resolved every
          tick — pane identity doesn't change mid-session).
        - If self resolution returns null (orchestrator pane, not a
          managed agent), the verb shows footer toast: "no self;
          launch from an agent pane to use 'my events' filter".
        - Composes with `/` filter: m AND / both must match.
        - Footer shows "filter: my=worker-1 | /task" when both active.

  c     CLEAR all filters (`/` substring + `m` toggle + future `e`).
        Convenience verb; the global `c` (clear footer) is dashboard-
        only per design_global_keymap, so reusing `c` here for
        "clear filters" doesn't shadow anything. NOT in the global
        in-popup convention; this is per-popup.

NOT bound in v0 (rejected, with reasons):
  - p     "pause" — `t` already toggles; a separate p is redundant.
  - f     "follow" — same as t/G; redundant.
  - s     "sort" — events are seq-ordered; no other useful order.
  - x     "delete event" — agent_logs is append-only; would lie.
  - a     "actor filter" — `m` covers self; per-other-actor filter
          can be done via `/<agent-name>` (substring).

Reserved-pool letters consumed: {t, e, m, c} → 4 of 18.

────────────────────────────────────────────────────────────────
6. YANK INTENTS — `y` matrix
────────────────────────────────────────────────────────────────

`y` extracts a "jump to context" CLI command from the focused
event row. Implementation: prefix-match payload against
EVENT_VERB_PREFIXES, then take the next whitespace-delimited token
as the entity id.

  Event verb prefix (payload startsWith)        Yank emits
  ────────────────────────────────────────      ─────────────────────────
  task add <id> ...                             mu task show <id> -w <ws>
  task note <id> ...                            mu task notes <id> -w <ws>
  task status <id> ...                          mu task show <id> -w <ws>
  task claim <id> ...                           mu task show <id> -w <ws>
  task release <id> ...                         mu task show <id> -w <ws>
  task update <id> ...                          mu task show <id> -w <ws>
  task delete <id> ...                          mu task show <id> -w <ws>
                                                 (will error if deleted; ok)
  task reap <id> ...                            mu task show <id> -w <ws>
  task block <id> ...                           mu task show <id> -w <ws>
  task unblock <id> ...                         mu task show <id> -w <ws>
  task reparent <id> ...                        mu task show <id> -w <ws>
  agent spawn <name> ...                        mu agent show <name> -w <ws>
  agent close <name> ...                        mu agent show <name> -w <ws>
  agent free <name> ...                         mu agent show <name> -w <ws>
  agent adopt <name> ...                        mu agent show <name> -w <ws>
  agent kick <name> ...                         mu agent show <name> -w <ws>
  agent stalled <name> ...                      mu agent show <name> -w <ws>
                                                 (per src/tasks/wait.ts emitter)
  workspace create <name> ...                   mu workspace path <name> -w <ws>
                                                 (more useful than "workspace show"
                                                  which doesn't exist; `path` cd's)
  workspace free <name> ...                     mu workspace list -w <ws>
                                                 (the workspace is gone; list-it-up)
  workspace refresh <name> ...                  mu workspace path <name> -w <ws>
  workspace recreate <name> ...                 mu workspace path <name> -w <ws>
  workstream init <name> ...                    mu state -w <name>
  workstream destroy <name> ...                 (no yank — workstream gone;
                                                 footer toast: "workstream
                                                 destroyed; nothing to yank")
  workstream export <name> ...                  mu state -w <name>
  workstream import <name> ...                  mu state -w <name>
  archive create <label> ...                    mu archive show <label>
  archive delete <label> ...                    (no yank — archive gone)
  archive add <label> ...                       mu archive show <label>
  archive remove <label> ...                    mu archive show <label>
  archive export <label> ...                    mu archive show <label>
  (no prefix match — message/broadcast row,     (no yank; footer toast:
   or unknown verb)                              "no yank for this event")

Workstream resolution: every yank that takes `-w <ws>` uses the
event row's workstreamName field (LogRow.workstreamName) — NOT the
TUI's currently-bound workstream. Reasoning: cross-workstream events
appear in `--all-workstreams` mode (future); the yank should jump
to the event's actual home, not the TUI's current binding. For v0
where the TUI is single-workstream, the two are always equal; the
distinction matters for v0.next.

If LogRow.workstreamName is null (machine-wide events: `archive *`,
`workstream destroy`), drop the `-w` flag — those verbs work
without it.

Per design_yank_flow: the yank() call writes to clipboard if
available + transient toast in popup + persistent footer line on
dashboard ("last: mu task show X -w tui [copied]"). The "no yank"
cases use a footer toast WITHOUT clipboard write, and DO NOT
overwrite the persistent dashboard footer.

Implementation: the prefix → verb-template mapping lives in a
single table in src/cli/tui/popups/log.tsx (or the TUI's yank
helper). When a new EVENT_VERB_PREFIXES entry lands without a yank
template, the popup falls through to the "no yank for this event"
toast — safe default. Add a unit test (per §10) that walks
EVENT_VERB_PREFIXES and asserts every entry either yields a yank
or is on an explicit "intentional no-yank" allow-list. Prevents
silent yank gaps when new SDK verbs land.

────────────────────────────────────────────────────────────────
7. ON-OPEN DATA — backfill once, then incremental
────────────────────────────────────────────────────────────────

Recommend: BACKFILL ON OPEN to a higher limit; do NOT scroll-back-
loads-more.

Mechanism:
  - The dashboard's snapshot.events caps at design_poll_loop §1's
    EVENT_N=200 (the card needs at most height-2 rows; 200 is the
    cushion).
  - The Log popup's onOpen hook (per design_card_iface §6 +
    design_popup_lifecycle §4) fetches a deeper window:

      onOpen: async (db, workstream) => {
        const events = listLogs(db, {
          workstream,
          kind: "event",
          limit: 1000,         // popup backfill depth
        });
        // listLogs returns oldest-first when called this way
        // (see src/logs.ts L172: rowsDesc.reverse()).
        return { events };
      };

  - PopupExtra<LogPopup> = { events: LogRow[] }.
  - The popup render uses extra.events (the deep backfill) AS THE
    INITIAL list, NOT snapshot.events. After mount, the popup's
    own tick (per design_popup_lifecycle §5) ALSO subscribes to
    snapshot.events deltas, appending NEW rows (seq > max(extra.events
    seq)) to its visible list.
  - On popup close, extra.events is dropped (per design_popup_lifecycle
    §4: "no extra cache across open/close"). Re-opening re-fetches
    1000 fresh.

Rejected: scroll-back-loads-more. Three reasons:
  (a) listLogs at limit=1000 is sub-millisecond on a typical
      workstream (seq is the AUTOINCREMENT PK; the index is
      effectively free per design_poll_loop §1).
  (b) Lazy-load needs a "show me page N going back" SDK call we
      don't have (`since` goes FORWARD from a cursor, not back).
      Adding `before:<seq>` to ListLogsOptions for one consumer is
      a violation of the design_sdk_seam ≥2-callers rule.
  (c) The complexity of "viewport intersection observer in ink"
      to detect "user scrolled past the top, fetch more" is
      WAY out of scope for v0 simple-poll.

If 1000 isn't enough (a real user reports it), v0.next adds
a `--log-backfill <N>` env var (MU_TUI_LOG_BACKFILL=10000) — NOT
a config file (anti-feature pledge), an env var. Not v0.

────────────────────────────────────────────────────────────────
8. TICK SEMANTICS
────────────────────────────────────────────────────────────────

Per design_poll_loop and design_popup_lifecycle:
  - The popup runs its OWN setInterval at tickMs (the same shared
    state the dashboard +/-/=/0 controls; live-mutates either
    surface).
  - Every tick: the same snapshot composer the dashboard uses runs
    against the popup's afterSeq cursor (seeded at popup open from
    extra.events[last].seq, NOT from the dashboard's afterSeq —
    they may diverge if the popup backfilled deeper than the card).
  - Snapshot delivers incremental events (afterSeq cursor); popup
    appends them to its local visible list AND to extra.events
    (so the on-open backfill stays current).
  - Dashboard tick is FROZEN while popup is open (per
    design_popup_lifecycle §5); on close, dashboard fires
    setNonce++ for one immediate refresh.

Performance: 1000 events backfill (~30KB) + sub-ms per-tick delta
read. Well under the 100ms tick floor.

────────────────────────────────────────────────────────────────
9. EMPTY STATE
────────────────────────────────────────────────────────────────

Two distinct empty states:

  (a) On open, the on-open backfill returns 0 events (a brand-new
      workstream, or a freshly-init workstream with no verbs run
      yet beyond `workstream init` itself):

      ┌─ Activity log — workstream: tui ─────────────────────[?]┐
      │ #seq  ts        agent       kind   payload              │
      ├─────────────────────────────────────────────────────────┤
      │                                                         │
      │              No events yet in this workstream.          │
      │                                                         │
      │              Events appear here as `mu` verbs run.      │
      │              Try: mu task add ... or mu agent spawn ... │
      │                                                         │
      ├─────────────────────────────────────────────────────────┤
      │ tail: live | 0/0 events | filter: -- | / e m t y G ?    │
      └─────────────────────────────────────────────────────────┘

      Tail mode stays "live"; new events on subsequent ticks
      replace the empty-state body with the normal list.

  (b) After applying a filter (`/` or `m`) that matches zero rows:

      ┌─ Activity log — workstream: tui ─────────────────────[?]┐
      │ #seq  ts        agent       kind   payload              │
      ├─────────────────────────────────────────────────────────┤
      │                                                         │
      │   No events match filter: /workstream-deleted-typo      │
      │                                                         │
      │   Press Esc to clear filter, or refine the search.      │
      │                                                         │
      ├─────────────────────────────────────────────────────────┤
      │ tail: live | 0/1003 events | filter: workstream-... | … │
      └─────────────────────────────────────────────────────────┘

      Esc clears filter (per the global convention's filter
      contract); the user is not stuck.

────────────────────────────────────────────────────────────────
10. TESTS — SCROLL-PAUSE CONTRACT GATE
────────────────────────────────────────────────────────────────

Required v0 test (the §4 contract gate):

  test("popup at-bottom auto-scrolls to new events; popup scrolled-up
        does not auto-scroll", async () => {
    // Setup: snapshot with 50 events, popup open at last row.
    const initial = makeSnapshot({
      events: makeEvents(50),  // seq 1..50
    });
    const { rerender, lastFrame, stdin } = renderPopup(
      LogPopup,
      { snapshot: initial, extra: { events: makeEvents(50) } },
    );

    // Assertion 1: tail mode is "live" by default; bottom row is
    // event seq=50; cursor on it.
    expect(lastFrame()).toMatch(/tail: live/);
    expect(lastFrame()).toMatch(/^.*#50/m);          // last row visible
    expect(getSelectedSeq(lastFrame())).toBe(50);

    // Assertion 2: snapshot tick adds 5 new events; viewport scrolls;
    // cursor stays at the new bottom (seq=55).
    const tick1 = makeSnapshot({ events: makeEvents(55) });
    rerender({ snapshot: tick1, extra: { events: makeEvents(55) } });
    expect(lastFrame()).toMatch(/^.*#55/m);
    expect(getSelectedSeq(lastFrame())).toBe(55);
    expect(lastFrame()).toMatch(/tail: live/);
    // Assertion 3: number of visible event rows GREW (or stayed at the
    // viewport cap, but newest is now at bottom).
    const visibleSeqsTick1 = parseVisibleSeqs(lastFrame());
    expect(visibleSeqsTick1).toContain(55);

    // User scrolls up: press 'k' five times.
    for (let i = 0; i < 5; i++) stdin.write("k");
    await flushAsync();

    // Assertion 4: tail mode is now "paused"; cursor moved up;
    // bottom-of-viewport row no longer == max-seq.
    expect(lastFrame()).toMatch(/tail: PAUSED/);
    expect(getSelectedSeq(lastFrame())).toBe(50);

    // Assertion 5: new tick adds 10 more events (seq 56..65). The list
    // GROWS (new rows are appended to snapshot.events) BUT viewport
    // does NOT auto-scroll (cursor stays at seq=50, bottom-of-viewport
    // does NOT advance to seq=65). Footer shows "10 new" pending.
    const tick2 = makeSnapshot({ events: makeEvents(65) });
    rerender({ snapshot: tick2, extra: { events: makeEvents(65) } });
    expect(lastFrame()).toMatch(/tail: PAUSED.*10 new/);
    expect(getSelectedSeq(lastFrame())).toBe(50);   // cursor unchanged
    const visibleSeqsTick2 = parseVisibleSeqs(lastFrame());
    expect(visibleSeqsTick2).not.toContain(65);     // newest NOT visible
    expect(visibleSeqsTick2).toContain(50);         // cursor row still in view

    // Assertion 6: pressing 'G' resumes tail; viewport jumps to bottom.
    stdin.write("G");
    await flushAsync();
    expect(lastFrame()).toMatch(/tail: live/);
    expect(getSelectedSeq(lastFrame())).toBe(65);
    expect(parseVisibleSeqs(lastFrame())).toContain(65);
  });

This single test covers: live → paused transition, paused-mode list
growth without scroll, paused footer counter, G resumes. Six
assertions; one ink-testing-library test; well under 80 LOC of
test code.

Companion tests v0 implementer SHOULD add (each is small):

  - `t` toggles tail mode without keyboard scroll input.
  - Reaching bottom via j (paused → autopromoted to live).
  - `/` filter narrows visible rows; `n`/`N` move within filtered.
  - `m` filter when self === null (orchestrator pane) shows toast.
  - yank `y` on a `task close X` row produces "mu task show X -w tui";
    yank `y` on a `workstream destroy ws` row produces "no yank"
    toast.
  - on-open backfill returns 1000 events (test fixture); subsequent
    tick adds 1 new event; popup shows 1001 in count.
  - empty workstream shows "No events yet" copy.
  - filter that matches zero shows "No events match filter:" copy.
  - EVENT_VERB_PREFIXES walk: every prefix has a yank-template
    entry (or is on the explicit "intentional no-yank" list). This
    is the drift-prevention test (parallels the existing
    colorEventPayload regression test in
    test/state-render.test.ts L395-444).

================================================================
NEXT
================================================================

- design_complete (downstream): consume this note + design_card_log
  + design_popup_lifecycle as the Activity-log subject's
  contribution to the v0 implementation manifest. The card + popup
  pair is now fully specified; ready to code.

- design_module_layout (informational): popups/log.tsx new file in
  src/cli/tui/popups/. Approximate LOC budget: ~280 (130 layout,
  60 tail-state machine, 40 yank dispatch table, 30 filter input,
  20 onOpen). Within the cluster's <1500 LOC cap with comfort.

- design_sdk_seam (informational): the yank dispatch table's
  EVENT_VERB_PREFIXES → yank-template mapping is the natural
  v0.next promotion candidate to move into src/logs.ts as a sibling
  to classifyEventVerb (call it eventYankTemplate(payload, ws):
  string | null). Reason: future popups (e.g. notification toasts)
  may want the same mapping. v0 keeps it inline in the popup —
  one caller, no premature seam.

- design_tests (informational): the §10 v0-required test plus the
  9 companion tests are net-new. design_tests should add a row
  asserting the popup test-suite size as ~10 tests for budgeting.

================================================================
VERIFIED
================================================================

- Cross-checked design_locked: Shift+4 = Activity-log popup
  preserved; in-popup convention {j/k g/G / Esc y ? +/-/=/0 r/F5
  Ctrl-C} all live; F1 simple poll honoured; yank flow A3' (toast +
  footer "last: ... [copied]") used verbatim; no persistence
  (filters, tail-state all popup-local).

- Cross-checked design_card_iface §I1 single-popup invariant: this
  popup never opens a child; conflict handled per
  design_popup_lifecycle §2 "popup already open: log" toast.
  PopupVerb keys used {t, e, m, c}; all four are in the reserved-
  letter pool {a b d e f h i l m o p s t u v x z}. None collide
  with the global in-popup convention {j k g G n N q y c r w}
  EXCEPT `c` (footer-clear). Justification in §5: the global `c`
  is dashboard-only per design_global_keymap; reusing inside the
  popup for "clear filters" is unambiguous because the dispatcher
  checks Popup.verbs FIRST (per design_card_iface ODDITIES). That
  said, this collision warrants a re-check during implementation
  — if the dispatcher rule is hardened to "global keys win
  everywhere", we drop `c` here and assign `x` for clear-filter
  (also in the pool, no collisions). Flagged as an ODDITY below.

- Cross-checked design_popup_lifecycle §1 (2-state machine), §4
  (onOpen useEffect), §5 (popup tick via shared tickMs), §6
  (ErrorBoundary): tail-state machine is popup-LOCAL (lost on
  close per the lifecycle's "per-popup state lost on close" rule);
  onOpen returns Promise<{events: LogRow[]}>; popup tick consumes
  snapshot.events deltas; render path is a single ink component
  that the lifecycle's ErrorBoundary will wrap.

- Cross-checked design_card_log: the card explicitly delegates
  "scroll, pause, kind, actor, full payload, ISO ts" to the popup;
  this design absorbs every one. The card stays at minWidth=60
  minHeight=6; the popup takes the full terminal.

- Cross-checked design_yank_flow: PopupProps.yank(text: string)
  is the public surface; popup calls it; toast + footer
  side-effects handled by the dispatcher; no popup direct
  clipboard touch. The "no yank for this row" footer-toast
  pattern (§3 in the yank flow) is exactly the §6 fall-through
  case here. Matches.

- Cross-checked design_global_keymap: `/` is the global filter
  binding (this popup uses it as substring filter, NOT rebound;
  per the keymap's "popup that wants its own / MAY rebind"
  contract — we keep the global). j/k g/G n/N Esc q y ? Ctrl-C
  +/-/=/0 r/F5 all behave per the convention. The new per-popup
  verbs {t, e, m, c} consume the reserved pool.

- Cross-checked design_sdk_seam + design_poll_loop §1: the
  on-open backfill uses listLogs directly (it's already exported
  from src/logs.ts) — no new SDK surface. The popup's per-tick
  consumption is via snapshot.events delta — no new SDK call. The
  EVENT_VERB_PREFIXES → yank-template mapping is intentionally
  inline (single consumer; ≥2-caller rule respected by NOT
  promoting it to SDK in v0).

- Cross-checked src/logs.ts L131-180: listLogs returns oldest-
  first regardless of `since` vs `limit`-only mode; no reverse
  needed. The card's design_card_log ODDITY about "verify and
  reverse if needed" turns out to be a non-issue — confirmed in
  L172 (rowsDesc.reverse() is INSIDE the limit-only path).

- Cross-checked src/cli/state.ts L630-686 formatHudRecentTable
  vs colorEventPayload: every column the static HUD showed has a
  TUI home — "+ago" stays on the CARD (per design_card_log);
  ISO timestamp / seq / kind / actor / full payload all land in
  this POPUP's per-row format (§2). Zero information loss; the
  popup is the strict superset.

- Cross-checked src/agents.ts getAgentByPane: the `m` verb's
  "self" resolution uses this exact helper (called once at popup
  open and cached). It's an existing export; no new SDK surface.

================================================================
ODDITIES
================================================================

- The `c` per-popup verb (§5: "clear all filters") shadows the
  GLOBAL dashboard-only `c` (clear-footer). Per
  design_card_iface ODDITIES the dispatcher checks Popup.verbs
  FIRST so this is technically legal, but it complicates the
  help overlay (one key, two meanings depending on mode).
  Mitigation: the help overlay (design_help_overlay) MUST list
  both bindings under their respective sections. If the
  implementer finds this confusing during dogfooding, drop `c`
  here and use `x` (also in the pool, also unambiguous).

- The §3 filter is INTENTIONALLY a single-string substring rather
  than three separate filters (substring + verb-prefix + agent).
  Reason: a single filter input is one-key-press cheaper to use
  and covers 95% of real cases. The §5 `m` verb is the single
  exception — "my events" is a frequent enough query to deserve
  a one-key toggle that COMPOSES with `/`. This is a deliberate
  choice; if real-user friction shows up around verb-only
  filtering ("I want all task verbs but no agent verbs"), v0.next
  adds a `--filter-verb=task` CLI flag mode rather than a second
  in-popup filter mode.

- The `e` verb (cycle event-kind filter) is a NO-OP in v0 because
  the snapshot is hardcoded to kind="event". Reserving the key
  now means the v0.next that introduces a multi-kind feed
  (info/event/broadcast) doesn't have to re-train muscle memory.
  The footer toast ("v0.next") makes the no-op DISCOVERABLE
  rather than silent (silent no-ops are foot-guns).

- The yank dispatch table (§6) is a 30-entry mapping in the
  popup. It WILL drift if a new SDK verb lands in
  EVENT_VERB_PREFIXES without a corresponding yank-template
  entry. The "EVENT_VERB_PREFIXES walk test" in §10 catches this
  — but the failure mode is "test fails CI", not "popup silently
  no-yanks the new verb". Acceptable. If a future v0.next promotes
  the table to src/logs.ts as eventYankTemplate(), the test moves
  with it.

- The §4 tail-state machine deliberately treats "snapshot.events
  was reset to a smaller list" (e.g. workstream destroyed +
  re-created) as a normal "list shrunk" event rather than a
  state reset. The ErrorBoundary in the lifecycle catches the
  "snapshot is empty after a destroy" transition; the popup just
  shows "No events yet" (per §9). No special-case code needed.
  If the user's cursor was at seq=50 and the snapshot now caps at
  seq=10, the cursor clamps to the last visible row and tail mode
  stays where it was (paused stays paused; live stays live and
  re-anchors to the new last row).

- The §6 workstreamName-from-event-row vs TUI-bound-workstream
  distinction is a forward-looking decision. v0 single-workstream
  mode they're always equal. The contract here ensures v0.next
  multi-workstream mode "just works" without a yank-template
  refactor; cost is one extra null-check per yank.

- The empty-state copy in §9 case (a) suggests `mu task add` and
  `mu agent spawn` as discoverable next steps. This violates the
  "TUI is read-only" pillar in spirit (we're suggesting what to
  type, not running it). Mitigation: the suggestions are TEXT
  inside the popup body, not yankable, not auto-executed. Same
  semantics as a CLI `Next:` block. Acceptable.

- The §10 main test relies on `parseVisibleSeqs(lastFrame())` and
  `getSelectedSeq(lastFrame())` helpers that don't exist yet.
  They're trivial regex helpers (~5 LOC each) over the rendered
  string. design_tests should add them to the shared test
  fixture file. If the implementer prefers a snapshot-based
  comparison instead, that's also acceptable — the contract is
  what the assertions verify, not the helper shape.

- We considered adding a `d` verb for "dump full event detail"
  (open a sub-modal showing seq + ISO ts + kind + source + raw
  payload + JSON-decoded payload if applicable). REJECTED: the
  full payload already renders inline (with wrap); the ISO ts is
  one keypress away (per §2 future "ts hover"); no real user has
  asked. v0.next promotion if a real complaint shows up about
  truncated multi-line payloads (currently zero such payloads
  in the SDK).

- The 1000-event backfill (§7) was picked as a round-number
  sweet-spot: deep enough that scrolling-back covers a typical
  multi-hour session (~600 events at typical rates per
  src/logs.ts emit-site count), shallow enough to render
  near-instantly. Not benchmarked; first-cut heuristic. If the
  implementer measures a noticeable open delay, drop to 500 or
  add the env var early.
```

### #2 by "scout-2", 2026-05-11T11:26:01.099Z

```
CLOSE: Activity-log popup design done
```
