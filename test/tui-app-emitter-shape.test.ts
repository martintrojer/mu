// Guard test for review_tui_app_uses_internal_ink_emitter.
//
// app.tsx's mouse-wheel path still replays one synthetic j/k key
// through ink's `internal_eventEmitter` (private-by-name; ink can
// rename or remove it without a breaking-change bump). Double-click
// row drill no longer uses this seam; it emits first-class
// PopupAction objects. We isolate the remaining scroll dependency
// behind getInkInternalEmitter(stdin) which runtime-probes the field
// and returns null if it disappears (mouse-wheel degrades gracefully).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { getInkInternalEmitter } from "../src/cli/tui/app.js";

describe("ink internal_eventEmitter contract (mouse-replay seam)", () => {
  it("getInkInternalEmitter returns the emitter when stdin has the field", () => {
    const emitter = new EventEmitter();
    const stdinLike = {
      stdin: process.stdin,
      setRawMode: () => {},
      isRawModeSupported: false,
      internal_exitOnCtrlC: true,
      internal_eventEmitter: emitter,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test fixture mimics ink stdin shape
    expect(getInkInternalEmitter(stdinLike as any)).toBe(emitter);
  });

  it("getInkInternalEmitter returns null when stdin lacks the field (graceful degradation)", () => {
    const stdinLike = {
      stdin: process.stdin,
      setRawMode: () => {},
      isRawModeSupported: false,
      internal_exitOnCtrlC: true,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test fixture mimics ink stdin shape minus the private field
    expect(getInkInternalEmitter(stdinLike as any)).toBeNull();
  });
});
