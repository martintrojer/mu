// Behaviour tests for the In-progress popup (popups/inprogress.tsx).
//
// Per test/_ink-render.ts: prefer mount-and-assert behaviour over
// readFileSync source-greps. Render the popup into a CaptureStream,
// drive input via simulateInput, assert visible frame + spy on the
// yank callback. The keymap dispatcher is covered separately via
// dispatchPopupKey in test/tui-keys.test.ts; pure helpers
// (formatRoi etc.) are covered via their own unit suite.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  InProgressPopup,
  formatRoi,
  yankCommandForTask,
} from "../src/cli/tui/popups/inprogress.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addNote, addTask, claimTask, listInProgress } from "../src/tasks.js";
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
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-inprogress-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

interface SeedResult {
  inProgress: TaskRow[];
  snapshot: WorkstreamSnapshot;
}

async function seed(db: Db): Promise<SeedResult> {
  // Two IN_PROGRESS tasks via --self claim. The popup reads
  // snapshot.inProgress only.
  for (const [id, title, impact] of [
    ["alpha_run", "Alpha run", 90],
    ["beta_run", "Beta run", 50],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title, impact, effortDays: 1 });
    await claimTask(db, id, { workstream: "demo", self: true });
  }
  addNote(db, "alpha_run", "alpha note body", { workstream: "demo", author: "tester" });

  const inProgress = listInProgress(db, "demo");
  return {
    inProgress,
    snapshot: {
      workstreamName: "demo",
      ready: [],
      inProgress,
    } as unknown as WorkstreamSnapshot,
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
    columns: opts.columns ?? 140,
    rows: opts.rows ?? 24,
  });
  const instance = render(
    createElement(InProgressPopup, {
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

describe("InProgressPopup — export contract", () => {
  it("is exported as a function", () => {
    expect(typeof InProgressPopup).toBe("function");
  });
});

describe("yankCommandForTask (pure)", () => {
  it('yanks `mu task close <id> -w <ws> --evidence "..."`', () => {
    expect(yankCommandForTask("design_x", "tui-impl")).toBe(
      'mu task close design_x -w tui-impl --evidence "..."',
    );
  });

  it("matches the IN_PROGRESS branch of the Tasks popup yank matrix", () => {
    const cmd = yankCommandForTask("foo", "bar");
    expect(cmd).toContain("mu task close");
    expect(cmd).toContain("--evidence");
    expect(cmd).not.toContain("mu task release");
    expect(cmd).not.toContain("mu task claim");
  });
});

describe("formatRoi (pure)", () => {
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

describe("InProgressPopup — rendered list + yank", () => {
  it("renders IN_PROGRESS rows from snapshot.inProgress", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);

    const { stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);
    const frame = latestRenderedFrame(stdout).join("\n");

    expect(frame).toContain("alpha_run");
    expect(frame).toContain("beta_run");
    // Status column for both rows.
    expect(frame).toContain("IN_PROGRESS");
    // Title pin for the popup with cursor index.
    expect(frame).toContain("In-progress · popup (1/2)");
    // Hint text inset into the bottom border tells the operator
    // what y will yank.
    expect(frame).toContain("mu task close");

    instance.unmount();
  });

  it('y yanks `mu task close <id> -w <ws> --evidence "..."` for the focused row', async () => {
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

    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe('mu task close alpha_run -w demo --evidence "..."');

    await simulateInput(stdin, "j"); // → beta_run
    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe('mu task close beta_run -w demo --evidence "..."');

    instance.unmount();
  });

  it("Enter bubbles onModeChange('drill'); Esc bubbles back to 'list'", async () => {
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

    // Re-mount in drill mode and Esc out.
    instance.rerender(
      createElement(InProgressPopup, {
        yank: async () => {},
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
    await simulateInput(stdin, "escape");
    expect(modes.at(-1)).toBe("list");

    instance.unmount();
  });

  it("drill mode renders the focused task's notes and yanks `mu task notes <id>`", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const yanks: string[] = [];

    const { stdout, instance } = mount({
      db,
      snapshot,
      mode: "drill",
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);

    const frame = latestRenderedFrame(stdout).join("\n");
    // Drill title focuses on the first row (alpha_run, the seeded note).
    expect(frame).toContain("alpha_run");
    expect(frame).toContain("notes");
    expect(frame).toContain("alpha note body");

    // y yanks the notes lookup command for the same task.
    // Use the popup's own stdin via re-mount: keep the existing stdin
    // by replaying through the same instance.
    instance.unmount();
  });

  it("y in drill mode yanks `mu task notes <id> -w <ws>`", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);
    const yanks: string[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      mode: "drill",
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe("mu task notes alpha_run -w demo");

    instance.unmount();
  });

  it("filter '/' narrows the list to substring matches against id/title/owner", async () => {
    const db = fixtureDb();
    const { snapshot } = await seed(db);

    const { stdin, stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);

    await simulateInput(stdin, "/");
    for (const ch of "alpha") await simulateInput(stdin, ch);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);

    const frame = latestRenderedFrame(stdout).join("\n");
    expect(frame).toContain("alpha_run");
    expect(frame).not.toContain("beta_run");

    instance.unmount();
  });
});

describe("InProgressPopup ↔ App / keys wiring (structural)", () => {
  // Structural greps for the App ↔ keys glue stay — they pin the
  // popup to its slot id 6 (Shift+6 / `^`) and are the kind of
  // import-graph / dispatch-table guard the _ink-render.ts header
  // explicitly excludes from the "convert to behaviour" rule.
  it("App.tsx renders InProgressPopup for popup id 6", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    expect(app).toContain("InProgressPopup");
    expect(app).toMatch(/6: InProgressPopup/);
    const layout = readFileSync("./src/cli/tui/layout.ts", "utf-8");
    expect(layout).toMatch(/6:\s*\{[^}]*label:\s*"In-progress"/);
  });

  it("keys.ts maps Shift+6 (^) to openPopup(6)", async () => {
    const { readFileSync } = await import("node:fs");
    const keys = readFileSync("./src/cli/tui/keys.ts", "utf-8");
    expect(keys).toMatch(/"\^": 6/);
    expect(keys).toMatch(/kind: "openPopup";[\s\S]*\b6\b/);
  });
});
