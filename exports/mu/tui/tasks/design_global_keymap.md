---
id: "design_global_keymap"
workstream: "tui"
status: CLOSED
impact: 80
effort_days: 0.5
roi: 160.00
owner: "designer-1"
created_at: "2026-05-11T10:44:55.967Z"
updated_at: "2026-05-11T10:54:33.439Z"
blocked_by: ["design_locked"]
blocks: ["design_help_overlay", "design_popup_lifecycle", "docs_usage_guide"]
---

# Design global keymap: 1-9 toggle, Shift+1-9 popup, +/- tick, q quit, ? help

## Notes (2)

### #1 by "designer-1", 2026-05-11T10:54:30.745Z

```
FILES:
- (none modified — design-only task; output is this note)
- read: docs/USAGE_GUIDE.md (skim, esp. `mu state` section), CHANGELOG.md
  v0.1.0 verb list, mu task notes design_locked -w tui

COMMANDS:
- mu task notes design_locked -w tui      # locked decisions
- mu task show  design_global_keymap -w tui

FINDINGS:
Ink's `useInput((input, key) => ...)` reports the *rendered* character
in `input` and modifier flags in `key` (`key.shift`, `key.ctrl`,
`key.meta`, `key.escape`, plus named keys `key.return`, `key.upArrow`,
etc.). Critical consequence on a US layout:

  Shift+1 arrives as input="!" with key.shift === false
  Shift+2 arrives as input="@" with key.shift === false
  ...
  Shift+9 arrives as input="(" with key.shift === false

Ink does NOT synthesise a `(input="1", key.shift=true)` event for
shifted digits. The terminal sends the post-shift glyph; the modifier
is lost. So our "Shift+1..Shift+9" binding from the brainstorm MUST be
implemented as bindings on the SHIFTED-DIGITS ROW: ! @ # $ % ^ & * (.
We document the user-facing name as "Shift+1..Shift+9" (everyone
recognises that), but the binding table is on the punctuation glyphs.

Side effect: this is layout-dependent. Non-US-QWERTY layouts produce
different shifted glyphs (e.g. UK = !"£$%^&*( ; AZERTY = digits ARE the
shifted glyphs because the unshifted row is punctuation). v0 ships
US-QWERTY assumption; document as ODDITY; if a real user complains,
add a remap in v0.next. No config file (pledge), so the remap would
ship as `MU_TUI_POPUP_KEYS=...` env var.

Ctrl-C: ink's <App> registers a SIGINT handler and ALSO surfaces
key.ctrl+input==='c' through useInput. By default ink quits cleanly on
Ctrl-C. We accept that default — Ctrl-C is the universal "get me out"
escape and any user pressing it wants out. We do NOT trap it for
custom behaviour.

DECISION:

================================================================
GLOBAL KEYMAP (active when no popup is open — the dashboard)
================================================================

Card-toggle row (1..9 → show/hide that card on the dashboard):
  Key   Effect                                Conflict / note
  ---   ------                                ---------------
  1     toggle Agents card                    none
  2     toggle Tracks card                    none
  3     toggle Ready (tasks) card             none
  4     toggle Activity log card              none
  5     reserved (no card; no-op + footer hint  "no card bound to 5")
  6     reserved                              "
  7     reserved                              "
  8     reserved                              "
  9     reserved                              "

Slots 5-9 are reserved so we can add cards (Workspaces, Snapshots,
Archives, Doctor, Logs-by-kind) WITHOUT churning the muscle memory
of the four canonical cards. v0 ships 4 cards; v0.x can fill 5+.

Popup-open row (Shift+1..Shift+9 → open fullscreen popup):
Bound by *glyph*, surfaced as "Shift+N" in the help overlay.

  User-facing   Glyph (US)   Effect
  -----------   ----------   ------
  Shift+1       !            open Agents popup
  Shift+2       @            open Tracks popup
  Shift+3       #            open Ready-tasks popup
  Shift+4       $            open Activity-log popup
  Shift+5       %            reserved (footer hint "no popup bound")
  Shift+6       ^            reserved
  Shift+7       &            reserved
  Shift+8       *            reserved
  Shift+9       (            reserved

Conflict notes:
  - On non-US-QWERTY layouts the glyph row differs; popup-open keys
    will not work as advertised. v0 = US-QWERTY assumption. ODDITY.
  - `^` is also the line-start key in many editors (vim, less); in
    our context it's a popup-open. No conflict because we are not a
    line-editing TUI.
  - `&` is shell background-and-fork; n/a in TUI keystroke land.

Tick-rate adjust:
  Key   Effect                                Conflict
  ---   ------                                --------
  +     tick rate /= 2 (faster), floor 100ms  none. Note: arrives
                                              as input="+" key.shift
                                              false on US (=Shift+=).
  -     tick rate *= 2 (slower), ceiling 10s  none. The plain "-"
                                              key, no modifier.
  =     alias for + (so unshifted "=" works   convenience; some
        too — same physical key as +)        users won't shift.
  0     reset tick rate to default 1s         convenient zero-ish key
                                              adjacent to +/-.

Footer always shows "tick: 1.00s" so the user sees the current value
change live. Hitting + at floor or - at ceiling shows a one-line
toast "tick floor 100ms" / "tick ceiling 10s" (no beep).

Quit:
  Key       Effect                            Conflict / note
  ---       ------                            ---------------
  q         quit cleanly (ink unmount,        common TUI convention
            print last-yank line if any to   (less, htop, k9s).
            stdout so it survives)
  Q         alias for q
  Ctrl-C    quit cleanly (SIGINT, ink         universal terminal
            default; same exit path as q)    interrupt. We do NOT
                                              trap it.
  Esc       NO-OP on the dashboard            Esc is reserved as
                                              "close popup"; making
                                              it also-quit is a foot-
                                              gun (one Esc too many
                                              kills the TUI). q is
                                              the dashboard quit.

Help overlay:
  Key   Effect                                Conflict
  ---   ------                                --------
  ?     toggle help overlay (modal-ish: a    none. ? is the universal
        scrollable card listing every        "what keys are there"
        binding, grouped by section)         (less, vim, gh, k9s).
        Esc / ? / q-inside-help all close.
  F1    alias for ?                          some terminals eat F1
                                              as terminal-help; ?
                                              is the primary, F1 is
                                              the discoverable alias.

Refresh-now (sub-tick poke):
  Key   Effect                                Conflict
  ---   ------                                --------
  r     trigger one immediate poll            none. lowercase r is
        (resets the tick clock to 0;          the convention in
        next auto-poll one tick later)       k9s, htop, lazygit.
  F5    alias for r                          browser-refresh muscle
                                              memory; harmless in TUI.

Workstream picker (NICE-TO-HAVE; document but mark v0.next):
  Key   Effect
  ---   ------
  w     open inline workstream switcher (a small fullscreen popup
        listing `mu workstream list`; Enter rebinds the TUI to the
        chosen workstream and re-renders all cards).
        v0: bound but shows toast "workstream switcher: v0.next".
        Reserving the key now means muscle memory survives the
        upgrade.

Yank surface (no key — happens INSIDE popups; recorded here for
completeness):
  - Inside any popup, `y` yanks the contextual mu command for the
    focused row (the act-intent: e.g. `mu agent close worker-1 -w
    tui`).
  - On yank: if `pbcopy`/`xclip`/`wl-copy` succeeds, append
    " [copied]" to the toast and to the dashboard footer line; if
    it fails, show " [no clipboard]" instead. Either way the
    command text is shown.
  - The dashboard footer reserves one line:
      "last: mu agent close worker-1 -w tui [copied]"
    Persists until the next yank or until cleared by `c`.

Footer-clear:
  Key   Effect
  ---   ------
  c     clear the persistent "last:" footer line
        (no-op if empty). Useful for screenshots / demos.

================================================================
IN-POPUP KEYMAP CONVENTION (every popup MUST honour these)
================================================================

These are inviolate across all four (and future) popups. Per-popup
verbs are designed in their own tasks; they MUST NOT shadow these
conventions.

  Key       Effect                                  CLI analogue
  ---       ------                                  ------------
  j         move selection down one row             vim-classic
  k         move selection up one row               vim-classic
  ↓ / ↑     aliases for j / k                       arrow keys
  g         jump selection to first row             vim-classic (gg
                                                   collapses to g
                                                   here — no risk of
                                                   ambiguity since
                                                   we have no `gd`
                                                   `ge` `gg` family)
  G         jump selection to last row              vim-classic
  Ctrl-D    half-page down                          vim/less
  Ctrl-U    half-page up                            vim/less
  PgDn/PgUp full-page nav                           obvious
  /         enter filter mode (incremental;         vim/less. Esc
            arrow-down moves through matches;       cancels filter,
            Enter accepts and exits filter mode)    does NOT close
                                                   popup. Second
                                                   Esc closes popup.
  n         next filter match                       vim/less
  N         previous filter match                   vim/less
  Esc       close popup → restore prior dashboard   universal modal
            state (toggles + tick rate)             dismissal
  q         alias for Esc (close popup)             friendlier than
                                                   Esc-and-pray
  y         yank act-intent for focused row         mnemonic (yank)
  ?         toggle in-popup help overlay listing    same as global
            this convention + per-popup verbs       help binding

Tick-rate keys (+ - = 0) and Ctrl-C remain live INSIDE popups (they
don't depend on selection state). r and F5 also remain live (refresh
is global). 1-9 / Shift+1-9 are SUPPRESSED inside popups: no
card-toggle while a popup owns the screen, and no popup-stack
because of the single-popup invariant. Pressing them shows a footer
toast "press Esc to return to dashboard".

Per-popup verbs (designed in OTHER tasks; not part of this contract)
will live on letter keys NOT in {j k g G n N q y c r w} and NOT on
the digit/punctuation rows. The per-popup task should add its keys
to this convention's "reserved-for-per-popup" pool: a b d e f h i l
m o p s t u v x z. That gives 18 letters of headroom per popup.

================================================================
SUMMARY TABLE (one-screen reference; same layout the help overlay
will render)
================================================================

  GLOBAL (dashboard)                 IN-POPUP (any popup)
  ------------------                 --------------------
  1-9    toggle card                 j/k    move selection
  !-(    open card popup             g/G    first/last
         (Shift+1..Shift+9)          /      filter
  +/=    faster tick                 n/N    next/prev match
  -      slower tick                 Esc    close popup
  0      reset tick (1s)             q      close popup (alias)
  r/F5   refresh now                 y      yank focused command
  ?/F1   help overlay                ?      help overlay
  q/Q    quit                        +/-/=/0 tick adjust (live)
  Ctrl-C quit                        r/F5   refresh now
  c      clear footer                Ctrl-C quit
  w      workstream picker (v0.next)

NEXT:
- design_help_overlay (sibling task; this keymap IS the source of
  truth that overlay will render — copy this section into the help
  card and keep them in sync).
- design_popup_lifecycle (sibling task; encode the single-popup
  invariant + restore-prior-dashboard-state contract).
- v0 implementation MUST add a unit test asserting the dispatcher
  binds the *glyph* row (! @ # $ %) for popup-open, not key.shift +
  digit. Without that test we'll silently regress to "Shift+1 does
  nothing" the first time someone refactors the input handler.
- Per-popup verb tasks (one per card) consume the
  "reserved-for-per-popup" letter pool above. They MUST NOT bind
  any key listed in the GLOBAL or IN-POPUP convention sections.

VERIFIED:
- Cross-checked locked decisions in `mu task notes design_locked
  -w tui`: 1-9 toggle, Shift+1-9 popup, +/- tick (100ms..10s, 1s
  default), single-popup invariant, popup close restores prior
  state, read-only with yank, in-popup convention {j/k g/G / Esc
  y ?}. All locked items appear in the keymap above.
- Cross-checked against ink's documented `useInput` semantics
  (input string is the rendered glyph; key.{shift,ctrl,meta,
  escape,return,...} for modifiers/named keys). Decision: bind
  on glyph for shifted-digit row; document layout assumption.

ODDITIES:
- Shifted-digit popup row is US-QWERTY-locked. Non-US users will
  hit "Shift+1 does nothing" until we ship MU_TUI_POPUP_KEYS or
  similar. NOT blocking v0; gate on a real user complaint per the
  ROADMAP promotion criteria.
- `=` as an alias for `+` is a usability nicety (avoids forcing a
  Shift on a "just speed it up" reflex). Slight cost: `=` is now a
  taken global key, so per-popup verbs must avoid it too.
- `0` as "reset tick" stole the digit-9-plus-1 slot from the
  toggleable-card row. Resolved by capping cards at 9, leaving 0
  free for the reset semantic. Documented above.
- We deliberately do NOT bind Tab / Shift-Tab on the dashboard.
  There is no "focus" concept on the dashboard (cards are not
  focused; popups are the focused mode). Reserving Tab for a
  future "cycle through cards" semantic would be premature.
- Ctrl-Z (suspend) is left to the terminal's default behaviour;
  ink unmounts cleanly on SIGTSTP. Not surfaced in the keymap.
- Mouse: not bound. v0 is keyboard-only. Ink supports mouse via
  third-party libs; out of scope.
```

### #2 by "designer-1", 2026-05-11T10:54:33.439Z

```
CLOSE: complete keymap drafted in note
```
