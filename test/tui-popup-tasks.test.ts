// Tests for the Tasks popup (popups/ready.tsx). The full keymap is
// covered via dispatchPopupKey in test/tui-keys.test.ts; here we
// exercise the yankCommandForTask matrix and import-graph integrity.

import { Box, render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";
import { TaskDetailDrill } from "../src/cli/tui/popups/task-detail.js";
import type { Db } from "../src/db.js";
import type { TaskRow } from "../src/tasks.js";
import { CaptureStream, createInkCaptureStream, waitForInkOutput } from "./_ink-render.js";

const task: TaskRow = {
  name: "t1",
  workstreamName: "demo",
  title: "T1",
  status: "OPEN",
  impact: 50,
  effortDays: 0.1,
  ownerName: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const db = {} as Db;

afterEach(() => {
  CaptureStream.cleanup();
});

describe("ReadyPopup (Tasks popup)", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyPopup).toBe("function");
  });

  // The full table-driven yank-matrix lives in tui-yank-matrix.test.ts.
  // Keep this lightweight source guard so import drift is still visible.
  it("source contains yank cases for OPEN/IN_PROGRESS/CLOSED", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/ready.tsx", "utf-8");
    expect(src).toContain("mu task claim");
    expect(src).toContain("mu task release");
    expect(src).toContain("mu task close");
    expect(src).toContain("mu task open");
    // And it covers the IN_PROGRESS branch
    expect(src).toContain('"IN_PROGRESS"');
  });

  it("TaskDetailDrill calls renderNotes once initially and again when tickNonce changes", async () => {
    const stdout = createInkCaptureStream({ columns: 80, rows: 20 });
    let calls = 0;
    const renderNotesFn = () => `body-${++calls}`;

    const instance = render(drillElement(0, renderNotesFn), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });
    await waitForInkOutput(stdout);
    expect(calls).toBe(1);

    instance.rerender(drillElement(1, renderNotesFn));
    await waitForInkOutput(stdout);
    expect(calls).toBe(2);

    instance.unmount();
  });

  it("source drills into task notes via the shared TaskDetailDrill leaf", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/ready.tsx", "utf-8");
    // Post-feat_track_drill_chains_to_task_drill: the inline notes
    // render moved into popups/task-detail.tsx (TaskDetailDrill).
    // ready.tsx consumes it (consumer #1) so any future popup that
    // adopts the chain pattern stays in lockstep.
    expect(src).toContain("TaskDetailDrill");
    // Post-review_tui_task_popups_duplicated_template: the per-popup
    // `renderNotes` useMemo block moved into the shared useNotesDrill
    // hook. Assert the new wiring instead of the literal symbol.
    expect(src).toContain("useNotesDrill");
    expect(src).toContain('onModeChange("drill")');
    expect(src).toContain('onModeChange("list")');
  });
});

function drillElement(
  tickNonce: number,
  renderNotesFn: (db: Db, taskId: string, workstream: string) => string,
): JSX.Element {
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
      renderNotesFn,
    }),
  );
}
