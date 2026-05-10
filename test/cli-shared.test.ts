// Unit tests for the canonical multi-value-flag parser
// (`parseCsvFlag`) — the single source of truth for "this commander
// variadic flag accepts repeat OR comma-separated OR both" introduced
// by cli_audit_plurality_uniformity (v0.3).
//
// Behaviour contract (from the task note):
//   - undefined / [] → []
//   - single value (no comma)        → 1-element array, trimmed
//   - single value with commas       → split into N elements, trimmed
//   - many values (no commas)        → unchanged
//   - mixed (some with commas)       → flattened
//   - whitespace inside fragments    → trimmed
//   - empty fragments (`,,` or `''`) → dropped
//
// Idempotence is implicit: applying the helper twice is a no-op once
// the array has no embedded commas.

import { describe, expect, it } from "vitest";
import { parseCsvFlag, parseStatusesOption } from "../src/cli.js";

describe("parseCsvFlag", () => {
  it("undefined → []", () => {
    expect(parseCsvFlag(undefined)).toEqual([]);
  });

  it("[] → []", () => {
    expect(parseCsvFlag([])).toEqual([]);
  });

  it("['a'] → ['a']", () => {
    expect(parseCsvFlag(["a"])).toEqual(["a"]);
  });

  it("['a,b,c'] → ['a','b','c'] (CSV form)", () => {
    expect(parseCsvFlag(["a,b,c"])).toEqual(["a", "b", "c"]);
  });

  it("['a','b','c'] → ['a','b','c'] (repeated-flag form)", () => {
    expect(parseCsvFlag(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("['a,b','c'] → ['a','b','c'] (mixed form)", () => {
    expect(parseCsvFlag(["a,b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace inside fragments", () => {
    expect(parseCsvFlag(["  a , b ", "c , d "])).toEqual(["a", "b", "c", "d"]);
  });

  it("drops empty fragments (consecutive / leading / trailing commas + empty values)", () => {
    expect(parseCsvFlag(["a,,b"])).toEqual(["a", "b"]);
    expect(parseCsvFlag(["a,", "", ",b"])).toEqual(["a", "b"]);
  });

  it("is idempotent (applying twice = applying once)", () => {
    const once = parseCsvFlag(["a,b", "c"]);
    expect(parseCsvFlag(once)).toEqual(once);
  });
});

// parseStatusesOption: the multi-status flag parser used by
// `mu task list / task next / approve list --status` (per
// task_list_multi_status_union, v0.3). Composes parseCsvFlag with
// parseStatusOption + dedup; returns undefined for empty/missing
// ("no filter" semantics matching today's no-flag shape).
describe("parseStatusesOption", () => {
  it("undefined → undefined (no filter)", () => {
    expect(parseStatusesOption(undefined)).toBeUndefined();
  });

  it("[] → undefined (no filter; matches missing-flag shape)", () => {
    expect(parseStatusesOption([])).toBeUndefined();
  });

  it("['  '] → undefined (whitespace-only fragments dropped)", () => {
    expect(parseStatusesOption(["  "])).toBeUndefined();
  });

  it("single value → 1-element array (back-compat shape)", () => {
    expect(parseStatusesOption(["OPEN"])).toEqual(["OPEN"]);
  });

  it("case-insensitive: lowercase → canonical UPPER", () => {
    expect(parseStatusesOption(["open"])).toEqual(["OPEN"]);
  });

  it("CSV form: ['OPEN,CLOSED'] → ['OPEN','CLOSED']", () => {
    expect(parseStatusesOption(["OPEN,CLOSED"])).toEqual(["OPEN", "CLOSED"]);
  });

  it("repeat form: ['OPEN','CLOSED'] → ['OPEN','CLOSED']", () => {
    expect(parseStatusesOption(["OPEN", "CLOSED"])).toEqual(["OPEN", "CLOSED"]);
  });

  it("mixed form: ['OPEN,CLOSED','REJECTED'] → ['OPEN','CLOSED','REJECTED']", () => {
    expect(parseStatusesOption(["OPEN,CLOSED", "REJECTED"])).toEqual([
      "OPEN",
      "CLOSED",
      "REJECTED",
    ]);
  });

  it("dedups case-insensitively (open + OPEN → single OPEN)", () => {
    expect(parseStatusesOption(["open", "OPEN"])).toEqual(["OPEN"]);
  });

  it("preserves first-occurrence order on dedup", () => {
    expect(parseStatusesOption(["CLOSED,open", "closed"])).toEqual(["CLOSED", "OPEN"]);
  });

  it("throws UsageError naming the offending element", () => {
    expect(() => parseStatusesOption(["OPEN,RESOLVED"])).toThrow(/--status must be one of/);
    expect(() => parseStatusesOption(["OPEN,RESOLVED"])).toThrow(/RESOLVED/);
  });
});
