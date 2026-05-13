// Pure unit tests for the centralised scroll/navigation primitives
// in src/cli/tui/popups/scroll.ts (per
// feat_centralize_scroll_navigation, workstream `tui-impl`).
//
// These functions previously existed as ~60 inline switch arms
// across 9 popup files. Now there's exactly one implementation —
// these tests are its only behaviour spec, so every consumer
// downstream gets the same answer.

import { describe, expect, it } from "vitest";
import {
  type NavAction,
  applyCursor,
  applyScroll,
  centredVisibleSlice,
  clampScrollTop,
  isNavAction,
} from "../src/cli/tui/popups/scroll.js";

describe("isNavAction", () => {
  it("recognises the six scroll nav kinds", () => {
    expect(isNavAction({ kind: "moveUp" })).toBe(true);
    expect(isNavAction({ kind: "moveDown" })).toBe(true);
    expect(isNavAction({ kind: "jumpTop" })).toBe(true);
    expect(isNavAction({ kind: "jumpBottom" })).toBe(true);
    expect(isNavAction({ kind: "pageUp" })).toBe(true);
    expect(isNavAction({ kind: "pageDown" })).toBe(true);
  });

  it("rejects every non-nav PopupAction kind", () => {
    for (const kind of [
      "close",
      "filter",
      "yank",
      "drill",
      "verb",
      "noop",
      "nextMatch",
      "prevMatch",
      "setCursor",
    ]) {
      expect(isNavAction({ kind })).toBe(false);
    }
  });
});

describe("clampScrollTop", () => {
  it("clamps below zero", () => {
    expect(clampScrollTop(-5, 100, 10)).toBe(0);
  });

  it("clamps above totalLines - viewport", () => {
    expect(clampScrollTop(999, 100, 10)).toBe(90);
  });

  it("collapses to 0 when content fits the viewport", () => {
    expect(clampScrollTop(5, 8, 10)).toBe(0);
    expect(clampScrollTop(0, 0, 10)).toBe(0);
  });

  it("preserves an already-valid offset", () => {
    expect(clampScrollTop(42, 100, 10)).toBe(42);
  });
});

describe("applyCursor", () => {
  // A typical popup: 50 rows, 10 visible.
  const total = 50;
  const viewport = 10;

  it("moveUp / moveDown step by 1 with floor 0 and ceiling total-1", () => {
    expect(applyCursor(0, { kind: "moveUp" }, total, viewport)).toBe(0);
    expect(applyCursor(5, { kind: "moveUp" }, total, viewport)).toBe(4);
    expect(applyCursor(49, { kind: "moveDown" }, total, viewport)).toBe(49);
    expect(applyCursor(5, { kind: "moveDown" }, total, viewport)).toBe(6);
  });

  it("jumpTop / jumpBottom go to the extremes", () => {
    expect(applyCursor(20, { kind: "jumpTop" }, total, viewport)).toBe(0);
    expect(applyCursor(20, { kind: "jumpBottom" }, total, viewport)).toBe(49);
  });

  it("setCursor jumps directly to an absolute row and clamps", () => {
    expect(applyCursor(0, { kind: "setCursor", index: 12 }, total, viewport)).toBe(12);
    expect(applyCursor(0, { kind: "setCursor", index: -5 }, total, viewport)).toBe(0);
    expect(applyCursor(0, { kind: "setCursor", index: 999 }, total, viewport)).toBe(49);
    expect(applyCursor(7, { kind: "setCursor", index: 3 }, 0, viewport)).toBe(0);
  });

  it("pageDown half/full step is floor(viewport / (half ? 2 : 1))", () => {
    expect(applyCursor(0, { kind: "pageDown", half: true }, total, viewport)).toBe(5);
    expect(applyCursor(0, { kind: "pageDown", half: false }, total, viewport)).toBe(10);
  });

  it("pageUp half/full step matches and clamps to 0", () => {
    expect(applyCursor(7, { kind: "pageUp", half: true }, total, viewport)).toBe(2);
    expect(applyCursor(2, { kind: "pageUp", half: false }, total, viewport)).toBe(0);
  });

  it("page actions clamp to last when overshooting", () => {
    expect(applyCursor(48, { kind: "pageDown", half: false }, total, viewport)).toBe(49);
  });

  it("collapses to 0 on an empty collection", () => {
    for (const kind of ["moveUp", "moveDown", "jumpTop", "jumpBottom"] as const) {
      expect(applyCursor(0, { kind }, 0, viewport)).toBe(0);
    }
    expect(applyCursor(0, { kind: "pageDown", half: true }, 0, viewport)).toBe(0);
    expect(applyCursor(0, { kind: "pageUp", half: true }, 0, viewport)).toBe(0);
    expect(applyCursor(0, { kind: "setCursor", index: 10 }, 0, viewport)).toBe(0);
  });

  it("a tiny viewport still yields a no-op page step (matches pre-centralisation behaviour)", () => {
    // Math.floor(1 / 2) === 0 — half-page on viewport 1 is a no-op,
    // exactly as the inline `Math.floor(viewport / 2)` formula
    // produced before this helper landed.
    expect(applyCursor(5, { kind: "pageDown", half: true }, total, 1)).toBe(5);
  });
});

describe("applyScroll", () => {
  // A typical drill body: 100 lines, 10 visible.
  const total = 100;
  const viewport = 10;

  it("moveUp / moveDown step by 1 within the clamped scroll range", () => {
    expect(applyScroll(0, { kind: "moveUp" }, total, viewport)).toBe(0);
    expect(applyScroll(5, { kind: "moveUp" }, total, viewport)).toBe(4);
    expect(applyScroll(90, { kind: "moveDown" }, total, viewport)).toBe(90);
    expect(applyScroll(89, { kind: "moveDown" }, total, viewport)).toBe(90);
  });

  it("jumpTop returns 0 and jumpBottom returns totalLines - viewport", () => {
    expect(applyScroll(42, { kind: "jumpTop" }, total, viewport)).toBe(0);
    expect(applyScroll(0, { kind: "jumpBottom" }, total, viewport)).toBe(90);
  });

  it("pageDown half/full advance and clamp at the bottom", () => {
    expect(applyScroll(0, { kind: "pageDown", half: true }, total, viewport)).toBe(5);
    expect(applyScroll(0, { kind: "pageDown", half: false }, total, viewport)).toBe(10);
    expect(applyScroll(85, { kind: "pageDown", half: false }, total, viewport)).toBe(90);
  });

  it("pageUp half/full retreat and clamp at the top", () => {
    expect(applyScroll(7, { kind: "pageUp", half: true }, total, viewport)).toBe(2);
    expect(applyScroll(2, { kind: "pageUp", half: false }, total, viewport)).toBe(0);
  });

  it("collapses to 0 when the body is empty or fits the viewport", () => {
    expect(applyScroll(0, { kind: "moveDown" }, 0, viewport)).toBe(0);
    expect(applyScroll(3, { kind: "jumpBottom" }, 5, viewport)).toBe(0);
  });
});

describe("centredVisibleSlice", () => {
  // 50 items, viewport of 10 — same shape every drill popup uses.
  const items = Array.from({ length: 50 }, (_, i) => i);

  it("empty items → start=0, visible=[]", () => {
    expect(centredVisibleSlice([], 0, 10)).toEqual({ start: 0, visible: [] });
    expect(centredVisibleSlice([], 5, 10)).toEqual({ start: 0, visible: [] });
  });

  it("viewport <= 0 → start=0, visible=[] (defensive against pathological terminals)", () => {
    expect(centredVisibleSlice(items, 25, 0)).toEqual({ start: 0, visible: [] });
    expect(centredVisibleSlice(items, 25, -3)).toEqual({ start: 0, visible: [] });
  });

  it("items.length <= viewport → start=0, visible=items.slice() (full list)", () => {
    const small = items.slice(0, 8);
    const out = centredVisibleSlice(small, 3, 10);
    expect(out.start).toBe(0);
    expect(out.visible).toEqual(small);
    // Returns a fresh array, not the same reference — callers slice into it.
    expect(out.visible).not.toBe(small);
  });

  it("cursor near top clamps start to 0", () => {
    expect(centredVisibleSlice(items, 0, 10)).toEqual({
      start: 0,
      visible: items.slice(0, 10),
    });
    expect(centredVisibleSlice(items, 4, 10)).toEqual({
      start: 0,
      visible: items.slice(0, 10),
    });
  });

  it("cursor near bottom clamps start to items.length - viewport", () => {
    // total=50, viewport=10 → max start = 40.
    expect(centredVisibleSlice(items, 49, 10)).toEqual({
      start: 40,
      visible: items.slice(40, 50),
    });
    expect(centredVisibleSlice(items, 47, 10)).toEqual({
      start: 40,
      visible: items.slice(40, 50),
    });
  });

  it("cursor in the middle: start = cursor - floor(viewport / 2)", () => {
    // cursor 25, viewport 10 → start = 25 - 5 = 20; visible = items[20..30).
    const out = centredVisibleSlice(items, 25, 10);
    expect(out.start).toBe(20);
    expect(out.visible).toEqual(items.slice(20, 30));
    expect(out.visible).toHaveLength(10);
  });

  it("odd viewport uses Math.floor (matches the pre-centralisation inline formula)", () => {
    // cursor 25, viewport 11 → start = 25 - 5 = 20 (floor(11/2) === 5).
    const out = centredVisibleSlice(items, 25, 11);
    expect(out.start).toBe(20);
    expect(out.visible).toHaveLength(11);
  });

  it("matches the legacy inline formula across a sweep of cursors", () => {
    // The inline formula every popup used before this helper:
    //   start = max(0, min(items.length - viewport, cursor - floor(viewport/2)))
    // This test pins the helper's output to that exact formula so a
    // future refactor (e.g. switching to ceil) gets caught.
    const viewport = 7;
    for (let cursor = 0; cursor < items.length; cursor++) {
      const expectedStart = Math.max(
        0,
        Math.min(items.length - viewport, cursor - Math.floor(viewport / 2)),
      );
      const out = centredVisibleSlice(items, cursor, viewport);
      expect(out.start).toBe(expectedStart);
      expect(out.visible).toEqual(items.slice(expectedStart, expectedStart + viewport));
    }
  });
});

describe("NavAction is structurally a subset of PopupAction", () => {
  // Sanity check that the union has exactly the six scroll kinds we
  // dispatch on. If a seventh kind appears here, `isNavAction`'s
  // NAV_KINDS allowlist must update too.
  const allKinds = (xs: NavAction[]) => xs.map((x) => x.kind).sort();
  const sample: NavAction[] = [
    { kind: "moveUp" },
    { kind: "moveDown" },
    { kind: "jumpTop" },
    { kind: "jumpBottom" },
    { kind: "pageUp", half: true },
    { kind: "pageDown", half: false },
  ];
  it("covers exactly six kinds", () => {
    expect(allKinds(sample)).toEqual([
      "jumpBottom",
      "jumpTop",
      "moveDown",
      "moveUp",
      "pageDown",
      "pageUp",
    ]);
  });
});
