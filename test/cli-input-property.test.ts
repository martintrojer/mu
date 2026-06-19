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

const safeFragment = fc
  .string({ minLength: 0, maxLength: 16 })
  .filter((s) => !s.includes("\u0000"));

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
    it("matches the reference flatten/trim/drop-empty implementation", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          expect(parseCsvFlag(values)).toEqual(referenceCsv(values));
        }),
      );
    });

    it("is idempotent once fragments contain no embedded commas", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
          const once = parseCsvFlag(values);
          expect(parseCsvFlag(once)).toEqual(once);
        }),
      );
    });

    it("never emits empty fragments or untrimmed fragments", () => {
      fc.assert(
        fc.property(fc.array(safeFragment, { maxLength: 20 }), (values) => {
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

    it("parseStatusesOption rejects invalid fragments", () => {
      fc.assert(
        fc.property(
          fc
            .string({ minLength: 1, maxLength: 12 })
            .filter(
              (s) => !TASK_STATUSES.includes(s.toUpperCase() as (typeof TASK_STATUSES)[number]),
            ),
          (invalid) => {
            expect(() => parseStatusesOption(["OPEN", invalid])).toThrow(/--status must be one of/);
          },
        ),
      );
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
