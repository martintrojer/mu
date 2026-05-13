// Tests for src/cli/tui/popups/workspaces.tsx (feat_popup_5_workspaces,
// workstream `tui-impl`).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { loadShowPreservingBody } from "../src/cli/tui/popups/show-loader.js";
import { WorkspacesPopup, colorForDirty, formatDirty } from "../src/cli/tui/popups/workspaces.js";
import { type Db, openDb, resolveWorkstreamId } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { WorkspaceRow } from "../src/workspace.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

const mockWorkspaceCommits = vi.hoisted(() => ({
  byAgent: new Map<
    string,
    Array<{
      sha: string;
      subject: string;
      body: string;
      author: string;
      authorDate: string;
      relTime: string;
    }>
  >(),
}));

const mockVcs = vi.hoisted(() => ({
  showText: "commit aaaaaaaaaaaa\n+ mocked workspace show body",
  showError: null as string | null,
  calls: [] as Array<{ path: string; sha: string }>,
}));

vi.mock("../src/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workspace.js")>();
  return {
    ...actual,
    listCommitsForWorkspace: vi.fn(
      async (_db: Db, agent: string, opts: { workstream: string }) => ({
        vcs: "git",
        baseRef: "base",
        workspacePath: `/tmp/${opts.workstream}/${agent}`,
        commits: mockWorkspaceCommits.byAgent.get(agent) ?? [],
      }),
    ),
  };
});

vi.mock("../src/vcs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs.js")>();
  return {
    ...actual,
    detectBackend: vi.fn(async (_path: string) => ({
      name: "git",
      showCommit: async (showPath: string, sha: string) => {
        mockVcs.calls.push({ path: showPath, sha });
        if (mockVcs.showError !== null) {
          return { text: "", truncated: false, error: mockVcs.showError };
        }
        return { text: mockVcs.showText, truncated: false };
      },
    })),
  };
});

const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const LAYOUT_SRC = readFileSync("./src/cli/tui/layout.ts", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const SRC = readFileSync("./src/cli/tui/popups/workspaces.tsx", "utf-8");
const originalStdoutColumns = process.stdout.columns;
let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  mockWorkspaceCommits.byAgent.clear();
  mockVcs.showText = "commit aaaaaaaaaaaa\n+ mocked workspace show body";
  mockVcs.showError = null;
  mockVcs.calls = [];
  Object.defineProperty(process.stdout, "columns", {
    value: originalStdoutColumns,
    configurable: true,
  });
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-workspaces-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function registerWorkspace(db: Db, workspace: WorkspaceRow): void {
  insertAgent(db, {
    name: workspace.agentName,
    workstream: workspace.workstreamName,
    paneId: `%${workspace.agentName}`,
    status: "needs_input",
  });
  const wsId = resolveWorkstreamId(db, workspace.workstreamName);
  const agent = db
    .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
    .get(workspace.agentName, wsId) as { id: number } | undefined;
  if (agent === undefined) throw new Error(`agent row missing: ${workspace.agentName}`);
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    wsId,
    workspace.backend,
    workspace.path,
    workspace.parentRef,
    workspace.createdAt,
  );
}

function workspace(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    agentName: "worker-1",
    workstreamName: "demo",
    backend: "git",
    path: "/tmp/demo/worker-1",
    parentRef: "abcdef0123456789",
    createdAt: "2026-05-11T00:00:00.000Z",
    commitsBehindMain: 0,
    dirty: false,
    ...over,
  };
}

function commit(
  over: Partial<{
    sha: string;
    subject: string;
    body: string;
    author: string;
    authorDate: string;
    relTime: string;
  }> = {},
) {
  return {
    sha: "aaaaaaaaaaaaaaaa",
    subject: "workspace commit",
    body: "",
    author: "tester",
    authorDate: "2026-05-11T00:00:00Z",
    relTime: "5m",
    ...over,
  };
}

function snapshot(over: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
  return {
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
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
    ...over,
  };
}

interface HarnessProps {
  db: Db;
  snapshot: WorkstreamSnapshot;
  yanked: string[];
  closed: { value: boolean };
}

function WorkspacesHarness({ db, snapshot, yanked, closed }: HarnessProps): JSX.Element {
  const [mode, setMode] = useState<"list" | "drill">("list");
  return createElement(WorkspacesPopup, {
    yank: async (command: string) => {
      yanked.push(command);
    },
    onClose: () => {
      closed.value = true;
    },
    snapshot,
    slowTickNonce: 0,
    mode,
    onModeChange: setMode,
    onFooter: () => {},
    db,
    workstream: "demo",
  });
}

async function renderWorkspacesPopup(
  db: Db,
  snapshotValue: WorkstreamSnapshot,
): Promise<{
  stdin: ReturnType<typeof createInkInputStream>;
  stdout: CaptureStream;
  yanked: string[];
  closed: { value: boolean };
  unmount: () => void;
}> {
  Object.defineProperty(process.stdout, "columns", { value: 150, configurable: true });
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 150, rows: 32 });
  const yanked: string[] = [];
  const closed = { value: false };
  const instance = render(
    createElement(WorkspacesHarness, { db, snapshot: snapshotValue, yanked, closed }),
    {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    },
  );
  await waitForInkOutput(stdout);
  return { stdin, stdout, yanked, closed, unmount: () => instance.unmount() };
}

function frameText(stdout: CaptureStream): string {
  return latestRenderedFrame(stdout).join("\n");
}

async function waitForFrame(stdout: CaptureStream, needle: string): Promise<string> {
  const deadline = Date.now() + 1000;
  let text = frameText(stdout);
  while (Date.now() < deadline) {
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = frameText(stdout);
  }
  throw new Error(`timed out waiting for ${needle}; last frame:\n${text}`);
}

async function typeFilter(
  stdin: ReturnType<typeof createInkInputStream>,
  query: string,
): Promise<void> {
  await simulateInput(stdin, "/");
  for (const ch of query) await simulateInput(stdin, ch);
  await simulateInput(stdin, "enter");
}

describe("WorkspacesPopup: export contract", () => {
  it("is exported as a function", () => {
    expect(typeof WorkspacesPopup).toBe("function");
  });

  it("re-uses card 5's pure colour/glyph helpers (no duplication)", () => {
    // Mirrors Card 5; the popup MUST import the four helpers rather
    // than re-derive them. Keeps the popup ↔ card visually in sync.
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("colorForGlyph");
    expect(SRC).toContain("colorForBehind");
    expect(SRC).toContain("formatBehind");
    expect(SRC).toMatch(/from\s+"\.\.\/cards\/workspaces\.js"/);
  });
});

describe("WorkspacesPopup: pure helpers", () => {
  describe("formatDirty", () => {
    it("yes when dirty", () => expect(formatDirty(true)).toBe("yes"));
    it("no when clean", () => expect(formatDirty(false)).toBe("no"));
    it("— when unknown (null)", () => expect(formatDirty(null)).toBe("—"));
    it("— when unknown (undefined)", () => expect(formatDirty(undefined)).toBe("—"));
  });
  describe("colorForDirty", () => {
    it("red when dirty", () => expect(colorForDirty(true)).toBe("red"));
    it("undefined when clean", () => expect(colorForDirty(false)).toBeUndefined());
    it("undefined when unknown", () => {
      expect(colorForDirty(null)).toBeUndefined();
      expect(colorForDirty(undefined)).toBeUndefined();
    });
  });
});

describe("WorkspacesPopup: behaviour", () => {
  it("renders workspaces, filters the list, and yanks the focused workspace path command", async () => {
    const db = fixtureDb();
    const rows = [
      workspace({ agentName: "worker-1", path: "/tmp/demo/worker-1", dirty: false }),
      workspace({
        agentName: "reviewer-1",
        path: "/tmp/demo/reviewer-1",
        backend: "git",
        parentRef: "feedfacecafebeef",
        commitsBehindMain: 12,
        dirty: true,
      }),
    ];
    const r = await renderWorkspacesPopup(db, snapshot({ workspaces: rows }));
    try {
      let text = frameText(r.stdout);
      expect(text).toContain("Workspaces · popup (1/2)");
      expect(text).toContain("worker-1");
      expect(text).toContain("reviewer-1");
      expect(text).toContain("/tmp/demo/worker-1");

      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["cd $(mu workspace path reviewer-1 -w demo)"]);

      await typeFilter(r.stdin, "dirty");
      text = await waitForFrame(r.stdout, "[filter] dirty");
      expect(text).toContain("reviewer-1");
      expect(text).toContain("yes");
      expect(text).not.toContain("worker-1");
    } finally {
      r.unmount();
    }
  });

  it("Enter drills into commits, Enter drills again into git show, and Esc backs out one level", async () => {
    const db = fixtureDb();
    const row = workspace({ agentName: "worker-1", path: "/tmp/demo/worker-1" });
    registerWorkspace(db, row);
    mockWorkspaceCommits.byAgent.set("worker-1", [
      commit({ sha: "aaaaaaaaaaaaaaaa", subject: "first workspace commit" }),
      commit({ sha: "bbbbbbbbbbbbbbbb", subject: "second workspace commit" }),
    ]);
    const r = await renderWorkspacesPopup(db, snapshot({ workspaces: [row] }));
    try {
      await simulateInput(r.stdin, "enter");
      let text = await waitForFrame(r.stdout, "second workspace commit");
      expect(text).toContain("Workspaces · worker-1 (commits since fork)");
      expect(text).toContain("bbbbbbbbbbbb");
      expect(text).toContain("aaaaaaaaaaaa");

      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["git show bbbbbbbbbbbbbbbb"]);

      await simulateInput(r.stdin, "enter");
      text = await waitForFrame(r.stdout, "+ mocked workspace show body");
      expect(text).toContain("Workspaces · git show bbbbbbbbbbbb");
      expect(text).toContain("git show bbbbbbbbbbbb (worker-1)");
      expect(mockVcs.calls).toEqual([{ path: "/tmp/demo/worker-1", sha: "bbbbbbbbbbbbbbbb" }]);

      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["git show bbbbbbbbbbbbbbbb", "git show bbbbbbbbbbbbbbbb"]);

      await simulateInput(r.stdin, "escape");
      text = await waitForFrame(r.stdout, "Workspaces · worker-1 (commits since fork)");
      expect(text).toContain("second workspace commit");
      expect(text).not.toContain("mocked workspace show body");
    } finally {
      r.unmount();
    }
  });

  it("filters the commits drill by sha + subject", async () => {
    const db = fixtureDb();
    const row = workspace({ agentName: "worker-1", path: "/tmp/demo/worker-1" });
    registerWorkspace(db, row);
    mockWorkspaceCommits.byAgent.set("worker-1", [
      commit({ sha: "aaaaaaaaaaaaaaaa", subject: "alpha feature" }),
      commit({ sha: "bbbbbbbbbbbbbbbb", subject: "beta fix" }),
    ]);
    const r = await renderWorkspacesPopup(db, snapshot({ workspaces: [row] }));
    try {
      await simulateInput(r.stdin, "enter");
      await waitForFrame(r.stdout, "beta fix");
      await typeFilter(r.stdin, "alpha");
      const text = await waitForFrame(r.stdout, "[filter] alpha");
      expect(text).toContain("aaaaaaaaaaaa");
      expect(text).toContain("alpha feature");
      expect(text).not.toContain("bbbbbbbbbbbb");
      expect(text).not.toContain("beta fix");
    } finally {
      r.unmount();
    }
  });
});

describe("WorkspacesPopup: Enter on focused commit drills into git show diff (feat_workspaces_drill_git_show)", () => {
  it("loadShow preserves the previous body while the backend refetch is pending", async () => {
    const states: string[] = [];
    let text = "previous diff body";
    let error: string | null = "old error";
    let loading = false;
    let resolveShow: ((value: { text: string; truncated: boolean }) => void) | undefined;
    const showPromise = new Promise<{ text: string; truncated: boolean }>((resolve) => {
      resolveShow = resolve;
    });

    const pending = loadShowPreservingBody(
      "/repo",
      "abc123",
      async () => ({
        showCommit: async () => showPromise,
      }),
      {
        setText: (next) => {
          text = next;
          states.push(`text:${next}`);
        },
        setError: (next) => {
          error = next;
          states.push(`error:${next ?? "null"}`);
        },
        setLoading: (next) => {
          loading = next;
          states.push(`loading:${String(next)}`);
        },
      },
    );

    await Promise.resolve();
    expect(loading).toBe(true);
    expect(error).toBeNull();
    expect(text).toBe("previous diff body");
    expect(states).not.toContain("text:");

    if (resolveShow === undefined) throw new Error("show promise was not captured");
    resolveShow({ text: "new diff body", truncated: false });
    await pending;

    expect(text).toBe("new diff body");
    expect(loading).toBe(false);
  });

  it("clears the body on an actual show error", async () => {
    let text = "previous diff body";
    let error: string | null = null;
    await loadShowPreservingBody(
      "/repo",
      "bad",
      async () => ({
        showCommit: async () => ({ text: "", truncated: false, error: "bad revision" }),
      }),
      {
        setText: (next) => {
          text = next;
        },
        setError: (next) => {
          error = next;
        },
        setLoading: () => {},
      },
    );

    expect(error).toBe("bad revision");
    expect(text).toBe("");
  });

  it("delegates git show through the shared VcsBackend.showCommit seam", () => {
    expect(SRC).not.toContain("node:child_process");
    expect(SRC).not.toMatch(/\bexecFile\b/);
  });

  it("show mode is popup-local (does NOT widen <App>'s PopupMode union)", () => {
    // Spec: "keep mode local to workspaces.tsx if PopupMode is
    // currently a union of 'list' | 'drill' only". The union must
    // stay binary; the third level rides on the local showSha
    // sentinel inside drill mode.
    expect(APP_SRC).toMatch(/export type PopupMode = "list" \| "drill";/);
    // The popup itself doesn't widen its accepted mode either.
    expect(SRC).toContain('mode: "list" | "drill"');
  });
});

describe("App ↔ keys wiring for popup 5", () => {
  it("app.tsx imports WorkspacesPopup", () => {
    expect(APP_SRC).toContain('from "./popups/workspaces.js"');
    expect(APP_SRC).toContain("WorkspacesPopup");
  });

  it("app.tsx POPUP_REGISTRY maps 5 → WorkspacesPopup", () => {
    expect(APP_SRC).toMatch(/5: WorkspacesPopup/);
  });

  it("layout.ts CARD_CONFIGS[5].label is 'Workspaces' (drives popupNameForId)", () => {
    // Post-review_tui_card_key_from_id_redundant: popupNameForId
    // reads CARD_CONFIGS[id].label instead of a 24-line switch.
    expect(LAYOUT_SRC).toMatch(/5:\s*\{[^}]*label:\s*"Workspaces"/);
  });

  it("app.tsx PopupId union includes 5", () => {
    // Match a regex so additional slot promotions (slot-7 popup,
    // slot-6 popup, ...) don't false-fire on the literal union.
    expect(APP_SRC).toMatch(/type PopupId = [^\n]*\b5\b[^\n]*null/);
  });

  it("keys.ts maps '%' → openPopup(5)", () => {
    // The glyph map should now include "%": 5 (not a placeholder
    // noop). Per the task brief KEYS WIRING block.
    expect(KEYS_SRC).toMatch(/"%":\s*5/);
  });
});
