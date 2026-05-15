// Tests for the Agents popup (popups/agents.tsx).
//
// Behaviour-test conversion (tests_tui_convert_agents_log_recent):
// the prior version of this file was 24 lines of `readFileSync`
// source-greps over `popups/agents.tsx`. Those have been swapped
// for mount-and-assert tests built on the CaptureStream seam in
// test/_ink-render.ts. Drill mode shells out to `readAgent` which
// in turn calls `capturePane` — we install a tmux executor stub so
// the drill body comes from a deterministic in-memory buffer.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRow, insertAgent } from "../src/agents.js";
import { AgentsPopup } from "../src/cli/tui/popups/agents.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import {
  CaptureStream,
  type InkInputStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

let openDbs: Db[] = [];

beforeEach(() => {
  // Default executor for tests that do not override it: capture-pane
  // returns a deterministic scrollback string keyed by the pane id.
  setTmuxExecutor(async (args) => {
    const verb = args[0];
    if (verb === "capture-pane") {
      // -t <pane-id> sits at args[2].
      const paneId = args[2] ?? "?";
      return {
        exitCode: 0,
        stdout: `scrollback for pane ${paneId}\nline two\nline three`,
        stderr: "",
      };
    }
    if (verb === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
    return { exitCode: 1, stdout: "", stderr: `unmocked ${args.join(" ")}` };
  });
});

afterEach(() => {
  resetTmuxExecutor();
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-agents-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedAgents(db: Db): AgentRow[] {
  return [
    insertAgent(db, {
      name: "worker_1",
      workstream: "demo",
      paneId: "%101",
      status: "free",
      role: "full-access",
    }),
    insertAgent(db, {
      name: "worker_2",
      workstream: "demo",
      paneId: "%102",
      status: "busy",
      role: "read-only",
    }),
  ];
}

function snapshotFor(agents: AgentRow[]): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents,
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
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
  };
}

interface MountOpts {
  db: Db;
  snapshot: WorkstreamSnapshot;
  mode?: "list" | "drill";
  yank?: (cmd: string) => Promise<void>;
  onClose?: () => void;
  onModeChange?: (mode: "list" | "drill") => void;
  rows?: number;
}

function mountAgentsPopup(opts: MountOpts): {
  stdin: InkInputStream;
  stdout: CaptureStream;
  unmount: () => void;
} {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: opts.rows ?? 24 });
  const instance = render(
    createElement(AgentsPopup, {
      yank: opts.yank ?? (async () => {}),
      onClose: opts.onClose ?? (() => {}),
      snapshot: opts.snapshot,
      slowTickNonce: 0,
      mode: opts.mode ?? "list",
      onModeChange: opts.onModeChange ?? (() => {}),
      db: opts.db,
      workstream: opts.snapshot.workstreamName,
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  return { stdin, stdout, unmount: () => instance.unmount() };
}

describe("AgentsPopup (export contract)", () => {
  it("is exported as a function", () => {
    expect(typeof AgentsPopup).toBe("function");
  });
});

describe("AgentsPopup behaviour (mount + simulateInput)", () => {
  it("renders one row per agent in snapshot.view.agents (name + status visible)", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);

    const { stdout, unmount } = mountAgentsPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("worker_1");
    expect(text).toContain("worker_2");
    expect(text).toContain("free");
    expect(text).toContain("busy");
    // Title carries the (selected/total) cursor counter.
    expect(text).toMatch(/Agents · popup \(1\/2\)/);
  });

  it("default 'y' yanks `mu agent send <name> '...' -w <ws>` for the focused row", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);
    const yank = vi.fn(async (_cmd: string) => {});

    const { stdin, stdout, unmount } = mountAgentsPopup({
      db,
      snapshot: snap,
      yank,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "y");
    expect(yank.mock.calls[0]?.[0]).toBe("mu agent send worker_1 '...' -w demo");

    // j moves cursor to the next row, then 'y' yanks for that one.
    await simulateInput(stdin, "j");
    await simulateInput(stdin, "y");
    expect(yank.mock.calls[1]?.[0]).toBe("mu agent send worker_2 '...' -w demo");

    unmount();
  });

  it("verb keys 'f' / 'x' yank `mu agent free` / `mu agent close`", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);
    const yank = vi.fn(async (_cmd: string) => {});

    const { stdin, stdout, unmount } = mountAgentsPopup({
      db,
      snapshot: snap,
      yank,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "f");
    expect(yank.mock.calls[0]?.[0]).toBe("mu agent free worker_1 -w demo");

    await simulateInput(stdin, "x");
    expect(yank.mock.calls[1]?.[0]).toBe("mu agent close worker_1 -w demo");

    unmount();
  });

  it("Enter on a focused row asks the parent to flip into drill mode", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);
    const onModeChange = vi.fn();

    const { stdin, stdout, unmount } = mountAgentsPopup({
      db,
      snapshot: snap,
      onModeChange,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "enter");
    unmount();

    expect(onModeChange).toHaveBeenCalledWith("drill");
  });

  it("Esc / q in list mode calls onClose", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);
    const onClose = vi.fn();

    const { stdin, stdout, unmount } = mountAgentsPopup({
      db,
      snapshot: snap,
      onClose,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "q");
    unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drill mode loads scrollback via readAgent → capturePane and yanks `mu agent read`", async () => {
    const db = fixtureDb();
    const agents = seedAgents(db);
    const snap = snapshotFor(agents);
    const captures: string[][] = [];
    setTmuxExecutor(async (args) => {
      captures.push([...args]);
      if (args[0] === "capture-pane") {
        return {
          exitCode: 0,
          stdout: "drill-body-marker line A\ndrill-body-marker line B",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unmocked ${args.join(" ")}` };
    });

    const yank = vi.fn(async (_cmd: string) => {});
    const onModeChange = vi.fn();
    const { stdin, stdout, unmount } = mountAgentsPopup({
      db,
      snapshot: snap,
      mode: "drill",
      yank,
      onModeChange,
    });
    // Drill mode kicks off an async readAgent on mount; give it time.
    await new Promise((r) => setTimeout(r, 50));
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");

    // The tmux executor was invoked with capture-pane on the focused
    // pane id (worker_1 → %101).
    const pane = captures.find((c) => c[0] === "capture-pane");
    expect(pane).toBeDefined();
    expect(pane).toContain("%101");
    // The drilled body is visible in the rendered frame.
    expect(text).toContain("drill-body-marker line A");

    // 'y' in drill mode → yanks `mu agent read <name> -n 80 -w <ws>`.
    await simulateInput(stdin, "y");
    expect(yank.mock.calls[0]?.[0]).toBe("mu agent read worker_1 -n 80 -w demo");

    // Esc in drill mode → asks the parent to flip back to list.
    await simulateInput(stdin, "escape");
    expect(onModeChange).toHaveBeenLastCalledWith("list");

    unmount();
  });

  it("renders an empty-state when snapshot.view.agents is empty", async () => {
    const db = fixtureDb();
    const snap = snapshotFor([]);

    const { stdout, unmount } = mountAgentsPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("no agents");
  });
});
