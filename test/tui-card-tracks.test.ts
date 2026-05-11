import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TracksCard } from "../src/cli/tui/cards/tracks.js";

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

describe("TracksCard", () => {
  it("is exported as a function", () => {
    expect(typeof TracksCard).toBe("function");
  });

  it("renders placeholder for null snapshot", () => {
    expect(TracksCard({ snapshot: null })).toBeTruthy();
  });

  it("renders empty state for no tracks", () => {
    expect(TracksCard({ snapshot: EMPTY_SNAPSHOT })).toBeTruthy();
  });
});

// feat_card_footer_inset: bottom-border inset replaces the in-body
// "+M more · …" line. Crude regex on the source is enough.
const SRC = readFileSync(
  fileURLToPath(new URL("../src/cli/tui/cards/tracks.tsx", import.meta.url)),
  "utf8",
);
describe("TracksCard source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(SRC).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(SRC).not.toMatch(/<Text[^>]*>[^<]*\+\$\{[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(SRC).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
