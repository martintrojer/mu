import { describe, expect, it } from "vitest";
import { POPUP_CHROME_TOP, replayPendingMouseEvent } from "../src/cli/tui/app.js";
import type { PopupAction } from "../src/cli/tui/keys.js";
import type { MouseEvent } from "../src/cli/tui/mouse.js";

interface PendingMouseEventRef {
  current: MouseEvent | null;
}

describe("replayPendingMouseEvent", () => {
  it("does not replay when opening a popup with no fresh pending mouse event", () => {
    const emitted: string[] = [];
    const actions: PopupAction[] = [];
    const pending: PendingMouseEventRef = { current: null };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
      emitAction: (action) => actions.push(action),
    });

    expect(replayed).toBe(false);
    expect(emitted).toEqual([]);
    expect(actions).toEqual([]);
    expect(pending.current).toBeNull();
  });

  it("does not consume the pending event while the popup is closed", () => {
    const event: MouseEvent = { kind: "doubleclick", x: 5, y: 6, button: 0, ts: 1 };
    const pending: PendingMouseEventRef = { current: event };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: false,
      filterEditing: false,
      emitKey: () => undefined,
      emitAction: () => undefined,
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
      emitAction: () => undefined,
    });

    expect(replayed).toBe(false);
    expect(pending.current).toBe(event);
  });

  it("does not consume scroll when the internal key emitter is unavailable", () => {
    const event: MouseEvent = { kind: "scroll", direction: "down", x: 1, y: 1, button: 65, ts: 1 };
    const pending: PendingMouseEventRef = { current: event };

    const replayed = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitAction: () => undefined,
    });

    expect(replayed).toBe(false);
    expect(pending.current).toBe(event);
  });

  it("replays a popup scroll event and consumes it once", () => {
    const emitted: string[] = [];
    const actions: PopupAction[] = [];
    const pending: PendingMouseEventRef = {
      current: { kind: "scroll", direction: "down", x: 1, y: 1, button: 65, ts: 1 },
    };

    const firstReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
      emitAction: (action) => actions.push(action),
    });
    const secondReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key) => emitted.push(key),
      emitAction: (action) => actions.push(action),
    });

    expect(firstReplay).toBe(true);
    expect(secondReplay).toBe(false);
    expect(emitted).toEqual(["j"]);
    expect(actions).toEqual([]);
    expect(pending.current).toBeNull();
  });

  it("emits setCursor then drill for popup double-click and consumes it once", () => {
    const emitted: Array<{ key: string; delayMs: number }> = [];
    const actions: PopupAction[] = [];
    const pending: PendingMouseEventRef = {
      current: { kind: "doubleclick", x: 5, y: 6, button: 0, ts: 1 },
    };

    const firstReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key, delayMs) => emitted.push({ key, delayMs }),
      emitAction: (action) => actions.push(action),
    });
    const secondReplay = replayPendingMouseEvent(pending, {
      popupOpen: true,
      filterEditing: false,
      emitKey: (key, delayMs) => emitted.push({ key, delayMs }),
      emitAction: (action) => actions.push(action),
    });

    expect(firstReplay).toBe(true);
    expect(secondReplay).toBe(false);
    expect(emitted).toEqual([]);
    expect(actions).toEqual([
      { kind: "setCursor", index: 6 - POPUP_CHROME_TOP },
      { kind: "drill" },
    ]);
    expect(pending.current).toBeNull();
  });
});
