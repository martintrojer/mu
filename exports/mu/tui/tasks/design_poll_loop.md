---
id: "design_poll_loop"
workstream: "tui"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "designer-1"
created_at: "2026-05-11T10:44:55.660Z"
updated_at: "2026-05-11T10:58:22.080Z"
blocked_by: ["design_locked"]
blocks: []
---

# Design poll loop: 1s default, +/- live adjust, floor 100ms ceiling 10s

## Notes (2)

### #1 by "designer-1", 2026-05-11T10:58:19.003Z

```
FILES:
- (none modified — design-only task; output is this note)
- read: src/index.ts (SDK surface), src/agents.ts (listAgents),
  src/tasks.ts (listTasks + ListTasksOptions), src/logs.ts
  (listLogs + afterSeq cursor + latestSeq), src/tracks.ts +
  src/cli/state.ts (getParallelTracks + collectStateData shape).
- read: mu task notes design_locked -w tui (poll loop locked: F1
  simple poll, 1s default, +/- floor 100ms ceiling 10s, no
  persistence, read-only).
- read: mu task notes design_global_keymap -w tui (r/F5 = refresh
  now; +/=, -, 0 = tick adjust; popups suppress 1-9; Esc closes
  popup; q quits dashboard).

COMMANDS:
- mu task notes design_locked        -w tui
- mu task show  design_poll_loop     -w tui
- mu task notes design_global_keymap -w tui

FINDINGS:

1. The four v0 cards each map to one SDK call already exported from
   src/index.ts. None of the four require new SDK surface area;
   this design is pure consumption.

   - Agents card        → listAgents(db, { workstream })
                          (src/agents.ts:284)
                          One SQLite SELECT joining agents to their
                          owned tasks via listTasksByOwner; cheap
                          (sub-ms on the typical <50-row workstream).

   - Tracks card        → getParallelTracks(db, workstream)
                          (src/tracks.ts; consumed by state.ts:116)
                          Loads all tasks + edges and runs union-find
                          + diamond-merge in JS. Cost scales with
                          |tasks|+|edges|; sub-ms for v0-sized graphs
                          (<200 tasks), low-ms at thousands.

   - Ready card         → listTasks(db, ws,
                            { status: "OPEN", ready: true, limit: N })
                          (src/tasks.ts:452, ListTasksOptions has
                          status / ready / limit).
                          Single SELECT with NOT EXISTS subquery for
                          unsatisfied blockers; sub-ms.

   - Activity log card  → listLogs(db,
                            { workstream, kind: "event",
                              afterSeq: lastSeenSeq, limit: N })
                          (src/logs.ts:131) — incremental cursor
                          reads. Initial load uses `limit` only
                          (~50 rows); subsequent ticks pass
                          `afterSeq` so we only fetch deltas.
                          Sub-ms; the seq column is the autoincrement
                          PK so the index is effectively free.

   All four read directly from the same opened SQLite handle. Total
   per-tick cost on a healthy workstream: well under 5ms wall, with
   listLogs amortised to near-zero by the cursor. We are nowhere
   near the 100ms tick floor; the loop is "instant-feeling" by
   construction.

2. Ink does not provide a built-in tick primitive. The two real
   options are setInterval inside a useEffect and a third-party
   wrapper (use-interval / react-fns / ink's own <Static> +
   re-render). The locked decision is "F1 simple poll" — we honour
   that by going with the simplest possible thing: a single
   setInterval owned by the top-level <Dashboard> component.

   <Static> is the wrong fit: it's for never-rerendered scrollback
   (think build logs that scroll past the dashboard). We render
   live cards; the whole point is that they refresh.

3. SQLite better-sqlite3 is *synchronous*. A getParallelTracks /
   listAgents / listTasks / listLogs call is a blocking JS function
   that returns rows directly; there is no Promise to race. That
   removes an entire class of "two queries racing each other"
   bugs by construction. The tick handler is straight-line:

       function tick() {
         const t0 = performance.now();
         const snap = {
           agents:  cardEnabled.agents ? listAgents(db, { workstream }) : prev.agents,
           tracks:  cardEnabled.tracks ? getParallelTracks(db, workstream) : prev.tracks,
           ready:   cardEnabled.ready  ? listTasks(db, workstream, { status:"OPEN", ready:true, limit:READY_N }) : prev.ready,
           events:  cardEnabled.events ? listLogs(db, { workstream, kind:"event", afterSeq, limit:EVENT_N }) : prev.events,
         };
         const dur = performance.now() - t0;
         setSnap(snap);
         setTickStat({ lastMs: dur });
       }

   No Promise.all, no async/await, no AbortController. The "no race"
   guarantee is structural, not policy.

DECISION:

================================================================
1. DATA-FETCH PATH (per visible card, per tick)
================================================================

   Card           SDK call                                     Latency      Cache?
   ----           --------                                     -------      ------
   Agents         listAgents(db, { workstream })               sub-ms       no — every tick (status lag is the whole reason we poll)
   Tracks         getParallelTracks(db, workstream)            sub-ms .. low-ms   no — every tick (cheap enough)
   Ready          listTasks(db, ws,                            sub-ms       no — every tick
                    { status:"OPEN", ready:true, limit:50 })
   Activity log   listLogs(db,                                 sub-ms       INCREMENTAL — afterSeq cursor; first tick of the
                    { workstream, kind:"event",                             session uses { limit:200 } and seeds afterSeq from
                      afterSeq:lastSeq, limit:200 })                        the max seq returned. Subsequent ticks only fetch new rows.

   Limits READY_N=50 and EVENT_N=200 are first-cut heuristics
   matching what the static `mu state --hud` already shows; tune
   in v0.next if the lists clip in real workstreams.

   Every fetch is synchronous (better-sqlite3); one db handle is
   shared across the lifetime of the TUI. No connection pool, no
   ORM, no stream. The handle is opened in the top-level <App>
   useEffect and closed on unmount.

   Static `mu state` already runs all four queries serially in
   src/cli/state.ts (collectStateData) — we are literally re-using
   that pattern in a loop. If a future v0.x adds a "compose" SDK
   call (one round-trip for everything), the Dashboard component
   swaps to it without changing tick semantics.

================================================================
2. TICK IMPLEMENTATION IN INK
================================================================

   Top-level <Dashboard> owns ONE setInterval, scheduled inside a
   useEffect whose only dep is `tickMs`. Pseudocode:

     useEffect(() => {
       tick();                       // immediate fetch on mount / on rate change
       const id = setInterval(tick, tickMs);
       return () => clearInterval(id);
     }, [tickMs]);

   `tick` itself is a stable useCallback that closes over the
   current `cardEnabled`, `afterSeq`, `popupOpen` flags via refs
   (NOT props) so we never re-create the interval on toggle.

   Why setInterval (not requestAnimationFrame, not a recursive
   setTimeout, not react-fns / use-interval):
   - "F1 simple poll" was locked. setInterval is the dictionary
     definition of simple polling.
   - rAF is a browser concept; tied to monitor refresh. Irrelevant
     in a terminal that re-renders on data, not on frames.
   - Recursive setTimeout (the "drift-correcting" pattern) is the
     right answer ONLY if we want to skip ticks that overlap in
     flight; better-sqlite3 is synchronous so overlap is impossible
     by construction (see §3).
   - use-interval / react-fns add a dep for ~12 lines of code.
     ROADMAP anti-feature pledge: no wrappers around wrappers.

   Race protection: structural. better-sqlite3 is synchronous, so
   there is exactly one tick in flight at any wall-clock instant
   (it occupies the JS thread). setInterval cannot fire on top of
   itself; Node's event loop queues the next callback only after
   the current one returns. We CANNOT "fire-and-forget two queries
   that race each other" because the queries are not async.

   Render: setSnap with a single object containing all four card
   payloads. React batches the re-render; ink reconciles the
   terminal once per tick. Card components are memoised on their
   slice of the snapshot so unaffected cards do not re-render.

   The popup, when open, is a sibling component that owns its own
   setInterval (see §7) — the dashboard's tick is paused via the
   popupOpen ref short-circuit at the top of `tick`.

================================================================
3. SLOW-TICK BEHAVIOUR (tick takes longer than tickMs)
================================================================

   Because better-sqlite3 is synchronous, a "slow tick" means the
   JS thread was busy past the next scheduled fire. Node's
   setInterval semantics in this case: the next callback fires
   IMMEDIATELY upon returning, and any further pending fires are
   COALESCED (Node will not "catch up" by firing N times back to
   back).

   We rely on this default. Specifically:

   - DO NOT queue. Each tick reads the live DB state; a backlog of
     stale ticks adds zero information.
   - DO NOT explicitly skip. Node already coalesces; explicit
     skip-logic would be redundant and add a state machine.
   - DO surface the cost. The footer always shows
       "tick: 1.00s  last fetch: 4ms"
     Once `last fetch` exceeds tickMs we add a yellow ⚠ next to it
     and a one-shot toast "tick fetch (Xms) > rate (Yms); cards
     will lag — try - to slow down". No automatic rate change; the
     user is in control (read-only pillar).

   Backpressure escape hatch: if `last fetch` exceeds 5× tickMs
   for three consecutive ticks (rare; means real disk pressure or
   a 10k-task graph), we emit ONE log line via mu log "tui: slow
   poll, last=Xms" so the orchestrator sees it post-mortem. We do
   NOT auto-throttle. (User remains in control via -.)

================================================================
4. +/- LIVE-ADJUST MECHANISM
================================================================

   State location: useState<number> on the top-level <Dashboard>,
   call it `tickMs`, default 1000. Initial floor 100, ceiling 10_000.

   Why useState (not a singleton ref, not Zustand, not a context):
   - Driving an interval off it via useEffect deps is the React-
     idiomatic pattern. Changing tickMs unmounts the prior interval
     (cleanup) and mounts a new one. No manual clearInterval +
     setInterval choreography in the keypress handler.
   - A singleton ref would force us to manually re-schedule on
     change AND would bypass React's batching.
   - The footer reads `tickMs` directly from the same useState; one
     source of truth.

   Key handling (in the global keymap dispatcher; see
   design_global_keymap):

     '+' or '=' : setTickMs(t => Math.max(100, Math.floor(t/2)))
     '-'        : setTickMs(t => Math.min(10_000, t*2))
     '0'        : setTickMs(1000)

   Pressing - while a tick is "in flight": again, by structural
   guarantee from §2/§3, there is no in-flight tick to cancel —
   the synchronous fetch has either already returned (we are in
   idle wait) or is mid-execution (the keypress is queued behind
   it and will run the moment it returns). So the question
   simplifies to: when the dispatcher runs, it calls setTickMs;
   React re-renders; useEffect's cleanup clears the old interval
   and schedules a new one with the new rate, FIRING ONE TICK
   IMMEDIATELY. This means + (faster) gets you a fresh fetch right
   away — exactly the user expectation. - (slower) likewise resets
   the next-fetch clock to "one new tick from now", which is
   slightly counterintuitive ("but I wanted slower not sooner")
   but matches the user model "the new rate starts NOW". Document
   in help overlay; do not engineer around it.

   Toast on rate-clamp: hitting + at the floor or - at the ceiling
   shows a one-line footer toast "tick floor 100ms" /
   "tick ceiling 10s". Already specified in design_global_keymap;
   restated here for completeness.

================================================================
5. r / F5 REFRESH-NOW
================================================================

   Behaviour: trigger one extra fetch IMMEDIATELY and reset the
   tick clock so the next auto-fetch is one full tickMs from now.

   Implementation: setTickMs(t => t) — i.e. set to the same value,
   forcing a useEffect re-run (we ensure this by also bumping a
   `nonce` state used as a useEffect dep alongside tickMs):

     const [tickMs, setTickMs] = useState(1000);
     const [nonce, setNonce]   = useState(0);
     useEffect(() => {
       tick();
       const id = setInterval(tick, tickMs);
       return () => clearInterval(id);
     }, [tickMs, nonce]);

     // r / F5 handler:
     setNonce(n => n + 1);

   This is the "reset the tick clock + inject one fetch" semantic
   in one keystroke. We chose RESET (not just inject) because:
   - "Inject without reset" leaves the user with a fresh fetch
     followed by another fetch X ms later, where X ≤ tickMs and
     varies depending on when in the cycle they hit r. Confusing.
   - "Reset and inject" is the standard k9s / lazygit / htop
     refresh semantic and matches the user model "I just refreshed,
     don't bother me for a full tick".

================================================================
6. CARD-TOGGLE INTERACTION — DATA FETCH WHEN HIDDEN
================================================================

   Decision: SKIP the fetch for hidden cards.

   Rationale:
   - The fetch is structurally cheap (sub-ms for the first three;
     incremental cursor for the fourth). The savings are
     negligible in absolute terms.
   - BUT the synchronous SQLite calls block the JS thread; even
     "free" calls add up at high tick rates (10/s × 4 calls =
     40 SELECTs/sec, much of which the user can't see).
   - Skipping a hidden card is a one-line `if (cardEnabled.x)`
     guard; no architectural cost.
   - Most importantly, this avoids a foot-gun for the Activity
     log specifically: when its card is hidden we MUST NOT advance
     the afterSeq cursor in the background. Otherwise unhiding the
     card would show "no recent events" (we burned through them
     with no UI). Skipping the fetch preserves the cursor at the
     last on-screen seq, so unhiding shows the events that
     accumulated while it was hidden — exactly the user
     expectation.

   The simplicity argument LOSES because of the cursor concern.
   "Always fetch, never display" introduces a cache-invalidation
   bug for free.

   Consequence: unhiding a card via 1-9 fires one immediate fetch
   for that card (so the user doesn't stare at stale or empty
   data for up to one tick). Implementation: in the toggle
   handler, if going hidden→visible, call the card's fetch
   synchronously and merge into snap.

================================================================
7. POPUP INTERACTION — DASHBOARD VS POPUP TICK
================================================================

   Sanity-check on the instinct "pause dashboard, popup runs its
   own tick at the same rate": YES — adopt it. Reasons:

   - The popup is fullscreen and owns the screen (single-popup
     invariant from design_locked). The dashboard is not visible
     while the popup is open; rendering it is wasted CPU and
     wasted SQLite work.
   - The popup typically reads MORE data per fetch than its
     dashboard-card sibling (full task list, full event log with
     filters, full agent metadata). Running both loops would
     double the per-tick cost for zero visible benefit.
   - On popup close, we want the dashboard to feel "fresh, not
     stale". So on close, fire ONE immediate fetch for every
     visible dashboard card (same code path as r) before resuming
     the dashboard interval. This is the "data is fresh on close"
     property the prompt asked about, achieved without paying
     for it during the popup's lifetime.

   Implementation:
   - <Dashboard>'s tick callback short-circuits at the top:
       if (popupOpenRef.current) return;
   - This freezes the dashboard interval cleanly without clearing
     it (cheaper than re-scheduling on every popup open/close).
   - <Popup> mounts its own setInterval driven by the SAME tickMs
     state (popup inherits the user's chosen rate; +/- inside the
     popup mutates the same useState, so closing the popup yields
     the new rate too — one source of truth, see §4).
   - On popup close: fire `setNonce(n => n + 1)` on the dashboard
     to force the immediate-refresh + clock-reset (same machinery
     as r/F5).
   - The popup's `afterSeq` cursor is INDEPENDENT of the
     dashboard's (the popup may be filtering / scrolling
     historical events). This is fine — they're separate
     components; no shared state between their cursors.

================================================================
8. ERROR / SQLITE-UNAVAILABLE BEHAVIOUR
================================================================

   The TUI must never crash a tick into an unhandled exception
   (would unmount ink and dump a stack trace into the user's
   terminal mid-session). Wrap each per-card fetch in try/catch:

     function fetchCard<T>(label: string, fn: () => T, prev: T): T {
       try { return fn(); }
       catch (e) {
         lastError = { card: label, msg: String(e), at: Date.now() };
         return prev;            // last good snapshot; never undefined
       }
     }

   Render rules per card on error:
   - Card body shows last good data dimmed (picocolors-equivalent
     in ink: <Text dimColor>) with a one-line header "stale: <cause>"
     in yellow.
   - If we have no prior good snapshot (error on first tick), the
     card body is a single line "DB unavailable: <cause>" in red.
   - Footer adds a persistent indicator "DB ⚠" until a successful
     tick clears it.

   Specific failure modes to recognise (no need for exhaustive
   classification; substring match is fine for v0):

   - "SQLITE_BUSY" / "database is locked" — common when another
     `mu` invocation has the DB open with a write lock. Header:
     "stale: db locked, retrying". The next tick may succeed; no
     special back-off, the existing tick rate IS the back-off.

   - "SQLITE_CORRUPT" / "no such table" — the DB is gone or wrong
     schema. Header: "DB unavailable: <message>". User must
     mu doctor; we cannot recover. Suggest in footer hint.

   - Any other Error — render `e.message` truncated to 80 chars.

   Whole-TUI error boundary: wrap the top-level <App> in an ink
   error boundary (try/catch inside the root render via React 18
   <ErrorBoundary>-equivalent). On a fatal render error we ink
   .unmount() cleanly and print one line to stderr explaining how
   to reproduce. Read-only pillar means we are never holding a
   write lock; we cannot corrupt anything by exiting.

   "DB locked" is the high-frequency case in the orchestrator
   workflow (orchestrator runs `mu` commands while the TUI is
   open). The dim-and-stale render is the right answer: the user
   sees the prior data, knows it's stale, and the next tick almost
   certainly succeeds. Crucially: read-only access opens the DB in
   `readonly: true` mode (better-sqlite3 supports this; see
   src/db.ts). Read-only opens are MUCH less likely to hit
   SQLITE_BUSY because they don't acquire a write lock; the
   typical lock contention is writer-vs-writer, not reader-vs-
   anything. So in practice this branch fires rarely.

NEXT:
- design_module_layout (sibling task) MUST place the tick state on
  a single <Dashboard> root component; sub-cards receive snapshot
  slices via props. The +/- and r handlers wire to the dashboard's
  setTickMs / setNonce — sketch above.
- design_help_overlay (sibling task; from design_global_keymap) —
  the help overlay's "tick" section should restate §4-§5 from this
  note (rate floor/ceiling, r resets clock, 0 returns to default).
- design_popup_lifecycle (sibling task) MUST honour §7: dashboard
  tick freezes via popupOpenRef short-circuit (not interval clear);
  popup owns its own interval driven by the same tickMs state;
  popup close fires one dashboard refresh (setNonce++) before
  resuming.
- design_db_open (NEW; consider promoting): open the DB in
  readonly mode for the TUI process. Reduces SQLITE_BUSY surface
  per §8; aligns with R1 read-only pillar. Probably 5-line change
  in src/db.ts (add `readonly` option to openDb).
- v0 implementation MUST add unit tests:
  (a) tickMs change cancels the prior interval and schedules a
      new one (via useEffect cleanup); assert one fetch fires
      immediately on rate change.
  (b) hidden cards do not call their fetch fn.
  (c) listLogs cursor (afterSeq) advances monotonically across
      ticks while the activity card is visible, and DOES NOT
      advance while it is hidden.
  (d) a fetch throwing returns the prior snapshot (per-card
      isolation) and sets the staleness header.

VERIFIED:
- Cross-checked the locked decisions in `mu task notes
  design_locked -w tui`: F1 simple poll (§2), 1s default (§4),
  +/- live adjust with floor 100ms / ceiling 10s (§4), no
  persistence — tickMs lives only in useState, dies on unmount
  (§4). All locked items appear above.
- Cross-checked the keymap from `mu task notes
  design_global_keymap -w tui`: + / = / - / 0 (§4), r / F5 (§5),
  popup-suppress-1-9 (compatible with §6/§7), Esc closes popup
  (§7 — restores dashboard with one immediate refresh). All
  keymap-side promises about poll behaviour are honoured here.
- Cross-checked the SDK surface: every per-card fetch fn used
  above is exported from src/index.ts today (listAgents,
  getParallelTracks, listTasks, listLogs). No SDK changes
  required to ship this loop.
- Cross-checked src/cli/state.ts collectStateData: it runs the
  same four queries serially per render. Our tick is the same
  pattern in a loop, so any future "compose" SDK call benefits
  both.

ODDITIES:
- The "- starts the new rate NOW" semantic (§4) is mildly
  counterintuitive — pressing - to slow down also fires one
  immediate refresh as a side-effect of the useEffect re-run.
  We accept this; it's the React-idiomatic behaviour and it
  matches the user model "the new rate is in effect from now."
  Documented in help overlay.
- Skipping fetches for hidden cards (§6) is the OPPOSITE of the
  "simplicity wins" instinct; we override because the activity-
  log cursor would silently advance off-screen. This is the only
  card with that property today, but reserving 5-9 for future
  cards (per design_global_keymap) means future cards may also
  carry cursor state — bake the skip-when-hidden discipline in
  at v0 so it's not retrofitted later.
- "- while a tick is in flight": there is no such state under
  better-sqlite3 (synchronous). If we ever swap to an async
  driver (postgres? sqlite-wasm in a worker?) we MUST revisit
  §3, §4, §7 — the no-race guarantee becomes a policy not a
  structural property.
- Read-only DB open (NEXT bullet) is technically out-of-scope for
  this task but the §8 design assumes it. If someone implements
  the loop without the readonly flag, SQLITE_BUSY toasts will
  flicker every time the orchestrator runs a `mu task close`.
  Flagged so it's not surprise-discovered at integration time.
- We do not implement a "pause" key. The user can effectively
  pause by setting tickMs to 10s and ignoring the screen. Adding
  a pause key would also need a "paused" indicator in the footer,
  another keystroke to bind, and another state in the help
  overlay. v0.next if a real user wants it.
- We do not adopt better-sqlite3's WAL mode change here. WAL
  reduces SQLITE_BUSY further but is a project-wide schema
  decision (src/db.ts), not a TUI decision. Out of scope for
  this task; flag for design_db_open if that task is promoted.
```

### #2 by "designer-1", 2026-05-11T10:58:22.080Z

```
CLOSE: tick/fetch/render loop designed in note
```
