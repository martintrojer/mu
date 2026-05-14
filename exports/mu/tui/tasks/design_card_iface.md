---
id: "design_card_iface"
workstream: "tui"
status: CLOSED
impact: 85
effort_days: 1
roi: 85.00
owner: "designer-1"
created_at: "2026-05-11T10:44:55.865Z"
updated_at: "2026-05-11T11:08:51.857Z"
blocked_by: ["design_module_layout", "design_sdk_seam"]
blocks: ["design_card_agents", "design_card_log", "design_card_ready", "design_card_tracks", "design_popup_lifecycle", "design_resize", "design_tests", "docs_vocab_amend"]
---

# Design Card and Popup interfaces (one file per card+popup pair)

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:08:48.914Z

````
FILES:
- (none modified — design-only role; output is this note)
- read: mu task notes design_locked        -w tui   (locked decisions)
- read: mu task notes design_module_layout -w tui   (src/cli/tui/ cluster + JSX/file tree)
- read: mu task notes design_poll_loop     -w tui   (tick + fetchCard pattern + cardEnabled gate)
- read: mu task notes design_global_keymap -w tui   (1-9 + !-( + in-popup convention + reserved letter pool)
- read: mu task notes design_sdk_seam      -w tui   (WorkstreamSnapshot exact shape)
- read: mu task notes audit_state_ts       -w tui   (regressions vs static `mu state`)

COMMANDS:
- mu task show design_card_iface -w tui
- (zero shell mutations; design-only; ~60 min)

FINDINGS:

1. The 6 prior notes lock enough that this contract can be surgical.
   Concretely:
   - The DATA shape is FIXED (scout-2's WorkstreamSnapshot — 9 fields,
     all SDK types, no new types). Each card consumes a TYPED SLICE.
   - The KEY BINDINGS are FIXED (designer-1's keymap: 1-9 toggle,
     !-( open popup; reserved-letter pool a/b/d/e/f/h/i/l/m/o/p/s/t/u/v/x/z
     for per-popup verbs; j/k/g/G/n/N/q/y/c/r/w are global in-popup verbs
     and MUST NOT be shadowed).
   - The FETCH GATING is FIXED (poll_loop §1 already gates
     `cardEnabled.X ? fetch : prev.X` — disabled cards skip SQLite
     reads and reuse the prior slice; TOGGLE-ON triggers an immediate
     refresh-now via the existing r/F5 path, see §5 below).
   - The MODULE LAYOUT is FIXED (src/cli/tui/cards/<id>.tsx +
     src/cli/tui/popups/<id>.tsx; one .tsx per card and one per popup;
     sibling state.ts owns the snapshot, keys.ts owns the dispatcher).
   So the contract reduces to: 2 TS interfaces, 1 pairing rule, 1
   single-popup invariant, 1 fetch-gate carve-out, 1 sample.

2. SCOPE-CHECK on per-card ephemeral state (the question the brief
   raised about Activity-log auto-scroll-pause):
   - The dashboard has NO selection state and NO scroll state on any
     card (locked in design_global_keymap: "1-9 / Shift+1-9 are
     SUPPRESSED inside popups"; the dashboard has zero per-card row
     focus). Cards are GLANCEABLE — fixed-height summaries.
   - The Activity-log card on the dashboard renders the LATEST N
     events truncated to fit; new events scroll in from the top.
     There is no user-driven scroll position.
   - The POPUP for Activity-log owns the auto-scroll-pause flag
     (since j/k drive selection in the popup; pause = "selection
     not at the head"). The CARD does not.
   - Conclusion: per-card ephemeral state is allowed by the contract
     but NONE of the v0 cards need any. Popups own all selection,
     scroll, pause, filter, and yank-target state.

3. SCOPE-CHECK on the `focused` flag the brief asks about:
   - Today the dashboard has no focus model (no Tab between cards,
     no card-level navigation). When a popup is open, the dashboard
     is COMPLETELY HIDDEN (single-popup invariant: popup is
     fullscreen, replaces the dashboard render tree). So there's no
     "highlight headers when popup is open for it" because the
     dashboard isn't on screen.
   - Therefore the prop is NOT `focused`. It is a future-proofing
     reservation: cards SHOULD accept a `focus` slot that today is
     always passed `'none'` and ignored. v0.next may add Tab-cycle
     focus or card-headers-glow-during-flash; the contract supports
     it without churn.

4. SCOPE-CHECK on popup-without-card (the brief's "command palette"
   example):
   - Cards and popups are INDEPENDENT registries. Pairing is by
     SHARED `subject` (a string id like "agents", "tracks") when
     both exist. A card MAY exist without a popup (rare; a popup
     adds value because cards are summaries). A popup MAY exist
     without a card (the command-palette case).
   - Numeric ids 1-9 are RESERVED for cards. A popup with a sibling
     card REUSES the card's numeric id and binds to Shift+<id>'s
     glyph (! @ # $ %). A popup WITHOUT a sibling card binds to a
     key drawn from the reserved-letter pool {a b d e f h i l m o p
     s t u v x z} that designer-1 carved out, OR to a punctuation
     key the keymap has not claimed (`:` is the obvious command-
     palette key — vim / k9s / many TUIs use it).
   - This rule keeps the digit row meaning STABLE (digit = card)
     and uses the letter pool for "everything else". No popup-stack
     either way (single-popup invariant).

5. SCOPE-CHECK on the fetch-gate (cardEnabled = data not fetched):
   - Already locked by design_poll_loop §1: when `cardEnabled.X`
     is false, the tick body returns `prev.X` (stale slice from the
     last visible-tick) and SKIPS the SDK call.
   - Justification: the F1-simple-poll lock favours the cheapest
     thing that works. Skipping unused queries is cheaper, and the
     stale-on-toggle-on risk is bounded — see §"Toggle-on contract"
     below: re-enabling a card triggers an IMMEDIATE refetch via
     the same code path as r/F5, so the user sees fresh data before
     the next user-perceptible frame.
   - Carve-out: the Activity-log card uses an `afterSeq` cursor
     (poll_loop §1). When the card is hidden, the cursor FREEZES
     (we do NOT advance afterSeq during hidden ticks). On toggle-on,
     the next fetch issues `listLogs({ afterSeq: <frozen>, limit:
     EVENT_N })` — so the user sees every event that arrived while
     the card was hidden, capped at EVENT_N. If the gap exceeds
     EVENT_N, we still display the latest EVENT_N (bounded), and
     the popup retains the full-history fetch. This is the only
     card with a non-trivial gating semantic.

DECISION:

================================================================
1. THE CARD INTERFACE (consumed by every card-design task)
================================================================

```ts
// src/cli/tui/types.ts (new file inside the cluster; pure TS, no JSX)

import type { ComponentType } from "react";
import type { WorkstreamSnapshot } from "../../state.js";

/** What a card receives. The data slice is derived from the snapshot
 *  by the card's own `select(snapshot)` projection (see below) so the
 *  parent does not have to know the card's internals.                  */
export interface CardProps<TSlice> {
  /** The card's typed projection of the latest WorkstreamSnapshot.    */
  data: TSlice;

  /** Width budget the dashboard layout is granting this card RIGHT
   *  NOW. Cards reflow to fit; if width < minWidth the dashboard hides
   *  the card before render (see Card.minWidth). Always > 0 here.     */
  width: number;

  /** Height budget. Same contract as width.                           */
  height: number;

  /** Reserved focus slot. Always 'none' in v0 (no dashboard focus
   *  model; popups own all interaction). Future-proofing for v0.next
   *  card-cycle focus or flash highlights — cards SHOULD accept and
   *  ignore non-'none' values without crashing.                       */
  focus: "none" | "soft" | "hard";

  /** Live tick budget (ms) and last fetch cost (ms). Cards MAY render
   *  micro-indicators (e.g. dim ⚠ when last fetch > tickMs); most
   *  won't bother. Same source as the dashboard footer.               */
  tickMs: number;
  lastFetchMs: number;
}

/** A Card is a value object. The dashboard imports a Card[] registry
 *  and maps over it. There are no classes, no hooks at the registry
 *  level — only data + a render function.                             */
export interface Card<TSlice> {
  /** Numeric 1..9. Toggles dashboard visibility on this digit
   *  (design_global_keymap). Sibling popup binds Shift+<id> glyph.    */
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

  /** Stable string subject id, used as the pairing key with popups
   *  and as the React key in the dashboard layout. lowercase, no
   *  spaces; e.g. "agents", "tracks", "ready", "log".                 */
  subject: string;

  /** Human-readable label. Help overlay reads this; truncated to ~16
   *  chars in the dashboard card header.                              */
  label: string;

  /** Pure projection: snapshot → typed slice the card needs. Called
   *  on every tick AFTER the snapshot has been refreshed (or, when
   *  the card is hidden, returns whatever `prev` would have been —
   *  the parent gates this; see §5).                                  */
  select: (snapshot: WorkstreamSnapshot) => TSlice;

  /** Layout-reflow hint. Dashboard hides the card (with a footer
   *  toast "card N hidden: terminal too narrow") if the assignable
   *  width or height for this row is below either threshold. v0
   *  defaults: minWidth=40 cols, minHeight=4 rows for tight cards;
   *  Activity-log uses minWidth=60.                                   */
  minWidth: number;
  minHeight: number;

  /** The ink component. FC<CardProps<TSlice>>. JSX lives in the
   *  per-card .tsx file; the registry sees an opaque component.      */
  render: ComponentType<CardProps<TSlice>>;
}
```

Notes:
- The TSlice generic is the contract that lets each card-design task
  pick its OWN slice of WorkstreamSnapshot. AgentsCard slice =
  `{ view: WorkstreamSnapshot["view"] }`; TracksCard slice =
  `Track[]`; ReadyCard slice = `{ ready: TaskRow[] }` (and reads
  `inProgress` if it wants to show "next claimable" badges); LogCard
  slice = `{ recent: LogRow[] }`. Each per-card task declares the
  exact slice in its note so the projection is auditable.
- NO ephemeral state on Card. The dashboard cards are stateless; if
  a card needs animation (e.g. a flash on new events), it does so
  with a local useEffect on the prop change — that's an
  IMPLEMENTATION detail of the .tsx file, NOT part of the contract.
  This is the brief's "auto-scroll-pause owned by popup not card"
  call — formalised as: cards have no useState, popups do.
- NO close/onClose callback on Card. The dashboard owns visibility
  via the cardEnabled state; cards do not toggle themselves.
- NO selection / onSelect callback on Card. The card is glanceable.
  Selection lives in the sibling popup.

================================================================
2. THE POPUP INTERFACE (consumed by every popup-design task)
================================================================

```ts
import type { ComponentType } from "react";
import type { WorkstreamSnapshot } from "../../state.js";
import type { Db } from "../../db.js";

/** Per-popup verb registration. The dispatcher (src/cli/tui/keys.ts)
 *  composes these with the global in-popup convention from
 *  design_global_keymap. Shadowing a global verb is a TYPE ERROR —
 *  the `key` field is bounded to the reserved-letter pool below.     */
export type PopupVerbKey =
  // Reserved letter pool from design_global_keymap (NOT j k g G n N q
  // y c r w; those are global in-popup verbs and MUST NOT be shadowed).
  | "a" | "b" | "d" | "e" | "f" | "h" | "i" | "l" | "m"
  | "o" | "p" | "s" | "t" | "u" | "v" | "x" | "z"
  // Punctuation a popup MAY claim if no sibling card binds it.
  | ":" | "/" | "."; // `/` is in-popup filter — see ODDITIES.

export interface PopupVerb {
  /** Letter (or punctuation) the user presses INSIDE this popup.
   *  MUST be from PopupVerbKey above.                                 */
  key: PopupVerbKey;

  /** Help-overlay label, e.g. "notes" / "tree" / "blockers".          */
  label: string;

  /** The action the verb performs. Receives the focused row's
   *  identity (popup-defined; e.g. taskId for a task popup, agent
   *  name for an agents popup). Returns a yank-string OR void. If
   *  it returns a string, the dispatcher routes through the global
   *  yank flow (clipboard probe + toast + footer line) — popups do
   *  not call clipboard themselves.                                   */
  act: (rowKey: string, ctx: PopupActCtx) => string | void;
}

export interface PopupActCtx {
  workstream: string;
  /** Snapshot at the time of the keypress; popups MAY use this to
   *  render or to format the yank string. NOT a fresh fetch.          */
  snapshot: WorkstreamSnapshot;
}

/** What a popup receives. Same data slice the sibling card got, plus
 *  the close callback, the yank helper, and any popup-only data.     */
export interface PopupProps<TSlice, TExtra = undefined> {
  /** The same projection the sibling card consumed. Cards and popups
   *  for the same `subject` SHARE the slice type (see Pairing Rule
   *  §3). For popups WITHOUT a sibling card, TSlice is whatever the
   *  popup declares.                                                  */
  data: TSlice;

  /** Optional extra data fetched on-open via Popup.onOpen (see
   *  below). undefined for popups that only need the tick snapshot.   */
  extra: TExtra;

  /** Width / height of the full terminal. Popups are FULLSCREEN
   *  (single-popup invariant); they do not negotiate layout.          */
  width: number;
  height: number;

  /** Close the popup and restore the prior dashboard state (see §4).
   *  Pressing Esc / q routes through this same callback.              */
  close: () => void;

  /** Yank helper: hand the dispatcher a string; it does the
   *  clipboard probe + toast + footer line. Popups MUST NOT call
   *  pbcopy / xclip directly (they live in src/cli/tui/yank.ts).      */
  yank: (text: string) => void;

  /** Live tick budget; popups MAY render their own freshness ticker
   *  (e.g. "events updated 0.4s ago"). Same source as Card.tickMs.    */
  tickMs: number;
}

/** A Popup is a value object, parallel to Card.                       */
export interface Popup<TSlice, TExtra = undefined> {
  /** Pairing id. If a sibling card exists, MUST equal that card's
   *  numeric id (binds Shift+<id> glyph). If no sibling card, set
   *  to `null` and declare `keyOverride` instead.                     */
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | null;

  /** Pairing key. If a sibling card exists, MUST equal that card's
   *  subject string. Otherwise a unique string of the popup's
   *  choosing (e.g. "palette").                                       */
  subject: string;

  /** Human-readable label for the help overlay.                       */
  label: string;

  /** Open key for orphan popups (id === null). One key, drawn from
   *  PopupVerbKey or `:` / `?`-adjacent. The global dispatcher
   *  registers it as a top-level open shortcut. MUST be undefined
   *  when id is non-null.                                              */
  keyOverride?: PopupVerbKey;

  /** Same projection the sibling card uses. For orphan popups
   *  declare your own.                                                */
  select: (snapshot: WorkstreamSnapshot) => TSlice;

  /** Per-popup verbs. Composed with the global in-popup convention
   *  by src/cli/tui/keys.ts. The dispatcher rejects (TYPE ERROR + a
   *  v0 unit test) any verb whose key collides with the global set
   *  {j k g G n N q y c r w} or with another popup verb.              */
  verbs: PopupVerb[];

  /** On-open hook. Runs ONCE when the popup mounts (Shift+id pressed
   *  on the dashboard). Use for popup-only fetches that should NOT
   *  fire every tick — e.g. AgentsPopup pulls full pane scrollback
   *  via `mu agent read -n N`; LogPopup pulls extended history via
   *  `listLogs({ limit: 1000 })`; TasksPopup pulls per-task notes
   *  via `listTaskNotes`. Returns the TExtra payload the component
   *  receives via PopupProps.extra. May return null / undefined.     */
  onOpen?: (db: Db, workstream: string, snapshot: WorkstreamSnapshot)
    => Promise<TExtra> | TExtra;

  /** On-close hook. Runs once on unmount (Esc / q / popup.close()).
   *  Use for cleanup (e.g. close a streaming subscription, free a
   *  scratch buffer). Pure side-effects; return value ignored.       */
  onClose?: () => void;

  /** The ink component. FC<PopupProps<TSlice, TExtra>>.               */
  render: ComponentType<PopupProps<TSlice, TExtra>>;
}
```

Notes:
- onOpen runs in the SAME synchronous path as the keypress; if it
  returns a Promise, the popup mounts in a "loading…" placeholder
  state until it resolves. The dispatcher uses the popup's `subject`
  as the key so React unmounts/remounts cleanly when a different
  popup is opened. (Single-popup invariant means at most one popup
  is mounted at any time.)
- Per-tick fetches inside the popup happen via the SAME poll loop
  the dashboard uses (poll_loop §7: "the popup, when open, is a
  sibling component that owns its own setInterval"); the popup's
  `data` prop is refreshed every tick. `extra` is NOT refreshed
  unless the popup explicitly calls a per-tick fetch from inside
  its component (rare; only LogPopup might want to advance afterSeq
  on its own faster cadence).
- Popups MAY call `yank(text)` from a useEffect or from a verb
  action. The yank string is whatever literal `mu` command the
  user would have run — that's the read-only act-intent contract
  from design_locked R1.

================================================================
3. THE CARD-POPUP PAIRING RULE
================================================================

THREE registries inside the cluster, each declared in
src/cli/tui/registry.ts:

  export const CARDS:  Card<unknown>[]   // Card[1..9] entries
  export const POPUPS: Popup<unknown>[]  // sibling popups + orphan popups
  // (no third — the help overlay is hard-coded and the workstream
  //  picker is bound to `w` and is its own thing per the keymap.)

Pairing rules:

  R1. A Card with id=N MAY have a sibling Popup with the same
      `subject` and id=N. That popup binds Shift+N glyph
      (! @ # $ % ^ & * ( per design_global_keymap).

  R2. A Card with id=N MAY exist WITHOUT a sibling popup. Hitting
      Shift+N glyph in that case shows the footer toast "no popup
      bound to <subject>". (Reserves Shift+N for a future popup
      without breaking muscle memory.)

  R3. A Popup with id=null is an ORPHAN popup. It declares
      `keyOverride` from PopupVerbKey (preferring `:` for the
      command-palette case; preferring a letter from the reserved
      pool for category-style popups). Orphan popups DO NOT consume
      a digit slot. Multiple orphan popups are allowed; each binds
      its own key.

  R4. A Card MUST be unique on its `subject`; a Popup MUST be unique
      on its `subject`. The pairing is `subject ===` (NOT id ===),
      so re-numbering a card and its popup together is a one-line
      change.

  R5. v0 ships the canonical 4 sibling pairs:
        id=1 subject="agents" — AgentsCard ↔ AgentsPopup
        id=2 subject="tracks" — TracksCard ↔ TracksPopup
        id=3 subject="ready"  — ReadyCard  ↔ ReadyPopup
        id=4 subject="log"    — LogCard    ↔ LogPopup
      Slots 5..9 are reserved cards (per the keymap) — corresponding
      Shift+5..Shift+9 are reserved popup slots, BUT only if a card
      claims that slot first. Until then, an orphan popup MAY claim
      Shift+5 glyph (`%`) as its open key by setting id=5 +
      subject=<own> with no card defined. Discouraged but allowed.

================================================================
4. SINGLE-POPUP INVARIANT + STATE-RESTORE CONTRACT (formalised)
================================================================

The <App> root owns the popup state machine:

```ts
type PopupState =
  | { kind: "closed" }
  | { kind: "open"; subject: string;
      saved: SavedDashboardState };

interface SavedDashboardState {
  /** Bitset of visible cards at the moment the popup opened. The
   *  dispatcher restores this exactly on close — popup-time toggles
   *  on hidden keys (which are no-ops anyway, see in-popup keymap
   *  suppressing 1-9) cannot perturb it.                              */
  cardEnabled: Record<string /* subject */, boolean>;

  /** Tick rate (ms) at popup-open time. The popup MAY change tickMs
   *  via the global +/-/=/0 keys (those remain live in popups per
   *  design_global_keymap); on close, dashboard restores THIS value.
   *  Rationale: a user who slowed the dashboard to 5s, opened the
   *  log popup, sped it up to 200ms for live tailing, and closed it,
   *  expects the dashboard to return to its 5s pace.                  */
  tickMs: number;

  /** The persistent footer line at popup-open time ("last: mu agent
   *  close worker-1 -w tui [copied]"). Yanks INSIDE the popup
   *  OVERWRITE the footer for the duration of the popup AND replace
   *  the saved value, so the new yank persists after close. (Yanks
   *  are permanent intent; you don't want them lost just because
   *  they happened in a popup.)                                       */
  footerLine: string;
}
```

State transitions (enforced by <App>):

  closed --Shift+N glyph (card-paired)--> open { subject, saved }
  closed --keyOverride pressed (orphan)--> open { subject, saved }
  open  --Esc / q / popup.close()------> closed; restore from saved

INVARIANTS:
  I1. There is at most one popup mounted at any time. Pressing
      Shift+M while a popup for subject X is open is a NO-OP +
      footer toast "popup already open: <X>". (No popup-stack; no
      cross-popup nav. Esc returns to dashboard, not to a prior
      popup.)
  I2. Closing a popup ALWAYS calls restoreState(saved) before
      unmounting. Any popup that side-effects beyond the snapshot
      (rare; clipboard yank counts but is "saved.footerLine
      override") MUST flow through PopupProps.yank, never raw.
  I3. Tick rate changes inside the popup are visible on the popup
      footer (so the user can see "tick: 200ms" while in LogPopup)
      but DO NOT carry through to the dashboard. The dashboard's
      footer reads `saved.tickMs` while a popup is open (technically
      irrelevant since the dashboard isn't on screen, but the
      restore on close uses `saved.tickMs`).
  I4. Card visibility changes are FORBIDDEN while a popup is open
      (1-9 suppressed in-popup per the keymap). So `saved.cardEnabled`
      is restored byte-identical.
  I5. The `?`-help overlay is NOT a popup. It is a separate
      dispatcher mode that overlays on top of either dashboard OR
      popup (whichever is active) without saving/restoring. Closing
      help returns to the underlying mode untouched.

restoreState pseudocode (lives in src/cli/tui/state.ts):

```ts
function restoreState(saved: SavedDashboardState) {
  setCardEnabled(saved.cardEnabled); // dashboard re-renders all cards
  setTickMs(saved.tickMs);            // useEffect re-creates the interval
  setFooterLine(saved.footerLine);    // dashboard footer line restored
  // setPopupState({ kind: "closed" }) is the action that triggers this
  // — handled by the dispatcher, not restoreState.
}
```

================================================================
5. CARD-DISABLED = DATA-NOT-FETCHED CONTRACT
================================================================

Decision: WHEN A CARD IS HIDDEN (cardEnabled[subject] === false), THE
POLL LOOP SKIPS THAT CARD'S SDK CALL AND REUSES THE PRIOR SLICE.

Rationale (per the locked F1-simple-poll decision):
- Cheap-and-correct beats clever. F1 simple poll is "do the smallest
  thing that works"; skipping unused queries is the smaller thing.
- For a workstream with 10+ agents, 30+ tasks, and a busy log,
  hiding 2 of 4 cards measurably halves the per-tick fetch cost
  (each fetch is sub-ms but staleness from decorateWithStaleness on
  workspaces is the long pole; if the v0.1 Workspaces card lands,
  this becomes the bigger win).
- Justifies the explicit `cardEnabled.X ? fetch : prev.X` ternary
  already present in design_poll_loop §1 — no behaviour change here,
  just formalisation.

Toggle-on contract (the "slight risk of stale data" concern):

  on user press of digit N where cardEnabled[subject(N)] flips
  false → true:
    1. setCardEnabled({ ...prev, [subject]: true })
    2. The keymap dispatcher then calls the same refresh-now action
       used by r/F5 (poll_loop §5): trigger an IMMEDIATE tick (does
       not wait for the next setInterval fire), which now picks up
       the newly-enabled card and fetches its slice.
    3. The user sees fresh data on the very first frame the card
       appears in. No "card flashes stale data then updates" UX.

  Carve-out for the Activity-log card (the one card with a cursor):
    - On card hide, the afterSeq cursor FREEZES at its last value.
    - On card re-show, the next fetch issues
        listLogs({ workstream, kind:"event", afterSeq:<frozen>,
                   limit:EVENT_N })
      so the user sees every event that arrived while hidden, capped
      at EVENT_N=200 (poll_loop §1). If the gap exceeds EVENT_N, the
      most-recent EVENT_N rows are shown and the cursor advances to
      the new max(seq); the gap is silently lost from the card view
      but the LogPopup's larger fetch (limit:1000) covers it.
    - This is the only card whose hide/show semantics differ from
      "fetch on demand"; documented here so the LogCard implementer
      doesn't reinvent it.

================================================================
6. SAMPLE CARD (literal template every per-card task copies)
================================================================

```ts
// src/cli/tui/cards/agents.tsx
import { Box, Text } from "ink";
import type { LiveAgentsView } from "../../../agents.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { Card, CardProps } from "../types.js";

interface AgentsSlice {
  view: LiveAgentsView;
  // status histogram is a derivation; can be computed inside render
  // OR added here if multiple consumers need it. Per-card task
  // decides; keep slice minimal by default.
}

const AgentsCardComponent = ({ data, width, height }:
  CardProps<AgentsSlice>) => {
  // Pure ink JSX — render `data.view.agents` summary in a
  // <Box flexDirection="column" width={width} height={height}>.
  // Header: "Agents (N active, M orphan)".
  // Body: per-agent one-liner (status glyph, name, role, idle?).
  // Footer (if room): per-agent in-progress task count via
  //   summarizeOwnedTasks(view.agents, snapshot.inProgress).
  // Implementation deferred to design_card_agents.
  return null as never;
};

export const AgentsCard: Card<AgentsSlice> = {
  id: 1,
  subject: "agents",
  label: "Agents",
  select: (snap: WorkstreamSnapshot) => ({ view: snap.view }),
  minWidth: 40,
  minHeight: 4,
  render: AgentsCardComponent,
};
```

And the matching popup skeleton:

```ts
// src/cli/tui/popups/agents.tsx
import type { Popup, PopupProps } from "../types.js";
import type { AgentsSlice } from "../cards/agents.js"; // share the slice

interface AgentsPopupExtra {
  /** Full pane scrollback per agent, fetched ON OPEN (mu agent read
   *  -n 200 piped through the SDK), not refreshed every tick.        */
  scrollbacks: Record<string /* agent name */, string[]>;
}

const AgentsPopupComponent = ({ data, extra, width, height,
  close, yank }: PopupProps<AgentsSlice, AgentsPopupExtra>) => {
  // Render row-selectable list of agents with j/k/g/G/Esc/q from
  // global in-popup keymap; per-popup verbs declared below get
  // routed by the dispatcher. y yanks the act-intent for the
  // focused row (e.g. `mu agent close worker-1 -w tui`).
  return null as never;
};

export const AgentsPopup: Popup<AgentsSlice, AgentsPopupExtra> = {
  id: 1,
  subject: "agents",
  label: "Agents",
  select: (snap) => ({ view: snap.view }),
  verbs: [
    { key: "s", label: "show",  act: (name) => `mu agent show ${name}` },
    { key: "f", label: "free",  act: (name) => `mu agent free ${name}` },
    { key: "x", label: "close", act: (name) => `mu agent close ${name}` },
    // 's' / 'f' / 'x' are from the reserved letter pool;
    // 'show' would shadow nothing (s is free).
  ],
  onOpen: async (db, workstream, snapshot) => {
    // Pull pane scrollback for each visible agent, ONCE.
    // Implementation deferred to design_popup_agents.
    return { scrollbacks: {} };
  },
  render: AgentsPopupComponent,
};
```

Each per-card task (design_card_agents / design_card_tracks /
design_card_ready / design_card_log) and each per-popup task
(design_popup_agents / design_popup_tracks / design_popup_lifecycle
/ design_popup_log) copies these two skeletons into the relevant
.tsx file and fills in (a) the slice, (b) the verbs, (c) the
render body. The contract above is what they MUST NOT deviate
from; everything else is theirs.

NEXT:
- design_card_agents / design_card_tracks / design_card_ready /
  design_card_log — copy the AgentsCard template; pick the slice;
  declare minWidth/minHeight; design the render layout.
- design_popup_agents / design_popup_lifecycle (the Tasks popup) /
  design_popup_log / design_popup_tracks — copy the AgentsPopup
  template; declare verbs from the reserved letter pool; declare
  onOpen if extra data is needed; design the render body.
- design_help_overlay — render the keymap summary table; cite
  Card.label / Popup.label / PopupVerb.label as data sources so
  the overlay never drifts from the registries.
- v0 implementation MUST add unit tests asserting:
  (1) every PopupVerb.key is in PopupVerbKey AND no two popups'
      verbs collide.
  (2) every Card.id in [1..9] is unique; every Popup.id matches a
      Card.id of the same subject OR is null.
  (3) opening a popup, mutating tickMs/cardEnabled, and closing
      restores byte-identical SavedDashboardState.

VERIFIED:
- Cross-checked against design_locked: 4 cards, single-popup
  invariant, in-popup convention, +/-/=/0 stays live in popups,
  yank surface, no persistence — all preserved.
- Cross-checked against design_global_keymap: digit row owns cards;
  glyph row opens popups; reserved-letter pool is exactly
  {a b d e f h i l m o p s t u v x z} (18 letters); j/k/g/G/n/N/q
  /y/c/r/w are global in-popup verbs and are EXCLUDED from
  PopupVerbKey by construction.
- Cross-checked against design_poll_loop: the cardEnabled gate is
  identical to §1's existing ternary; the toggle-on refresh-now
  reuses §5's r/F5 path; afterSeq freeze-on-hide is consistent
  with §1's incremental-cursor contract; popup owns its own
  setInterval per §7.
- Cross-checked against design_sdk_seam: every Card.select /
  Popup.select projection consumes one or more fields of the
  9-field WorkstreamSnapshot; no card or popup invents a new SDK
  type. AgentsPopupExtra is the carve-out (popup-only data fetched
  on-open) and is explicitly outside the snapshot.
- Cross-checked against audit_state_ts: v0 cards cover Agents,
  Tracks, Ready, Log; In-progress / Blocked / Recent-closed /
  Workspaces / Orphans are accepted regressions for the dashboard
  (orphans fold into Agents card; v0.1 Workspaces card lands in
  reserved slot id=5 if promoted). The Card.id 5..9 reservations
  in the keymap exist exactly for that promotion.
- Cross-checked against design_module_layout: types.ts is a new
  pure-TS file inside src/cli/tui/; cards/<id>.tsx and
  popups/<id>.tsx slot into the existing tree; registry.ts is one
  more pure-TS file (re-exports CARDS / POPUPS); no JSX delta to
  the layout's manifest.

ODDITIES:
- `/` is in the PopupVerbKey punctuation set because design_global_keymap
  reserves it AS a global in-popup verb (filter mode). Including it
  here is intentional: a popup that does NOT want default `/`-filter
  (e.g. one with no list to filter) MAY rebind `/` to its own action.
  The dispatcher checks Popup.verbs FIRST; if the popup binds `/`,
  the global filter is suppressed for that popup. Document on
  per-popup tasks; v0 popups all keep the global filter.
- `?` is also a global key (help overlay) — it CAN'T be rebound;
  PopupVerbKey deliberately excludes it. Same rule for q/y/c/r/w.
- The `keyOverride` field on Popup is a forward-looking hook for
  the command-palette case (popup without sibling card). v0 ships
  zero orphan popups; the field exists to make the contract honest
  (the brief explicitly asked) without forcing v0 to ship one.
  v0.next can add a "command palette" or "search" popup without
  re-amending this contract.
- AgentsPopupExtra in the sample assumes a `mu agent read` SDK
  hook exists. It does — see src/agents.ts (readAgent / pane
  scrollback). The popup-design task for AgentsPopup will confirm
  the exact signature; this contract only asserts that on-open
  fetches are LEGAL and routed via Popup.onOpen, not that any
  particular fetch exists.
- The Card.minWidth / minHeight numbers above (40 cols, 4 rows;
  Log 60 cols) are first-cut heuristics from looking at the
  static HUD's column budgets in src/cli/state.ts L538-733; the
  per-card task is the FINAL authority and may revise. Contract
  only requires that the field exists and is honoured by the
  dashboard layout.
- types.ts intentionally exports `Card<unknown>[]` and
  `Popup<unknown>[]` array element types. The generic on each
  entry is preserved at the per-card declaration; the registry
  array erases it (TypeScript variance limitation — there's no
  way to express "an array of Card<T> for varying T without
  losing T"). The per-card .tsx file keeps full inference; the
  registry array does not. This is fine because the dashboard
  iterates the registry and calls `card.select(snapshot)` →
  `card.render({data, ...})` polymorphically, never inspecting T
  itself.
````

### #2 by "designer-1", 2026-05-11T11:08:51.857Z

```
CLOSE: Card + Popup interfaces locked; per-card and per-popup tasks can now proceed in parallel
```
