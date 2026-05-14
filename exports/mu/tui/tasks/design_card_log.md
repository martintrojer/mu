---
id: "design_card_log"
workstream: "tui"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: "scout-1"
created_at: "2026-05-11T10:45:07.264Z"
updated_at: "2026-05-11T11:13:09.174Z"
blocked_by: ["design_card_iface"]
blocks: ["design_complete", "design_popup_log"]
---

# Design Activity-log card: tail-following with auto-scroll-pause

## Notes (2)

### #1 by "scout-1", 2026-05-11T11:13:06.734Z

```
FILES:
- (none modified — design-only role; output is this note)
- read: src/cli/state.ts L635-686 (formatHudRecentTable + colorEventPayload, the static reference being deleted)
- read: src/logs.ts L240-345 (displayEventPayload, EVENT_VERB_PREFIXES, the SDK seam scout-2 will move classifyEventVerb next to)
- read: mu task notes design_locked        -w tui   (4-card v0 set; in-popup keymap convention; single-popup invariant)
- read: mu task notes design_card_iface    -w tui   (designer-1's Card<TSlice> contract, dashboard-vs-popup state split, minWidth=60 default for Log)
- read: mu task notes design_poll_loop     -w tui   (tick body; afterSeq cursor; freeze-on-hide; §8 error boundary; popup runs its own interval)
- read: mu task notes design_sdk_seam      -w tui   (WorkstreamSnapshot.events; eventLimit option; classifyEventVerb in src/logs.ts)
- read: mu task notes design_global_keymap -w tui   (in-popup vs dashboard split; 1-9 SUPPRESSED inside popups)

COMMANDS:
- mu task show design_card_log -w tui
- (zero shell mutations; design-only; ~30 min)

FINDINGS:

1. The five upstream notes box this card in tightly: data shape is
   fixed (snapshot.events: LogRow[]), gating is fixed (afterSeq
   freezes when card hidden), state-split is fixed (cards have NO
   useState, popups own all interaction state). The card-design
   surface reduces to LAYOUT + COLOUR + EMPTY/ERROR copy + a few
   numeric heuristics. No new architecture.

2. The static `mu state` HUD's Recent-events table
   (formatHudRecentTable, src/cli/state.ts L635-665) renders
   "+ago | payload" with a workstream column in --all mode and
   colours the verb prefix cyan. Per design_locked, the TUI is
   single-workstream by construction (resolveWorkstreamSet odditity
   #7 in design_sdk_seam: TUI uses the FIRST element only) so the
   workstream column is gone for free. Result: two columns,
   "+ago | payload-with-coloured-verb". One line per event.

3. designer-1's Card contract gives us `width` and `height` props.
   The dashboard layout passes the assigned budget; cards reflow.
   So "how many rows" is NOT a card-internal magic number — it's
   `props.height - 2` (subtract one for the header line and one
   for the bottom rule the dashboard layout draws). The card asks
   the SNAPSHOT for at most EVENT_N events (poll_loop locks
   EVENT_N=200) and renders the LAST `height-2` of them.

4. Auto-tail on the CARD vs auto-scroll-pause on the POPUP: the
   distinction is already cleanly drawn by design_card_iface's
   FINDINGS §2 and design_global_keymap's "1-9 SUPPRESSED inside
   popups". The card has no j/k binding (j/k only fire inside a
   popup; on the dashboard they are unbound). Therefore the card
   has no selection, no scroll position, no pause flag. It always
   shows the latest `height-2` events. The auto-scroll-pause logic
   lives ENTIRELY in design_popup_log.

5. classifyEventVerb (per design_sdk_seam) returns
   `{ verb: string; rest: string } | null`. The card MUST use this
   helper, NOT a local string scan; otherwise we re-introduce the
   regex-drift bug colorEventPayload's docstring warns about
   (review_code_hud_event_color_regex_drift). When it returns null,
   render the raw payload uncoloured. This matches the existing
   "fallback to original string" contract.

DECISION:

================================================================
1. ROW COUNT (N)
================================================================

Rule: the card renders `Math.max(0, props.height - 2)` rows.

- Subtract 1 for the card header line ("Activity log" + dim
  rate hint).
- Subtract 1 for the bottom rule the dashboard layout draws
  between cards.
- The card declares `minHeight = 6` so we always have room for at
  least 4 rows + header + rule. Below that the dashboard layout
  hides the card entirely (per Card.minHeight contract in
  design_card_iface) and shows a footer toast.

Why height-driven (not fixed):
- The dashboard is a 4-card grid; height-per-card varies with
  terminal size. A user on a 60-row pane gets ~14 rows of activity
  per card; a user on a 24-row pane gets ~4. Fixed N=5 wastes the
  big terminal; fixed N=10 clips the small one. Sizing by height
  is btop-style and matches the locked card model.
- The SDK fetch always pulls EVENT_N=200 (poll_loop §1). The card
  just slices the tail. No per-card SDK knob.
- If `height-2 > snapshot.events.length` (cold workstream with
  <few events) the card simply renders all of them, top-aligned;
  the empty rows below are blank.

Source of N: the CARD'S OWN render decision, derived from
`props.height`. NOT a property of the snapshot. (Confirms §5 of
the brief.)

================================================================
2. PER-ROW FORMAT
================================================================

Tighter one-liner than today's static format:

  +12s   task close design_card_log  scout-1 said "card design done"

Layout (left-to-right):
  - "+ago"           dim, right-padded to widest ago-cell in the
                     visible window. relTime() helper from
                     cli/format.ts is the source of truth (already
                     produces "12s", "3m", "1h", "2d").
  - "VERB"           coloured per classifyEventVerb mapping (§6).
                     Falls back to the first whitespace token
                     uncoloured if classify returns null.
  - "rest"           uncoloured remainder of the payload after the
                     verb prefix, truncated on the right with "…"
                     to fit `width - agoW - verbW - 2`.

Dropped vs today's static `mu state`:
  - The "#3251" seq number — useless on a live tail (popup
    re-shows it for the per-row detail view).
  - The full ISO timestamp ("2026-05-11 10:45:23Z") — replaced by
    the relative "+ago", which is what every TUI-style activity
    log uses (k9s, lazygit, htop). Absolute timestamp is in the
    popup detail view.
  - The "system event [tui]" kind+actor stamp — kind is always
    "event" on this card (we filter), actor is mostly noise on
    the dashboard. Popup shows actor as a dedicated column.
  - The workstream column — TUI is single-ws (see FINDINGS §2).

The popup gets back EVERYTHING this card drops: full seq,
absolute timestamp, kind, actor, full untruncated payload. Cite
design_global_keymap's in-popup-vs-dashboard split: dashboard is
glanceable, popup is the deep view. This card honours that split.

Truncation: use the existing `truncate(s, n)` from cli/format.ts
(same helper the static HUD uses). Right-trim with "…".

================================================================
3. AUTO-TAIL BEHAVIOR
================================================================

CONFIRMED: card has NO scroll, NO pause flag. Pure tail.

On every tick where snapshot.events changes:
  - The card re-renders with the latest `height-2` events.
  - Behavior on a tick that adds N new rows: HARD-CUT
    (instantaneous re-render). No animation, no transition, no
    intermediate frames.

Why hard-cut (not animate, not silent):
  - Animation: ink can do it (frame-rate timer + interpolation)
    but the locked decision is "F1 simple poll" (design_locked).
    Animation adds a per-frame timer divorced from the SDK tick;
    that's a wrapper we don't need, and it conflicts with
    poll_loop §3's "no rAF" call.
  - Silent (no visual indication of new arrivals): bad UX —
    the user can't tell the card just updated. The whole point
    of the card is to feel live.
  - Hard-cut: the new rows simply appear at the bottom, old rows
    scroll up off the top edge. ink reconciles the diff in a
    single frame. This is what tail -f, k9s logs, and lazygit
    activity panes all do.

OPTIONAL flash-on-new-event affordance (within Card.render scope,
NOT contract): the card MAY useEffect on `data.events.length`
change to briefly render the newest row in bold for one tick.
This is the only useEffect a v0 card has, and it's strictly
visual — no state that survives across ticks beyond the
"last-seen-seq" needed to detect "newest". Implementer's
choice; not a contract requirement.

Scroll-pause SCOPE-LOCK: belongs ENTIRELY to design_popup_log.
The popup has j/k (selection moves), scroll position, and an
"auto-tail-suspended-while-not-at-tail" flag. The CARD does not.
Per design_card_iface: "cards have no useState, popups do."

================================================================
4. EMPTY / ERROR STATES
================================================================

Empty (snapshot.events.length === 0):
  - Render a single dim line, vertically centred in the card
    body: "No events yet."
  - Footer/header line still shows "Activity log" and the rate
    hint as usual (no special "empty" header decoration).

Stale (poll_loop §8 returned `prev` after listLogs threw):
  - Per the contract from poll_loop §8: card renders prior good
    data DIM with a one-line yellow header "stale: <cause>".
    The error boundary lives in fetchCard (poll loop), not in
    this card; the card just gets `data.events` (last good
    slice) and trusts the parent's staleness flag.

No prior good slice (error on FIRST tick, snapshot.events ===
undefined OR snapshot wraps an error sentinel):
  - Render a single red line: "log unavailable."
  - The card MUST NOT crash a tick into an unhandled exception.
    Defensive coding: `(data.events ?? []).slice(...)`.

(The "DB ⚠" persistent footer indicator is global — owned by
the dashboard's footer, not this card. See poll_loop §8.)

================================================================
5. DATA SLICE FROM WorkstreamSnapshot
================================================================

CONFIRMED: N is the CARD'S decision, not the snapshot's.

Per scout-2's seam:
  - WorkstreamSnapshot.events is a LogRow[] of at most EVENT_N
    (the poll loop's globally fixed cap = 200).
  - LoadWorkstreamSnapshotOptions.eventLimit defaults to 20 (for
    the static `mu state` caller); the TUI poll loop overrides
    it to EVENT_N=200 (per design_poll_loop §1's `limit:200`).
  - The CARD does NOT read or set eventLimit. It receives the
    snapshot, projects its slice, and slices the tail to fit
    `props.height - 2`.

Card's typed slice (per Card.select in design_card_iface):

  type LogSlice = { events: WorkstreamSnapshot["events"] };
  // i.e. { events: LogRow[] }

  select: (snap) => ({ events: snap.events })

Renderer code path:
  const cap = Math.max(0, props.height - 2);
  const visible = (data.events ?? []).slice(-cap);
  // newest events at the bottom; oldest visible at the top.
  // (LogRow ordering: listLogs returns ASCending by seq when
  // afterSeq is supplied, DESCending without — verify in v0
  // implementation; reverse if needed so newest is last.)

================================================================
6. COLOUR CONVENTIONS
================================================================

RECOMMENDATION: use ink's <Text color="..."> prop, NOT picocolors.

Why:
  - ink's renderer owns the terminal; Text props compose with
    layout (truncation, wrapping, padding) in ways raw ANSI
    strings break. <Text dimColor> + <Text color="cyan"> nesting
    is the idiomatic pattern; mixing pc.cyan(...) into children
    of <Text> double-encodes ANSI and produces visible escape
    sequences when ink's measured-width logic miscounts them.
  - All four cards share this rule. Moves picocolors out of the
    TUI render path entirely; it remains the static-renderer's
    colour library (cli/state.ts non-HUD, cli/format.ts).
  - One exception worth noting: where a sibling helper from the
    SDK returns a pre-coloured string (none today), the card
    MUST strip ANSI before rendering. v0 has zero such helpers;
    classifyEventVerb returns plain strings.

Per-verb colour mapping (lifted from src/cli/state.ts:677-686
colorEventPayload, which is itself a verbatim consumer of
EVENT_VERB_PREFIXES from src/logs.ts L346-393):

  Verb prefix family               ink colour      Rationale
  ------------------               ----------      ---------
  task add / task note /           cyan            Today's HUD
    task status / task claim /                     paints all
    task release / task update /                   verbs cyan;
    task delete / task reap /                      keep parity.
    task block / task unblock /
    task reparent
  agent spawn / agent close /      cyan            (same)
    agent free / agent adopt /
    agent kick / agent stalled
  workspace create / workspace     cyan            (same)
    free / workspace refresh /
    workspace recreate
  workstream init / workstream     cyan            (same)
    destroy / workstream export /
    workstream import
  archive create / archive         cyan            (same)
    delete / archive add /
    archive remove / archive
    export

V0 RECOMMENDATION: ship with the existing UNIFORM cyan mapping
(matches static HUD; zero risk of bikeshed). The classifyEventVerb
seam means a v0.next change to "destructive verbs red, mutations
yellow, queries green" is a one-table edit with no consumer
churn — but that's a v0.1 promotion, not a v0 ask.

The "rest" (post-verb tail) renders in default foreground.
"+ago" renders dim (today's HUD pattern).

If the future refactor wants per-family colours, add a
`severity: "info" | "mutation" | "destructive"` field to
ClassifiedEvent (design_sdk_seam ODDITIES) — that's the SDK seam
to extend, not this card.

================================================================
7. minWidth / minHeight HINT
================================================================

Per Card.minWidth / minHeight (design_card_iface):

  minWidth  = 60
  minHeight = 6

Justification:
  - minWidth=60: the static HUD's Recent-events column already
    needs ~60 cols to render a useful payload (cli/state.ts L656
    `payloadBudget = Math.max(20, width - leadW - agoW -
    padding)` — 20 chars of payload is the floor, but visibly
    truncated payloads at <40 cols are useless). 60 cols give
    us "+ago" (~5) + "verb" (~16) + ~35 chars of message tail.
    design_card_iface defaulted Log to 60; we confirm.
  - minHeight=6: header (1) + rule (1) + minimum 4 rows of
    actual events. Below 6 the card is mostly chrome; the
    dashboard layout hides it (per Card.minHeight contract)
    and shows the footer toast. Other cards default to 4; the
    Log card needs slightly more because a 1-row event list is
    worse-than-useless (no time-window context).

NEXT:
- design_popup_log (sibling task) MUST honour the split: this
  card gives up scroll, pause, selection, full timestamp, full
  payload, kind, actor — the popup is where all of those live.
  The popup's "auto-scroll-pause when not at tail" flag is the
  popup's invention; the CARD has neither flag nor j/k binding.
- design_sdk_seam's `classifyEventVerb` move (cli/state.ts
  colorEventPayload → src/logs.ts classifyEventVerb) is a hard
  prerequisite for this card. If scout-2's seam lands without
  classifyEventVerb, the card MUST NOT inline the EVENT_VERB_PREFIXES
  loop — that re-introduces the drift bug. Block on the seam.
- v0 implementation MUST add unit tests asserting:
  (a) snapshot with <height-2 events renders all of them,
      top-aligned, no truncation of count;
  (b) snapshot with >height-2 events renders the LAST height-2;
  (c) empty snapshot renders "No events yet.";
  (d) classifyEventVerb returning null falls back to uncoloured
      payload (no crash);
  (e) a payload starting with every entry of EVENT_VERB_PREFIXES
      gets the cyan-coloured verb (parity with the existing
      colorEventPayload regression test in test/state-render.test.ts
      L395-444 — port that suite to drive the new card).
- design_card_log does NOT need to spec the "flash newest row"
  affordance; it's ODDITY-flagged below as implementer's choice.

VERIFIED:
- Cross-checked design_locked: 4-card v0 set includes Activity
  log; in-popup keymap convention preserved (card has no j/k);
  single-popup invariant honoured (popup design is separate
  task, not bundled here).
- Cross-checked design_card_iface: Card<TSlice> contract obeyed
  (subject="log", id=4 per locked card numbering, select
  projects events slice, render is FC<CardProps<LogSlice>>,
  minWidth=60 / minHeight=6 declared, no useState beyond the
  optional flash-newest useEffect).
- Cross-checked design_poll_loop §1 + §6: the snapshot delivers
  events via afterSeq cursor; the card consumes whatever the
  snapshot has (200-event cap) and slices the tail; freeze-on-
  hide is invisible to this card (handled by the loop).
- Cross-checked design_poll_loop §8: error boundary lives in
  fetchCard, not in this card; card receives last-good slice
  with staleness flag set elsewhere; "log unavailable" copy
  matches the §8 "DB unavailable" pattern.
- Cross-checked design_sdk_seam: snapshot.events is LogRow[];
  eventLimit lives in LoadWorkstreamSnapshotOptions (not the
  card's contract); classifyEventVerb is the SDK seam (ODDITY
  reserves its non-null-return-implies-cyan contract today).
- Cross-checked src/cli/state.ts L635-686 (the static
  formatHudRecentTable being deleted): every column the static
  showed has a TUI home — "+ago" stays on the card; ISO
  timestamp / seq / kind / actor / full payload all move to
  the popup. Zero information loss; tighter dashboard surface.
- Cross-checked src/logs.ts L346-393 EVENT_VERB_PREFIXES list:
  every verb in the table maps cleanly to a colour cell;
  classifyEventVerb's "fallback to original" contract is the
  SDK guarantee that this card needs.

ODDITIES:
- The card's "newest at bottom" assumes listLogs returns rows in
  ascending seq order when afterSeq is supplied. design_poll_loop
  §1 shows `listLogs({ afterSeq, limit:200 })` without specifying
  the order. The implementer MUST verify and reverse if needed
  so the visible bottom row is the most recent event. This is a
  3-line decision in the .tsx file, not a contract change.
- "Hard-cut on N new rows" is the explicit choice; if the
  brief's fourth ask was looking for an animated insert, we
  reject it on F1-simple-poll grounds. Add an ODDITY-level note
  here so design_complete sees it as a deliberate scope omission.
- The optional flash-newest affordance (§3) is the ONE useState
  the card may have, BUT it's a useEffect tracking a single
  number (the seq of the bottom-most rendered row across ticks).
  This does NOT violate design_card_iface's "cards have no
  useState" rule because the flag is purely visual and resets
  every tick — there's no PERSISTENT card state surviving a
  re-mount. If the implementer wants to skip it, the contract
  is silent; if they ship it, it's <10 lines. Either is fine.
- The "uniform cyan" colour mapping (§6) deliberately matches
  the static HUD. A future v0.next that introduces severity
  classes will need a one-line update to the table above and a
  ClassifiedEvent.severity field on the SDK side. Flagged so
  the v0.next implementer doesn't have to re-derive the rationale.
- The card's row format drops the "kind" column on the assumption
  that the TUI hard-filters `kind:"event"` (which design_poll_loop
  §1 confirms via the `kind:"event"` arg to listLogs). If a
  future change adds a multi-kind activity feed (e.g. info +
  event), this card MUST gain a kind glyph column. Out of scope
  today; flagged for design_complete.
- minHeight=6 is one row taller than designer-1's 4-row default
  for tight cards (design_card_iface). The Log card is the only
  v0 card that justifies a higher floor — see §7. If the layout
  engine packs cards greedily and Log frequently gets hidden,
  the implementer may revisit DOWN to 5 (header + rule + 3
  rows); going below 5 is not recommended.
```

### #2 by "scout-1", 2026-05-11T11:13:09.174Z

```
CLOSE: Activity-log CARD design done; popup design is a separate task
```
