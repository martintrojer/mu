// Global keymap dispatcher for the TUI dashboard. Per
// design_global_keymap (workstream `tui`):
//
//   1-4         toggle Agents/Tracks/Ready/Log card
//   5           toggle Workspaces card (feat_card_5_workspaces)
//   6           toggle In-progress card (feat_card_6_inprogress)
//   7           toggle Blocked card (feat_card_7_blocked)
//   8           toggle Commits card (feat_tui_commits_card)
//   9           toggle Doctor card (feat_card_9_doctor)
//   g           open full DAG popup (graph mnemonic)
//   l / L       open Commits popup (log mnemonic; lazygit/k9s convention)
//   ! @ # $     open fullscreen popup for that card  (Shift+1..Shift+4
//               on US keyboards; bound by glyph because ink reports
//               the post-shift character, not the modifier).
//   Shift+8/*   open Recent popup (popup-only after Commits takes
//               Card 8)
//   + / =       tick faster (floor 100ms); = is the unshifted alias
//   -           tick slower (ceiling 10s)
//   0           reset tick to default 1s
//   r / F5      refresh now (poke poll loop)
//   ?           toggle help overlay
//   q / Q       quit
//   Ctrl-C      quit (handled by ink's exitOnCtrlC)
//   c           clear footer (most-recent-yank line)
//   Tab         next workstream tab (multi-ws TUI; noop when N=1)
//   Shift-Tab   previous workstream tab
//
// This module is pure TS: takes a keystroke (input + key flags from
// ink's useInput) and returns a structured GlobalAction. The caller
// (the <App> component in app.tsx) maps actions to state mutations.

export type GlobalAction =
  | { kind: "toggleCard"; cardId: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }
  | { kind: "openPopup"; cardId: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | "commits" }
  | { kind: "tickFaster" }
  | { kind: "tickSlower" }
  | { kind: "tickReset" }
  | { kind: "refreshNow" }
  | { kind: "toggleHelp" }
  | { kind: "quit" }
  | { kind: "clearFooter" }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
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
}

/**
 * Structural subset of ink's `Key` object as delivered to useInput.
 * Kept local (instead of importing ink's type) so keys.ts remains a
 * pure keymap module with no render-time dependency.
 */
export type InkKeyLike = KeyFlags;

function keyFlagsFromInk(key: InkKeyLike): KeyFlags {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    escape: key.escape,
    return: key.return,
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    leftArrow: key.leftArrow,
    rightArrow: key.rightArrow,
    tab: key.tab,
    pageUp: key.pageUp,
    pageDown: key.pageDown,
    f5: key.f5,
  };
}

export function dispatchGlobalKeyFromInk(input: string, key: InkKeyLike): GlobalAction {
  return dispatchGlobalKey(input, keyFlagsFromInk(key));
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
  if (input === "?") return { kind: "toggleHelp" };

  // Refresh-now poke
  if (input === "r" || key.f5) return { kind: "refreshNow" };

  // Footer clear (last-yank line)
  if (input === "c") return { kind: "clearFooter" };

  // Multi-workstream tab navigation. Tab cycles forward;
  // Shift-Tab cycles backward. Per feat_tui_multi_workstream
  // (workstream `tui-impl`): the dispatcher returns the action
  // unconditionally; the App suppresses it (via the popup-open
  // guard) when a popup is mounted, and degenerates to a noop
  // when only one workstream is loaded.
  if (key.tab === true) {
    return { kind: key.shift === true ? "prevTab" : "nextTab" };
  }

  // Tick rate adjust. `+` arrives as `+` (Shift+= on US); `=` is the
  // unshifted alias for users who don't bother shifting; `-` is the
  // plain minus key; `0` resets.
  if (input === "+" || input === "=") return { kind: "tickFaster" };
  if (input === "-") return { kind: "tickSlower" };
  if (input === "0") return { kind: "tickReset" };

  // Card toggles 1-9. All reserved slots from design_global_keymap
  // are now filled: slot 5 by feat_card_5_workspaces, slot 6 by
  // feat_card_6_inprogress, slot 7 by feat_card_7_blocked, slot 8
  // by feat_tui_commits_card, slot 9 by feat_card_9_doctor (all
  // workstream `tui-impl`). Slot 0 stays reserved by convention
  // (no promotion task today).
  if (input >= "1" && input <= "9") {
    const cardId = (input.charCodeAt(0) - "0".charCodeAt(0)) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    return { kind: "toggleCard", cardId };
  }

  if (input === "g") return { kind: "openPopup", cardId: 0 };
  if (input === "l" || input === "L") return { kind: "openPopup", cardId: "commits" };

  // Popup openers !-) on US keyboards. Bound by glyph because ink
  // reports the post-shift character; key.shift is false.
  // Layout-dependent — see design_global_keymap ODDITY for non-US
  // keymaps. Slot 8 still opens the Recent popup, even though Card 8
  // is now Commits; the Commits popup uses the mnemonic `l`/`L`.
  const glyphMap: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9> = {
    ")": 0,
    "!": 1,
    "@": 2,
    "#": 3,
    $: 4,
    "%": 5,
    "^": 6,
    "&": 7,
    "*": 8,
    "(": 9,
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
  | { kind: "filter" }
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
export function dispatchPopupKeyFromInk(input: string, key: InkKeyLike): PopupAction {
  return dispatchPopupKey(input, keyFlagsFromInk(key));
}

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
  if (input === "/") return { kind: "filter" };
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
