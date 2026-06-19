// Behaviour tests for the Tracks popup (TracksPopup, popups/tracks.tsx).
//
// Per test/_ink-render.ts + test/README.md: prefer mount-and-assert
// behaviour over readFileSync source-greps. Render the popup into a
// CaptureStream and drive the drill recursion:
//
//   list        → list of tracks                 (Enter drills)
//   drill       → list of tasks for focused track (Enter chains)
//   task-detail → notes timeline for focused task (LEAF; no chain)
//
// Coverage:
//   - export shape (still a function) — narrow import-graph guard
//   - list view renders the seeded track + its goal
//   - Enter bubbles onModeChange("drill") and drill renders the
//     track's tasks
//   - Enter again chains into the task-detail leaf, which shows the
//     focused task's note body
//   - Esc/q from the leaf backs out exactly ONE level (task-detail →
//     task-list), NOT all the way to the tracks list (mode stays
//     "drill"; onModeChange("list") is NOT called)
//   - Esc from the task-list drill bubbles onModeChange("list")

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TracksPopup } from "../src/cli/tui/popups/tracks.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { addNote, addTask } from "../src/tasks.js";
import { getParallelTracks } from "../src/tracks.js";
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
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-tracks-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

// Two goals sharing a prerequisite collapse into ONE track (diamond
// merge via union-find). The shared prerequisite carries a note so
// the task-detail leaf has a body to render.
async function seed(db: Db): Promise<WorkstreamSnapshot> {
  addTask(db, {
    workstream: "demo",
    localId: "shared_prereq",
    title: "Shared prerequisite",
    impact: 80,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "goal_a",
    title: "Goal A",
    impact: 90,
    effortDays: 1,
    blockedBy: ["shared_prereq"],
  });
  addTask(db, {
    workstream: "demo",
    localId: "goal_b",
    title: "Goal B",
    impact: 70,
    effortDays: 1,
    blockedBy: ["shared_prereq"],
  });
  addNote(db, "shared_prereq", "leaf note on shared_prereq", {
    workstream: "demo",
    author: "tester",
  });

  const tracks = getParallelTracks(db, "demo");
  return { workstreamName: "demo", tracks } as WorkstreamSnapshot;
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
    createElement(TracksPopup, {
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

describe("TracksPopup — export shape", () => {
  it("is exported as a function", () => {
    expect(typeof TracksPopup).toBe("function");
  });
});

describe("TracksPopup — list view", () => {
  it("renders the merged track and its goal names", async () => {
    const db = fixtureDb();
    const snapshot = await seed(db);
    // Diamond merge: goal_a + goal_b share shared_prereq → one track.
    expect(snapshot.tracks.length).toBe(1);

    const { stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);
    const frame = latestRenderedFrame(stdout).join("\n");

    expect(frame).toContain("Tracks · popup (1/1)");
    expect(frame).toContain("Track 1");
    // Both goal names surface (head ordering may vary; assert both).
    expect(frame).toContain("goal_a");
    expect(frame).toContain("goal_b");

    instance.unmount();
  });
});

describe("TracksPopup — drill recursion", () => {
  it("Enter on a track bubbles onModeChange('drill')", async () => {
    const db = fixtureDb();
    const snapshot = await seed(db);
    const modes: ("list" | "drill")[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      onModeChange: (m) => modes.push(m),
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "enter");
    expect(modes.at(-1)).toBe("drill");

    instance.unmount();
  });

  it("drill view renders the track's resolved tasks", async () => {
    const db = fixtureDb();
    const snapshot = await seed(db);

    const { stdout, instance } = mount({ db, snapshot, mode: "drill" });
    await waitForInkOutput(stdout);
    const frame = latestRenderedFrame(stdout).join("\n");

    // Track-drill task list shows the goals + the shared prereq.
    expect(frame).toContain("shared_prereq");
    expect(frame).toContain("goal_a");
    expect(frame).toContain("goal_b");

    instance.unmount();
  });

  it("Enter in the drill chains into the task-detail leaf showing the note body", async () => {
    const db = fixtureDb();
    const snapshot = await seed(db);
    const modes: ("list" | "drill")[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      mode: "drill",
      onModeChange: (m) => modes.push(m),
    });
    await waitForInkOutput(stdout);

    // drillTasks are status-sorted then name-sorted. All three are
    // OPEN here, so the first row is the alphabetically-first id:
    // goal_a. Move the drill cursor to shared_prereq (the row whose
    // note we seeded) before chaining into the leaf.
    await simulateInput(stdin, "j"); // goal_a → goal_b
    await simulateInput(stdin, "j"); // goal_b → shared_prereq
    await simulateInput(stdin, "enter"); // chain into task-detail leaf
    await waitForInkOutput(stdout);

    const leafFrame = latestRenderedFrame(stdout).join("\n");
    // Leaf title pins to the focused task + the notes leaf.
    expect(leafFrame).toContain("shared_prereq");
    expect(leafFrame).toContain("notes");
    // The seeded note body renders in the leaf.
    expect(leafFrame).toContain("leaf note on shared_prereq");
    // Chaining into the leaf must NOT have flipped the popup back to
    // list mode — the App's mode stays "drill" the whole time.
    expect(modes).not.toContain("list");

    instance.unmount();
  });

  it("Esc from the task-detail leaf backs out exactly one level (NOT to tracks list)", async () => {
    const db = fixtureDb();
    const snapshot = await seed(db);
    const modes: ("list" | "drill")[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      mode: "drill",
      onModeChange: (m) => modes.push(m),
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "j");
    await simulateInput(stdin, "j"); // → shared_prereq
    await simulateInput(stdin, "enter"); // → task-detail leaf
    await waitForInkOutput(stdout);
    expect(latestRenderedFrame(stdout).join("\n")).toContain("leaf note on shared_prereq");

    // One Esc backs out task-detail → task-list, NOT all the way to
    // the tracks list: onModeChange("list") must NOT have fired.
    await simulateInput(stdin, "escape");
    await waitForInkOutput(stdout);
    const backFrame = latestRenderedFrame(stdout).join("\n");
    expect(backFrame).toContain("y yanks `mu task show`"); // task-list footer
    expect(backFrame).not.toContain("leaf note on shared_prereq");
    expect(modes).not.toContain("list");

    // A second Esc from the task-list now bubbles back to the App.
    await simulateInput(stdin, "escape");
    expect(modes.at(-1)).toBe("list");

    instance.unmount();
  });
});
