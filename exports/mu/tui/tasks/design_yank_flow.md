---
id: "design_yank_flow"
workstream: "tui"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: "designer-1"
created_at: "2026-05-11T10:44:56.172Z"
updated_at: "2026-05-11T11:18:47.586Z"
blocked_by: ["design_popup_lifecycle", "investigate_clipboard"]
blocks: ["design_popup_agents", "design_popup_tasks", "docs_vocab_amend"]
---

# Design yank flow: clipboard detect, toast in popup, footer on dashboard (A3')

## Notes (2)

### #1 by "designer-1", 2026-05-11T11:18:45.707Z

```
END-TO-END YANK FLOW — locked. Implementer can encode straight from this.

================================================================
FILES (the cluster footprint this note covers)
================================================================

  src/cli/tui/yank.ts          NEW. ~80 LOC. Pure (no JSX). Owns:
                                 detectClipboard() + yank() + the
                                 ClipboardBackend / YankResult types.
  src/cli/tui/state.ts         EDIT. App context provides `yank()`
                                 closure to PopupHost via React
                                 context; probe result cached on the
                                 App singleton at mount.
  src/cli/tui/popup.tsx        EDIT. PopupHost wires PopupProps.yank;
                                 owns the popup-local toast state +
                                 2s timer + next-keypress dismissal.
  src/cli/tui/app.tsx          EDIT. Dashboard renders the always-
                                 visible bottom strip "footer line"
                                 from App-level footerLine state.
  src/cli/tui/keys.ts          EDIT. Dispatches `c` (clear footer)
                                 on the dashboard; routes `y` in
                                 popups through the popup's focused
                                 row → verb.act → PopupProps.yank.
  test/cli/tui/yank.test.ts    NEW. Unit tests; mocks execa + the
                                 OSC-52 /dev/tty writer. No ink.

================================================================
COMMANDS (the act-intents per popup, v0)
================================================================

Reaffirms design_card_iface: `y` in a popup invokes the focused row's
implicit yank or a verb-keyed yank. Each per-popup task fills these in;
this note locks the SHAPES the dispatcher will see.

  Popup            Focused row    `y` (default verb) yields
  -----            -----------    --------------------------
  Agents (Shift+1) agent name N   `mu agent show N -w <ws>`
  Tracks (Shift+2) goal task T    `mu task tree T -w <ws>`
  Ready  (Shift+3) ready task T   `mu task claim T -w <ws> --self`
                                  (the canonical "I want this one")
  Log    (Shift+4) event row E    SUPPRESSED. See ODDITIES.

Verb-keyed yanks (per design_card_iface PopupVerb pool) layer on top —
e.g. in Tasks/Ready: `n` yanks `mu task notes T -w <ws>`,
`b` yanks `mu task show T -w <ws>` (blockers visible there),
`r` yanks `mu task release T -w <ws>` (only when claimed).
The shape every per-popup task MUST follow:

  yank string = `mu <verb> <args> -w <ws>`     // always include -w

The "always include -w" rule is non-negotiable: a yanked command must
work paste-and-go from any shell; ambient $MU_SESSION must not be a
dependency. Use the workstream from PopupActCtx.workstream.

================================================================
FINDINGS (the contract pieces, expanded)
================================================================

──── 1. THE YANK API SHAPE ────

Two layers; do not collapse.

  Public (popups call this):
    PopupProps.yank: (text: string, opts?: YankOpts) => void

    interface YankOpts {
      /** Human label rendered in the toast / footer in place of the
       *  raw command, when the command is unwieldy (e.g. multi-line
       *  task notes). Default: the command itself.                */
      description?: string;
    }

  Internal (yank.ts exports for tests):
    export interface YankResult {
      copied: boolean;             // true iff a backend write succeeded
      backend: ClipboardBackend | null;
                                   // 'pbcopy' | 'wl-copy' | 'xclip'
                                   // | 'xsel'  | 'clip.exe' | 'osc52'
                                   // | null when copied=false
      error?: string;              // present iff copied=false; short,
                                   // already-formatted, user-readable.
    }

    export async function yank(
      command: string,
      probe: ClipboardProbe,
    ): Promise<YankResult>;

CONFIRMED with one expansion vs the brief: the public PopupProps.yank
returns void (fire-and-forget) because it must do toast + footer
side-effects on the orchestrating component. The INTERNAL yank() in
yank.ts returns Promise<YankResult> — that's what unit tests assert on.

SYNC vs ASYNC: ASYNC. execa is async (it returns a Promise<ExecaReturn>);
synchronously spawning would mean execaSync, which blocks the ink event
loop and renders a frozen frame for ~10-30ms per yank. Unacceptable for
a TUI that polls at 1Hz.

WHILE WAITING: the popup renders the toast OPTIMISTICALLY:
  1. user presses `y`
  2. popup synchronously sets toastText = "yanked: <description>"
     (no [copied] suffix yet) and starts the 2s timer
  3. yank() promise resolves (typically <5ms for CLI, <1ms for OSC-52)
  4. popup updates toastText to "yanked: <description>  [copied]"
     OR "yanked: <description>  [no clipboard]" — same toast widget,
     suffix swap. Timer is NOT restarted; the original 2s window
     covers the (typically sub-ms) latency.
  5. on toast disappear (timer fire OR next-keypress, whichever first),
     popup pushes the FINAL string (with the resolved suffix) to the
     App-level footerLine via the yank context callback.

This means the user briefly sees "yanked: …" with no suffix on slow
CLI backends (rare), then it firms up. Acceptable; the alternative
(block 5-30ms before showing the toast) is worse UX.

──── 2. BACKEND PROBE + CACHE ────

Per designer-2's matrix (priority order: native CLI for platform →
OSC-52 → none).

  export type ClipboardBackend =
    | 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe' | 'osc52';

  export interface ClipboardProbe {
    /** First-choice backend; null when no native CLI was found AND
     *  OSC-52 is not assumed available (we always assume OSC-52 is
     *  worth trying — see designer-2 §5; downgrade to null is rare). */
    cli: { cmd: string; args: string[] } | null;

    /** Always true for v0 — we don't probe DA1/CSI; we just attempt
     *  the OSC-52 write to /dev/tty and pray. Set to false only by
     *  v0.next when DA1 probing lands.                               */
    osc52: boolean;
  }

  export function detectClipboard(): ClipboardProbe;

CACHE INVARIANT: detectClipboard() runs ONCE at App mount (in
src/cli/tui/state.ts useEffect on mount, results stored on App-level
useRef). Re-detection on the lifetime of one `mu` invocation is
not done; users don't install pbcopy mid-session. The probe is
synchronous (it shells `command -v` for one OS-appropriate binary,
~5-15ms; runs in the mount path BEFORE first paint, so users don't
see flicker).

PLATFORM ORDER (the only branches detectClipboard() takes):
  process.platform === 'darwin'    → try pbcopy
  process.platform === 'win32' OR
    /microsoft/i.test(os.release()) → try clip.exe
  else (linux/bsd):
    if XDG_SESSION_TYPE === 'wayland' → try wl-copy
    else                              → try xclip then xsel

LOCATION: src/cli/tui/yank.ts — same file as yank() and YankResult,
matching design_module_layout's "yank.ts ~50" line item (we'll
overshoot to ~80 because of the YankOpts/Result types, fine).

──── 3. THE TOAST UX (in-popup) ────

WHERE RENDERED: popup-local component. Not a top-level overlay; not
in design_card_iface PopupProps. The popup owns its toast because
(a) the toast is bound to popup lifetime — popup close kills the
toast unconditionally; (b) the per-popup author may want to position
it (bottom-of-popup vs alongside the focused row); the contract
gives them freedom by NOT putting the toast widget in PopupProps.

Recommendation for the per-popup tasks: render the toast as a single
Box at the bottom edge of the popup, full-width, dim background when
the terminal supports it, single line. Component lives in
src/cli/tui/popup.tsx as <PopupToast text={...} /> for reuse — but
the SHOW state lives in the popup itself, not in PopupHost.

THE STATE THE POPUP OWNS:
  const [toast, setToast] = useState<{
    text: string;
    suffix: '[copied]' | '[no clipboard]' | null;
  } | null>(null);

DISAPPEAR POLICY: 2-second timer + next-keypress, whichever first.
Implemented via:
  - setTimeout(2000) on toast set; cleared on unmount and on
    setToast(null).
  - useInput handler: ANY keypress while toast !== null calls
    setToast(null) BEFORE the keypress is otherwise dispatched.
    Exception: the same `y` that just fired (within ~50ms input
    debounce) does NOT re-dismiss; otherwise rapid yanks would
    immediately self-cancel. The dispatcher tracks the most recent
    yank timestamp and ignores keypress-dismissal within 100ms of it.

The fact that "next keypress dismisses toast then dispatches" is
load-bearing: a user spamming `j` to scroll after a yank will see
the toast vanish on the first `j`, with the `j` still moving the
selection. This matches lazygit/helix conventions.

TOAST TEXT (wordsmithed):

  Optimistic (before yank() resolves):
    yanked: mu agent show worker-1 -w tui

  Resolved, copied via CLI:
    yanked: mu agent show worker-1 -w tui  [copied]

  Resolved, copied via OSC-52:
    yanked: mu agent show worker-1 -w tui  [copied]

  Resolved, no backend:
    yanked: mu agent show worker-1 -w tui  [no clipboard — copy from footer]

Note we COLLAPSE designer-2's `[copied]` vs `[copied*]` distinction.
Reasoning: the asterisk requires a `?` help-line entry to explain it,
adds visual noise, and OSC-52 is "best-effort" by nature — telling
the user "your terminal might have eaten this; check before pasting"
is more honest than "[copied*]" which most users will read as a
typo. If a real user later reports "I pressed y, saw [copied], paste
was empty" we'll add the asterisk under the v0.next promotion bar.
The fallback string is wordsmith-final: "[no clipboard — copy from
footer]" — explicit instruction, fits in 33 chars, parallels the
[copied] suffix.

Long-command truncation: the toast renders at popup width. If the
command is wider than (popup_width - 8 - len(' [copied]')) the popup
right-truncates with `…` BEFORE the suffix. The user can still see
the full command in the dashboard footer (which has its own
truncation rule — see §4). Per designer-2's NEXT.

──── 4. THE FOOTER LINE UX (on dashboard) ────

WHERE: always-visible 1-row Box at the bottom of the dashboard
viewport, BELOW the cards row, ABOVE the help-line if present.
Owns its own row in the App's flex layout. Empty when no yank has
fired this session OR when the user pressed `c`.

Lives in src/cli/tui/app.tsx as <DashboardFooter line={footerLine} />.
State (footerLine: string | null) lives in App-level useState in
state.ts; the yank context callback writes to it.

EXACT FORMAT:

  last: <command>  [copied]
  last: <command>  [no clipboard]

When the popup yanked with a `description` (i.e. command was unwieldy):

  last: <description>  [copied]

(The footer renders the SAME string the toast settled on, minus the
"yanked: " prefix and replaced with "last: ". Same suffix policy.)

Width handling: right-truncate-with-ellipsis at
(terminalCols - "last: ".length - " [copied]".length). The suffix
NEVER truncates; the command field absorbs the loss. Per designer-2's
NEXT.

LIFETIME: until next yank (overwrite) OR the user presses `c` on the
dashboard (clear) OR app quits. NOT cleared by popup close — that's
the whole point of the persistent footer (so the user can read +
manually copy the command from a TUI that lacks clipboard). Survives
arbitrary popup open/close cycles.

The `c` binding is part of design_global_keymap "GLOBAL (dashboard)"
column. NOT bound inside popups — popups don't see the dashboard
footer (they cover it). After Esc-from-popup, `c` clears.

MULTI-YANK INSIDE ONE POPUP — RECOMMENDATION:

Only the most recent. Implementation:
- The popup's toast state replaces on each `y` (if a toast is
  visible, the new yank's optimistic text immediately overwrites
  it; the 2s timer resets to a fresh 2s).
- The App-level footerLine receives the FINAL resolved string from
  the most recent yank. Earlier yanks in the same popup session are
  lost from the footer (overwritten).
- Rationale: a "stack" or "history" footer would force a multi-row
  footer or a horizontal scroller, which violates the always-visible-
   1-row design. A user who needs the previous command can re-yank it
  (it's a deterministic function of the focused row). v0.next can add
  `mu state --history` if real users hit this >=2 times; until then,
  no.

This matches design_card_iface §I3 ("yanks INSIDE the popup OVERWRITE
the footer for the duration of the popup AND replace the saved
value") word-for-word.

──── 5. ERROR HANDLING — THE FALLBACK LADDER ────

  step | tried       | on success                | on failure
  -----|-------------|---------------------------|--------------
   1   | probe.cli   | YankResult{copied:true,   | step 2
       | (execa with | backend: probe.cli.cmd}   |
       | stdin=text) |                           |
   2   | OSC-52      | YankResult{copied:true,   | step 3
       | (write to   | backend:'osc52'}          |
       | /dev/tty,   |                           |
       | base64(text))                           |
   3   | give up     | YankResult{copied:false,  | n/a
       |             | backend:null,             |
       |             | error:"no clipboard       |
       |             | backend available"}       |

EDGE CASES:

a) probe.cli was 'pbcopy' but the binary vanished between probe and
   yank (e.g. user uninstalled). execa throws ENOENT → caught → fall
   to step 2 (OSC-52). The probe cache is NOT updated (we don't
   re-probe; rare enough to not bother). Subsequent yanks repeat the
   ENOENT-then-fallback; cost is one extra failed exec per yank, which
   is ~5ms. Acceptable given the rarity.

b) probe.cli succeeded execa but exited nonzero (exit code != 0).
   Treat as failure of step 1 → fall to step 2.

c) OSC-52 write throws (no /dev/tty, e.g. running under a CI runner
   that closed /dev/tty). Caught → fall to step 3.

d) /dev/tty writable but the terminal silently dropped the OSC-52
   sequence (tmux ≥3.2 without `set-clipboard on`). We have NO way
   to detect this. The yank reports backend:'osc52', copied:true.
   Footer says "[copied]". Best-effort by design (see §3 wordsmith
   note above). If users report this, v0.next probes via DA1.

e) Probe at startup found NO cli AND we elect not to attempt OSC-52
   (currently never; probe.osc52 is always true for v0). Step 2 still
   runs and either succeeds-quietly or falls to step 3.

The yank() function CATCHES every error internally; it never throws
to the popup. The popup's optimistic toast → resolved-toast pipeline
just sees a YankResult.

──── 6. FOOTER + TOAST when popup is OPEN at the same time ────

Per design_popup_lifecycle §2: a popup-already-open toast is written
to the SAME footerLine the dashboard uses. That's INDEPENDENT of the
yank flow. Coexistence rules:
- Inside a popup, yank toast lives on the popup. On popup close, the
  most-recent yank's resolved string lands on the dashboard
  footerLine (§4 multi-yank rule).
- A "popup already open" toast (fired when the user presses Shift+N
  for a different N while a popup is open) writes to the dashboard
  footerLine directly (per design_popup_lifecycle). It is NOT routed
  through PopupProps.yank.
- If both fire (user yanked, then tried Shift+N), the popup-already-
  open toast wins (most-recent overwrite, same as multi-yank).
This is consistent with the "single footerLine, last writer wins"
model in design_popup_lifecycle ODDITIES.

──── 7. UNIT TESTS (test/cli/tui/yank.test.ts) ────

Surface (no ink, no React; pure):

  detectClipboard() with mocked process.platform / mocked execa
    (a) darwin → returns {cli:{cmd:'pbcopy',args:[]}, osc52:true}
    (b) win32  → returns {cli:{cmd:'clip.exe',args:[]}, osc52:true}
    (c) linux + XDG_SESSION_TYPE=wayland → wl-copy
    (d) linux + XDG_SESSION_TYPE unset + xclip present → xclip
    (e) linux + XDG_SESSION_TYPE unset + xclip absent + xsel present
        → xsel
    (f) linux, no native cli → {cli:null, osc52:true}
    (g) WSL detection (os.release contains "microsoft") → clip.exe

  yank(command, probe) with mocked execa AND mocked /dev/tty writer
    (h) probe.cli=pbcopy, execa OK → {copied:true, backend:'pbcopy'}
    (i) probe.cli=pbcopy, execa exit 1 → fall to OSC-52 success
        → {copied:true, backend:'osc52'}
    (j) probe.cli=pbcopy, execa throws ENOENT → fall to OSC-52
    (k) probe.cli=null, OSC-52 success → {copied:true, backend:'osc52'}
    (l) probe.cli=null, /dev/tty throws → {copied:false, backend:null,
        error:/no clipboard backend/}
    (m) probe.cli=pbcopy, execa OK — assert exact stdin sent equals
        the command argument verbatim (no trailing newline appended)
    (n) probe.cli=pbcopy with multibyte command — stdin survives
        round-trip (vitest spy on execa's input stream)
    (o) OSC-52 path — assert /dev/tty receives the exact bytes
        `\x1b]52;c;<base64(text)>\x07` (BEL terminator)

  No tests for the popup/toast/footer wiring in this file — those
  belong to test/cli/tui/popup.test.ts (uses ink-testing-library;
  blocked on the devDep landing per design_module_layout ODDITIES).

================================================================
DECISION
================================================================

LOCKED for v0:

1. PUBLIC API per popup: PopupProps.yank(text, opts?) → void; popups
   never see YankResult. Optimistic toast first, suffix swap when
   yank() resolves.

2. INTERNAL API for tests: yank(command, probe) → Promise<YankResult>
   in src/cli/tui/yank.ts; YankResult = {copied, backend, error?}.
   ASYNC (execa is async; execaSync would block ink).

3. PROBE: detectClipboard() runs ONCE at App mount, cached on the App
   useRef. Order: native CLI for platform → OSC-52 (always assumed
   available for v0; no DA1 probing).

4. TOAST: popup-local; rendered as <PopupToast> in popup.tsx; lives at
   the bottom edge of the popup; 2s timer + next-keypress (with 100ms
   debounce against the firing `y`) dismissal; suffix is [copied] or
   "[no clipboard — copy from footer]" — no [copied*] for v0.

5. FOOTER: always-visible 1-row Box at dashboard bottom; format
   `last: <command>  [copied|no clipboard]`; overwrite-on-yank;
   cleared by `c` or app quit; truncates command field, never the
   suffix; surviving popup close cycles.

6. MULTI-YANK in one popup session: only the MOST RECENT shows in
   the toast and lands on the footer at popup close. No stack.

7. PER-POPUP `y` shapes (per-popup tasks confirm; v0 lock):
   - Agents popup `y` → `mu agent show <name> -w <ws>`
   - Tracks popup `y` → `mu task tree <id> -w <ws>`
   - Ready popup  `y` → `mu task claim <id> -w <ws> --self`
   - Log popup    `y` → SUPPRESSED (footer toast: "no yank for
     event rows — yank from a different popup"); per-popup task
     MAY add a verb-keyed yank if a useful command exists.

8. ERROR LADDER: cli (execa) → osc52 → null. ENOENT, nonzero exit,
   /dev/tty failure all caught and fall through. yank() never throws.

9. UNIT TESTS: pure src/cli/tui/yank.ts surface only; mock execa +
   /dev/tty; 7 detect tests + 8 yank tests = 15 total. No ink in
   this file.

================================================================
NEXT
================================================================

- design_popup_agents / design_popup_tasks (Tracks+Ready) /
  design_popup_log: confirm the per-popup `y` shape above and add
  any verb-keyed yanks (e.g. `n` → notes, `r` → release-when-claimed).
  Log popup must explicitly suppress `y`.

- impl_tui_yank (NEW) — ship src/cli/tui/yank.ts + the test file
  above. ~80 LOC + ~120 LOC test = lands in <300 LOC budget.

- impl_tui_popup_toast (folded into impl per-popup tasks): wire the
  PopupToast component + the 2s timer + next-keypress dismissal.

- impl_tui_footer (folded into impl_tui_entry): render the always-
  visible footer; bind `c` to clear; honour the truncation rule.

- v0.next: DA1 OSC-52 probing; per-popup yank-format config; "y twice
  to force OSC-52" override; `mu doctor` hint to set `set-clipboard
  on` in tmux (per designer-2 ODDITIES).

================================================================
VERIFIED
================================================================

- Cross-checked design_locked: A3' yank flow says "clipboard if
  available + transient toast in popup + persistent footer line on
  dashboard ('last: mu agent close worker-1 -w tui [copied]')" —
  reproduced verbatim, including the [copied]/[no clipboard] format.

- Cross-checked investigate_clipboard (designer-2): probe order
  (native CLI → OSC-52 → none), detect-once-at-startup cache,
  hand-roll over clipboardy, ~30-60 LOC budget — all honoured. The
  ONE deviation: collapsed [copied*] back into [copied]. Reasoned
  in §3 wordsmith note; designer-2's full asterisk + ?-help-line
  treatment is moved to v0.next.

- Cross-checked design_card_iface §I3 ("yanks INSIDE the popup
  OVERWRITE the footer … and replace the saved value, so the new
  yank persists after close") — encoded as the §4 multi-yank rule
  (most recent only) plus the "lands on footerLine at popup close"
  pipeline.

- Cross-checked design_card_iface PopupProps.yank signature
  `yank: (text: string) => void` — kept as-is for the public surface
  (popups call this); internal yank() in yank.ts has the
  Promise<YankResult> shape for tests. The brief's
  `yank(command, opts?): YankResult` is realised at the INTERNAL
  surface; popups stay simple.

- Cross-checked design_popup_lifecycle §2: "popup-already-open" toast
  writes to the SAME footerLine; conflict semantics in §6 above
  (last writer wins, popup-already-open beats yank because it fires
  later). Documented; not contradicted.

- Cross-checked design_global_keymap: `c` is on the GLOBAL (dashboard)
  side as "clear the persistent 'last:' footer line"; NOT bound in
  popups. `y` is on the IN-POPUP side as "yank act-intent for focused
  row" with the "100ms debounce" wrinkle from §3 added here (the
  keymap doesn't need to know about it; it's a dispatcher detail).

- Cross-checked design_module_layout: yank.ts ~50 line item; we
  budget ~80 (still within the file's "small pure helper" theme;
  cluster total ~1450 LOC unaffected — yank.ts grew 30 LOC, popup.tsx
  grew ~20 for PopupToast, app.tsx grew ~15 for DashboardFooter, all
  inside the ROADMAP <300 LOC promotion bar for the whole TUI yank
  feature).

- Pi-subagents pillar fit: zero new dependencies (execa already a
  dep per investigate_clipboard); zero new abstractions with zero
  implementors (PopupProps.yank has 4 implementors: each v0 popup);
  no config file (probe is automatic; no MU_CLIPBOARD_BACKEND env
  var); no daemon (yank is a one-shot per keypress).

================================================================
ODDITIES
================================================================

- The Log popup's `y` SUPPRESSION is a v0 simplification. Event rows
  COULD yank `mu log -n N` (to fetch the surrounding window) or
  `mu sql "select * from agent_logs where id = E"` (to inspect raw
  payload). Both are weak (the second leaks `mu sql` as the
  "read-an-event" surface, which the ROADMAP wants to avoid). The
  per-popup task can override (e.g. yank the event's `task_id` if
  present, formatted as `mu task notes <id> -w <ws>` — that's
  actually useful). Recommend the per-popup task lock that
  conditional shape; this note's suppression is the SAFE default.

- Optimistic toast then suffix-swap is a UX call. Alternative
  (block on yank() before showing the toast at all) was rejected
  because of execa worst-case latency on cold-cache pbcopy
  (~30ms); a sub-frame freeze for every keypress is jarring in a
  TUI. The sub-ms jitter where the user briefly sees no suffix is
  acceptable; the suffix swap doesn't shift any layout (it's
  appended to the right edge of the toast).

- The 100ms keypress-debounce-against-self is asymmetric: it ONLY
  applies to dismissing the toast on the SAME `y` that fired it.
  Other keys (j/k/n/N/Esc/...) dismiss the toast on the very next
  press without delay. Without this carve-out, holding `y` for
  rapid repeated yanks would ping-pong toast on/off; with it, each
  `y` cleanly replaces the prior toast.

- The footer's "[copied]" vs "[no clipboard]" suffix is the SAME
  for OSC-52 and native-CLI successes. Designer-2 wanted the
  asterisk distinction to surface OSC-52's best-effort nature; we
  collapsed it (§3 wordsmith note). If a real user reports a silent
  OSC-52 drop, v0.next adds the asterisk + help-line. That's the
  promotion criterion.

- detectClipboard() shells out at App mount, BEFORE first paint.
  Worst case ~50ms (linux, all three of xclip/xsel checks against a
  cold disk). Acceptable for an interactive `mu` startup that's
  already paying ink-mount cost (~80-150ms). If we ever observe a
  noticeable startup regression, move the probe behind a deferred
  Promise.all() and let the first yank wait on it.

- WSL detection via `/microsoft/i.test(os.release())` is the
  industry-standard heuristic (used by clipboardy, gh-cli, etc.)
  but it's a substring match on a kernel string — fragile by
  nature. Acceptable for v0; if WSL2 ever changes its uname the
  fallback to OSC-52 covers us silently.

- We do NOT distinguish between "OSC-52 write succeeded but
  terminal absorbed it silently" and "OSC-52 write succeeded and
  terminal updated the clipboard". Both are reported as
  backend:'osc52', copied:true. This is the documented
  best-effort contract; users who see the [copied] suffix on a
  failed paste are expected to fall back to manual selection from
  the dashboard footer (which is exactly why the footer is
  always-visible).

- The yank() return shape `{copied, backend, error?}` from the
  brief is implemented at the INTERNAL surface only. The public
  PopupProps.yank stays `(text, opts?) => void` because: (a) popups
  cannot meaningfully react to YankResult (the toast/footer side-
  effects are handled by the dispatcher); (b) returning a Promise
  from PopupProps.yank would force every popup author to handle
  async; (c) per design_card_iface, popups MUST NOT touch clipboard
  themselves — so they have nothing useful to do with a YankResult.
  The brief's "shape" question is answered: YankResult exists, in
  the internal surface, fully testable, never escapes yank.ts to
  popup code.
```

### #2 by "designer-1", 2026-05-11T11:18:47.586Z

```
CLOSE: yank flow + probe + toast + footer locked
```
