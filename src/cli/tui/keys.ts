// Global keymap dispatcher for the TUI dashboard. Per
// design_global_keymap (workstream `tui`):
//
//   1-4         toggle Agents/Tracks/Ready/Log card
//   ! @ # $     open fullscreen popup for that card  (Shift+1..Shift+4
//               on US keyboards; bound by glyph because ink reports
//               the post-shift character, not the modifier)
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
  | { kind: "toggleCard"; cardId: 1 | 2 | 3 | 4 }
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

  // Card toggles 1-4. Slots 5-9 are reserved per design_global_keymap.
  if (input >= "1" && input <= "4") {
    const cardId = (input.charCodeAt(0) - "0".charCodeAt(0)) as 1 | 2 | 3 | 4;
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
