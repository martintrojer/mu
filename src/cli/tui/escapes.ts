// Pure escape-sequence constants for the TUI. Lives in src/cli/tui/ but
// imports neither ink nor react so unit tests can assert exact bytes
// without booting an ink renderer.
//
// On enter:
//   \x1b[?1049h  swap to alt-screen buffer
//   \x1b[2J      clear entire screen (else stale shell text bleeds through
//                ink's diff renderer until ink overwrites it)
//   \x1b[H       home cursor to row 1, col 1 (alt-screen swap inherits the
//                cursor row from the prior buffer on most terminals —
//                iTerm2, Apple Terminal, tmux's inner terminal, ...)
//   \x1b[?25l    hide cursor (lazygit/btop convention; otherwise the
//                blinking cursor sits behind the rendered cards)
//
// On exit, mirror in reverse: show cursor, then restore the prior buffer.
export const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
export const ALT_SCREEN_EXIT = "\x1b[?25h\x1b[?1049l";

// Mouse mode uses normal tracking + button-motion + SGR extended
// coordinates. SGR reports arrive as ESC [ < button ; x ; y ; M/m.
// Disable in the exact reverse order during TUI teardown so native
// terminal selection works again after exit.
export const MOUSE_MODE_ENTER = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_MODE_EXIT = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
