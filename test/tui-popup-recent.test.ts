// Tests for the Recent popup (popups/recent.tsx).
//
// Behaviour-test conversion (tests_tui_convert_agents_log_recent):
// the prior version of this file leaned heavily on `readFileSync`
// source-greps over `popups/recent.tsx`. Those have been swapped
// for mount-and-assert tests built on the CaptureStream seam in
// test/_ink-render.ts. Source-greps survive only for the small
// import-graph guard that pins App + keys wiring (a structural
// invariant, not a behaviour assertion).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { RecentPopup, formatRoi, yankCommandForTask } from "../src/cli/tui/popups/recent.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { addNote, addTask, listTasks, setTaskStatus } from "../src/tasks.js";
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

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-recent-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedRecentClosed(db: Db): void {
  // Three CLOSED tasks plus one OPEN one (which the popup must NOT
  // surface — the popup pulls only `snapshot.recentClosed`).
  for (const id of ["alpha", "beta", "gamma"]) {
    addTask(db, {
      workstream: "demo",
      localId: id,
      title: `Title ${id}`,
      impact: 50,
      effortDays: 1,
    });
    setTaskStatus(db, id, "CLOSED", { workstream: "demo", evidence: "done" });
  }
  addTask(db, {
    workstream: "demo",
    localId: "still_open",
    title: "Title still_open",
    impact: 50,
    effortDays: 1,
  });
}

function seedRecentClosedForFilter(db: Db): void {
  addTask(db, {
    workstream: "demo",
    localId: "target_recent",
    title: "needle1 shipped work",
    impact: 50,
    effortDays: 1,
  });
  setTaskStatus(db, "target_recent", "CLOSED", { workstream: "demo", evidence: "done" });
  db.prepare(
    `UPDATE tasks
        SET owner_id = (SELECT id FROM agents WHERE name = 'needle2_owner')
      WHERE local_id = 'target_recent'
        AND workstream_id = (SELECT id FROM workstreams WHERE name = 'demo')`,
  ).run();

  addTask(db, {
    workstream: "demo",
    localId: "noise_recent",
    title: "ordinary shipped work",
    impact: 50,
    effortDays: 1,
  });
  setTaskStatus(db, "noise_recent", "CLOSED", { workstream: "demo", evidence: "done" });
  db.prepare(
    `UPDATE tasks
        SET owner_id = (SELECT id FROM agents WHERE name = 'other_owner')
      WHERE local_id = 'noise_recent'
        AND workstream_id = (SELECT id FROM workstreams WHERE name = 'demo')`,
  ).run();
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

function mountRecentPopup(opts: MountOpts): {
  stdin: InkInputStream;
  stdout: CaptureStream;
  unmount: () => void;
} {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: opts.rows ?? 24 });
  const instance = render(
    createElement(RecentPopup, {
      yank: opts.yank ?? (async () => {}),
      onClose: opts.onClose ?? (() => {}),
      snapshot: opts.snapshot,
      fastTickNonce: 0,
      mode: opts.mode ?? "list",
      onModeChange: opts.onModeChange ?? (() => {}),
      db: opts.db,
      workstream: opts.snapshot.workstreamName,
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  return { stdin, stdout, unmount: () => instance.unmount() };
}

function snapshotFor(db: Db): WorkstreamSnapshot {
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
    recentClosed: listTasks(db, "demo").filter((t) => t.status === "CLOSED"),
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

describe("RecentPopup (export contract)", () => {
  it("is exported as a function", () => {
    expect(typeof RecentPopup).toBe("function");
  });
});

describe("yankCommandForTask", () => {
  it("yanks `mu task open <id> -w <ws>`", () => {
    expect(yankCommandForTask("design_x", "tui-impl")).toBe("mu task open design_x -w tui-impl");
  });

  it("matches the CLOSED branch of the Tasks popup yank matrix", () => {
    // Stay consistent with popups/ready.tsx so the operator's
    // muscle memory transfers. The Tasks popup yields exactly this
    // shape for CLOSED rows (re-open is the typical act-intent).
    const cmd = yankCommandForTask("foo", "bar");
    expect(cmd).toContain("mu task open");
    expect(cmd).not.toContain("mu task close");
    expect(cmd).not.toContain("mu task release");
    expect(cmd).not.toContain("mu task claim");
    expect(cmd).not.toContain("--evidence");
  });
});

describe("formatRoi", () => {
  it("returns rounded integer for finite ROI", () => {
    expect(formatRoi(60, 0.2)).toBe("300");
    expect(formatRoi(75, 1)).toBe("75");
    expect(formatRoi(50, 3)).toBe("17");
  });

  it("returns ∞ for zero / negative effortDays", () => {
    expect(formatRoi(60, 0)).toBe("∞");
    expect(formatRoi(60, -1)).toBe("∞");
  });
});

async function typeCommittedFilter(stdin: InkInputStream, query: string): Promise<void> {
  await simulateInput(stdin, "/");
  for (const char of query) await simulateInput(stdin, char);
  await simulateInput(stdin, "enter");
}

async function renderFilteredRecent(query: string): Promise<string> {
  const db = fixtureDb();
  insertAgent(db, {
    name: "needle2_owner",
    workstream: "demo",
    paneId: "%201",
    status: "free",
  });
  insertAgent(db, {
    name: "other_owner",
    workstream: "demo",
    paneId: "%202",
    status: "free",
  });
  seedRecentClosedForFilter(db);
  const snap = snapshotFor(db);
  const { stdin, stdout, unmount } = mountRecentPopup({ db, snapshot: snap });
  await waitForInkOutput(stdout);
  await typeCommittedFilter(stdin, query);
  await waitForInkOutput(stdout);
  const text = latestRenderedFrame(stdout).join("\n");
  unmount();
  return text;
}

describe("RecentPopup behaviour (mount + simulateInput)", () => {
  it("renders only snapshot.recentClosed rows (not OPEN tasks)", async () => {
    const db = fixtureDb();
    seedRecentClosed(db);
    const snap = snapshotFor(db);

    const { stdout, unmount } = mountRecentPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
    expect(text).not.toContain("still_open");
    // Title tracks the cursor position in the visible list.
    expect(text).toMatch(/Recent · popup \(1\/3\)/);
  });

  it("j/k move the cursor; selection drives the yanked id", async () => {
    const db = fixtureDb();
    seedRecentClosed(db);
    const snap = snapshotFor(db);
    const yank = vi.fn(async (_cmd: string) => {});

    const { stdin, stdout, unmount } = mountRecentPopup({
      db,
      snapshot: snap,
      yank,
    });
    await waitForInkOutput(stdout);

    // First yank → cursor at 0 → first recentClosed entry.
    await simulateInput(stdin, "y");
    const firstYank = yank.mock.calls[0]?.[0];
    expect(firstYank).toMatch(/^mu task open \w+ -w demo$/);
    const firstId = firstYank?.split(" ")[3];

    // Move down twice and yank again → different id.
    await simulateInput(stdin, "j");
    await simulateInput(stdin, "j");
    await simulateInput(stdin, "y");
    const secondYank = yank.mock.calls[1]?.[0];
    expect(secondYank).toMatch(/^mu task open \w+ -w demo$/);
    const secondId = secondYank?.split(" ")[3];

    expect(firstId).not.toBe(secondId);
    expect(["alpha", "beta", "gamma"]).toContain(firstId);
    expect(["alpha", "beta", "gamma"]).toContain(secondId);

    unmount();
  });

  it("'/' filter matches by title substring", async () => {
    const text = await renderFilteredRecent("needle1");

    expect(text).toContain("target_recent");
    expect(text).toContain("needle1 shipped work");
    expect(text).not.toContain("noise_recent");
    expect(text).not.toContain("ordinary shipped work");
  });

  it("'/' filter matches by owner substring", async () => {
    const text = await renderFilteredRecent("needle2");

    expect(text).toContain("target_recent");
    expect(text).not.toContain("noise_recent");
    expect(text).not.toContain("ordinary shipped work");
  });

  it("Enter on a row asks the parent to flip into drill mode", async () => {
    const db = fixtureDb();
    seedRecentClosed(db);
    const snap = snapshotFor(db);
    const onModeChange = vi.fn();

    const { stdin, stdout, unmount } = mountRecentPopup({
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
    seedRecentClosed(db);
    const snap = snapshotFor(db);
    const onClose = vi.fn();

    const { stdin, stdout, unmount } = mountRecentPopup({
      db,
      snapshot: snap,
      onClose,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "q");
    unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drill mode renders task notes and yanks `mu task notes` (not `mu task open`)", async () => {
    const db = fixtureDb();
    seedRecentClosed(db);
    addNote(db, "alpha", "first note about alpha", {
      workstream: "demo",
      author: "tester",
    });
    const snap = snapshotFor(db);
    const yank = vi.fn(async (_cmd: string) => {});
    const onModeChange = vi.fn();

    const { stdin, stdout, unmount } = mountRecentPopup({
      db,
      snapshot: snap,
      mode: "drill",
      yank,
      onModeChange,
    });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");

    // Drill body must include the note content.
    expect(text).toContain("first note about alpha");
    // Title shifts to the focused task's notes view.
    expect(text).toContain("alpha");

    // 'y' in drill mode → yanks `mu task notes` (NOT `mu task open`).
    await simulateInput(stdin, "y");
    const cmd = yank.mock.calls[0]?.[0];
    expect(cmd).toBe("mu task notes alpha -w demo");

    // Esc in drill mode → asks the parent to flip back to list.
    await simulateInput(stdin, "escape");
    expect(onModeChange).toHaveBeenLastCalledWith("list");

    unmount();
  });

  it("renders an empty-state when there are no recently-closed tasks", async () => {
    const db = fixtureDb();
    // Only OPEN tasks: snapshot.recentClosed is empty.
    addTask(db, {
      workstream: "demo",
      localId: "open_only",
      title: "open only",
      impact: 50,
      effortDays: 1,
    });
    const snap = snapshotFor(db);

    const { stdout, unmount } = mountRecentPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("none recently closed");
  });
});

describe("popups/recent.tsx ↔ App / keys wiring (structural)", () => {
  // These are the load-bearing import-graph guards: keep them as
  // source-greps because they pin a wiring invariant across
  // module boundaries (App / layout / keys), not popup behaviour.
  it("App.tsx still renders RecentPopup for popup id 8", () => {
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    expect(app).toContain("RecentPopup");
    expect(app).toMatch(/8: RecentPopup/);
    const layout = readFileSync("./src/cli/tui/layout.ts", "utf-8");
    expect(layout).toMatch(/8:\s*\{[^}]*label:\s*"Recent"/);
  });

  it("keys.ts maps Shift+8 (*) to openPopup(8)", () => {
    const keys = readFileSync("./src/cli/tui/keys.ts", "utf-8");
    expect(keys).toMatch(/"\*":\s*8/);
    expect(keys).toMatch(/kind: "openPopup";[\s\S]*\b8\b/);
  });
});
