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
import { normalizeInheritedWorkstream, parseCsvFlag, parseStatusesOption } from "../src/cli.js";

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

  // bug_whitespace_status_fragment. EMPTY ("" pre-trim) is a comma
  // artifact or the documented clear-all sentinel, so it is dropped.
  // BLANK (non-empty pre-trim, empty post-trim) is a typo or quoting
  // accident that no operator means, so it is a usage error rather
  // than a silently narrower/wider result.
  it("rejects blank (whitespace-only) fragments as a usage error", () => {
    for (const blank of [" ", "  ", "\t", "\n", " \t "]) {
      expect(() => parseCsvFlag([blank])).toThrow(/blank \(whitespace-only\)/);
      expect(() => parseCsvFlag([`a,${blank}`])).toThrow(/blank \(whitespace-only\)/);
      expect(() => parseCsvFlag(["a", blank])).toThrow(/blank \(whitespace-only\)/);
    }
  });

  it("names the offending flag and the blank value in the message", () => {
    expect(() => parseCsvFlag([" "], "--status")).toThrow(/^--status got a blank/);
    expect(() => parseCsvFlag([" "], "-b/--by")).toThrow(/^-b\/--by got a blank/);
    // The value is quoted so a tab/space is visible in the message.
    expect(() => parseCsvFlag(["\t"], "--status")).toThrow(/"\\t"/);
  });

  it("still accepts a fragment with INTERNAL whitespace after trimming", () => {
    // Only entirely-blank fragments are rejected; padding is fine.
    expect(parseCsvFlag(["  a  ,  b  "])).toEqual(["a", "b"]);
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

  // bug_whitespace_status_fragment: a BLANK (whitespace-only) fragment
  // used to be dropped, so `--status "OPEN, "` silently widened to
  // no-filter and `--status " "` returned every task as though no
  // filter were given. It is now a usage error (exit 2). Structurally
  // EMPTY fragments are still dropped — see the test below.
  it("['  '] → UsageError (blank fragment is not a silent no-filter)", () => {
    expect(() => parseStatusesOption(["  "])).toThrow(/blank \(whitespace-only\)/);
  });

  it("['OPEN,'] → ['OPEN'] (structurally empty fragments still dropped)", () => {
    expect(parseStatusesOption(["OPEN,"])).toEqual(["OPEN"]);
    expect(parseStatusesOption([""])).toBeUndefined();
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

// normalizeInheritedWorkstream: subcommands that call optsWithGlobals()
// inherit the ROOT variadic `-w, --workstream <names...>`, so a
// root-position `mu -w ws task owned-by agent` hands them a string[]
// where a single workstream name is expected. This helper funnels
// either shape into a single name (or undefined) and rejects multiple.
// Guards finding_optswithglobals_can_pass_root.
describe("normalizeInheritedWorkstream", () => {
  it("undefined → undefined", () => {
    expect(normalizeInheritedWorkstream(undefined)).toBeUndefined();
  });

  it("plain string → unchanged (subcommand-position single-value form)", () => {
    expect(normalizeInheritedWorkstream("foo")).toBe("foo");
  });

  it("single-element array → single name (root-position variadic form)", () => {
    expect(normalizeInheritedWorkstream(["foo"])).toBe("foo");
  });

  it("empty array → undefined", () => {
    expect(normalizeInheritedWorkstream([])).toBeUndefined();
  });

  it("whitespace-only fragment → UsageError (was: silent undefined)", () => {
    expect(() => normalizeInheritedWorkstream(["  "])).toThrow(/blank \(whitespace-only\)/);
  });

  it("CSV string → single name when only one survives", () => {
    expect(normalizeInheritedWorkstream("foo,")).toBe("foo");
  });

  it("throws UsageError naming the count when multiple workstreams given", () => {
    expect(() => normalizeInheritedWorkstream(["foo", "bar"])).toThrow(
      /single workstream here \(got 2: foo, bar\)/,
    );
    expect(() => normalizeInheritedWorkstream(["foo,bar"])).toThrow(/got 2/);
  });
});
