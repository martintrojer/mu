import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyQualifiedRef,
  parseCsvFlag,
  parseImpact,
  parseLines,
  parseNonNegativeInt,
  parsePositiveNumber,
  parseQualifiedRef,
  parseStatusOption,
  parseStatusesOption,
} from "../src/cli.js";
import { TASK_STATUSES } from "../src/tasks.js";

// Generators deliberately admit blank (whitespace-only) fragments so
// the throw-on-blank rule stays under test rather than being generated
// away. `hasBlankFragment` is the shared oracle for "should this input
// throw?" (docs/VOCABULARY.md § Empty vs blank flag fragments).
const safeFragment = fc
  .string({ minLength: 0, maxLength: 16 })
  .filter((s) => !s.includes("\u0000"));

/** True when any comma-fragment is non-empty but trims to empty — the
 *  exact condition parseCsvFlag rejects. Empty fragments (`"a,,b"`,
 *  `""`) are NOT blank; they are dropped. */
function hasBlankFragment(values: readonly string[] | undefined): boolean {
  if (!values) return false;
  return values.some((v) => v.split(",").some((f) => f.length > 0 && f.trim().length === 0));
}

function referenceCsv(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.flatMap((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

describe("CLI parser properties", () => {
  describe("parseCsvFlag", () => {
    it("matches the reference flatten/trim/drop-empty implementation on blank-free input", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          fc.pre(!hasBlankFragment(values));
          expect(parseCsvFlag(values)).toEqual(referenceCsv(values));
        }),
      );
    });

    it("throws UsageError exactly when a fragment is blank (whitespace-only)", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          if (hasBlankFragment(values)) {
            expect(() => parseCsvFlag(values)).toThrow(/blank \(whitespace-only\) value/);
          } else {
            expect(() => parseCsvFlag(values)).not.toThrow();
          }
        }),
      );
    });

    it("is idempotent once fragments contain no embedded commas", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          fc.pre(!hasBlankFragment(values));
          const once = parseCsvFlag(values);
          // Output is blank-free by construction, so a second pass can
          // never throw — that is what keeps the helper idempotent.
          expect(parseCsvFlag(once)).toEqual(once);
        }),
      );
    });

    it("never emits empty fragments or untrimmed fragments", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          fc.pre(!hasBlankFragment(values));
          for (const part of parseCsvFlag(values)) {
            expect(part).not.toBe("");
            expect(part).toBe(part.trim());
          }
        }),
      );
    });
  });

  describe("status parsers", () => {
    it("parseStatusOption accepts every status case-insensitively", () => {
      fc.assert(
        fc.property(fc.constantFrom(...TASK_STATUSES), fc.boolean(), (status, lower) => {
          expect(parseStatusOption(lower ? status.toLowerCase() : status)).toBe(status);
        }),
      );
    });

    it("parseStatusesOption dedups case-insensitively while preserving first occurrence order", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...TASK_STATUSES), { maxLength: 30 }),
          fc.array(fc.boolean(), { maxLength: 30 }),
          (statuses, lowerFlags) => {
            const raw = statuses.map((s, i) => (lowerFlags[i] ? s.toLowerCase() : s));
            const expected: string[] = [];
            for (const status of statuses) {
              if (!expected.includes(status)) expected.push(status);
            }
            expect(parseStatusesOption(raw)).toEqual(expected.length === 0 ? undefined : expected);
          },
        ),
      );
    });

    it("parseStatusesOption composes with CSV splitting", () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...TASK_STATUSES), { maxLength: 20 }), (statuses) => {
          const csv = statuses.join(",");
          const expected: string[] = [];
          for (const status of statuses) {
            if (!expected.includes(status)) expected.push(status);
          }
          expect(parseStatusesOption([csv])).toEqual(expected.length === 0 ? undefined : expected);
        }),
      );
    });

    // This property replaces a filter-based one that was the original
    // bug report. That version asserted "any string that isn't a status
    // makes parseStatusesOption throw" and was WRONG in three ways,
    // each surfacing only when fast-check happened to draw it:
    //
    //   " "      blank      — the reported bug: silently dropped.
    //   ","      separators — splits to two EMPTY fragments, correctly
    //                         dropped, so nothing throws. The filter
    //                         let it through because "," is not a
    //                         status name.
    //   "OPEN,"  artifact   — parses to a perfectly valid [OPEN].
    //
    // Filtering those out one at a time would keep the property
    // under-specified. Instead this is TOTAL: it derives the expected
    // outcome from the input for every draw, so there is nothing left
    // to be lucky about. `fc.pre` and generator filters are gone.
    it("parseStatusesOption throws exactly when a fragment is blank or not a status", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 6 }), (values) => {
          // Structurally-empty fragments are dropped and cannot cause
          // either failure mode, so the oracle ignores them too.
          const present = values.flatMap((v) => v.split(",")).filter((f) => f.length > 0);
          const anyBlank = present.some((f) => f.trim().length === 0);
          const anyNotAStatus = present.some(
            (f) =>
              f.trim().length > 0 &&
              !TASK_STATUSES.includes(f.trim().toUpperCase() as (typeof TASK_STATUSES)[number]),
          );

          if (anyBlank || anyNotAStatus) {
            expect(() => parseStatusesOption(values)).toThrow(
              /--status must be one of|blank \(whitespace-only\) value/,
            );
          } else {
            expect(() => parseStatusesOption(values)).not.toThrow();
          }
        }),
      );
    });

    it("a blank fragment is reported as blank even when a valid status precedes it", () => {
      expect(() => parseStatusesOption(["OPEN", " "])).toThrow(/blank \(whitespace-only\)/);
    });

    it("a blank --status fragment is a usage error, not a silently dropped one", () => {
      // bug_whitespace_status_fragment, the original counterexample.
      for (const blank of [" ", "  ", "\t", "\n"]) {
        expect(() => parseStatusesOption(["OPEN", blank])).toThrow(/blank \(whitespace-only\)/);
        expect(() => parseStatusesOption([blank])).toThrow(/blank \(whitespace-only\)/);
        expect(() => parseStatusesOption([`OPEN,${blank}`])).toThrow(/blank \(whitespace-only\)/);
      }
    });

    it("a non-blank invalid --status fragment still names the status list", () => {
      expect(() => parseStatusesOption(["OPEN", "nope"])).toThrow(/--status must be one of/);
    });

    it("structurally empty fragments stay dropped (trailing/double comma)", () => {
      // Empty is not blank: these are comma artifacts, not typos.
      expect(parseStatusesOption(["OPEN,"])).toEqual(["OPEN"]);
      expect(parseStatusesOption(["OPEN,,CLOSED"])).toEqual(["OPEN", "CLOSED"]);
      expect(parseStatusesOption([""])).toBeUndefined();
    });
  });

  describe("numeric parsers", () => {
    it("parseImpact accepts exactly integer strings in the 1..100 prefix range", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
          expect(parseImpact(String(n))).toBe(n);
        }),
      );
    });

    it("parseLines and parseNonNegativeInt accept non-negative integer strings", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => {
          expect(parseLines(String(n))).toBe(n);
          expect(parseNonNegativeInt(String(n))).toBe(n);
        }),
      );
    });

    it("parsePositiveNumber accepts positive finite decimal strings", () => {
      fc.assert(
        fc.property(fc.float({ min: Math.fround(0.001), max: 1_000_000, noNaN: true }), (n) => {
          fc.pre(Number.isFinite(n) && n > 0);
          expect(parsePositiveNumber(String(n))).toBeCloseTo(Number.parseFloat(String(n)));
        }),
      );
    });

    it("numeric parsers reject empty, negative, NaN, and obvious non-numeric strings", () => {
      const invalid = ["", " ", "-1", "NaN", "abc", "--", "."];
      for (const raw of invalid) {
        expect(() => parseImpact(raw)).toThrow();
        expect(() => parseLines(raw)).toThrow();
        expect(() => parseNonNegativeInt(raw)).toThrow();
      }
      for (const raw of ["", " ", "0", "-0.1", "NaN", "abc", "--", "."]) {
        expect(() => parsePositiveNumber(raw)).toThrow();
      }
    });

    it("documents current permissive prefix parsing for numeric options", () => {
      expect(parseImpact("10abc")).toBe(10);
      expect(parseLines("12.9")).toBe(12);
      expect(parseNonNegativeInt("7days")).toBe(7);
      expect(parsePositiveNumber("1.5days")).toBe(1.5);
    });
  });

  describe("qualified refs", () => {
    const refPart = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes("/"));

    it("bare refs stay bare", () => {
      fc.assert(
        fc.property(refPart, (name) => {
          expect(parseQualifiedRef(name)).toEqual({ name });
        }),
      );
    });

    it("qualified refs split on the first slash", () => {
      fc.assert(
        fc.property(refPart, refPart, fc.string({ maxLength: 10 }), (ws, name, suffix) => {
          const raw = `${ws}/${name}${suffix ? `/${suffix}` : ""}`;
          expect(parseQualifiedRef(raw)).toEqual({
            workstream: ws,
            name: raw.slice(ws.length + 1),
          });
        }),
      );
    });

    it("applyQualifiedRef fills missing workstream", () => {
      fc.assert(
        fc.property(refPart, refPart, (ws, name) => {
          const opts: { workstream?: string } = {};
          expect(applyQualifiedRef(`${ws}/${name}`, opts)).toBe(name);
          expect(opts.workstream).toBe(ws);
        }),
      );
    });

    it("applyQualifiedRef rejects conflicting explicit workstream", () => {
      fc.assert(
        fc.property(refPart, refPart, refPart, (ws, other, name) => {
          fc.pre(ws !== other);
          expect(() => applyQualifiedRef(`${ws}/${name}`, { workstream: other })).toThrow(
            /conflicts/,
          );
        }),
      );
    });
  });
});
