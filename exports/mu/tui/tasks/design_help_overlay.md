---
id: "design_help_overlay"
workstream: "tui"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: "designer-2"
created_at: "2026-05-11T10:45:23.423Z"
updated_at: "2026-05-11T11:19:13.492Z"
blocked_by: ["design_global_keymap", "design_popup_lifecycle"]
blocks: ["design_complete"]
---

# Design help overlay (?): shows global + popup-local keymap

## Notes (2)

### #1 by "designer-2", 2026-05-11T11:19:10.379Z

```
DESIGN: ?/F1 help overlay — orthogonal modal (not a popup), layered
on top of dashboard OR popup, rendered from declarative keymap inputs.

This note locks the overlay so the implementer can encode it
mechanically. It builds on (and does not contradict):
  - design_locked         (no config; in-popup convention; yank flow)
  - design_global_keymap  (SUMMARY TABLE = canonical content)
  - design_popup_lifecycle I5 ("help overlay is NOT a popup; orthogonal
                               mode; closes return to underlying mode
                               untouched")
  - design_card_iface     (Popup.verbs: PopupVerb[] — declarative
                          per-popup keymap already exists, §2; help
                          consumes this)

================================================================
FILES (planned)
================================================================
- src/cli/tui/help.tsx            — <HelpOverlay> component (~80 LOC).
                                    Pure function of {dashboardKeymap,
                                    inPopupKeymap, currentPopup?}.
- src/cli/tui/help-content.ts     — buildHelpModel({...}) that returns
                                    a HelpModel (sections + rows). Pure;
                                    no React; testable in isolation.
                                    ~60 LOC.
- src/cli/tui/state.ts            — adds helpOpen: boolean orthogonal
                                    to popupState (one extra useState
                                    in <App>; ~5 LOC).
- src/cli/tui/keys.ts             — routes ?/F1 to setHelpOpen toggle
                                    BEFORE any per-mode dispatch (~10
                                    LOC).
- test/tui-help.test.ts           — unit test on buildHelpModel (see §7).

================================================================
COMMANDS
================================================================
None. Read-only design task. Cross-checked sibling notes:
  mu task notes design_locked          -w tui
  mu task notes design_global_keymap   -w tui  (SUMMARY TABLE)
  mu task notes design_popup_lifecycle -w tui  (I5: orthogonal)
  mu task notes design_card_iface      -w tui  (§2: Popup.verbs)

================================================================
FINDINGS
================================================================

----------------------------------------------------------------
1. TRIGGER / DISMISS / SINGLE-POPUP RELATIONSHIP — ORTHOGONAL
----------------------------------------------------------------

DECISION: The help overlay is ORTHOGONAL to the popup state machine.
It does NOT take the single-popup slot. design_popup_lifecycle's
invariant I5 already locks this; this note is the corroborating
sibling that consumes it.

Concrete state model (lives in <App>, src/cli/tui/state.ts):

    type PopupState =
      | { kind: "closed" }
      | { kind: "open"; subject: PopupSubject; saved: PreservedDashboardState };
    const [popupState, ...] = useState<PopupState>({ kind: "closed" });
    const [helpOpen,   setHelpOpen] = useState(false);  // ORTHOGONAL

    // Render order (top of <App>):
    //   {popupState.kind === "open"
    //     ? <PopupHost popup={...} />
    //     : <Dashboard />}
    //   {helpOpen && <HelpOverlay
    //     dashboardKeymap={GLOBAL_KEYMAP}
    //     inPopupKeymap={popupState.kind === "open" ? IN_POPUP_KEYMAP : null}
    //     currentPopup={popupState.kind === "open"
    //       ? POPUPS.find(p => p.subject === popupState.subject)
    //       : null} />}

Bindings (the dispatcher in keys.ts handles `?` and F1 BEFORE any
mode-specific dispatch — they are universal):

    Dashboard mode:
      ?  / F1   → setHelpOpen(prev => !prev)        # toggle open
    Popup mode (popup currently mounted):
      ?  / F1   → setHelpOpen(prev => !prev)        # toggle open
                   # popup remains MOUNTED beneath the overlay; its
                   # state (filter, scroll, extra-fetch) is unaffected.
    Help-open mode (overlay currently rendered on top):
      ?  / F1   → setHelpOpen(false)                # dismiss
      Esc       → setHelpOpen(false)                # dismiss
      q         → setHelpOpen(false)                # dismiss (NOT quit)
      any other → consumed; show toast inside overlay
                  "press ?, Esc, or q to close help"

WHY ORTHOGONAL (justifying the choice over "help-as-popup"):

(a) Popup-as-help would VIOLATE the single-popup invariant:
    user opens AgentsPopup, hits `?`, the help-popup would either
    REPLACE Agents (loses Agents state — bad) or refuse to open
    (footer toast "popup already open" — strictly worse than just
    showing help). Both are user-hostile.

(b) Popup-as-help would inherit the popup contract: its own
    `select(snapshot)`, `verbs`, etc. — but help has NO data slice
    (it's a static reference grid) and NO verbs (its only key is
    "dismiss"). Forcing it into the Popup interface adds noise.

(c) Orthogonal matches universal TUI convention. less, vim, htop,
    k9s, gh — every one of them has `?` as a layer that doesn't
    perturb the underlying mode, and Esc/q dismisses without exiting
    the program.

(d) Implementation is one boolean and one render branch; no state
    machine, no preservation/restore semantics (since nothing under
    it changed).

TICK BEHAVIOUR while help is open: the underlying mode (dashboard
or popup) keeps ticking. Help is a static reference grid; it does
not pulse, refresh, or fetch. The +/- keys do NOT adjust tick while
help is open (those are CONSUMED by help-open mode and ignored — the
"any other → toast" branch above). Rationale: nobody adjusts tick
while reading help; if they want to, they dismiss first.

q-INSIDE-HELP IS NOT QUIT: this is the key non-obvious point. On
the dashboard, `q` quits the TUI; on a popup, `q` closes the popup;
in the help overlay, `q` closes the OVERLAY only. The dispatcher
checks helpOpen FIRST. This matches less/vim ("`q` always means
'dismiss the topmost transient mode'") and avoids the foot-gun of
"I tried to dismiss help and accidentally killed the TUI".

----------------------------------------------------------------
2. CONTENT — TWO-COLUMN GLOBAL/IN-POPUP GRID + APPENDED PER-POPUP
----------------------------------------------------------------

The MASTER source of truth is design_global_keymap's SUMMARY TABLE
(the side-by-side "GLOBAL (dashboard) | IN-POPUP (any popup)" grid).
The overlay renders that grid VERBATIM as its base content.

LAYOUT DECISION: TWO COLUMNS for the keymap grid (matching the
SUMMARY TABLE's existing layout), then a STACKED THIRD SECTION
below for per-popup verbs WHEN a popup is the current context.

Visual sketch (terminal_width = 80, popup currently AgentsPopup):

  ┌─ Help (?, Esc, q to close) ───────────────────────────────────┐
  │                                                               │
  │  GLOBAL (dashboard)            IN-POPUP (any popup)           │
  │  ──────────────────            ────────────────────           │
  │  1-9    toggle card            j/k    move selection          │
  │  !-(    open card popup        g/G    first/last              │
  │  +/=    faster tick            /      filter                  │
  │  -      slower tick            n/N    next/prev match         │
  │  0      reset tick (1s)        Esc    close popup             │
  │  r/F5   refresh now            q      close popup (alias)     │
  │  ?/F1   help overlay           y      yank focused command    │
  │  q/Q    quit                   ?      help overlay            │
  │  Ctrl-C quit                   +/-/=/0 tick adjust (live)     │
  │  c      clear footer           r/F5   refresh now             │
  │  w      workstream picker      Ctrl-C quit                    │
  │           (v0.next)                                           │
  │                                                               │
  │  ─────────────────────────────────────────────────────────────│
  │  AGENTS POPUP (current context)                               │
  │  ──────────────────────────                                   │
  │    y    yank `mu agent close <focused> -w <ws>`               │
  │    c    yank `mu agent close <focused> -w <ws>`               │
  │    s    yank `mu agent send <focused> -w <ws> '<msg>'`        │
  │    k    yank `mu agent kick <focused> -w <ws>`                │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘

When NO popup is open, the third section is OMITTED entirely (no
"no popup current" placeholder — design_popup_lifecycle's I5 says
the overlay layers on whatever is active; if the dashboard is
active there is no per-popup context).

Why two columns + stacked third (not three columns):

- The two-column grid IS the SUMMARY TABLE; copying it preserves
  one source of truth and renders identically to the spec.
- Per-popup verbs vary in count (Agents has 4, Tracks has 1-2,
  ReadyPopup may have 5) and in label length (yank-string previews
  can be ~40 chars). A third column would need its own width budget
  and would compete with the grid; stacking it below is cleaner
  and keeps the grid stable across popup contexts.
- Stacking also matches the user's mental model: "global stuff at
  the top, then THIS popup's specific stuff."

----------------------------------------------------------------
3. HOW PER-POPUP VERBS REACH THE OVERLAY — Popup.verbs ALREADY
    EXISTS, NO IFACE CHANGE NEEDED
----------------------------------------------------------------

design_card_iface §2 already declares the field:

    interface Popup<TSlice, TExtra = undefined> {
      ...
      verbs: PopupVerb[];   // each has { key, label, act }
      ...
    }

DECISION: The help overlay reads Popup.verbs DIRECTLY off the
currentPopup it was passed. NO new method, NO new field, NO
amendment to design_card_iface. The PopupVerb shape already has
both `key` (for the binding column) and `label` (for the
description column) — exactly the two fields the overlay needs
per row.

For the YANK-STRING TEMPLATE (the right-hand column in the sketch
above), the overlay does NOT call PopupVerb.act() — that would
mutate clipboard and footer. Instead, the overlay shows the
verb's `label` and (optionally) a TEMPLATE STRING the popup
declares per-verb. PROPOSED tiny addition to PopupVerb (forward
to designer-1 / iface task as a TYPED SUGGESTION, not a hard ask):

    interface PopupVerb {
      key: PopupVerbKey;
      label: string;                       // existing
      act: (rowKey, ctx) => string | void; // existing
      template?: string;                   // NEW (optional). Help-only
                                           // preview. e.g. "mu agent
                                           // close <name> -w <ws>".
                                           // Pure cosmetic; the overlay
                                           // shows it dimmed beside the
                                           // label. If absent, the
                                           // overlay shows label only.
    }

If the iface task pushes back ("don't grow the interface for help"),
the FALLBACK is: overlay renders only `key` + `label`. The template
column is a v0.x nice-to-have; v0 can ship without it. NEVER attempt
to derive the template by calling act() with synthetic args — that
is brittle (act may need a real rowKey/ctx) and may yank to
clipboard as a side effect.

DEFAULT for v0: ship without `template`; the overlay shows
`<key>  <label>` per per-popup row. Adding `template` is a 5-LOC
follow-up if a real user wants to see the preview. This honours the
ROADMAP anti-feature pledges (no anticipatory abstractions; ship
the smallest thing that works).

----------------------------------------------------------------
4. LAYOUT UNDER TERMINAL RESIZE
----------------------------------------------------------------

The SUMMARY TABLE has 11 dashboard rows + 11 in-popup rows. Plus
header (2 lines) + section divider (1 line) + per-popup section
(1 header + N rows, N ≤ ~6 for v0). Worst case content height:
~22 lines + chrome (2 borders) = 24 lines. Just barely fits a
24-line terminal — and DOESN'T fit if a per-popup section adds
>0 rows.

DECISION: SCROLLING, NOT AUTO-SHRINK.

- Scroll keys (active only when help is open):
    j / ↓     scroll one line down
    k / ↑     scroll one line up
    Ctrl-D    half-page down
    Ctrl-U    half-page up
    g         jump to top
    G         jump to bottom
  These mirror the in-popup convention deliberately — same muscle
  memory.
- Render shows a one-line dim "more ↓" indicator at the bottom-right
  of the border when there is content below the visible area, and
  "more ↑" at the top-right when content is above. Both visible if
  scrolled mid-content.
- Width: if terminal_width < 60, COLLAPSE to one column (global
  first, then in-popup, then per-popup). No truncation of
  binding/label text — the labels are already terse.

WHY NOT AUTO-SHRINK:
- Shrinking means hiding rows or truncating labels. Both are
  worse than scrolling: users invoke help BECAUSE they don't
  remember the binding; hiding the binding they need is
  user-hostile, and truncating "Ctrl-D" to "Ct…" is illegible.
- Scrolling matches every TUI help convention (less, vim, htop,
  k9s — all scroll their help).
- The keys are already wired (j/k/g/G/Ctrl-D/Ctrl-U exist as the
  in-popup convention); reusing them is zero new bindings.

Minimum viable terminal: 30×10. Below that, the overlay still
renders its border + a single message "terminal too small for help
(needs 30×10); resize and press ? again". Esc/q/?/F1 still dismiss.

----------------------------------------------------------------
5. VISUAL STYLE
----------------------------------------------------------------

DECISION (matches design_locked's "btop-style" aesthetic):

- BORDER: single-line box drawing (Ink's <Box borderStyle="single">),
  using picocolors-equivalent dim grey. Not double; not heavy.
  Title in the top-left of the border: " Help (?, Esc, q to close) ".
- BACKGROUND BLANKING: the overlay renders ON TOP of the underlying
  mode in a Box with borderStyle="single" and a HEIGHT/WIDTH
  computed to fill the terminal MINUS 2 cols/rows (so the user
  sees a 1-col margin on each side; reinforces "this is on top").
  Inside the border, the body has solid spaces (Ink's default) so
  underlying content is fully obscured.
  - Note: Ink does NOT support true alpha/dim of underlying content.
    The "dim background simulated by blanking" wording in the brief
    matches what's achievable: blanking, not actual dim. The 1-col
    margin around the border is the visual cue that there's
    something underneath.
- ROW STYLE: monospace, two-column table inside the border. Column
  separators are 4 spaces (matches the SUMMARY TABLE source). The
  binding column is bold; the description column is regular weight.
- COLOURS: keys in bold default fg; labels in default fg; section
  headers in bold underline; the "more ↑/↓" indicators in dim;
  the "press ? to close" hint in the title border in dim.
- NO ANIMATION: help is static. No pulse, no fade, no flash. The
  dashboard tick continues underneath but nothing on screen
  reflects it.

----------------------------------------------------------------
6. EMPTY / ERROR PATH
----------------------------------------------------------------

DECISION: render with PLACEHOLDERS, never crash.

Failure modes and their handling (all in buildHelpModel(); pure
function, exhaustively unit-tested per §7):

(a) GLOBAL_KEYMAP is missing or empty (constant import failed —
    won't happen at runtime, but type-checker can't prove it):
    → render placeholder row "(global keymap unavailable)" in
      the global column.

(b) IN_POPUP_KEYMAP is missing AND a popup is open:
    → render placeholder row "(in-popup keymap unavailable)" in
      the in-popup column. Per-popup section still renders
      (independent input).

(c) currentPopup is non-null but currentPopup.verbs is undefined
    or empty:
    → render the per-popup section header anyway (so the user
      knows the context), with one row "(no per-popup verbs
      declared)". Don't omit the section silently — that would
      be ambiguous ("did the popup declare verbs and they're
      hidden? or does it have none?").

(d) currentPopup is null:
    → omit the per-popup section entirely (NOT a placeholder; the
      absence of a popup means there is no current popup context,
      which is a normal dashboard state — no error to communicate).

(e) A PopupVerb has missing label or missing key:
    → render with "?" in the missing column. Don't crash. A real
      occurrence is a TypeScript-type-violation that should be
      caught at build time, but defence-in-depth makes the
      overlay safe against partial type rot.

In NO case does the overlay throw or unmount underlying state.
The overlay sits behind an <ErrorBoundary> in <App> (same boundary
the popup uses, per design_popup_lifecycle §6) and on render-throw
the boundary closes the overlay (setHelpOpen(false)) and writes
"help overlay crashed: <msg>" to footerLine. The underlying
mode is preserved (orthogonality is what saves us here — closing
help doesn't perturb popup state).

----------------------------------------------------------------
7. TESTS
----------------------------------------------------------------

The overlay's content is a PURE FUNCTION of inputs:

    function buildHelpModel(input: {
      dashboardKeymap: KeymapRow[];      // GLOBAL_KEYMAP constant
      inPopupKeymap: KeymapRow[] | null; // IN_POPUP_KEYMAP or null
      currentPopup: { subject: string; label: string;
                      verbs: PopupVerb[] } | null;
    }): HelpModel;

    type HelpModel = {
      title: string;
      sections: Array<
        | { kind: "two-column"; left: KeymapRow[]; right: KeymapRow[] }
        | { kind: "stacked"; header: string; rows: KeymapRow[] }
      >;
    };
    type KeymapRow = { binding: string; description: string };

UNIT TEST (test/tui-help.test.ts):

    describe("buildHelpModel", () => {
      it("renders every binding from every input source", () => {
        const dashboardKeymap = [
          { binding: "1-9", description: "toggle card" },
          { binding: "?/F1", description: "help overlay" },
          { binding: "q/Q", description: "quit" },
        ];
        const inPopupKeymap = [
          { binding: "j/k", description: "move selection" },
          { binding: "y",   description: "yank focused command" },
          { binding: "Esc", description: "close popup" },
        ];
        const currentPopup = {
          subject: "agents",
          label: "Agents",
          verbs: [
            { key: "c", label: "yank close", act: () => "" },
            { key: "s", label: "yank send",  act: () => "" },
            { key: "k", label: "yank kick",  act: () => "" },
          ],
        };

        const model = buildHelpModel({ dashboardKeymap, inPopupKeymap,
                                       currentPopup });
        const flat = JSON.stringify(model);

        // EVERY binding from EVERY input must appear in the output.
        for (const row of dashboardKeymap)
          expect(flat).toContain(row.binding);
        for (const row of inPopupKeymap)
          expect(flat).toContain(row.binding);
        for (const verb of currentPopup.verbs) {
          expect(flat).toContain(verb.key);
          expect(flat).toContain(verb.label);
        }
        // And the per-popup section header MUST mention the popup.
        expect(flat).toMatch(/AGENTS POPUP|Agents Popup|agents/i);
      });

      it("omits the per-popup section when no popup is current", () => {
        const model = buildHelpModel({
          dashboardKeymap: [{ binding: "?", description: "help" }],
          inPopupKeymap: null,
          currentPopup: null,
        });
        const stacked = model.sections.filter(s => s.kind === "stacked");
        expect(stacked).toHaveLength(0);
      });

      it("renders placeholder, never crashes, when verbs are missing", () => {
        const model = buildHelpModel({
          dashboardKeymap: [{ binding: "?", description: "help" }],
          inPopupKeymap: [],
          currentPopup: { subject: "x", label: "X", verbs: [] },
        });
        const flat = JSON.stringify(model);
        expect(flat).toMatch(/no per-popup verbs declared/);
      });

      it("renders placeholder for missing dashboard keymap", () => {
        const model = buildHelpModel({
          dashboardKeymap: [],
          inPopupKeymap: null,
          currentPopup: null,
        });
        const flat = JSON.stringify(model);
        expect(flat).toMatch(/global keymap unavailable/);
      });
    });

The first test is the MUST-HAVE per the brief: "asserts the rendered
text contains every binding from the inputs." It's the regression
guard against silent column-loss / row-truncation refactors. The
other three lock the placeholder/empty contracts from §6.

INTEGRATION TEST (optional, v0.x): use ink-testing-library to mount
<HelpOverlay> with a fake terminal size and assert the snapshot
contains the bindings. Skip for v0; the pure-function test gives
~95% of the value at ~10% of the maintenance cost.

DECISION (single-line summary):

Help overlay is an ORTHOGONAL boolean mode (NOT a popup, doesn't
take the single-popup slot, layers on top of either dashboard or
popup, dismissed with ?/F1/Esc/q-WITHIN-HELP, with the underlying
mode preserved byte-identical). Content is the SUMMARY TABLE from
design_global_keymap rendered as a two-column grid, plus a STACKED
per-popup section (when a popup is current) sourced from the
already-existing Popup.verbs field on design_card_iface (no iface
change required for v0). Layout under resize: SCROLL with j/k/g/G/
Ctrl-D/Ctrl-U (reusing the in-popup convention); collapse to one
column below width=60. Visual: bordered Ink box with title, blanked
body (no true dim — ink limitation acknowledged). Empty/error:
placeholders, never crash. Tests: buildHelpModel() is pure and
unit-tested with assertions that every input binding appears in the
output.

NEXT:
- Implementer task (v0): add `helpOpen: boolean` useState to
  src/cli/tui/state.ts; route ?/F1 in keys.ts BEFORE mode-specific
  dispatch; render <HelpOverlay> conditionally in <App>; ship the
  unit tests in test/tui-help.test.ts.
- v0.x consideration: add optional `template?: string` field to
  PopupVerb (per §3) so the overlay can show yank-string previews
  beside per-popup verb labels. NOT a blocker; gated on a real
  user wanting to see "what will y produce" without pressing y.
- Follow-on: if a workstream picker (`w` key, v0.next) lands, its
  bindings join the dashboard keymap row automatically — buildHelpModel
  takes them as input data, no overlay change needed.

VERIFIED:
- Cross-checked design_popup_lifecycle invariant I5: "?-help overlay
  is NOT a popup. It is a separate dispatcher mode that overlays on
  top of either dashboard OR popup ... without saving/restoring.
  Closing help returns to the underlying mode untouched." This
  note's §1 (orthogonal model) and §6 (no underlying perturbation
  on crash) implement that contract verbatim.
- Cross-checked design_card_iface §2: Popup.verbs: PopupVerb[]
  ALREADY exists with both `key` and `label` fields. §3 confirms
  no mandatory iface change is needed; the optional `template`
  field is a future-proofing suggestion only.
- Cross-checked design_global_keymap SUMMARY TABLE: §2 visual
  sketch reproduces it byte-identical as the two-column body of
  the overlay. The "in-sync" risk (designer-1's NEXT note: "this
  keymap IS the source of truth that overlay will render — copy
  this section into the help card and keep them in sync") is
  resolved by sourcing the dashboardKeymap and inPopupKeymap
  from the SAME exported KEYMAP constants the dispatcher consumes
  — one source of truth in code, not two parallel copies.

ODDITIES:
- `q` is overloaded across THREE modes (dashboard=quit, popup=close,
  help=dismiss-help). The dispatcher resolves it by checking
  helpOpen FIRST, popupState SECOND, dashboard LAST. Documented
  in §1 because it's the foot-gun the implementer is most likely
  to get wrong (a regression where pressing `q` to dismiss help
  instead quits the TUI is high-impact and silent).
- Ink can't truly dim the underlying content; "dim background
  simulated by blanking" in the brief is the achievable approximation
  (blanked body inside the bordered overlay). True semi-transparent
  overlays would require a Ratatui/blessed-style buffer composite
  ink does not expose. Acceptable trade-off.
- `?` in many terminals is shifted-/ on US-QWERTY (Shift-/ →
  input="?" key.shift=false). Same layout caveat designer-1 flagged
  for Shift+1..Shift+9: bind on the GLYPH, not on key.shift+slash.
  This is identical handling to the global keymap; nothing new for
  the overlay.
- The help overlay does NOT include itself as a row labelled "?
  toggle help" in the per-popup section even when the popup's
  verbs include `?` (they shouldn't — `?` is global per
  design_global_keymap and PopupVerbKey from design_card_iface
  excludes it). If a popup somehow declares verb.key === "?" the
  type check fails at build time; defence-in-depth in §6(e).
- `q` inside help that gets escalated to a SECOND `q` (user wants
  to actually quit): documented behaviour is "dismiss help on
  first q; user must press q again on dashboard to quit." This is
  consistent with less ("q quits less, q in less's help quits the
  help") and is what every TUI user expects.
```

### #2 by "designer-2", 2026-05-11T11:19:13.492Z

```
CLOSE: help overlay design done
```
