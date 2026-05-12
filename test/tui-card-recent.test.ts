// Tests for src/cli/tui/cards/recent.tsx (feat_card_8_recent,
// workstream `tui-impl`).

import { describe, expect, it } from "vitest";
import {
  RecentCard,
  ageMs,
  formatSubtitle,
  formatWhen,
  glyphFor,
} from "../src/cli/tui/cards/recent.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { expectTextAbsent, expectTextOnce, renderCardToText } from "./_card-render.js";

const EMPTY_SNAPSHOT: WorkstreamSnapshot = {
  workstreamName: "demo",
  view: {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
  },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
  doctor: null,
};

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: "feat_card_5",
    workstreamName: "demo",
    title: "FEAT: Card 5 — Workspaces",
    status: "CLOSED",
    impact: 50,
    effortDays: 1,
    ownerName: "worker-3",
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("RecentCard", () => {
  it("is exported as a function", () => {
    expect(typeof RecentCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(RecentCard({ snapshot: null }));
    expect(text).toContain("Recent");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(RecentCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Recent");
    expect(text).toContain("(none recently closed)");
  });

  it("renders title subtitle plus every task name/status/glyph exactly once", () => {
    const snapshot: WorkstreamSnapshot = {
      ...EMPTY_SNAPSHOT,
      recentClosed: [
        task({ name: "feat_card_5", title: "FEAT: Card 5 — Workspaces" }),
        task({ name: "feat_card_6", title: "FEAT: Card 6 — In-progress" }),
        task({ name: "feat_card_7", title: "FEAT: Card 7 — Blocked" }),
      ],
    };

    const text = renderCardToText(RecentCard({ snapshot }));
    expect(text).toContain("Recent");
    expect(text).toContain("3 · last");
    for (const [name, title] of [
      ["feat_card_5", "FEAT: Card 5 — Workspaces"],
      ["feat_card_6", "FEAT: Card 6 — In-progress"],
      ["feat_card_7", "FEAT: Card 7 — Blocked"],
    ] as const) {
      expectTextOnce(text, name);
      expectTextOnce(text, title);
    }
    expect(text.split("CLOSED").length - 1).toBe(3);
    expect(text.split("✓").length - 1).toBe(3);
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+8'", () => {
    const recentClosed = Array.from({ length: 10 }, (_, i) =>
      task({ name: `recent_${i + 1}`, title: `Recent ${i + 1}` }),
    );
    const text = renderCardToText(RecentCard({ snapshot: { ...EMPTY_SNAPSHOT, recentClosed } }));

    expect(text).toContain("+2 more · Shift+8");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `recent_${i}`);
    expectTextAbsent(text, "recent_9");
    expectTextAbsent(text, "recent_10");
  });
});

describe("RecentCard pure helpers", () => {
  it("glyphFor: every recently-closed row gets the heavy check glyph", () => {
    // Argumentless per review_dead_code_glyph_for_unused: the glyph
    // never depended on the row, so the previous TaskRow parameter
    // was an anticipatory abstraction (AGENTS.md ban).
    const g = glyphFor();
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
    expect(g).toBe("✓");
  });

  it("glyphFor: takes no arguments (review_dead_code_glyph_for_unused)", () => {
    expect(glyphFor.length).toBe(0);
  });

  it("ageMs: returns the delta against `now`, never negative", () => {
    const t = task({ updatedAt: "2026-05-11T00:00:00Z" });
    const now = Date.parse("2026-05-11T00:01:30Z"); // +90s
    expect(ageMs(t, now)).toBe(90_000);
    expect(ageMs(t, Date.parse("2026-05-10T23:59:00Z"))).toBe(0);
  });

  it("ageMs: returns null when updatedAt is unparseable", () => {
    expect(ageMs(task({ updatedAt: "not-a-date" }), Date.now())).toBeNull();
  });

  it("formatWhen: short relative-time tokens with `ago` suffix", () => {
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen(undefined)).toBe("—");
    expect(formatWhen(0)).toBe("0s ago");
    expect(formatWhen(45_000)).toBe("45s ago");
    expect(formatWhen(60_000)).toBe("1m ago");
    expect(formatWhen(15 * 60_000)).toBe("15m ago");
    expect(formatWhen(60 * 60_000)).toBe("1h ago");
    expect(formatWhen(5 * 60 * 60_000)).toBe("5h ago");
    expect(formatWhen(24 * 60 * 60_000)).toBe("1d ago");
    expect(formatWhen(7 * 24 * 60 * 60_000)).toBe("1w ago");
  });

  it("formatSubtitle: total only when no most-recent age", () => {
    expect(formatSubtitle(0, null)).toBe("0");
    expect(formatSubtitle(3, null)).toBe("3");
  });

  it("formatSubtitle: appends `last <when>` when most-recent age is present", () => {
    expect(formatSubtitle(3, 0)).toBe("3 · last 0s ago");
    expect(formatSubtitle(3, 90_000)).toBe("3 · last 1m ago");
    expect(formatSubtitle(7, 5 * 60 * 60_000)).toBe("7 · last 5h ago");
  });
});

// feat_card_footer_inset: bottom-border inset replaces the in-body
// "+M more · …" line. Crude regex on the source is enough.
import { readFileSync as _readFileSync_recent } from "node:fs";
import { fileURLToPath as _fileURLToPath_recent } from "node:url";
const _SRC_recent = _readFileSync_recent(
  _fileURLToPath_recent(new URL("../src/cli/tui/cards/recent.tsx", import.meta.url)),
  "utf8",
);
describe("recent.tsx source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(_SRC_recent).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(_SRC_recent).not.toMatch(/<Text[^>]*>[^<]*\+\${[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(_SRC_recent).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
