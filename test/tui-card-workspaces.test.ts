// Tests for src/cli/tui/cards/workspaces.tsx (feat_card_5_workspaces,
// workstream `tui-impl`). ink-testing-library is not installable in
// this environment so we lean on:
//   - calling the FC as a plain function (catches import-graph drift),
//   - asserting on the pure helpers (glyph / colour / subtitle).
//
// Mirrors the test pattern of test/tui-card-agents.test.ts.

import { describe, expect, it } from "vitest";
import {
  WorkspacesCard,
  colorForBehind,
  colorForGlyph,
  formatBehind,
  formatSubtitle,
  glyphFor,
  isStale,
} from "../src/cli/tui/cards/workspaces.js";
import type { WorkspaceRow } from "../src/workspace.js";

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

function row(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    agentName: "worker-1",
    workstreamName: "demo",
    backend: "git",
    path: "/tmp/demo/worker-1",
    parentRef: "abc123def4567890",
    createdAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("WorkspacesCard", () => {
  it("is exported as a function", () => {
    expect(typeof WorkspacesCard).toBe("function");
  });

  it("renders a placeholder for null snapshot (loading state)", () => {
    const result = WorkspacesCard({ snapshot: null });
    expect(result).toBeTruthy();
  });

  it("renders the empty-state hint when no workspaces exist", () => {
    const result = WorkspacesCard({ snapshot: EMPTY_SNAPSHOT });
    expect(result).toBeTruthy();
  });

  it("renders rows for a populated workspaces list", () => {
    const result = WorkspacesCard({
      snapshot: {
        ...EMPTY_SNAPSHOT,
        workspaces: [
          row({ agentName: "worker-1", commitsBehindMain: 1, dirty: false }),
          row({ agentName: "worker-2", commitsBehindMain: 12, dirty: false }),
          row({ agentName: "worker-3", commitsBehindMain: 0, dirty: true }),
        ],
      },
    });
    expect(result).toBeTruthy();
  });
});

describe("WorkspacesCard pure helpers", () => {
  it("isStale: ≥10 commits behind ⇒ true; below ⇒ false; unknown ⇒ false", () => {
    expect(isStale(0)).toBe(false);
    expect(isStale(2)).toBe(false);
    expect(isStale(9)).toBe(false);
    expect(isStale(10)).toBe(true);
    expect(isStale(50)).toBe(true);
    expect(isStale(null)).toBe(false);
    expect(isStale(undefined)).toBe(false);
  });

  it("formatBehind: number ⇒ String(n); null/undefined ⇒ em-dash", () => {
    expect(formatBehind(0)).toBe("0");
    expect(formatBehind(7)).toBe("7");
    expect(formatBehind(null)).toBe("—");
    expect(formatBehind(undefined)).toBe("—");
  });

  it("colorForBehind: green ≤2, yellow 3-9, red ≥10, undefined ⇒ default", () => {
    expect(colorForBehind(0)).toBe("green");
    expect(colorForBehind(2)).toBe("green");
    expect(colorForBehind(3)).toBe("yellow");
    expect(colorForBehind(9)).toBe("yellow");
    expect(colorForBehind(10)).toBe("red");
    expect(colorForBehind(100)).toBe("red");
    expect(colorForBehind(null)).toBeUndefined();
    expect(colorForBehind(undefined)).toBeUndefined();
  });

  it("glyphFor: dirty wins over stale wins over clean", () => {
    // dirty + stale → dirty (★)
    expect(glyphFor(row({ dirty: true, commitsBehindMain: 50 }))).toBe("★");
    // dirty + fresh → dirty
    expect(glyphFor(row({ dirty: true, commitsBehindMain: 0 }))).toBe("★");
    // not-dirty + stale → ⓘ
    expect(glyphFor(row({ dirty: false, commitsBehindMain: 12 }))).toBe("ⓘ");
    // not-dirty + fresh → ✓
    expect(glyphFor(row({ dirty: false, commitsBehindMain: 0 }))).toBe("✓");
    // unknown dirty + fresh → ✓ (we still paint clean when staleness is fresh)
    expect(glyphFor(row({ dirty: undefined, commitsBehindMain: 0 }))).toBe("✓");
    // unknown dirty + stale → ⓘ
    expect(glyphFor(row({ dirty: null, commitsBehindMain: 50 }))).toBe("ⓘ");
  });

  it("colorForGlyph: dirty=red, stale=yellow, clean=green", () => {
    expect(colorForGlyph(row({ dirty: true }))).toBe("red");
    expect(colorForGlyph(row({ dirty: false, commitsBehindMain: 12 }))).toBe("yellow");
    expect(colorForGlyph(row({ dirty: false, commitsBehindMain: 0 }))).toBe("green");
  });

  it("formatSubtitle: zeros are suppressed; positives are joined with ' · '", () => {
    expect(formatSubtitle(0, 0, 0)).toBe("0");
    expect(formatSubtitle(3, 0, 0)).toBe("3");
    expect(formatSubtitle(3, 1, 0)).toBe("3 · 1 stale");
    expect(formatSubtitle(3, 0, 2)).toBe("3 · 2 dirty");
    expect(formatSubtitle(5, 1, 2)).toBe("5 · 1 stale · 2 dirty");
  });
});

// feat_card_footer_inset: bottom-border inset replaces the in-body
// "+M more · …" line. Crude regex on the source is enough.
import { readFileSync as _readFileSync_workspaces } from "node:fs";
import { fileURLToPath as _fileURLToPath_workspaces } from "node:url";
const _SRC_workspaces = _readFileSync_workspaces(
  _fileURLToPath_workspaces(new URL("../src/cli/tui/cards/workspaces.tsx", import.meta.url)),
  "utf8",
);
describe("workspaces.tsx source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(_SRC_workspaces).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(_SRC_workspaces).not.toMatch(/<Text[^>]*>[^<]*\+\${[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(_SRC_workspaces).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
