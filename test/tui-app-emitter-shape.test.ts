// Guard test for review_tui_app_uses_internal_ink_emitter.
//
// app.tsx's mouse path replays synthetic key bytes through ink's
// `internal_eventEmitter` (private-by-name; ink can rename or remove
// it without a breaking-change bump). We isolate that dependency
// behind getInkInternalEmitter(stdin) which runtime-probes the field
// and returns null if it disappears (mouse degrades gracefully).
//
// This test is the CI tripwire: it asserts ink STILL exposes the
// emitter on the StdinContext Props shape. If a future ink upgrade
// drops the field, this test fails loudly so we know to either pin
// the ink version or migrate to Path B (route mouse through useMouse
// directly into popups). See task notes for details.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getInkInternalEmitter } from "../src/cli/tui/app.js";

describe("ink internal_eventEmitter contract (mouse-replay seam)", () => {
  it("ink's StdinContext Props type still declares internal_eventEmitter", () => {
    // Inspect ink's published .d.ts so we don't need to spin up a
    // full ink render to verify the shape. If ink removes the field
    // the type declaration disappears and this assertion fails.
    const dts = readFileSync("./node_modules/ink/build/components/StdinContext.d.ts", "utf-8");
    expect(
      dts,
      "ink StdinContext.d.ts must still declare internal_eventEmitter for mouse replay; if this fails, ink dropped the field — pin ink or migrate app.tsx mouse path to Path B (useMouse → popups directly).",
    ).toContain("internal_eventEmitter");
  });

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
