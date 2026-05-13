// Behaviour tests for the Tasks popup (ReadyPopup, popups/ready.tsx).
//
// Per test/_ink-render.ts: prefer mount-and-assert behaviour over
// readFileSync source-greps. Render the popup into a CaptureStream
// and assert the visible frame + spy on the yank callback. The
// keymap dispatcher is covered separately via dispatchPopupKey in
// test/tui-keys.test.ts.
//
// Coverage:
//   - export shape (still a function)
//   - rendered list shows OPEN + IN_PROGRESS rows from the snapshot
//   - cursor moves with `j`; the focused yank command rotates with it
//   - `y` on a ready OPEN row yanks `mu task claim <id> -w <ws>`
//     (claim — not release — when ownerName is null)
//   - `y` on an IN_PROGRESS row yanks `mu task close <id> -w <ws>
//     --evidence "..."`
//   - Enter drills into TaskDetailDrill, which displays the focused
//     task's notes and bubbles `onModeChange("drill")` to the parent
//   - Esc out of drill bubbles `onModeChange("list")`

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import {
  type TaskRow,
  addNote,
  addTask,
  claimTask,
  listInProgress,
  listReady,
} from "../src/tasks.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-ready-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

interface SeedResult {
  ready: TaskRow[];
  inProgress: TaskRow[];
  snapshot: WorkstreamSnapshot;
}

async function seed(db: Db): Promise<SeedResult> {
  // Two ready (OPEN, no owner) and one IN_PROGRESS via --self claim
  // so the in-progress row has ownerName === null but status flips.
  addTask(db, {
    workstream: "demo",
    localId: "ready_a",
    title: "Ready A",
    impact: 90,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "ready_b",
    title: "Ready B",
    impact: 50,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "running_x",
    title: "Running X",
    impact: 70,
    effortDays: 1,
  });
  await claimTask(db, "running_x", { workstream: "demo", self: true });
  addNote(db, "running_x", "first note on running_x", { workstream: "demo", author: "tester" });

  const ready = listReady(db, "demo");
  const inProgress = listInProgress(db, "demo");
  return {
    ready,
    inProgress,
    snapshot: {
      workstreamName: "demo",
      ready,
      inProgress,
    } as WorkstreamSnapshot,
  };
}

interface MountOpts {
  db: Db;
  snapshot: WorkstreamSnapshot;
  mode?: "list" | "drill";
  onModeChange?: (mode: "list" | "drill") => void;
  onClose?: () => void;
  yank?: (cmd: string) => Promise<void>;
  rows?: number;
  columns?: number;
}

function mount(opts: MountOpts) {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({
    columns: opts.columns ?? 120,
    rows: opts.rows ?? 24,
  });
  const instance = render(
    createElement(ReadyPopup, {
      yank: opts.yank ?? (async () => {}),
      onClose: opts.onClose ?? (() => {}),
      snapshot: opts.snapshot,
      fastTickNonce: 0,
      mode: opts.mode ?? "list",
      onModeChange: opts.onModeChange ?? (() => {}),
      db: opts.db,
      workstream: "demo",
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  return { stdin, stdout, instance };
}

describe("ReadyPopup (Tasks popup) — export shape", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyPopup).toBe("function");
  });
});

describe("ReadyPopup — rendered list + yank matrix", () => {
  it("renders OPEN and IN_PROGRESS rows from the snapshot", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);

    const { stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);
    const frame = latestRenderedFrame(stdout).join("\n");

    // All three task ids surface in the list.
    expect(frame).toContain("ready_a");
    expect(frame).toContain("ready_b");
    expect(frame).toContain("running_x");
    // And both statuses surface (status column).
    expect(frame).toContain("OPEN");
    expect(frame).toContain("IN_PROGRESS");
    // Title shows total + cursor position (1/N at fresh mount).
    expect(frame).toContain("Tasks · popup (1/3)");

    instance.unmount();
  });

  it("y on a ready OPEN row yanks `mu task claim <id> -w <ws>`", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const yanks: string[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);

    // The first row in source order. snapshot.ready is sorted by ROI
    // desc — both demo rows have effort=1 so impact wins → ready_a (90).
    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe("mu task claim ready_a -w demo");

    instance.unmount();
  });

  it("j moves the cursor and the yanked command rotates with the focused row", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const yanks: string[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "j"); // move from row 0 → 1 (ready_b, OPEN)
    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe("mu task claim ready_b -w demo");

    await simulateInput(stdin, "j"); // move to row 2 (running_x, IN_PROGRESS)
    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe('mu task close running_x -w demo --evidence "..."');

    instance.unmount();
  });

  it("Enter on a focused row bubbles onModeChange('drill') to the App", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const modes: ("list" | "drill")[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      onModeChange: (m) => {
        modes.push(m);
      },
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "enter");
    expect(modes.at(-1)).toBe("drill");

    instance.unmount();
  });

  it("drill mode shows the task's notes and yanks `mu task notes <id>`", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const yanks: string[] = [];
    const modes: ("list" | "drill")[] = [];

    // Move cursor to running_x (which has a real note attached) before
    // entering drill mode. Mounting straight in mode="drill" focuses
    // the snapshot's first row; we want the row whose notes we know.
    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      yank: async (cmd) => {
        yanks.push(cmd);
      },
      onModeChange: (m) => {
        modes.push(m);
      },
    });
    await waitForInkOutput(stdout);
    await simulateInput(stdin, "j"); // → ready_b
    await simulateInput(stdin, "j"); // → running_x

    // Manually rerender into drill mode (App owns the mode flip; here
    // we drive it directly). The popup should display the task's notes.
    instance.rerender(
      createElement(ReadyPopup, {
        yank: async (cmd) => {
          yanks.push(cmd);
        },
        onClose: () => {},
        snapshot,
        fastTickNonce: 0,
        mode: "drill",
        onModeChange: (m) => {
          modes.push(m);
        },
        db,
        workstream: "demo",
      }),
    );
    await waitForInkOutput(stdout);

    const drillFrame = latestRenderedFrame(stdout).join("\n");
    // Drill title pins focus to the running_x task and notes leaf.
    expect(drillFrame).toContain("running_x");
    expect(drillFrame).toContain("notes");
    // The seeded note body shows up in the rendered drill body.
    expect(drillFrame).toContain("first note on running_x");

    // y in drill mode yanks the notes lookup command.
    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe("mu task notes running_x -w demo");

    // Esc bubbles back to list mode.
    await simulateInput(stdin, "escape");
    expect(modes.at(-1)).toBe("list");

    instance.unmount();
  });
});
