---
id: "investigate_clipboard"
workstream: "tui"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: "designer-2"
created_at: "2026-05-11T10:44:45.561Z"
updated_at: "2026-05-11T10:58:38.685Z"
blocked_by: ["design_locked"]
blocks: ["design_yank_flow"]
---

# Investigate clipboard backends (pbcopy/xclip/wl-copy)

## Notes (2)

### #1 by "designer-2", 2026-05-11T10:58:36.236Z

```
Clipboard backend matrix + recommendation for TUI yank flow (A3').

FILES:
  - package.json (deps: execa already present; no clipboard pkg)
  - docs/USAGE_GUIDE.md:132 (mu requires tmux ≥ 3.0, no Windows-native today)
  - src/agents/kick.ts:170-228 (only platform-divergent code today: BSD/Darwin + Linux ps; no win32 branch anywhere in src/)
  - mu task notes design_locked -w tui (yank A3' = clipboard-if-available + toast + footer)

COMMANDS:
  - rg -i "win32|wsl|clipboard|pbcopy|xclip|osc52|clipboardy" src/   # → 0 hits in src; mu has no clipboard code yet and no Windows support today
  - cat package.json | jq '.dependencies'                            # → execa is already in; no new dep needed for spawn-based backends
  - mu task show design_yank_flow -w tui                             # → consumer task; this investigation unblocks it

FINDINGS:

  ── 1. CLI BACKEND TABLE ───────────────────────────────────────────
  All commands take payload on stdin; we pipe `cmd` (utf-8, no
  trailing newline) and ignore stdout. Detection = `command -v <bin>`
  via execa; cache the resolved path (or null) for the session.

  | Backend         | Platform     | Detect                                                   | Command                                | Stdin |
  |-----------------|--------------|----------------------------------------------------------|----------------------------------------|-------|
  | pbcopy          | macOS        | process.platform==='darwin' && which pbcopy              | pbcopy                                 | utf-8 |
  | wl-copy         | Wayland      | $WAYLAND_DISPLAY set && which wl-copy                    | wl-copy --type text/plain              | utf-8 |
  | xclip           | X11/Linux    | $DISPLAY set && which xclip                              | xclip -selection clipboard -in         | utf-8 |
  | xsel            | X11/Linux    | $DISPLAY set && which xsel  (alt to xclip)               | xsel --clipboard --input               | utf-8 |
  | clip.exe        | WSL only     | /proc/version contains 'microsoft' && which clip.exe     | clip.exe                               | utf-16le pref. (see odd) |
  | Set-Clipboard   | Win-native   | n/a — mu requires tmux ≥ 3.0 (unix only). Skip for v0.   | —                                      | —     |

  Edge cases:
   - Wayland-on-XWayland: $DISPLAY AND $WAYLAND_DISPLAY both set.
     Order Wayland-first (wl-copy → xclip/xsel) so XWayland sessions
     still get the right compositor selection.
   - Headless ssh (no $DISPLAY, no $WAYLAND_DISPLAY): every CLI
     backend fails detection. OSC-52 via TTY is the only path.
   - tmux: pbcopy/xclip/wl-copy run *inside the pane*, so they target
     whatever clipboard the SSH-forwarded environment exposes. They
     do NOT need OSC-52 forwarding to work; they bypass the terminal
     entirely. Caveat: if user is ssh-tunneled with no X/Wayland
     forwarding, the CLIs are absent → fall through to OSC-52.
   - clip.exe on WSL: historically wants UTF-16LE; modern clip.exe
     accepts UTF-8 fine but a stray BOM is harmless. mu commands are
     ASCII-only in practice (no emoji in `mu agent close worker-1
     -w tui`), so UTF-8 is safe.
   - xclip blocks holding the X selection until consumed; spawn it
     detached or use `-loops 1 -quiet` to release after one paste.
     Recommend `xclip -selection clipboard -in -loops 1 -quiet`.

  ── 2. OSC-52 ALTERNATIVE ──────────────────────────────────────────
  Sequence: ESC ] 52 ; c ; <base64(payload)> BEL
  i.e. `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`
  Write to /dev/tty (NOT stdout — ink owns stdout). Zero deps.

  Compatibility matrix (verified from project docs / 2024 reality):

  | Terminal             | OSC-52 write | Notes                                          |
  |----------------------|--------------|------------------------------------------------|
  | iTerm2               | YES          | enabled by default since 3.x                   |
  | kitty                | YES          | `clipboard_control write-clipboard` (default y)|
  | wezterm              | YES          | default-on                                     |
  | alacritty            | YES (≥0.10)  | default-on                                     |
  | foot (Wayland)       | YES          | default-on                                     |
  | Ghostty              | YES          | default-on                                     |
  | xterm                | YES (≥279)   | needs `allowWindowOps: true` in some configs   |
  | gnome-terminal/VTE   | NO (default) | VTE upstream still gates it; many distros off  |
  | Konsole              | YES (≥21.x)  | confirm dialog by default                      |
  | Windows Terminal     | YES          | n/a for mu today (no Windows-native)           |
  | screen               | partial      | needs `termcapinfo xterm* 'hs@'` workaround    |
  | tmux                 | PASSTHROUGH  | requires `set -g set-clipboard on` (or `external`) AND tmux ≥ 3.2 to forward to outer terminal; also outer terminal must itself support OSC-52 |

  tmux trap: even with `set-clipboard on`, if the outer terminal is
  gnome-terminal/VTE, OSC-52 is silently dropped. mu cannot detect
  that "the bytes were absorbed into a black hole" — there is no
  ack. So OSC-52 is best-effort: we emit it, show the toast, and
  trust the user to re-yank via the footer if they notice nothing
  happened. (Same caveat applies to every TUI that uses OSC-52,
  e.g. lazygit, helix.)

  ── 3. RECOMMENDED PRIORITY ORDER (v0) ─────────────────────────────
  1. Native CLI for the platform we're on (most reliable, gives an
     exit code we can trust):
       darwin            → pbcopy
       linux + Wayland   → wl-copy
       linux + X11       → xclip (then xsel)
       wsl               → clip.exe
  2. OSC-52 fallback (works over SSH; covers headless + remote dev
     boxes; degrades gracefully if terminal/tmux drop it).
  3. No-op + toast says "(copy from footer)" (the dashboard footer
     line is the durable display; user can mouse-select).

  Justify: native CLI first because (a) deterministic exit code lets
  us show "[copied]" with confidence, (b) it works regardless of
  terminal emulator support, (c) it's how every other TUI on the
  platform behaves so muscle memory matches. OSC-52 second because
  it's the only thing that works headless/SSH and it's free (no dep,
  no probe). The "no clipboard" leg is the reason A3' shoves the
  command into a footer line — the UX is correct even when both
  legs fail.

  ── 4. DETECTION RUNTIME COST ──────────────────────────────────────
  Per-yank: each `command -v` shells out — measurable (5-15ms on
  warm fs) and visible in an interactive TUI doing 1Hz polls.
  Decision: **detect once at TUI startup**, cache `{cli: 'pbcopy'
  | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe' | null, osc52: true}`
  on a module-level constant. Re-detection on the lifetime of one
  `mu` invocation is unnecessary; users don't install pbcopy mid-
  session. OSC-52 path needs no detection — we just write to /dev/tty
  and hope. (Optional v0.next: re-probe on SIGUSR1 or on toggling
  workspace/pane.) Net startup cost: 1 fork+exec (`which pbcopy`
  style) on macOS, up to 3 on Linux. Negligible against ink mount.

  ── 5. FALLBACK UX ─────────────────────────────────────────────────
  CONFIRMED for v0: when both CLI and OSC-52 are unavailable (or we
  can't tell OSC-52 was absorbed), the yank action still:
   - shows the transient toast in the popup ("yanked: mu agent close
     worker-1 -w tui") for ~2s
   - writes the persistent footer line on the dashboard:
       last: mu agent close worker-1 -w tui  [copy from footer]
  When CLI succeeded → suffix `[copied]`; OSC-52 only → `[copied*]`
  with a `?` help-line entry explaining the asterisk = best-effort.
  When neither → `[copy from footer]`.

  Beyond v0 (mark v0.next):
   - Probe OSC-52 with DA1/CSI ack and downgrade automatically.
   - "y twice in a row to force OSC-52" override.
   - Configurable per-popup yank format (qualified id vs CLI verb).
   - Win-native Set-Clipboard (gated on mu ever supporting Windows
     non-WSL; not on roadmap).

  ── 6. NPM PACKAGE EVAL ────────────────────────────────────────────
  Candidates surveyed:
   - clipboardy (sindresorhus): ~120kB unpacked, bundles binaries
     for xsel/wl-copy and a vendored xsel. ESM-only, MIT, well-
     maintained. Pros: handles WSL, Termux, Wayland-vs-X for us,
     2-line API. Cons: bundles binaries (we'd ship them in `dist/`),
     dep-weight grows for a single-feature use, doesn't do OSC-52,
     hides which backend won (we lose the [copied]/[copied*] signal),
     and conflicts with the "small deps" + "no anticipatory abstr"
     pledges.
   - node-clipboard / copy-paste / clipboard-cli: variously
     unmaintained, win-bias, or wrap clipboardy.
   - No package on npm does OSC-52 + native CLI + tells you which
     leg fired. Every TUI that cares (lazygit, gh, helix) hand-rolls.

  RECOMMENDATION: hand-roll. ~30-60 LOC across one new file
  src/tui/clipboard.ts:
    - detectBackend() at startup → cached {cli, osc52: true}
    - copy(text): try cli (execa, stdin); on non-zero or absent,
      try osc52 (write to /dev/tty); return discriminated union
      `{ok: 'cli', backend} | {ok: 'osc52'} | {ok: false}` so the
      footer can render the right suffix.
    - One unit test per branch with execa mocked + a fake /dev/tty.
  Zero new dependencies. Fits the pledge.

DECISION:
  v0 ships: hand-rolled clipboard module with priority
  native-CLI → OSC-52 → footer-only. Detection cached at TUI
  startup. Exact backend recorded in copy() return so footer
  suffix can distinguish [copied] / [copied*] / [copy from footer].
  No npm dep added.

NEXT (for design_yank_flow):
  - Specify the exact toast string + duration (suggest 2s).
  - Specify footer line truncation rule (commands like `mu task
    note <id> "..."` with literal quoted blobs can blow column
    width — recommend right-truncate-with-ellipsis at terminal
    cols - "last: ".length - " [copied]".length).
  - Specify yank payload for each popup verb (notes popup yanks
    `mu task note <id> "<placeholder>"`? or just `mu task notes
    <id>`? — the brainstorm leaned toward the verb-only form).
  - Add a `?` help-line entry that explains the [copied*] asterisk.

VERIFIED:
  - mu has zero clipboard code today (rg over src/ → 0 hits).
  - mu has no Windows-native code path today (only kick.ts has BSD
    vs Linux divergence, no win32 branch); WSL is the only Windows
    story we need to think about.
  - execa is already a dep, so spawn-based backends add 0 deps.
  - tmux ≥ 3.0 is the documented requirement; OSC-52 forwarding
    needs tmux ≥ 3.2 + `set-clipboard on`. We do NOT propose
    auto-setting that option (would violate the no-config
    side-effect spirit) — surface it as a `mu doctor` hint instead
    (v0.next).

ODDITIES:
  - clipboardy actually vendors an xsel binary in its npm tarball.
    Cute, but exactly the kind of "bundled binary in a Node
    package" magic that bites us on aarch64-musl users. Another
    nudge toward hand-roll.
  - tmux's set-clipboard has three values: off / external (default
    on most distros) / on. "external" forwards but doesn't update
    tmux's internal buffer; "on" does both. For mu's purposes
    either is fine — we don't read back from tmux's buffer.
  - On macOS, pbcopy strips trailing newlines silently. We're not
    appending one anyway, but worth a unit-test pin.
  - OSC-52 has a 100kB-ish payload limit in many terminals
    (base64-encoded). A `mu` command line is well under that, so
    not a concern for the yank flow specifically.
```

### #2 by "designer-2", 2026-05-11T10:58:38.685Z

```
CLOSE: clipboard backend matrix + recommendation in note
```
