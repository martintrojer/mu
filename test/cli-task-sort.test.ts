import { describe, expect, it } from "vitest";
import { TASK_SORT_KEYS, parseSortOption } from "../src/cli.js";

describe("parseSortOption", () => {
  it("accepts every key in TASK_SORT_KEYS verbatim", () => {
    for (const k of TASK_SORT_KEYS) {
      expect(parseSortOption(k)).toBe(k);
    }
  });

  it("rejects unknown keys with a UsageError naming every legal value", () => {
    expect(() => parseSortOption("priority")).toThrow(/--sort must be one of/);
    expect(() => parseSortOption("ROI")).toThrow(/--sort must be one of/);
    expect(() => parseSortOption("")).toThrow(/--sort must be one of/);
  });
});
