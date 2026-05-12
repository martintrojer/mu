import { describe, expect, test } from "vitest";
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  MOUSE_MODE_ENTER,
  MOUSE_MODE_EXIT,
} from "../src/cli/tui/escapes.js";

describe("tui escape sequences", () => {
  test("ALT_SCREEN_ENTER swaps to alt-screen, clears, homes, and hides cursor", () => {
    // Exact bytes, in order: ?1049h then 2J then H then ?25l.
    expect(ALT_SCREEN_ENTER).toBe("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
    // Sanity: cursor home + hide are at the tail so they win any
    // earlier in-string positioning.
    expect(ALT_SCREEN_ENTER.endsWith("\x1b[H\x1b[?25l")).toBe(true);
    // The alt-screen swap MUST be first — clearing/homing the live
    // shell buffer before swapping would nuke the user's scrollback.
    expect(ALT_SCREEN_ENTER.startsWith("\x1b[?1049h")).toBe(true);
  });

  test("ALT_SCREEN_EXIT restores cursor visibility before swapping back", () => {
    expect(ALT_SCREEN_EXIT).toBe("\x1b[?25h\x1b[?1049l");
    // Show cursor first, then restore the prior buffer — otherwise the
    // user's shell prompt would briefly render with no visible cursor.
    expect(ALT_SCREEN_EXIT.startsWith("\x1b[?25h")).toBe(true);
    expect(ALT_SCREEN_EXIT.endsWith("\x1b[?1049l")).toBe(true);
  });

  test("mouse mode enables normal/button-motion tracking plus SGR coordinates", () => {
    expect(MOUSE_MODE_ENTER).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  });

  test("mouse mode exit disables SGR/button-motion/normal tracking", () => {
    expect(MOUSE_MODE_EXIT).toBe("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  });
});
