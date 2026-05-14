---
id: "design_popup_lifecycle"
workstream: "tui"
status: CLOSED
impact: 85
effort_days: 0.5
roi: 170.00
owner: "designer-1"
created_at: "2026-05-11T10:44:56.070Z"
updated_at: "2026-05-11T11:14:14.553Z"
blocked_by: ["design_card_iface", "design_global_keymap"]
blocks: ["design_help_overlay", "design_popup_agents", "design_popup_log", "design_popup_tasks", "design_popup_tracks", "design_tests", "design_yank_flow"]
---

# Design fullscreen popup lifecycle: open/restore-state/close/single-popup invariant

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:14:12.321Z

```
DESIGN: fullscreen popup lifecycle — state machine, restore contract,
on-open hook, popup tick, error path, invariant test.

This note locks the lifecycle so the implementer can encode it
mechanically. It builds on (and does not contradict):
  - design_locked         (single-popup invariant; popup close restores
                          prior dashboard state; +/-/=/0 stay live in
                          popups)
  - design_card_iface     (Card/Popup interfaces; SavedDashboardState
                          shape; PopupProps)
  - design_global_keymap  (digit/glyph row; in-popup convention; 1-9 +
                          Shift+1-9 SUPPRESSED inside popups)
  - design_poll_loop      (popup pauses dashboard tick via
                          popupOpenRef short-circuit; popup owns own
                          setInterval driven by SAME tickMs state;
                          on close fires one immediate dashboard
                          refresh via setNonce++)
  - design_module_layout  (state.ts in src/cli/tui/ holds the
                          dispatcher + restoreState + popup-lifecycle
                          helpers)

================================================================
FILES (planned)
================================================================
- src/cli/tui/state.ts      — PopupState union, dispatcher reducer,
                              restoreState, error-boundary integration.
                              ~120 LOC.
- src/cli/tui/app.tsx       — root <App>; owns useState for tickMs,
                              cardEnabled, footerLine, popupState;
                              passes the dispatcher down.
- src/cli/tui/popup.tsx     — <PopupHost>: error boundary + onOpen
                              effect runner + popup-local setInterval +
                              popup→dashboard restoration on unmount.
                              ~80 LOC.
- src/cli/tui/types.ts      — PopupState union (re-export from state.ts
                              if cleaner) + PreservedDashboardState
                              (alias for SavedDashboardState in
                              design_card_iface; one shape, one name).

================================================================
COMMANDS
================================================================
None. Read-only design task. Cross-checked sibling notes:
  mu task notes design_locked        -w tui
  mu task notes design_card_iface    -w tui
  mu task notes design_global_keymap -w tui
  mu task notes design_poll_loop     -w tui
  mu task notes design_module_layout -w tui
  mu task notes design_sdk_seam      -w tui

================================================================
FINDINGS
================================================================

----------------------------------------------------------------
1. STATE MACHINE — 2 STATES, NOT 4
----------------------------------------------------------------

The brief proposed 4 states (DASHBOARD, POPUP_OPENING, POPUP_OPEN,
POPUP_CLOSING). Pick the smaller set:

    type PopupState =
      | { kind: "closed" }                                 // = DASHBOARD
      | { kind: "open"; subject: PopupSubject;
          saved: PreservedDashboardState }                 // = POPUP_OPEN

Why only 2:

- POPUP_OPENING was meant to model "first render of popup; useful if
  popup needs an on-open fetch." But that role is already filled by
  Popup.onOpen (per design_card_iface §6 sample) running in a
  useEffect inside <PopupHost> on mount. The state machine doesn't
  need a transient state to express "the effect hasn't resolved yet";
  React already expresses that as "extra is still undefined and the
  popup renders its loading branch" (see §4 below).

- POPUP_CLOSING was meant to model "last render of dashboard
  restoring state." But restoreState is a SYNCHRONOUS operation
  (three setState calls) that happens BEFORE the dispatcher transitions
  popupState to {kind:"closed"}. There is no observable in-between
  state from the user's perspective: one tick the popup is on screen,
  the next tick the dashboard is on screen with restored toggles +
  tickMs. No transient to model.

Adding states the implementer can't observe is anti-feature pledge
violation territory ("anticipatory abstractions"). The contract is
2 states; the React lifecycle does the mounting/unmounting work.

State transitions (the only legal ones):

    closed --user presses Shift+N (glyph row)----> open { N→subject, saved }
    open   --Esc / q / Popup.close() called------> closed; restore from saved
    open   --user presses Shift+M (M ≠ subject)--> NO-OP (see §2)
    open   --popup render throws-----------------> closed; restore from saved;
                                                   footerLine := crash toast
                                                   (see §6)

The dispatcher is one reducer in state.ts. Pseudocode:

    type Action =
      | { type: "open";  subject: PopupSubject }
      | { type: "close" }
      | { type: "crash"; subject: PopupSubject; message: string };

    function reduce(state: PopupState, action: Action,
                    snapshot: SnapshotForRestore): PopupState {
      switch (action.type) {
        case "open":
          if (state.kind === "open") {
            // SINGLE-POPUP INVARIANT — see §2.
            // The reducer does NOT mutate state; it returns state
            // unchanged. The dispatcher emits a footer toast as a
            // separate side-effect (see §2).
            return state;
          }
          return {
            kind: "open",
            subject: action.subject,
            saved: capture(snapshot),
          };
        case "close":
        case "crash":
          if (state.kind === "closed") return state;
          // restoreState(state.saved) is called by the caller before
          // dispatching this action — the reducer is pure.
          return { kind: "closed" };
      }
    }

----------------------------------------------------------------
2. SINGLE-POPUP INVARIANT — CHOICE (a): IGNORE + TOAST
----------------------------------------------------------------

Question: while POPUP_OPEN, what happens if user presses Shift+M
(opens a different popup)?

DECISION: Choice (a) — IGNORED + footer toast.

The toast text is deterministic, so the implementer doesn't have to
invent it:

    "popup already open: <currentSubject> — press Esc to close"

Rationale (against the other two options):

- (b) "close current + open new (instant transition)" — REJECTED.
  Modal popups should behave modally. A user who hits Shift+1 → reads
  the agents popup → fat-fingers Shift+2 expects nothing to happen,
  not to silently lose their place. Worse: if AgentsPopup had any
  mid-interaction state (filter mode active, scroll position), (b)
  destroys it without confirmation. (b) also conflicts with
  design_card_iface I1, which already calls this case a "NO-OP +
  footer toast 'popup already open: <X>'."

- (c) "error / sound bell" — REJECTED. Bells in TUIs are user-hostile
  on most terminal emulators (some users have them disabled, some
  have them deafening, some have flash-screen visual bells that strobe
  the entire screen). And the keypress isn't an error — it's a stale
  reflex; the user may not even realise a popup is open. A toast is
  the gentlest correct feedback.

- (a) "ignored + footer toast" — CHOSEN. Matches design_card_iface
  I1 verbatim. Visible feedback (the footer line updates) without
  being modal-on-modal. The toast is informative ("press Esc to
  close" tells the user the recovery action). Cheap to implement
  (one branch in the reducer + one footer write).

Edge case: pressing Shift+N where N IS the currently open subject
(e.g. Shift+1 while Agents popup is open). Same NO-OP + toast — but
the toast text is identical to "popup already open: agents", which
already conveys the right thing. No special-case branch needed; the
state.kind === "open" check fires regardless of subject.

The toast is written to the SAME footerLine the dashboard uses.
Per design_card_iface I3, yanks inside the popup overwrite the
footer for the duration of the popup AND replace the saved value;
the toast follows the same path (it's not a yank but it's the same
"popup writes to footer" code path). On Esc, the toast becomes the
restored footer line — fine; the user just saw it.

----------------------------------------------------------------
3. PreservedDashboardState — CONFIRMED ALIAS, NOT A NEW SHAPE
----------------------------------------------------------------

The brief proposed:

    PreservedDashboardState = {
      cardVisibility: Record<CardId, boolean>;
      tickMs: number;
      footerLine: string | null;
      lastYank: string | null;
    }

DECISION: PreservedDashboardState is exactly SavedDashboardState
from design_card_iface §3. It is one type, one name, one source of
truth. Pick ONE name to avoid drift; I am picking
PreservedDashboardState as the canonical (closer to the brief's
naming + clearer at the call site) and aliasing in types.ts:

    /** The bundle of dashboard state captured at popup-open time
     *  and restored byte-identical on popup-close. Single source
     *  of truth; do NOT introduce parallel "saved" types per popup. */
    interface PreservedDashboardState {
      cardEnabled: Record<PopupSubject, boolean>;  // §I4: forbidden
                                                   // to mutate while
                                                   // popup is open
      tickMs: number;                               // §5: shared
                                                   // useState; popup
                                                   // mutations DO
                                                   // affect this
      footerLine: string | null;                   // §I3 + §2: yanks
                                                   // and toasts inside
                                                   // popup overwrite
                                                   // saved.footerLine
    }
    /** Alias for backwards-compat with design_card_iface text. */
    type SavedDashboardState = PreservedDashboardState;

Confirmation / divergences from the brief shape:

- cardVisibility → cardEnabled. Same semantics; cardEnabled is the
  field name design_card_iface §3 already uses, and the dashboard's
  useState is named the same way. Don't rename for cosmetics.

- CardId → PopupSubject. The keymap uses subjects ("agents", "tracks",
  "ready", "log"); the digit ID is a positional index, the subject
  is the stable identifier. Use subject so the type survives
  card-reorders.

- tickMs — KEPT AS IS. Per §5 + design_poll_loop §4 + §7, tickMs is
  ONE useState in <App>; +/-/=/0 inside the popup mutate it; close
  restores saved.tickMs. The "save and restore" semantic is the
  brief's intent — implementer must NOT collapse this to "popup
  inherits and never restores."

- footerLine — KEPT. saved.footerLine is the dashboard's persistent
  footer at popup-open time. Inside the popup, the footer gets
  rewritten by yanks (per design_card_iface I3) AND by the
  popup-already-open toast (per §2 above). Per I3, those writes
  REPLACE saved.footerLine, so on close the most recent overwrite
  persists. Type stays string | null because the dashboard ships
  with footerLine = null (no yanks yet, no toasts yet); the union
  matches the dashboard's useState<string | null>(null).

- lastYank — DROPPED. The brief listed it separately from footerLine,
  but per design_locked the yank flow A3' is "clipboard if available
  + transient toast in popup + persistent footer line on dashboard."
  The persistent footer line IS the lastYank in serialised form
  ("last: mu agent close worker-1 -w tui [copied]"). Storing both
  duplicates state and creates drift questions ("what if footerLine
  has a non-yank message and lastYank has a yank — which wins on
  restore?"). One field, one source of truth: footerLine. If the
  implementer needs the raw mu command (without the "last: " prefix
  and "[copied]" suffix) for re-yank, parse it back from footerLine
  or keep the parsing helper next to the writer.

Capture is trivial; restore is three setState calls (per
design_card_iface §4):

    function capture({cardEnabled, tickMs, footerLine}): PreservedDashboardState {
      return { cardEnabled: {...cardEnabled}, tickMs, footerLine };
      // structural copy of cardEnabled defends against future code
      // that mutates it in place; tickMs/footerLine are primitives.
    }
    function restore(saved: PreservedDashboardState) {
      setCardEnabled(saved.cardEnabled);
      setTickMs(saved.tickMs);          // useEffect re-creates interval
      setFooterLine(saved.footerLine);
    }

----------------------------------------------------------------
4. ON-OPEN HOOK CONTRACT
----------------------------------------------------------------

Some popups need data outside WorkstreamSnapshot (e.g. AgentsPopup
wants pane scrollback for the focused agent — see design_card_iface
§6 sample's AgentsPopupExtra). The Popup interface already declares:

    onOpen?: (db, workstream, snapshot) => Promise<Extra>

This note locks the runtime contract:

WHERE THE FETCH HAPPENS:
  Inside <PopupHost> (src/cli/tui/popup.tsx). On mount, useEffect runs
  Popup.onOpen and stores the resolved value in local useState<Extra
  | undefined>. <PopupHost> is the only place that knows the popup's
  full lifecycle; the dispatcher in state.ts is concerned with
  open/closed transitions and does not own per-popup data.

  Pseudocode:

    function PopupHost({ popup, snapshot, ... }) {
      const [extra, setExtra] = useState<Extra | undefined>(undefined);
      const [extraError, setExtraError] = useState<string | null>(null);
      useEffect(() => {
        let cancelled = false;
        popup.onOpen?.(db, workstream, snapshot)
          .then(v => { if (!cancelled) setExtra(v); })
          .catch(e => { if (!cancelled) setExtraError(String(e)); });
        return () => { cancelled = true; };
      }, [popup.subject]);  // refire only on subject change (single-popup
                            // invariant means subject changes ↔ a fresh
                            // popup mount, but the cleanup is correctness
                            // insurance)
      const data = popup.select(snapshot);
      return <ErrorBoundary onError={...}>
               <popup.render data={data} extra={extra} ... />
             </ErrorBoundary>;
    }

  onOpen is OPTIONAL. If absent, extra is permanently undefined and
  the popup's render must handle that (typically by not consuming
  extra at all — see TasksPopup or LogPopup, which don't need
  extra; everything's in the snapshot).

LOADING STATE:
  Per-popup decision, not a global pattern. Render rules:

    - extra === undefined && extraError === null  → "loading"
    - extra !== undefined                          → "ready"
    - extraError !== null                          → "load failed"

  The popup's render decides what to show in each case. v0
  recommended pattern (the implementer should adopt unless the
  popup has a specific reason to differ):

    - Loading:    Render the popup CHROME (header, footer, key hints)
                  but show a centered "Loading…" line in the body
                  area. This is friendlier than spinner animation
                  (which competes with the dashboard tick) and beats
                  "blank screen for 200ms".
    - Failed:     Render chrome + body shows
                  "failed to load: <message> — press r to retry, Esc
                  to close" in red. Pressing r RE-FIRES the onOpen
                  effect (the global r/F5 keymap routes a refresh
                  intent to the focused popup; PopupHost listens and
                  re-runs the fetch on a nonce bump, mirroring the
                  dashboard's setNonce idiom from design_poll_loop §5).
    - Cached:     NOT the v0 pattern. We deliberately do NOT keep a
                  per-subject extra cache across popup open/close.
                  Rationale: popups close and reopen rarely (this is
                  a manual user gesture); on-open data is by definition
                  volatile (pane scrollback changes, log entries
                  arrive). A cache layer would be a "fix bug at
                  cache-invalidation time" pattern. Re-fetch every
                  open. If a popup has cheap-to-fetch extra, its
                  onOpen is fast; if it's expensive, the popup author
                  will notice during implementation and either narrow
                  the fetch or slot a Snapshot field in.

DOES THE FETCH BLOCK KEY HANDLING?
  NO. The keymap stays live the entire time onOpen is in flight.
  Specifically:
    - Esc / q closes the popup mid-load. The cleanup function
      (return () => { cancelled = true; }) marks the result as
      stale; if onOpen resolves after unmount, setExtra is not
      called (no React "set state on unmounted component" warning).
    - +/-/=/0 / r / F5 / ? all behave normally during load.
    - The popup's per-popup verb keys (a, b, d, ... per the
      reserved-letter pool from design_global_keymap) are routed but
      will likely no-op because the verb's act() typically needs
      extra (e.g. the focused agent's name). Per-popup author
      decides; the recommended pattern is "verb keys ignored while
      extra === undefined; the help overlay shows them as dimmed".

----------------------------------------------------------------
5. THE POPUP TICK
----------------------------------------------------------------

Per design_poll_loop §7: "dashboard tick freezes via popupOpenRef
short-circuit (not interval clear); popup owns its own interval
driven by the same tickMs state; popup close fires one dashboard
refresh (setNonce++) before resuming."

This note locks the questions design_poll_loop §7 left open:

DOES THE POPUP TICK FETCH THE SAME WorkstreamSnapshot?

YES. One shape, one fetcher (per design_sdk_seam — one composer
function in src/state.ts produces the 9-field WorkstreamSnapshot;
both the static HUD, the dashboard tick, and the popup tick consume
it). Reasons:

- Avoids divergence: a popup-specific subset would mean two fetchers
  to keep in sync ("agents popup's snapshot has X but dashboard's
  doesn't — bug"). The seam exists exactly to prevent that.
- Cheap: the snapshot composer is sub-millisecond per call
  (design_poll_loop §1 demonstrated this); fetching slices we don't
  use is not a measurable cost.
- The popup uses the snapshot via Popup.select to pick its slice
  (per design_card_iface §6 sample); the slice projection is the
  popup's mechanism for "I only care about agents". No need for a
  separate query.
- The popup's ON-OPEN extra (AgentsPopupExtra etc.) is the carve-out
  for data outside the snapshot. The tick doesn't refetch extra (per
  §4: extra is stored in PopupHost-local useState; the tick refreshes
  data, not extra).

DOES PRESSING +/- INSIDE THE POPUP AFFECT THE POPUP TICK AND THE
DASHBOARD'S RESTORED tickMs?

YES, both. There is exactly ONE tickMs useState in <App>. The +/-/=/0
keymap handlers are GLOBAL (per design_global_keymap: tick-rate keys
remain live inside popups). They mutate the same useState regardless
of popupState.

Consequences:
  - During popup: the popup's setInterval depends on tickMs (via
    useEffect with [tickMs] in the dependency list); changing tickMs
    cancels and re-creates the popup's interval at the new rate.
    The dashboard's setInterval is paused via popupOpenRef
    short-circuit (per design_poll_loop §7), so it doesn't matter
    that its interval is also still scheduled at the new rate.
  - On popup close: the dashboard restores saved.tickMs (the value
    captured at popup-open time). This is the WHOLE POINT of saving
    tickMs in PreservedDashboardState. The user's sped-up tick
    INSIDE the popup ("I want to live-tail the log at 200ms") is
    intentionally LOCAL to that popup session and reverts when they
    return to the dashboard ("don't burn battery polling at 200ms
    when I'm not even looking at the live log").

  Note: this is different from cardEnabled (where I4 says the popup
  CAN'T mutate it, so capture/restore is trivial). For tickMs, the
  popup CAN mutate the live state; the restore semantic comes from
  saved.tickMs being the snapshot taken on open, not from any
  guarantee about who can mutate.

  This is a deliberate asymmetry and worth a comment in state.ts:

    // tickMs IS shared (popup can mutate); cardEnabled IS NOT
    // (popup can't mutate). Both restore from saved on close.
    // The asymmetry is intentional: tick rate is a "session-local"
    // performance dial; card visibility is a "screen layout" dial.
    // Popup mutates the former for its own tick; the latter stays
    // dormant.

----------------------------------------------------------------
6. ERROR PATH
----------------------------------------------------------------

If a popup throws during render, the lifecycle MUST fall back to
dashboard with a footer toast and never crash the TUI.

ERROR BOUNDARY PLACEMENT:

ONE ErrorBoundary inside <PopupHost>, wrapping ONLY the popup's
render output. NOT a global app boundary; NOT a per-card boundary on
the dashboard (the dashboard cards have their own per-card try/catch
fence per design_poll_loop §8 — that handles fetch errors; render
errors fall through to a separate dashboard-level boundary if the
implementer wants belt-and-braces, but that's a dashboard concern,
not a popup-lifecycle concern).

Pseudocode:

    function PopupHost({ popup, snapshot, dispatch }) {
      // ...
      return (
        <ErrorBoundary
          onError={(e) => dispatch({
            type: "crash",
            subject: popup.subject,
            message: String(e),
          })}
        >
          <popup.render ... />
        </ErrorBoundary>
      );
    }

The dispatcher's "crash" action (see §1):
  1. Calls restore(saved) to return dashboard state to capture-time.
  2. OVERWRITES saved.footerLine BEFORE restoring it, with the toast:

       "popup <subject> crashed; check mu log -w <ws> --tail kind=error"

     i.e. the implementer writes:

       const toast = `popup ${subject} crashed; check ` +
                     `mu log -w ${ws} --tail kind=error`;
       restore({ ...saved, footerLine: toast });

  3. Returns { kind: "closed" } from the reducer.
  4. ALSO emits a `mu log` entry (kind=error) so the
     "check mu log" hint in the toast is honoured. PopupHost calls
     emitEvent (per src/logs.ts) with the popup subject, the error
     message, and the workstream. Read-only pillar caveat: the TUI
     opens the DB read-only per design_poll_loop NEXT bullet
     (design_db_open). Logging is a WRITE. Two acceptable
     resolutions:
       (a) The TUI process opens a SECOND db handle in read-write
           mode just for log writes. Cheap (better-sqlite3 handles
           are cheap; mu opens new ones in every CLI invocation).
           Recommended.
       (b) Skip the log write; the toast tells the user to check
           the log but only events emitted by other mu invocations
           appear there. Sub-optimal but pillar-pure.
     Recommend (a). The TUI is a special citizen; one rw handle for
     telemetry-style writes is acceptable. Document on
     design_db_open if/when promoted.

IMPORTANT non-coverage:
  - Errors INSIDE Popup.onOpen are NOT render errors; they're caught
    by the .catch in §4 and surface via extraError. The error
    boundary fires only on synchronous render-time throws.
  - Errors inside per-popup verb act() callbacks (e.g. yank
    serialization fails) are caught by the YANK handler, not the
    boundary; treated as a yank failure (footer "yank failed: …"),
    popup remains open. Out of scope here; locked in design_yank_flow.
  - Errors during restoreState itself: shouldn't be possible
    (three setState calls on hooks the dispatcher closed over),
    but if they did, they'd unmount the entire <App>. The top-level
    process exit message in src/cli/tui/index.ts should suggest
    re-running `mu state` (the static fallback) with a short
    "interactive TUI crashed" line.

----------------------------------------------------------------
7. UNIT TEST FOR THE SINGLE-POPUP INVARIANT
----------------------------------------------------------------

Writeable mechanically by the implementer. File:
test/cli/tui/popup-lifecycle.test.ts (or wherever the TUI cluster
tests land — design_module_layout doesn't pin a test path; this is
the natural mirror).

Test name + body sketch (vitest + ink-testing-library):

    import { render } from "ink-testing-library";
    import { App } from "../../../src/cli/tui/app.js";

    it("single-popup invariant: Shift+B is ignored while popup A " +
       "is open; footer toasts the conflict", () => {
      const { stdin, lastFrame } = render(<App snapshot={fakeSnap}
                                              workstream="tui" />);
      // Open Agents popup (Shift+1 on US-QWERTY = "!")
      stdin.write("!");
      expect(lastFrame()).toMatch(/Agents/);
      expect(lastFrame()).not.toMatch(/Tracks/);

      // Send Shift+2 ("@") — popup A should remain; popup B is NOT open
      stdin.write("@");
      expect(lastFrame()).toMatch(/Agents/);   // still Agents
      expect(lastFrame()).not.toMatch(/Tracks/); // NOT switched
      expect(lastFrame()).toMatch(/popup already open: agents/);

      // Esc → dashboard restored, no popup
      stdin.write("\x1b");                     // Esc
      expect(lastFrame()).not.toMatch(/Agents popup/);
      // (footer may carry the toast or the cleared dashboard footer
      //  depending on capture order — assert ONE of them, not both,
      //  to avoid coupling to the §2 design's "toast persists post-Esc"
      //  detail)
    });

Companion tests the implementer SHOULD add in the same file:

    it("Esc / q both close the popup and restore saved state", () => {
      // open popup, mutate tickMs (+ keypress), assert popup tick
      // changed; close with Esc; assert tickMs reverted to saved.
    });

    it("popup render throw is caught, dashboard restored, footer " +
       "carries crash toast", () => {
      // mock a popup whose render() throws "boom"; open it; assert
      // popupState became closed; assert footerLine matches
      // /popup .* crashed; check mu log -w tui --tail kind=error/.
    });

    it("on-open extra is fetched after mount; popup is interactive " +
       "while extra is undefined", () => {
      // mock onOpen as a never-resolving promise; open popup; assert
      // body shows /Loading/; press Esc; assert popup closes (no
      // hang); assert no React unmount warning was emitted.
    });

These four tests (the §1-§6 contracts) are the v0 must-have; the
implementer can add more (e.g. testing the popup's tickMs +/-
mutating shared state) but these four cover the lifecycle locked
above.

================================================================
DECISION (summary)
================================================================

1. Two-state machine: { kind: "closed" } | { kind: "open"; subject;
   saved }. No transient OPENING/CLOSING — React lifecycle handles
   the mount/unmount and onOpen useEffect handles the loading window.

2. Single-popup conflict (Shift+M while popup A open): IGNORE +
   footer toast "popup already open: <subject> — press Esc to close".
   Modal popups stay modal; (b) loses user's place; (c) is hostile.

3. PreservedDashboardState = { cardEnabled, tickMs, footerLine }.
   Dropped lastYank: the persistent footer line IS the serialised
   yank. Aliased to design_card_iface §3's SavedDashboardState; one
   shape, one source of truth.

4. on-open hook: fetched in PopupHost useEffect on mount; per-popup
   render decides loading UI (recommend "chrome + 'Loading…' centred
   body"); keymap stays live; no extra cache across open/close.
   Failed onOpen surfaces as "press r to retry, Esc to close".

5. Popup tick: same WorkstreamSnapshot as the dashboard (one
   composer; design_sdk_seam). +/-/=/0 mutate the SAME tickMs
   useState — the popup tick changes immediately AND the dashboard
   restores saved.tickMs on close (intentional: session-local
   performance dial). cardEnabled is forbidden mutation in popup
   (per I4); restored byte-identical.

6. Error path: ErrorBoundary inside <PopupHost> wraps
   popup.render; on throw the dispatcher emits "crash" → restore
   saved with footerLine overwritten to "popup <subject> crashed;
   check mu log -w <ws> --tail kind=error" + emit a kind=error log
   entry (requires a rw DB handle in the TUI process; recommended).

7. Test: open Shift+1, send Shift+2, assert popup A still open AND
   popup B NOT open AND footer matches "popup already open: agents".
   Plus three companion tests (Esc/q close+restore, render-throw
   recovery, on-open loading non-blocking).

================================================================
NEXT
================================================================

- design_help_overlay (downstream): document all four error/load
  states ("Loading…", "failed: … (r=retry)", "popup already open:
  X", "popup X crashed") in the help table so users see them as
  discoverable affordances.

- design_popup_agents / design_popup_tasks / design_popup_log /
  design_popup_tracks (downstream): each per-popup task copies the
  Popup template from design_card_iface §6, declares verbs, and
  declares onOpen if needed. The lifecycle contract above is what
  they MUST honour:
    (a) onOpen returns Promise<Extra>; the loading branch in render
        must handle extra === undefined gracefully.
    (b) verb act() callbacks must not throw synchronously into
        render; use the yank-flow error path instead.
    (c) per-popup state (filter mode, scroll position, etc.) lives
        in popup-local useState and is LOST on close. If a popup
        wants persistence, that's a v0.next request — push back.

- design_tests (downstream): the four lifecycle tests in §7 are
  the v0 required suite. Add to the design_tests inventory.

- design_yank_flow (downstream): footer overwrite semantics for
  yanks must not collide with the conflict-toast and crash-toast
  paths described here. The lifecycle treats footerLine as a
  generic "popup-writeable string"; yank flow is responsible for
  formatting its own writes ("last: <command> [copied]") and for
  not overwriting a same-tick crash toast. Recommend yank writes
  guard with a "do not overwrite a footerLine starting with
  'popup ... crashed'" check, OR (simpler) accept the
  last-writer-wins semantics (yank presses are user-initiated and
  immediate, crashes are rare; if both fire same tick, the yank is
  the user's last action and wins). My recommendation: last-writer-
  wins; simpler, no special-case.

- design_db_open (NEW; consider promoting per design_poll_loop's
  NEXT): the TUI process needs read-only DB for the tick AND a
  separate read-write handle for emitting the crash log entry
  (§6 case (a)). Five-line change in src/db.ts to support a
  readonly: boolean option. Promotion criterion: real
  SQLITE_BUSY toasts during dogfooding.

================================================================
VERIFIED
================================================================

- Cross-checked against design_locked: single-popup invariant,
  popup close restores prior dashboard state (toggles + tick),
  no persistence, +/- live in popups, yank-flow A3'. All preserved
  and made specific in this lifecycle.

- Cross-checked against design_card_iface §3 (SavedDashboardState),
  §4 (restoreState pseudocode), §I1 (single-popup invariant), §I3
  (yank overwrite), §I4 (cardEnabled forbidden in popup), §6
  (Popup.onOpen sample). PreservedDashboardState reuses the §3
  shape verbatim; the "ignore + toast" choice in §2 matches §I1
  word-for-word; the on-open hook in §4 here builds on §6's
  AgentsPopupExtra sample without contradicting it.

- Cross-checked against design_global_keymap: 1-9 + Shift+1-9 are
  SUPPRESSED inside popups; pressing them shows a footer toast.
  This note's §2 toast text ("popup already open: <X> — press Esc
  to close") is the lifecycle's specific case of that general rule;
  the keymap's blanket "press Esc to return to dashboard" is the
  fallback when the suppression isn't a popup-conflict (e.g.
  pressing 3 to toggle a card while a popup is open). Both toasts
  are valid and distinct; the keymap dispatcher routes to the
  correct one based on which key was pressed (digit vs glyph).

- Cross-checked against design_poll_loop §7: dashboard tick freezes
  via popupOpenRef short-circuit (no interval clear); popup owns
  its own setInterval driven by the same tickMs state; on close
  the dashboard fires setNonce++ for one immediate refresh. This
  note's §5 honours all three. Plus answers two questions §7 left
  open (same snapshot? yes; +/- shared? yes for live mutation, AND
  saved.tickMs restores on close).

- Cross-checked against design_module_layout: state.ts is the
  cluster file that owns the dispatcher + restoreState; popup.tsx
  is a new file in the cluster that owns PopupHost (with the
  ErrorBoundary, the onOpen useEffect, and the popup-local
  setInterval). Both fit the cluster layout (~120 + ~80 LOC).

- Cross-checked the SDK surface for the §6 log emission: src/logs.ts
  exports emitEvent(workstream, kind, payload). No SDK additions
  needed. The rw DB handle for that write is the only new
  infrastructure (design_db_open).

================================================================
ODDITIES
================================================================

- The reducer in §1 is a "pure-but-with-side-effect-context" pattern
  (the close/crash actions assume the caller already invoked
  restoreState). React's useReducer doesn't model side effects
  cleanly; alternatives are (a) call restoreState INSIDE the
  reducer (impure but co-located), (b) split into two functions
  closeAndRestore() and crashAndRestore() and skip the reducer
  entirely. The implementer can pick (a) or (b); the contract
  here is the state-transition shape, not the reducer mechanics.
  (b) is probably simpler — useReducer is overkill for a 2-state
  union.

- "Loading…" vs spinner (§4): the "popup pauses dashboard tick"
  semantic from design_poll_loop §7 means we already have a
  setInterval running inside the popup. Adding ANOTHER setInterval
  for a spinner is wasteful but not catastrophic. Recommend
  "Loading…" static text; if a per-popup author wants a spinner,
  they own it. Document in the per-popup tasks.

- The §6 log-on-crash story requires write access from the TUI
  process. This note recommends a second rw DB handle but
  acknowledges the read-only pillar pressure. If design_db_open
  punts on the rw side, fall back to the no-log behaviour (toast
  still tells user to check the log; the log just won't have THIS
  crash). Acceptable degradation.

- The "popup already open" toast (§2) conflicts with the
  "press Esc to return to dashboard" toast (from design_global_keymap
  for digit-row presses inside popup). Both are valid; both fire
  for different keystrokes (glyph row vs digit row). Implementer
  must wire BOTH, with the right toast for the right key. Help
  overlay should list both so users learn the two distinct error
  modes.

- design_card_iface §I3 says yanks inside the popup REPLACE
  saved.footerLine (so the new yank persists post-close). §2 here
  treats the conflict toast the same way: "popup already open" is
  written to the live footerLine via the same setFooterLine handler
  as a yank, AND replaces saved.footerLine. The consequence: if a
  user opens Agents, fat-fingers Shift+2 (gets the toast), then
  presses Esc, the dashboard footer reads "popup already open:
  agents — press Esc to close" — which is now a stale message
  with no popup. Acceptable: the user can press 'c' (the global
  "clear footer" key per design_global_keymap) to dismiss. NOT a
  bug; documented here so the implementer doesn't try to special-
  case toast vs yank in the saved.footerLine update.

- We considered a "popup history" stack (close popup A → press B in
  popup → A reappears on Esc-from-B). REJECTED for v0; design_locked
  is explicit about single-popup invariant and design_card_iface I1
  says "no popup-stack; no cross-popup nav. Esc returns to
  dashboard, not to a prior popup." The 2-state machine in §1
  encodes that pledge structurally — there's no place to put a
  stack.

- Test coverage in §7 uses ink-testing-library. design_module_layout
  ODDITIES already flagged this as a devDep to add; the lifecycle
  tests are one of the strongest reasons to land that devDep early
  (the §7 four-test suite is the lifecycle's gate).
```

### #2 by "designer-1", 2026-05-11T11:14:14.553Z

```
CLOSE: lifecycle state machine + restore contract + on-open hook locked
```
