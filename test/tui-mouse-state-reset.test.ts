import { describe, expect, it } from "vitest";
import { replayPendingMouseEvent } from "../src/cli/tui/app.js";
import type { MouseEvent } from "../src/cli/tui/mouse.js";

interface PendingMouseEventRef {
  current: MouseEvent | null;
}

describe("replayPendingMouseEvent", () => {
  it("does not replay when opening a popup with no fresh pending mouse event", () => {
    const emitted: string[] = [];
    const pending: PendingMouseEventRef = { current: null };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
    });

    expect(replayed).toBe(false);
    expect(emitted).toEqual([]);
    expect(pending.current).toBeNull();
  });

  it("does not consume the pending event while the popup is closed", () => {
    const event: MouseEvent = { kind: "doubleclick", x: 5, y: 6, button: 0, ts: 1 };
    const pending: PendingMouseEventRef = { current: event };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: false,
      filterEditing: false,
      emitKey: () => undefined,
    });

    expect(replayed).toBe(false);
    expect(pending.current).toBe(event);
  });

  it("does not consume the pending event while the filter prompt is editing", () => {
    const event: MouseEvent = { kind: "scroll", direction: "down", x: 1, y: 1, button: 65, ts: 1 };
    const pending: PendingMouseEventRef = { current: event };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: true,
      emitKey: () => undefined,
    });

    expect(replayed).toBe(false);
    expect(pending.current).toBe(event);
  });

  it("replays a popup scroll event and consumes it once", () => {
    const emitted: string[] = [];
    const pending: PendingMouseEventRef = {
      current: { kind: "scroll", direction: "down", x: 1, y: 1, button: 65, ts: 1 },
    };

    const firstReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
    });
    const secondReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
    });

    expect(firstReplay).toBe(true);
    expect(secondReplay).toBe(false);
    expect(emitted).toEqual(["j"]);
    expect(pending.current).toBeNull();
  });

  it("replays a popup double-click into row-navigation keys and consumes it once", () => {
    const emitted: Array<{ key: string; delayMs: number }> = [];
    const pending: PendingMouseEventRef = {
      current: { kind: "doubleclick", x: 5, y: 6, button: 0, ts: 1 },
    };

    const firstReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key, delayMs) => emitted.push({ key, delayMs }),
    });
    const secondReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key, delayMs) => emitted.push({ key, delayMs }),
    });

    expect(firstReplay).toBe(true);
    expect(secondReplay).toBe(false);
    expect(emitted.map((e) => e.key).join("")).toBe("gjjjj\r");
    expect(emitted.map((e) => e.delayMs)).toEqual([0, 8, 16, 24, 32, 40]);
    expect(pending.current).toBeNull();
  });
});
