import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, render } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDetailDrill } from "../src/cli/tui/popups/task-detail.js";
import { type Db, openDb } from "../src/db.js";
import { type TaskRow, addNote, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { CaptureStream, waitForInkOutput } from "./_ink-render.js";

let dir: string;
let db: Db;
let task: TaskRow;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tui-drill-refresh-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "demo");
  task = addTask(db, {
    workstream: "demo",
    localId: "t1",
    title: "T1",
    impact: 50,
    effortDays: 0.1,
  });
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

describe("TaskDetailDrill tick refresh", () => {
  it("open all-tasks-style task detail drill shows a note inserted mid-test after fast tickNonce changes", async () => {
    addNote(db, "t1", "initial note", { workstream: "demo", author: "alice" });
    const stdout = new CaptureStream({ columns: 100, rows: 24 });

    const instance = render(drillElement(0), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });
    await waitForInkOutput(stdout);
    expect(stdout.output).toContain("initial note");
    expect(stdout.output).not.toContain("fresh note from outside the TUI");

    const row = db.prepare("SELECT id FROM tasks WHERE local_id = ?").get("t1") as
      | { id: number }
      | undefined;
    if (row === undefined) throw new Error("task id missing");
    db.prepare(
      "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
    ).run(row.id, "shell", "fresh note from outside the TUI", new Date().toISOString());
    instance.rerender(drillElement(1));
    await waitForInkOutput(stdout);

    expect(stdout.output).toContain("fresh note from outside the TUI");
    instance.unmount();
  });
});

function drillElement(tickNonce: number): JSX.Element {
  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(TaskDetailDrill, {
      task,
      db,
      workstream: "demo",
      scrollTop: 0,
      viewport: 20,
      tickNonce,
    }),
  );
}
