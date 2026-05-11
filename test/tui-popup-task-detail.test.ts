// TaskDetailDrill is the shared leaf of the popup-drill recursion
// (per feat_track_drill_chains_to_task_drill). Two consumers today
// (popups/ready.tsx for the Tasks popup; popups/tracks.tsx for the
// Tracks popup); future consumers (Card 6/7/8 popups under
// feat_more_cards_umbrella) will plug in unchanged.
//
// We can't snapshot ink output without ink-testing-library, so we
// exercise the pure formatter (renderNotes) directly against a real
// in-memory SQLite, plus assert the import-graph + source contract.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDetailDrill, renderNotes } from "../src/cli/tui/popups/task-detail.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tdd-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "demo");
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskDetailDrill", () => {
  it("is exported as a function", () => {
    expect(typeof TaskDetailDrill).toBe("function");
  });

  it("renderNotes returns '' when there are no notes (empty-state)", () => {
    addTask(db, { localId: "t1", title: "T1", impact: 50, effortDays: 0.1, workstream: "demo" });
    expect(renderNotes(db, "t1", "demo")).toBe("");
  });

  it("renderNotes formats every note with a `── <ts>  <author> ──` header", () => {
    addTask(db, { localId: "t1", title: "T1", impact: 50, effortDays: 0.1, workstream: "demo" });
    addNote(db, "t1", "first body", { workstream: "demo", author: "alice" });
    addNote(db, "t1", "second body", { workstream: "demo", author: "bob" });
    const out = renderNotes(db, "t1", "demo");
    expect(out).toContain("── ");
    expect(out).toContain("  alice ──");
    expect(out).toContain("  bob ──");
    expect(out).toContain("first body");
    expect(out).toContain("second body");
    // Notes joined with a blank line so DrillScrollView paints them
    // as visually-separated blocks.
    expect(out).toContain("\n\n");
  });

  it("renderNotes uses '?' as the author when none recorded", () => {
    addTask(db, { localId: "t2", title: "T2", impact: 50, effortDays: 0.1, workstream: "demo" });
    addNote(db, "t2", "anon body", { workstream: "demo" });
    const out = renderNotes(db, "t2", "demo");
    expect(out).toContain("  ? ──");
    expect(out).toContain("anon body");
  });
});

describe("TaskDetailDrill source contract (no anticipatory abstraction)", () => {
  it("source consumes DrillScrollView (re-uses the existing primitive)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/task-detail.tsx", "utf-8");
    expect(src).toContain("DrillScrollView");
    expect(src).toContain("listNotes");
  });

  it("ready.tsx imports TaskDetailDrill (Tasks popup is consumer #1)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/ready.tsx", "utf-8");
    expect(src).toContain("TaskDetailDrill");
  });

  it("tracks.tsx imports TaskDetailDrill (Tracks popup is consumer #2 — the chain)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    expect(src).toContain("TaskDetailDrill");
  });
});
