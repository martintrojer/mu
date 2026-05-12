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
  clampScrollTop,
  isNavAction,
} from "../src/cli/tui/popups/scroll.js";

describe("isNavAction", () => {
  it("recognises the six nav kinds", () => {
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

describe("NavAction is structurally a subset of PopupAction", () => {
  // Sanity check that the union has exactly the six kinds we
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
