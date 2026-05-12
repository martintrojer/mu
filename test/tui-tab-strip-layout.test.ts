import { describe, expect, it } from "vitest";
import { layoutTabStrip } from "../src/cli/tui/tab-strip-layout.js";

const twelve = [
  "ws-01",
  "ws-02",
  "ws-03",
  "ws-04",
  "ws-05",
  "ws-06",
  "ws-07",
  "ws-08",
  "ws-09",
  "ws-10",
  "ws-11",
  "ws-12",
];

function names(layout: NonNullable<ReturnType<typeof layoutTabStrip>>): string[] {
  return layout.visible.map((t) => t.name);
}

describe("layoutTabStrip", () => {
  it("returns null for one workstream", () => {
    expect(layoutTabStrip(["A"], 0, 80)).toBeNull();
  });

  it("shows all tabs with no counters when everything fits", () => {
    const layout = layoutTabStrip(["A", "B", "C", "D", "E"], 0, 200);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.leftHidden).toBe(0);
    expect(layout.rightHidden).toBe(0);
    expect(names(layout)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("windows around the active tab and reports hidden counts", () => {
    const layout = layoutTabStrip(twelve, 5, 80);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.visible.some((t) => t.name === "ws-06" && t.isActive)).toBe(true);
    expect(layout.leftHidden).toBeGreaterThan(0);
    expect(layout.rightHidden).toBeGreaterThan(0);
    expect(layout.leftHidden + layout.visible.length + layout.rightHidden).toBe(twelve.length);
  });

  it("handles the head edge", () => {
    const layout = layoutTabStrip(twelve, 0, 80);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.leftHidden).toBe(0);
    expect(names(layout)[0]).toBe("ws-01");
    expect(layout.rightHidden).toBe(twelve.length - layout.visible.length);
  });

  it("handles the tail edge", () => {
    const layout = layoutTabStrip(twelve, 11, 80);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.rightHidden).toBe(0);
    expect(names(layout).at(-1)).toBe("ws-12");
    expect(layout.leftHidden).toBe(twelve.length - layout.visible.length);
  });

  it("degrades to active-only with counters and an ellipsised name when extremely narrow", () => {
    const longNames = twelve.map((name) => `${name}-very-long-workstream-name`);
    const layout = layoutTabStrip(longNames, 5, 25);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.leftHidden).toBe(5);
    expect(layout.rightHidden).toBe(6);
    expect(layout.visible).toHaveLength(1);
    expect(layout.visible[0]).toMatchObject({ isActive: true });
    expect(layout.visible[0]?.name).toContain("…");
    expect(layout.showHint).toBe(false);
  });
});
