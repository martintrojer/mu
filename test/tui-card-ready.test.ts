import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";

const EMPTY_SNAPSHOT = {
  workstreamName: "demo",
  view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
};

describe("ReadyCard", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyCard).toBe("function");
  });

  it("renders placeholder for null snapshot", () => {
    expect(ReadyCard({ snapshot: null })).toBeTruthy();
  });

  it("renders empty state for no ready tasks", () => {
    expect(ReadyCard({ snapshot: EMPTY_SNAPSHOT })).toBeTruthy();
  });
});

// feat_card_footer_inset: the truncation hint is now inset into the
// bottom border via TitledBox.bottomLabel — the source MUST NOT
// render an in-body "+M more · …" line. Crude regex on the source
// is enough; the bottomLabel wire-up is asserted by tui-titled-box.
const SRC = readFileSync(
  fileURLToPath(new URL("../src/cli/tui/cards/ready.tsx", import.meta.url)),
  "utf8",
);
describe("ReadyCard source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(SRC).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(SRC).not.toMatch(/<Text[^>]*>[^<]*\+\$\{[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(SRC).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
