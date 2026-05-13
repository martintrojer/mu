import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POPUP_CHROME_TOP } from "../src/cli/tui/app.js";
import type { PopupActionEnvelope } from "../src/cli/tui/keys.js";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addTask } from "../src/tasks.js";
import { CaptureStream, createInkCaptureStream, createInkInputStream } from "./_ink-render.js";

let dir = "";
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tui-mouse-doubleclick-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  CaptureStream.cleanup();
});

describe("popup double-click actions", () => {
  it("setCursor focuses y - POPUP_CHROME_TOP before drill runs", async () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      addTask(db, {
        workstream: "demo",
        localId: `task_${i}`,
        title: `Task ${i}`,
        impact: 50,
        effortDays: 1,
      }),
    );
    const rowIndex = 5 - POPUP_CHROME_TOP;
    const drilled: string[] = [];
    let popupActions: PopupActionEnvelope[] = [];
    const stdout = createInkCaptureStream({ columns: 120, rows: 24 });
    const stdin = createInkInputStream();

    const instance = render(readyPopupElement({ db, tasks, popupActions, drilled }), {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    });

    popupActions = [{ seq: 1, action: { kind: "setCursor", index: rowIndex } }];
    instance.rerender(readyPopupElement({ db, tasks, popupActions, drilled }));
    await waitFor(() => expect(stdout.output).toContain(`Tasks · popup (${rowIndex + 1}/6)`));

    popupActions = [...popupActions, { seq: 2, action: { kind: "drill" } }];
    instance.rerender(readyPopupElement({ db, tasks, popupActions, drilled }));
    await waitFor(() => expect(drilled).toEqual(["drill"]));

    expect(stdout.output).toContain(`Tasks · popup (${rowIndex + 1}/6)`);
    expect(stdout.output).toContain("task_3");
    instance.unmount();
  });
});

function readyPopupElement(opts: {
  db: Db;
  tasks: TaskRow[];
  popupActions: PopupActionEnvelope[];
  drilled: string[];
}): JSX.Element {
  return createElement(ReadyPopup, {
    yank: async () => {},
    onClose: () => {},
    snapshot: snapshotWithReady(opts.tasks),
    fastTickNonce: 0,
    mode: "list",
    onModeChange: (mode: "list" | "drill") => {
      if (mode === "drill") opts.drilled.push(mode);
    },
    db: opts.db,
    workstream: "demo",
    popupActions: opts.popupActions,
  });
}

function snapshotWithReady(ready: TaskRow[]): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
    },
    tracks: [],
    ready,
    inProgress: [],
    blocked: [],
    recentClosed: [],
    allTasks: ready,
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}
