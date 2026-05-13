// Behaviour tests for the Blocked popup (popups/blocked.tsx).
//
// Per test/_ink-render.ts: prefer mount-and-assert behaviour over
// readFileSync source-greps. Render the popup into a CaptureStream
// and assert the visible frame + spy on the yank callback. The
// keymap dispatcher is covered separately via dispatchPopupKey in
// test/tui-keys.test.ts.
//
// The popup's row source is `snapshot.blocked` — every OPEN task
// with at least one still-gating blocker. Per-row blocker IDs come
// from `getTaskEdgesWithStatus` SELECTed at render time, so the
// fixture has to seed real `addBlockEdge` rows for the visible
// blocker count + top-blocker columns to look right.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedPopup } from "../src/cli/tui/popups/blocked.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addBlockEdge, addNote, addTask, listBlocked } from "../src/tasks.js";
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
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-blocked-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

interface SeedResult {
  blocked: TaskRow[];
  snapshot: WorkstreamSnapshot;
}

function seed(db: Db): SeedResult {
  // Two blocked tasks (one blocker each, so blocker count column is
  // 1 and top-blocker is unambiguous).
  for (const [id, title, impact] of [
    ["paint", "Paint the walls", 90],
    ["furnish", "Furnish the room", 50],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title, impact, effortDays: 1 });
  }
  for (const [id, title] of [
    ["prime", "Prime the walls"],
    ["pick_furniture", "Pick out furniture"],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title, impact: 50, effortDays: 1 });
  }
  addBlockEdge(db, "demo", "paint", "prime");
  addBlockEdge(db, "demo", "furnish", "pick_furniture");
  // A note on `paint` so drill mode shows real text.
  addNote(db, "paint", "blocked on prime; needs primer order", {
    workstream: "demo",
    author: "tester",
  });

  const blocked = listBlocked(db, "demo");
  return {
    blocked,
    snapshot: {
      workstreamName: "demo",
      ready: [],
      inProgress: [],
      blocked,
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
    createElement(BlockedPopup, {
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

describe("BlockedPopup — export contract", () => {
  it("is exported as a function", () => {
    expect(typeof BlockedPopup).toBe("function");
  });
});

describe("BlockedPopup — rendered list + yank", () => {
  it("renders blocked tasks from snapshot.blocked with blocker columns", async () => {
    const db = fixtureDb();
    const { snapshot, blocked } = seed(db);
    expect(blocked.map((t) => t.name).sort()).toEqual(["furnish", "paint"]);

    const { stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);
    const frame = latestRenderedFrame(stdout).join("\n");

    // Blocked task ids surface; their blocker ids surface in the
    // top-blocker column.
    expect(frame).toContain("paint");
    expect(frame).toContain("furnish");
    expect(frame).toContain("prime");
    expect(frame).toContain("pick_furniture");
    // Title pin shows total + cursor.
    expect(frame).toContain("Blocked · popup (1/2)");

    instance.unmount();
  });

  it("y on a focused row yanks `mu task tree <id> -w <ws>`", async () => {
    const db = fixtureDb();
    const { snapshot } = seed(db);
    const yanks: string[] = [];

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);

    // listBlocked returns rows in DB-defined order; the first row
    // in our seed is `furnish` (id-ascending) — but the popup itself
    // doesn't re-sort. We test BOTH possible first rows so the
    // behaviour-pin doesn't drift if listBlocked changes ordering.
    await simulateInput(stdin, "y");
    const first = yanks.at(-1) ?? "";
    expect(first).toMatch(/^mu task tree (paint|furnish) -w demo$/);

    await simulateInput(stdin, "j"); // → next row
    await simulateInput(stdin, "y");
    const second = yanks.at(-1) ?? "";
    expect(second).toMatch(/^mu task tree (paint|furnish) -w demo$/);
    // The two yanks must focus DIFFERENT rows.
    expect(second).not.toBe(first);

    instance.unmount();
  });

  it("Enter bubbles onModeChange('drill'); Esc bubbles back to 'list'", async () => {
    const db = fixtureDb();
    const { snapshot } = seed(db);
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

    instance.rerender(
      createElement(BlockedPopup, {
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

  it("drill mode renders the focused task's notes; y yanks `mu task notes <id>`", async () => {
    const db = fixtureDb();
    const { snapshot, blocked } = seed(db);
    const yanks: string[] = [];

    // Find which row is `paint` (the one with the seeded note) and
    // pre-walk the cursor there before flipping into drill.
    const paintIndex = blocked.findIndex((t) => t.name === "paint");
    expect(paintIndex).toBeGreaterThanOrEqual(0);

    const { stdin, stdout, instance } = mount({
      db,
      snapshot,
      yank: async (cmd) => {
        yanks.push(cmd);
      },
    });
    await waitForInkOutput(stdout);
    for (let i = 0; i < paintIndex; i++) await simulateInput(stdin, "j");

    instance.rerender(
      createElement(BlockedPopup, {
        yank: async (cmd) => {
          yanks.push(cmd);
        },
        onClose: () => {},
        snapshot,
        fastTickNonce: 0,
        mode: "drill",
        onModeChange: () => {},
        db,
        workstream: "demo",
      }),
    );
    await waitForInkOutput(stdout);

    const frame = latestRenderedFrame(stdout).join("\n");
    expect(frame).toContain("paint");
    expect(frame).toContain("notes");
    expect(frame).toContain("blocked on prime; needs primer order");

    await simulateInput(stdin, "y");
    expect(yanks.at(-1)).toBe("mu task notes paint -w demo");

    instance.unmount();
  });

  it("filter '/' narrows the list to substring matches across id / title / blocker ids", async () => {
    const db = fixtureDb();
    const { snapshot } = seed(db);

    const { stdin, stdout, instance } = mount({ db, snapshot });
    await waitForInkOutput(stdout);

    // Filter on the BLOCKER's id ("pick_furniture"); only the row
    // it gates ("furnish") should remain. This pins the spec's
    // matching-rule that the search blob includes blocker ids.
    await simulateInput(stdin, "/");
    for (const ch of "pick_furniture") await simulateInput(stdin, ch);
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);

    const frame = latestRenderedFrame(stdout).join("\n");
    expect(frame).toContain("furnish");
    // `paint` row should be filtered out (its blocker is `prime`,
    // not `pick_furniture`, and its title doesn't contain the query
    // either).
    const taskRows = frame
      .split("\n")
      .filter((line) => /\b(paint|furnish)\b/.test(line) && !/Paint the walls/.test(line));
    // Defensive: once filtered, only the furnish row is in the body.
    expect(taskRows.some((line) => line.includes("furnish"))).toBe(true);
    expect(taskRows.some((line) => /\bpaint\b/.test(line))).toBe(false);

    instance.unmount();
  });
});

describe("BlockedPopup ↔ App / keys wiring (structural)", () => {
  // Structural greps for the App ↔ keys glue stay — they pin the
  // popup to its slot id 7 (Shift+7 / `&`) and are the kind of
  // import-graph / dispatch-table guard the _ink-render.ts header
  // explicitly excludes from the "convert to behaviour" rule.
  it("app.tsx imports BlockedPopup and POPUP_REGISTRY maps 7 → BlockedPopup", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    expect(app).toContain('from "./popups/blocked.js"');
    expect(app).toContain("BlockedPopup");
    expect(app).toMatch(/7: BlockedPopup/);
  });

  it("layout.ts CARD_CONFIGS[7].label is 'Blocked'", async () => {
    const { readFileSync } = await import("node:fs");
    const layout = readFileSync("./src/cli/tui/layout.ts", "utf-8");
    expect(layout).toMatch(/7:\s*\{[^}]*label:\s*"Blocked"/);
  });

  it("keys.ts maps '&' → openPopup(7)", async () => {
    const { readFileSync } = await import("node:fs");
    const keys = readFileSync("./src/cli/tui/keys.ts", "utf-8");
    expect(keys).toMatch(/"&":\s*7/);
  });
});
