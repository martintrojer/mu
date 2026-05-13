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
  const ansiBoldCyan = "\x1b[1;36m";
  const ansiReset = "\x1b[0m";

  it("is exported as a function", () => {
    expect(typeof TaskDetailDrill).toBe("function");
  });

  it("renderNotes returns '' when there are no notes (empty-state)", () => {
    addTask(db, { localId: "t1", title: "T1", impact: 50, effortDays: 0.1, workstream: "demo" });
    expect(renderNotes(db, "t1", "demo")).toBe("");
  });

  it("renderNotes wraps a single note header in bold cyan ANSI", () => {
    addTask(db, { localId: "t1", title: "T1", impact: 50, effortDays: 0.1, workstream: "demo" });
    addNote(db, "t1", "first body", { workstream: "demo", author: "alice" });
    const out = renderNotes(db, "t1", "demo");
    const [header, body] = out.split("\n");
    expect(header).toMatch(
      new RegExp(
        `^${escapeRegExp(ansiBoldCyan)}── \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}  alice ──${escapeRegExp(ansiReset)}$`,
      ),
    );
    expect(body).toBe("first body");
  });

  it("renderNotes wraps every note header with its own ANSI reset", () => {
    addTask(db, { localId: "t1", title: "T1", impact: 50, effortDays: 0.1, workstream: "demo" });
    addNote(db, "t1", "first body", { workstream: "demo", author: "alice" });
    addNote(db, "t1", "second body", { workstream: "demo", author: "bob" });
    const out = renderNotes(db, "t1", "demo");
    expect(out.matchAll(new RegExp(escapeRegExp(ansiBoldCyan), "g")).toArray()).toHaveLength(2);
    expect(out.matchAll(new RegExp(escapeRegExp(ansiReset), "g")).toArray()).toHaveLength(2);
    expect(out).toContain(`${ansiReset}\nfirst body\n\n${ansiBoldCyan}`);
    expect(out).toContain("  alice ──");
    expect(out).toContain("  bob ──");
    // Notes joined with a blank line so DrillScrollView paints them
    // as visually-separated blocks.
    expect(out).toContain("\n\n");
  });

  it("renderNotes leaves body content unchanged with no added ANSI", () => {
    addTask(db, { localId: "t3", title: "T3", impact: 50, effortDays: 0.1, workstream: "demo" });
    const body = "plain body\n> quoted text\n$ echo hi";
    addNote(db, "t3", body, { workstream: "demo", author: "alice" });
    const out = renderNotes(db, "t3", "demo");
    const renderedBody = out.split("\n").slice(1).join("\n");
    expect(renderedBody).toBe(body);
    expect(renderedBody).not.toContain(ansiBoldCyan);
    expect(renderedBody).not.toContain(ansiReset);
  });

  it("renderNotes uses '?' as the author when none recorded", () => {
    addTask(db, { localId: "t2", title: "T2", impact: 50, effortDays: 0.1, workstream: "demo" });
    addNote(db, "t2", "anon body", { workstream: "demo" });
    const out = renderNotes(db, "t2", "demo");
    expect(out).toContain("  ? ──");
    expect(out).toContain("anon body");
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
