// Tests for src/cli/tui/use-notes-drill.ts — the shared notes-drill
// memo extracted from 5 task-list popups per task
// review_tui_task_popups_duplicated_template (workstream `tui-impl`).
//
// Behavioural surface to pin (the contract callers rely on):
//   1. mode === "list" → notesText is "" (no SELECT issued).
//   2. mode === "drill" + focused row → notesText equals
//      renderNotes(db, focused.name, workstream).
//   3. fastTickNonce changes re-run the memo so the SQL-backed
//      body picks up new notes on the fast tick.
//
// We render a tiny consumer component through ink (the same
// CaptureStream harness test/tui-popup-tasks.test.ts uses for
// TaskDetailDrill) and capture the produced notesText through a ref.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/* +
// tests; this is a test file so the harness is fine.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, render } from "ink";
import { createElement, useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderNotes } from "../src/cli/tui/popups/task-detail.js";
import { useNotesDrill } from "../src/cli/tui/use-notes-drill.js";
import { type Db, openDb } from "../src/db.js";
import { type TaskRow, addNote, addTask, listTasks } from "../src/tasks.js";
import { CaptureStream, waitForInkOutput } from "./_ink-render.js";

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-use-notes-drill-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

interface HarnessProps {
  mode: "list" | "drill";
  focused: TaskRow | undefined;
  db: Db;
  workstream: string;
  fastTickNonce: number;
  /** Test-only sink: each render appends the produced notesText. */
  capture: { values: string[] };
}

function Harness({
  mode,
  focused,
  db,
  workstream,
  fastTickNonce,
  capture,
}: HarnessProps): JSX.Element {
  const notesText = useNotesDrill({ mode, focused, db, workstream, fastTickNonce });
  const sink = useRef(capture);
  useEffect(() => {
    sink.current.values.push(notesText);
  }, [notesText]);
  // ink requires SOMETHING to render — keep it minimal.
  return createElement(Text, null, notesText === "" ? "(empty)" : "(has body)");
}

describe("useNotesDrill", () => {
  it("returns '' when mode === 'list' (no SELECT)", async () => {
    const db = fixtureDb();
    addTask(db, { workstream: "demo", localId: "t1", title: "T1", impact: 50, effortDays: 1 });
    addNote(db, "t1", "first note", { workstream: "demo", author: "tester" });
    const [task] = listTasks(db, "demo");
    expect(task).toBeDefined();
    if (!task) return;

    const stdout = new CaptureStream({ columns: 80, rows: 20 });
    const capture = { values: [] as string[] };

    const instance = render(
      createElement(Harness, {
        mode: "list",
        focused: task,
        db,
        workstream: "demo",
        fastTickNonce: 0,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    expect(capture.values.at(-1)).toBe("");
    instance.unmount();
  });

  it("returns '' when focused is undefined (even in drill mode)", async () => {
    const db = fixtureDb();
    const stdout = new CaptureStream({ columns: 80, rows: 20 });
    const capture = { values: [] as string[] };

    const instance = render(
      createElement(Harness, {
        mode: "drill",
        focused: undefined,
        db,
        workstream: "demo",
        fastTickNonce: 0,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    expect(capture.values.at(-1)).toBe("");
    instance.unmount();
  });

  it("returns rendered notes when mode === 'drill' + focused", async () => {
    const db = fixtureDb();
    addTask(db, { workstream: "demo", localId: "t1", title: "T1", impact: 50, effortDays: 1 });
    addNote(db, "t1", "hello world", { workstream: "demo", author: "tester" });
    const [task] = listTasks(db, "demo");
    expect(task).toBeDefined();
    if (!task) return;

    const expected = renderNotes(db, task.name, "demo");
    expect(expected).toContain("hello world");

    const stdout = new CaptureStream({ columns: 80, rows: 20 });
    const capture = { values: [] as string[] };

    const instance = render(
      createElement(Harness, {
        mode: "drill",
        focused: task,
        db,
        workstream: "demo",
        fastTickNonce: 0,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    expect(capture.values.at(-1)).toBe(expected);
    instance.unmount();
  });

  it("re-runs the memo when fastTickNonce changes (picks up new notes)", async () => {
    const db = fixtureDb();
    addTask(db, { workstream: "demo", localId: "t1", title: "T1", impact: 50, effortDays: 1 });
    addNote(db, "t1", "first", { workstream: "demo", author: "tester" });
    const [task] = listTasks(db, "demo");
    expect(task).toBeDefined();
    if (!task) return;

    const stdout = new CaptureStream({ columns: 80, rows: 20 });
    const capture = { values: [] as string[] };

    const instance = render(
      createElement(Harness, {
        mode: "drill",
        focused: task,
        db,
        workstream: "demo",
        fastTickNonce: 0,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);
    const firstBody = capture.values.at(-1) ?? "";
    expect(firstBody).toContain("first");
    expect(firstBody).not.toContain("second");

    // Add a new note BEHIND the popup, then bump the fast tick.
    // Without the tickNonce in the memo deps the body would stay
    // stale (props only changed numerically — same task, same db).
    addNote(db, "t1", "second", { workstream: "demo", author: "tester" });
    instance.rerender(
      createElement(Harness, {
        mode: "drill",
        focused: task,
        db,
        workstream: "demo",
        fastTickNonce: 1,
        capture,
      }),
    );
    await waitForInkOutput(stdout);
    const secondBody = capture.values.at(-1) ?? "";
    expect(secondBody).toContain("first");
    expect(secondBody).toContain("second");

    instance.unmount();
  });
});
