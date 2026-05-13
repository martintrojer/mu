import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, render } from "ink";
import { createElement, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PopupAction } from "../src/cli/tui/keys.js";
import { useDrillKeymap } from "../src/cli/tui/popups/drill.js";
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

describe("useDrillKeymap refresh semantics", () => {
  it("preserves scrollTop across body refresh when resetKey is unchanged", async () => {
    const capture = { scrolls: [] as number[] };
    const stdout = new CaptureStream({ columns: 100, rows: 24 });
    const instance = render(
      keymapElement({
        body: numberedLines(20, "before"),
        viewport: 5,
        resetKey: "same-task",
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    instance.rerender(
      keymapElement({
        body: numberedLines(20, "before"),
        viewport: 5,
        resetKey: "same-task",
        action: { kind: "jumpBottom" },
        actionNonce: 1,
        capture,
      }),
    );
    await waitForScroll(capture, 15);

    instance.rerender(
      keymapElement({
        body: numberedLines(20, "after"),
        viewport: 5,
        resetKey: "same-task",
        actionNonce: 2,
        capture,
      }),
    );
    await waitForLatestScroll(capture, 15);

    instance.unmount();
  });

  it("resets scrollTop to 0 when resetKey changes", async () => {
    const capture = { scrolls: [] as number[] };
    const stdout = new CaptureStream({ columns: 100, rows: 24 });
    const instance = render(
      keymapElement({
        body: numberedLines(20, "same"),
        viewport: 5,
        resetKey: "task-a",
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    instance.rerender(
      keymapElement({
        body: numberedLines(20, "same"),
        viewport: 5,
        resetKey: "task-a",
        action: { kind: "jumpBottom" },
        actionNonce: 1,
        capture,
      }),
    );
    await waitForScroll(capture, 15);

    instance.rerender(
      keymapElement({
        body: numberedLines(20, "same"),
        viewport: 5,
        resetKey: "task-b",
        actionNonce: 2,
        capture,
      }),
    );
    await waitForScroll(capture, 0);

    instance.unmount();
  });

  it("clamps scrollTop when body shrinks below the current offset", async () => {
    const capture = { scrolls: [] as number[] };
    const stdout = new CaptureStream({ columns: 100, rows: 24 });
    const instance = render(
      keymapElement({
        body: numberedLines(20, "long"),
        viewport: 5,
        resetKey: "same-task",
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    instance.rerender(
      keymapElement({
        body: numberedLines(20, "long"),
        viewport: 5,
        resetKey: "same-task",
        action: { kind: "jumpBottom" },
        actionNonce: 1,
        capture,
      }),
    );
    await waitForScroll(capture, 15);

    instance.rerender(
      keymapElement({
        body: numberedLines(8, "short"),
        viewport: 5,
        resetKey: "same-task",
        actionNonce: 2,
        capture,
      }),
    );
    await waitForScroll(capture, 3);

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

interface KeymapElementOptions {
  body: string;
  viewport: number;
  resetKey: string;
  capture: { scrolls: number[] };
  action?: PopupAction;
  actionNonce?: number;
}

function keymapElement(opts: KeymapElementOptions): JSX.Element {
  return createElement(DrillKeymapHarness, opts);
}

function DrillKeymapHarness({
  body,
  viewport,
  resetKey,
  capture,
  action,
}: KeymapElementOptions): JSX.Element {
  const drill = useDrillKeymap({
    body,
    viewport,
    resetKey,
    onClose: () => {},
  });
  const sink = useRef(capture);
  useEffect(() => {
    sink.current.scrolls.push(drill.scrollTop);
  }, [drill.scrollTop]);
  useEffect(() => {
    if (action !== undefined) drill.dispatch(action);
  }, [action, drill.dispatch]);
  return createElement(Text, null, `scroll:${drill.scrollTop}`);
}

function numberedLines(count: number, label: string): string {
  return Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join("\n");
}

async function waitForScroll(capture: { scrolls: number[] }, expected: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (capture.scrolls.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(capture.scrolls).toContain(expected);
}

async function waitForLatestScroll(
  capture: { scrolls: number[] },
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (capture.scrolls.at(-1) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(capture.scrolls.at(-1)).toBe(expected);
}
