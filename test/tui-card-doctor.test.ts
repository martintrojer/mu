// Tests for src/cli/tui/cards/doctor.tsx (feat_card_9_doctor,
// workstream `tui-impl`).

import { describe, expect, it } from "vitest";
import {
  DoctorCard,
  colorForStatus,
  formatSubtitle,
  glyphFor,
} from "../src/cli/tui/cards/doctor.js";
import type { DoctorCheck, DoctorSummary } from "../src/doctor-summary.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { expectTextAbsent, expectTextOnce, renderCardToText } from "./_card-render.js";

const EMPTY_VIEW = {
  agents: [],
  orphans: [],
  report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" as const },
};

const HEALTHY_DOCTOR: DoctorSummary = {
  checks: [
    { name: "schema", status: "ok", detail: "33 tables" },
    { name: "schema_version", status: "ok", detail: "7" },
    { name: "journal_mode", status: "ok", detail: "wal" },
    { name: "foreign_keys", status: "ok", detail: "on" },
  ],
  problemCount: 0,
};

const PROBLEMS_DOCTOR: DoctorSummary = {
  checks: [
    { name: "schema", status: "ok", detail: "33 tables" },
    { name: "schema_version", status: "ok", detail: "7" },
    { name: "journal_mode", status: "warn", detail: "delete (expected wal)" },
    { name: "foreign_keys", status: "ok", detail: "on" },
    { name: "agents", status: "warn", detail: "2 ghost panes; run `mu agent list`" },
    { name: "panes", status: "ok", detail: "no orphan panes" },
    { name: "workspaces", status: "fail", detail: "1 orphan dir; run `mu workspace orphans`" },
  ],
  problemCount: 3,
};

function snap(doctor: DoctorSummary | null): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: EMPTY_VIEW,
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    doctor,
  };
}

describe("DoctorCard", () => {
  it("is exported as a function", () => {
    expect(typeof DoctorCard).toBe("function");
  });

  it("renders the loading title row for null snapshot and missing doctor summary", () => {
    for (const snapshot of [null, snap(null)] as const) {
      const text = renderCardToText(DoctorCard({ snapshot }));
      expect(text).toContain("Doctor");
      expect(text).toContain("loading…");
    }
  });

  it("renders title subtitle and all-healthy line when problemCount === 0", () => {
    const text = renderCardToText(DoctorCard({ snapshot: snap(HEALTHY_DOCTOR) }));
    expect(text).toContain("Doctor");
    expect(text).toContain("all healthy");
    expect(text).toContain("✓");
    expect(text).toContain("4 checks");
  });

  it("renders title subtitle plus every non-OK check and glyph exactly once", () => {
    const text = renderCardToText(DoctorCard({ snapshot: snap(PROBLEMS_DOCTOR) }));
    expect(text).toContain("Doctor");
    expect(text).toContain("3");
    for (const [name, detail] of [
      ["journal_mode", "delete (expected wal)"],
      ["agents", "2 ghost panes; run `mu agent list`"],
      ["workspaces", "1 orphan dir; run `mu workspace orphans`"],
    ] as const) {
      expectTextOnce(text, name);
      expectTextOnce(text, detail);
    }
    expect(text.split("warn").length - 1).toBe(2);
    expectTextOnce(text, "fail");
    expectTextOnce(text, "✗");
    expect(text.split("⚠").length - 1).toBe(2);
    expectTextAbsent(text, "schema_version");
    expectTextAbsent(text, "foreign_keys");
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+9'", () => {
    const checks = Array.from({ length: 10 }, (_, i): DoctorCheck => {
      const n = i + 1;
      return { name: `check_${n}`, status: n % 2 === 0 ? "fail" : "warn", detail: `detail ${n}` };
    });
    const doctor: DoctorSummary = { checks, problemCount: checks.length };
    const text = renderCardToText(DoctorCard({ snapshot: snap(doctor) }));

    expect(text).toContain("+2 more · Shift+9");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `check_${i}`);
    expectTextAbsent(text, "check_9");
    expectTextAbsent(text, "check_10");
  });
});

describe("DoctorCard pure helpers", () => {
  it.each([
    ["fail", "✗"],
    ["warn", "⚠"],
    ["ok", "✓"],
  ] as const)("glyphFor(%s) → %s", (status, glyph) => {
    expect(glyphFor({ status })).toBe(glyph);
  });

  it("glyphFor: glyphs are short single-codepoint strings", () => {
    for (const s of ["fail", "warn", "ok"] as const) {
      const g = glyphFor({ status: s });
      expect(typeof g).toBe("string");
      expect(g.length).toBeGreaterThan(0);
      expect(g.length).toBeLessThanOrEqual(4);
    }
  });

  it.each([
    ["fail", "red"],
    ["warn", "yellow"],
    ["ok", "green"],
  ] as const)("colorForStatus(%s) → %s", (status, color) => {
    expect(colorForStatus(status)).toBe(color);
  });

  it("formatSubtitle: 0 problems → 'all healthy'", () => {
    expect(formatSubtitle(0)).toBe("all healthy");
  });

  it("formatSubtitle: N>0 problems → just the count", () => {
    expect(formatSubtitle(1)).toBe("1");
    expect(formatSubtitle(3)).toBe("3");
    expect(formatSubtitle(99)).toBe("99");
  });

  it("DoctorCheck shape stays compatible with the SDK type", () => {
    const c: DoctorCheck = { name: "schema", status: "ok", detail: "ok" };
    expect(c.name).toBe("schema");
  });
});

// feat_card_footer_inset: bottom-border inset replaces the in-body
// "+M more · …" line. Crude regex on the source is enough.
import { readFileSync as _readFileSync_doctor } from "node:fs";
import { fileURLToPath as _fileURLToPath_doctor } from "node:url";
const _SRC_doctor = _readFileSync_doctor(
  _fileURLToPath_doctor(new URL("../src/cli/tui/cards/doctor.tsx", import.meta.url)),
  "utf8",
);
describe("doctor.tsx source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(_SRC_doctor).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(_SRC_doctor).not.toMatch(/<Text[^>]*>[^<]*\+\${[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(_SRC_doctor).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
