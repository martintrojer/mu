import { describe, expect, it } from "vitest";
import {
  DOUBLE_CLICK_MS,
  createDoubleClickDetector,
  parseSgrMouseEvents,
} from "../src/cli/tui/mouse.js";

const NOW = () => 1_000;

describe("SGR mouse parser", () => {
  it("parses a press event", () => {
    expect(parseSgrMouseEvents("\x1b[<0;12;5M", NOW)).toEqual([
      { kind: "press", x: 12, y: 5, button: 0, ts: 1_000 },
    ]);
  });

  it("parses a release event", () => {
    expect(parseSgrMouseEvents("\x1b[<0;12;5m", NOW)).toEqual([
      { kind: "release", x: 12, y: 5, button: 0, ts: 1_000 },
    ]);
  });

  it("parses scroll-wheel events", () => {
    expect(parseSgrMouseEvents("\x1b[<64;4;9M\x1b[<65;4;10M", NOW)).toEqual([
      { kind: "scroll", direction: "up", x: 4, y: 9, button: 64, ts: 1_000 },
      { kind: "scroll", direction: "down", x: 4, y: 10, button: 65, ts: 1_000 },
    ]);
  });
});

describe("double-click detector", () => {
  it("synthesizes doubleclick for two presses on the same cell inside the window", () => {
    const d = createDoubleClickDetector();
    expect(d.push({ kind: "press", x: 3, y: 4, button: 0, ts: 0 })).toEqual([
      { kind: "press", x: 3, y: 4, button: 0, ts: 0 },
    ]);
    expect(d.push({ kind: "press", x: 3, y: 4, button: 0, ts: DOUBLE_CLICK_MS - 1 })).toEqual([
      { kind: "press", x: 3, y: 4, button: 0, ts: DOUBLE_CLICK_MS - 1 },
      { kind: "doubleclick", x: 3, y: 4, button: 0, ts: DOUBLE_CLICK_MS - 1 },
    ]);
  });

  it("does not synthesize doubleclick for different cells", () => {
    const d = createDoubleClickDetector();
    d.push({ kind: "press", x: 3, y: 4, button: 0, ts: 0 });
    expect(d.push({ kind: "press", x: 4, y: 4, button: 0, ts: 10 })).toEqual([
      { kind: "press", x: 4, y: 4, button: 0, ts: 10 },
    ]);
  });

  it("does not synthesize doubleclick after the window", () => {
    const d = createDoubleClickDetector();
    d.push({ kind: "press", x: 3, y: 4, button: 0, ts: 0 });
    expect(d.push({ kind: "press", x: 3, y: 4, button: 0, ts: DOUBLE_CLICK_MS + 1 })).toEqual([
      { kind: "press", x: 3, y: 4, button: 0, ts: DOUBLE_CLICK_MS + 1 },
    ]);
  });
});
