// Tests for the pure helpers in src/cli/tui/state.ts (the React hook
// itself is exercised by the <App> tests in Wave 4 Task 24).

import { describe, expect, it } from "vitest";
import {
  TICK_CEILING_MS,
  TICK_DEFAULT_MS,
  TICK_FLOOR_MS,
  clampTick,
  fasterTick,
  slowerTick,
} from "../src/cli/tui/state.js";

describe("tick rate constants + clamp", () => {
  it("default is 1000ms", () => {
    expect(TICK_DEFAULT_MS).toBe(1000);
  });
  it("floor is 100ms", () => {
    expect(TICK_FLOOR_MS).toBe(100);
  });
  it("ceiling is 10000ms", () => {
    expect(TICK_CEILING_MS).toBe(10000);
  });
  it("clamps below floor", () => {
    expect(clampTick(50)).toBe(TICK_FLOOR_MS);
    expect(clampTick(0)).toBe(TICK_FLOOR_MS);
    expect(clampTick(-1)).toBe(TICK_FLOOR_MS);
  });
  it("clamps above ceiling", () => {
    expect(clampTick(20000)).toBe(TICK_CEILING_MS);
  });
  it("passes through values in range", () => {
    expect(clampTick(500)).toBe(500);
    expect(clampTick(1000)).toBe(1000);
  });
});

describe("fasterTick / slowerTick", () => {
  it("fasterTick halves and clamps", () => {
    expect(fasterTick(1000)).toBe(500);
    expect(fasterTick(200)).toBe(100);
    expect(fasterTick(100)).toBe(TICK_FLOOR_MS); // already at floor
    expect(fasterTick(50)).toBe(TICK_FLOOR_MS);
  });
  it("slowerTick doubles and clamps", () => {
    expect(slowerTick(1000)).toBe(2000);
    expect(slowerTick(5000)).toBe(TICK_CEILING_MS);
    expect(slowerTick(10000)).toBe(TICK_CEILING_MS);
  });
});
