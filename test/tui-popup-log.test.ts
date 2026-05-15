// Tests for the Activity-log popup (popups/log.tsx).
//
// Behaviour-test conversion (tests_tui_convert_agents_log_recent):
// the prior version of this file leaned on `readFileSync` over
// `popups/log.tsx`. Those source-greps have been swapped for
// mount-and-assert tests built on the CaptureStream seam in
// test/_ink-render.ts. The popup itself touches the DB only via
// snapshot.recent (a plain LogRow[]), so we don't need to seed
// SQLite — we hand the popup an in-memory snapshot directly.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogPopup } from "../src/cli/tui/popups/log.js";
import { type Db, openDb } from "../src/db.js";
import type { LogRow } from "../src/logs.js";
import type { WorkstreamSnapshot } from "../src/state.js";
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
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-log-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function logRow(seq: number, payload: string, source = "system"): LogRow {
  return {
    seq,
    workstreamName: "demo",
    source,
    kind: "event",
    payload,
    createdAt: "2026-01-01T12:34:56.000Z",
  };
}

function snapshotWithEvents(events: LogRow[]): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
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
    recent: events,
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

interface MountOpts {
  db: Db;
  snapshot: WorkstreamSnapshot | null;
  mode?: "list" | "drill";
  yank?: (cmd: string) => Promise<void>;
  onClose?: () => void;
  onModeChange?: (mode: "list" | "drill") => void;
  rows?: number;
}

function mountLogPopup(opts: MountOpts): {
  stdin: InkInputStream;
  stdout: CaptureStream;
  unmount: () => void;
} {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: opts.rows ?? 24 });
  const instance = render(
    createElement(LogPopup, {
      yank: opts.yank ?? (async () => {}),
      onClose: opts.onClose ?? (() => {}),
      snapshot: opts.snapshot,
      mode: opts.mode ?? "list",
      onModeChange: opts.onModeChange ?? (() => {}),
      db: opts.db,
      workstream: "demo",
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  return { stdin, stdout, unmount: () => instance.unmount() };
}

describe("LogPopup (export contract)", () => {
  it("is exported as a function", () => {
    expect(typeof LogPopup).toBe("function");
  });
});

describe("LogPopup behaviour (mount + simulateInput)", () => {
  it("renders the empty-snapshot placeholder when snapshot.recent is empty", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([]);

    const { stdout, unmount } = mountLogPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("no events yet");
  });

  it("renders one row per event with the seq # and payload visible", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([
      logRow(101, "task add my_task title=hello", "system"),
      logRow(102, "agent spawn worker_1", "system"),
    ]);

    const { stdout, unmount } = mountLogPopup({ db, snapshot: snap });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    unmount();

    expect(text).toContain("#101");
    expect(text).toContain("#102");
    expect(text).toContain("my_task");
    expect(text).toContain("worker_1");
    // List title carries the (selected/total) cursor counter.
    expect(text).toMatch(/Activity log · popup \(1\/2\)/);
  });

  it("y on a `task ...` event yanks `mu task show <id>`", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([logRow(101, "task add my_task title=hi")]);
    const yank = vi.fn(async (_cmd: string) => {});

    const { stdin, stdout, unmount } = mountLogPopup({
      db,
      snapshot: snap,
      yank,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "y");
    unmount();

    expect(yank).toHaveBeenCalledTimes(1);
    expect(yank.mock.calls[0]?.[0]).toBe("mu task show my_task -w demo");
  });

  it("y on an `agent ...` event yanks `mu agent show <name>`", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([logRow(202, "agent spawn worker_42")]);
    const yank = vi.fn(async (_cmd: string) => {});

    const { stdin, stdout, unmount } = mountLogPopup({
      db,
      snapshot: snap,
      yank,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "y");
    unmount();

    expect(yank.mock.calls[0]?.[0]).toBe("mu agent show worker_42 -w demo");
  });

  it("Enter on a focused row asks the parent to flip into drill mode", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([logRow(303, "task add x")]);
    const onModeChange = vi.fn();

    const { stdin, stdout, unmount } = mountLogPopup({
      db,
      snapshot: snap,
      onModeChange,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "enter");
    unmount();

    expect(onModeChange).toHaveBeenCalledWith("drill");
  });

  it("drill mode renders the focused event payload and yanks `mu log --since <seq-1>`", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([
      logRow(500, "task note workstream_test very-long-payload-body"),
    ]);
    const yank = vi.fn(async (_cmd: string) => {});
    const onModeChange = vi.fn();

    const { stdin, stdout, unmount } = mountLogPopup({
      db,
      snapshot: snap,
      mode: "drill",
      yank,
      onModeChange,
    });
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");

    expect(text).toContain("very-long-payload-body");
    // Title carries the focused seq # in drill mode.
    expect(text).toContain("#500");

    await simulateInput(stdin, "y");
    expect(yank.mock.calls[0]?.[0]).toBe("mu log --since 499 -n 1 -w demo");

    await simulateInput(stdin, "escape");
    expect(onModeChange).toHaveBeenLastCalledWith("list");

    unmount();
  });

  it("Esc / q in list mode calls onClose", async () => {
    const db = fixtureDb();
    const snap = snapshotWithEvents([logRow(1, "task add x")]);
    const onClose = vi.fn();

    const { stdin, stdout, unmount } = mountLogPopup({
      db,
      snapshot: snap,
      onClose,
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "q");
    unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
