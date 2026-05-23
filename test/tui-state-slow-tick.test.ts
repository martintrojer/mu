import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOW_TICK_MS } from "../src/cli/tui/state.js";
import type { WorkstreamSnapshot, WorkstreamSnapshotSlowFields } from "../src/state.js";
import { mergeSnapshotFastSlow } from "../src/state.js";

function fastSnapshot(label: string): WorkstreamSnapshot {
  return {
    workstreamName: "ws",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
    },
    tracks: [],
    ready: [
      {
        name: `ready-${label}`,
        workstreamName: "ws",
        title: `Ready ${label}`,
        status: "OPEN",
        impact: 50,
        effortDays: 1,
        ownerName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    allTasks: [],
    workspaces: [
      {
        agentName: "worker-1",
        workstreamName: "ws",
        backend: "git",
        path: "/tmp/ws/worker-1",
        parentRef: "base",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

function slowFields(label: string): WorkstreamSnapshotSlowFields {
  return {
    view: {
      agents: [
        {
          name: `agent-${label}`,
          workstreamName: "ws",
          cli: "pi",
          paneId: "%1",
          status: "busy",
          role: "full-access",
          tab: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
    },
    workspaces: [
      {
        agentName: "worker-1",
        workstreamName: "ws",
        backend: "git",
        path: "/tmp/ws/worker-1",
        parentRef: "base",
        createdAt: "2026-01-01T00:00:00.000Z",
        commitsBehindMain: 3,
        dirty: true,
      },
    ],
    recentCommits: [
      {
        sha: `sha-${label}`,
        subject: `commit ${label}`,
        body: "",
        author: "tester",
        authorDate: "2026-01-01T00:00:00.000Z",
        relTime: "1s",
      },
    ],
    commitsBackend: "git",
    doctor: { checks: [{ name: `doctor-${label}`, status: "ok", detail: "ok" }], problemCount: 0 },
  };
}

describe("useDashboardSnapshot slow tier contract", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "src", "cli", "tui", "state.ts"), "utf8");

  it("defines a hardcoded 10s slow tick constant", () => {
    expect(SLOW_TICK_MS).toBe(10_000);
    expect(src).toMatch(/export const SLOW_TICK_MS = 10_000/);
  });

  it("fast interval calls the fast loader", () => {
    expect(src).toMatch(/loaders\.fast\(db, workstream, FAST_OPTS\)/);
    expect(src).toMatch(/setInterval\(\(\) => void tick\(\), tickMs\)/);
  });

  it("slow interval calls the slow loader", () => {
    expect(src).toMatch(/loaders\.slow\([\s\S]*?db,[\s\S]*?workstream,[\s\S]*?SLOW_OPTS/);
    expect(src).toMatch(/setInterval\(\(\) => void slowTick\(\), SLOW_TICK_MS\)/);
  });

  it("refresh nonce triggers both effects immediately", () => {
    expect(src).toMatch(/void refreshNonce;[\s\S]*?const tick = async/);
    expect(src).toMatch(/void refreshNonce;[\s\S]*?const slowTick = async/);
    expect(src).toMatch(/\[db,\s*workstream,\s*tickMs,\s*enabled,\s*refreshNonce,\s*loaders\]/);
    expect(src).toMatch(
      /\[db,\s*workstream,\s*enabled,\s*refreshNonce,\s*loaders,\s*publishNoopSlowTicks\]/,
    );
  });

  it("exposes fast and slow tick nonces for visible drill refresh", () => {
    expect(src).toMatch(/fastTickNonce:\s*number/);
    expect(src).toMatch(/slowTickNonce:\s*number/);
    expect(src).toMatch(/const \[fastTickNonce, setFastTickNonce\] = useState\(0\)/);
    expect(src).toMatch(/const \[slowTickNonce, setSlowTickNonce\] = useState\(0\)/);
    expect(src).toMatch(
      /publishSnapshot\(fresh, setData, publishedKeyRef, errorRef\)[\s\S]*?setLastTickMs\(dur\);[\s\S]*?setFastTickNonce\(\(n\) => n \+ 1\)/,
    );
    expect(src).toMatch(
      /const changed =[\s\S]*?publishSnapshot\(mergeSnapshotFastSlow\(fast, slow\), setData, publishedKeyRef, errorRef\)[\s\S]*?changed \|\| \(fast !== null && publishNoopSlowTicks\)[\s\S]*?setSlowTickNonce\(\(n\) => n \+ 1\)/,
    );
    expect(src).toMatch(
      /return \{ data: data\.data, fastTickNonce, slowTickNonce, lastTickMs, error: data\.error \}/,
    );
  });

  it("workstream switch clears cached slow values", () => {
    expect(src).toMatch(/slowRef\.current = null/);
    expect(src).toMatch(/latestFastRef\.current = null/);
    expect(src).toMatch(/setData\s*\(\s*\{\s*data:\s*null/);
  });

  it("slow subprocess values persist across fast ticks by merge", () => {
    const slow = slowFields("s1");
    const first = mergeSnapshotFastSlow(fastSnapshot("f1"), slow);
    const second = mergeSnapshotFastSlow(fastSnapshot("f2"), slow);

    expect(first.recentCommits[0]?.sha).toBe("sha-s1");
    expect(second.ready[0]?.name).toBe("ready-f2");
    expect(second.recentCommits[0]?.sha).toBe("sha-s1");
    expect(second.workspaces[0]?.dirty).toBe(true);
    expect(second.view.agents[0]?.name).toBe("agent-s1");
  });
});
