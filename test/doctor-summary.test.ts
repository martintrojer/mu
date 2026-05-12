// Tests for src/doctor-summary.ts (feat_card_9_doctor, workstream
// `tui-impl`). The summary is the SDK seam consumed by the TUI's
// slot-9 Doctor card; it slices the textual `mu doctor` checks into
// a per-tick-cheap structured shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { countProblems, loadDoctorSummary } from "../src/doctor-summary.js";
import type { WorkstreamSnapshot } from "../src/state.js";

const EMPTY_VIEW = {
  agents: [],
  orphans: [],
  report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" as const },
};

function emptySnapshot(over: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
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
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
    ...over,
  };
}

describe("loadDoctorSummary", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-summary-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* noop */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("on a fresh DB without a snapshot, every check passes", () => {
    const s = loadDoctorSummary(db, null);
    // schema, schema_version, journal_mode, foreign_keys (no
    // snapshot-derived rows since snapshot is null).
    expect(s.checks.length).toBe(4);
    expect(s.checks.every((c) => c.status === "ok")).toBe(true);
    expect(s.problemCount).toBe(0);
  });

  it("each fresh-DB check carries a non-empty detail string", () => {
    const s = loadDoctorSummary(db, null);
    for (const c of s.checks) {
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it("includes the four core DB checks by name", () => {
    const s = loadDoctorSummary(db, null);
    const names = new Set(s.checks.map((c) => c.name));
    expect(names.has("schema")).toBe(true);
    expect(names.has("schema_version")).toBe(true);
    expect(names.has("journal_mode")).toBe(true);
    expect(names.has("foreign_keys")).toBe(true);
  });

  it("when snapshot is provided, adds agents/panes/workspaces rows", () => {
    const s = loadDoctorSummary(db, emptySnapshot());
    const names = new Set(s.checks.map((c) => c.name));
    expect(names.has("agents")).toBe(true);
    expect(names.has("panes")).toBe(true);
    expect(names.has("workspaces")).toBe(true);
    // 4 base + 3 snapshot-derived = 7 total
    expect(s.checks.length).toBe(7);
  });

  it("ghosts > 0 → agents row is warn with ghost count in detail", () => {
    const snap = emptySnapshot({
      view: {
        ...EMPTY_VIEW,
        report: { ...EMPTY_VIEW.report, prunedGhosts: 2 },
      },
    });
    const s = loadDoctorSummary(db, snap);
    const agents = s.checks.find((c) => c.name === "agents");
    expect(agents).toBeDefined();
    expect(agents?.status).toBe("warn");
    expect(agents?.detail).toMatch(/2 ghost panes/);
  });

  it("singular vs plural ghost-pane count uses pluralisation", () => {
    const oneGhost = emptySnapshot({
      view: { ...EMPTY_VIEW, report: { ...EMPTY_VIEW.report, prunedGhosts: 1 } },
    });
    const sOne = loadDoctorSummary(db, oneGhost);
    expect(sOne.checks.find((c) => c.name === "agents")?.detail).toMatch(/1 ghost pane;/);
  });

  it("workspace orphan dirs surface as a workspaces warn row", () => {
    const snap = emptySnapshot({
      workspaceOrphans: [
        // shape per WorkspaceOrphan; only the array length matters
        // for the warn detection (cast loosely so we don't drag in
        // the full row schema for the test).
        { agentName: "lost-1", path: "/tmp/lost", dbExists: false } as never,
      ],
    });
    const s = loadDoctorSummary(db, snap);
    const ws = s.checks.find((c) => c.name === "workspaces");
    expect(ws?.status).toBe("warn");
    expect(ws?.detail).toMatch(/1 orphan dir/);
  });

  it("problemCount tracks the number of warn+fail rows", () => {
    const snap = emptySnapshot({
      view: { ...EMPTY_VIEW, report: { ...EMPTY_VIEW.report, prunedGhosts: 1 } },
      workspaceOrphans: [{ agentName: "x", path: "/tmp/x", dbExists: false } as never],
    });
    const s = loadDoctorSummary(db, snap);
    // agents (warn) + workspaces (warn) = 2; everything else ok.
    expect(s.problemCount).toBe(2);
  });
});

describe("countProblems", () => {
  it("returns 0 for an empty list", () => {
    expect(countProblems([])).toBe(0);
  });

  it("counts every non-OK row once", () => {
    expect(
      countProblems([
        { name: "a", status: "ok", detail: "" },
        { name: "b", status: "warn", detail: "" },
        { name: "c", status: "fail", detail: "" },
        { name: "d", status: "ok", detail: "" },
        { name: "e", status: "fail", detail: "" },
      ]),
    ).toBe(3);
  });
});
