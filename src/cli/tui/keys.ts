// Global keymap dispatcher for the TUI dashboard. Per
// design_global_keymap (workstream `tui`):
//
//   1-4         toggle Agents/Tracks/Ready/Log card
//   5           toggle Workspaces card (feat_card_5_workspaces)
//   ! @ # $     open fullscreen popup for that card  (Shift+1..Shift+4
//               on US keyboards; bound by glyph because ink reports
//               the post-shift character, not the modifier).
//               Slot-5 popup is OUT OF SCOPE for feat_card_5_workspaces;
//               `%` (Shift+5) stays a noop until the matching popup task
//               lands.
//   + / =       tick faster (floor 100ms); = is the unshifted alias
//   -           tick slower (ceiling 10s)
//   0           reset tick to default 1s
//   r / F5      refresh now (poke poll loop)
//   ? / F1      toggle help overlay
//   q / Q       quit
//   Ctrl-C      quit (handled by ink's exitOnCtrlC)
//   c           clear footer (most-recent-yank line)
//   w           workstream picker (v0.next; emits a noop-with-toast)
//
// This module is pure TS: takes a keystroke (input + key flags from
// ink's useInput) and returns a structured GlobalAction. The caller
// (the <App> component in app.tsx) maps actions to state mutations.

export type GlobalAction =
  | { kind: "toggleCard"; cardId: 1 | 2 | 3 | 4 | 5 }
  | { kind: "openPopup"; cardId: 1 | 2 | 3 | 4 }
  | { kind: "tickFaster" }
  | { kind: "tickSlower" }
  | { kind: "tickReset" }
  | { kind: "refreshNow" }
  | { kind: "toggleHelp" }
  | { kind: "quit" }
  | { kind: "clearFooter" }
  | { kind: "workstreamPicker" }
  | { kind: "noop" };

/**
 * Subset of ink's `Key` shape we care about. Defining locally so the
 * keys module stays decoupled from ink's render-time Key type.
 */
export interface KeyFlags {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  escape?: boolean;
  return?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  f5?: boolean;
  f1?: boolean;
}

/**
 * Map a single keystroke (delivered by ink's useInput) to the global
 * dashboard action it represents. Returns `{kind:"noop"}` for any
 * unrecognised input — the caller can treat noop as "do nothing".
 *
 * Pure function: no side effects, no React, no ink imports. Trivially
 * unit-testable.
 */
export function dispatchGlobalKey(input: string, key: KeyFlags): GlobalAction {
  // Quit takes precedence over everything (including help overlay
  // suppression handled by the caller).
  if (key.ctrl && input === "c") return { kind: "quit" };
  if (input === "q" || input === "Q") return { kind: "quit" };

  // Help overlay
  if (input === "?" || key.f1) return { kind: "toggleHelp" };

  // Refresh-now poke
  if (input === "r" || key.f5) return { kind: "refreshNow" };

  // Footer clear (last-yank line)
  if (input === "c") return { kind: "clearFooter" };

  // Workstream picker (reserved; v0.next)
  if (input === "w") return { kind: "workstreamPicker" };

  // Tick rate adjust. `+` arrives as `+` (Shift+= on US); `=` is the
  // unshifted alias for users who don't bother shifting; `-` is the
  // plain minus key; `0` resets.
  if (input === "+" || input === "=") return { kind: "tickFaster" };
  if (input === "-") return { kind: "tickSlower" };
  if (input === "0") return { kind: "tickReset" };

  // Card toggles 1-5. Slots 6-9 are reserved per design_global_keymap;
  // 5 was promoted by feat_card_5_workspaces (workstream `tui-impl`).
  if (input >= "1" && input <= "5") {
    const cardId = (input.charCodeAt(0) - "0".charCodeAt(0)) as 1 | 2 | 3 | 4 | 5;
    return { kind: "toggleCard", cardId };
  }

  // Popup openers !-$ on US keyboards. Bound by glyph because ink
  // reports the post-shift character; key.shift is false. Layout-
  // dependent — see design_global_keymap ODDITY for non-US keymaps.
  const glyphMap: Record<string, 1 | 2 | 3 | 4> = {
    "!": 1,
    "@": 2,
    "#": 3,
    $: 4,
  };
  const popupId = glyphMap[input];
  if (popupId !== undefined) return { kind: "openPopup", cardId: popupId };

  return { kind: "noop" };
}

// ─── In-popup keymap convention ────────────────────────────────────
//
// Per design_global_keymap, every popup honours:
//   j / ↓        moveDown
//   k / ↑        moveUp
//   g            jumpTop
//   G            jumpBottom
//   Ctrl-D       pageDown (half)
//   Ctrl-U       pageUp (half)
//   PgDn / PgUp  pageDown / pageUp (full)
//   /            enterFilter
//   n            nextMatch
//   N            prevMatch
//   Esc          close (or exit drill, when in drill mode)
//   q            close (alias)
//   y            yank
//   Enter        drill into the focused row (popup decides what to render)
//   ?            toggleHelp
//
// Tick-rate keys (+/-/=/0), refresh (r/F5), and Ctrl-C remain live in
// popups (they're global). Card toggles (1-4) and popup openers (!-$)
// are SUPPRESSED by <App>.

export type PopupAction =
  | { kind: "moveDown" }
  | { kind: "moveUp" }
  | { kind: "jumpTop" }
  | { kind: "jumpBottom" }
  | { kind: "pageDown"; half: boolean }
  | { kind: "pageUp"; half: boolean }
  | { kind: "enterFilter" }
  | { kind: "nextMatch" }
  | { kind: "prevMatch" }
  | { kind: "close" }
  | { kind: "yank" }
  | { kind: "drill" }
  | { kind: "verb"; key: string }
  | { kind: "noop" };

/**
 * Map a keystroke inside a popup to the popup-local action it
 * represents. Per-popup verbs (letter keys not in the reserved set
 * {j k g G n N q y c r w}) bubble up as `{kind: "verb", key}` so the
 * caller can switch on the literal letter.
 */
export function dispatchPopupKey(input: string, key: KeyFlags): PopupAction {
  if (key.escape || input === "q" || input === "Q") return { kind: "close" };
  if (input === "j" || key.downArrow) return { kind: "moveDown" };
  if (input === "k" || key.upArrow) return { kind: "moveUp" };
  if (input === "g") return { kind: "jumpTop" };
  if (input === "G") return { kind: "jumpBottom" };
  if (key.ctrl && input === "d") return { kind: "pageDown", half: true };
  if (key.ctrl && input === "u") return { kind: "pageUp", half: true };
  if (key.pageDown) return { kind: "pageDown", half: false };
  if (key.pageUp) return { kind: "pageUp", half: false };
  if (input === "/") return { kind: "enterFilter" };
  if (input === "n") return { kind: "nextMatch" };
  if (input === "N") return { kind: "prevMatch" };
  if (input === "y") return { kind: "yank" };
  // Enter drills into the focused row. The popup chooses what
  // "drill" renders (scrollback / sub-list / notes / no-op for
  // log). The dispatcher stays purely structural — read-only.
  if (key.return) return { kind: "drill" };
  // Per-popup verbs: any letter NOT in the reserved set above is a
  // candidate for a popup-specific verb. The caller decides whether
  // to act.
  if (/^[a-zA-Z]$/.test(input)) return { kind: "verb", key: input };
  return { kind: "noop" };
}
