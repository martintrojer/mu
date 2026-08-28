import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, render, Text } from "ink";
import { createElement, type ReactElement, useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cellWidth } from "../src/cli/tui/columns.js";
import type { PopupAction } from "../src/cli/tui/keys.js";
import { buildDagBody, dagYankCommand, truncateDagBody } from "../src/cli/tui/popups/dag.js";
import { useDrillKeymap } from "../src/cli/tui/popups/drill.js";
import { loadFullDag, renderForest } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { TASK_STATUSES } from "../src/tasks/status.js";
import { addBlockEdge, addTask, setTaskStatus, type TaskRow } from "../src/tasks.js";
import { CaptureStream, createInkCaptureStream, waitForInkOutput } from "./_ink-render.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
});

function task(name: string, title = name): TaskRow {
  return {
    name,
    workstreamName: "demo",
    title,
    status: "OPEN",
    impact: 50,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-dag-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedOnePerStatus(db: Db): void {
  for (const [id, status] of [
    ["open", "OPEN"],
    ["in_progress", "IN_PROGRESS"],
    ["closed", "CLOSED"],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
    if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
  }
}

describe("renderForest", () => {
  it("renders a stable ASCII forest for multiple roots", () => {
    const roots = [task("root_a", "Root A"), task("root_b", "Root B"), task("root_c", "Root C")];
    const childA = task("child_a", "Child A");
    const childB = task("child_b", "Child B");
    const edges = new Map<string, string[]>([
      ["root_a", ["child_a", "child_b"]],
      ["root_b", []],
      ["root_c", []],
    ]);
    const tasksByName = new Map([...roots, childA, childB].map((t) => [t.name, t]));

    const out = renderForest(roots, edges, (t) => t.status, tasksByName);

    expect(out).toBe(
      [
        "root_a  OPEN  Root A",
        "├── child_a  OPEN  Child A",
        "└── child_b  OPEN  Child B",
        "",
        "root_b  OPEN  Root B",
        "",
        "root_c  OPEN  Root C",
      ].join("\n"),
    );
  });
});

describe("DagPopup", () => {
  it("loads every root and edge for the current workstream", () => {
    const db = fixtureDb();
    for (const id of ["root_a", "root_b", "root_c", "child_a", "child_b"] as const) {
      addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
    }
    addBlockEdge(db, "demo", "child_a", "root_a");
    addBlockEdge(db, "demo", "child_b", "root_a");

    const dag = loadFullDag(db, "demo");

    expect(dag.roots.map((t) => t.name)).toEqual(["root_a", "root_b", "root_c"]);
    expect(dag.edges.get("root_a")).toEqual(["child_a", "child_b"]);
  });

  it("omits task titles from DAG popup nodes", () => {
    const db = fixtureDb();
    addTask(db, {
      workstream: "demo",
      localId: "compact_node",
      title: "FEAT: recognisable summary line that should not render",
      impact: 50,
      effortDays: 1,
    });

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES));

    expect(body.body).toContain("compact_node");
    expect(body.body).toContain("OPEN");
    expect(body.body).not.toContain("FEAT: recognisable summary line");
  });

  it("truncates long DAG lines to the popup content width with a safety margin", () => {
    const db = fixtureDb();
    const longRoot = `root_${"x".repeat(58)}`;
    addTask(db, {
      workstream: "demo",
      localId: longRoot,
      title: "title should be omitted before truncation",
      impact: 50,
      effortDays: 1,
    });
    const contentWidth = 30;

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES), contentWidth);
    const lines = body.body.split("\n");

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toBeDefined();
    expect(cellWidth(line ?? "")).toBeLessThanOrEqual(contentWidth - 1);
    expect(line).toContain("…");
  });

  it("truncateDagBody clips each logical line without adding wrapped rows", () => {
    const body = ["a".repeat(40), `${"b".repeat(40)}  CLOSED`].join("\n");
    const clipped = truncateDagBody(body, 12);
    const lines = clipped.split("\n");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(11);
      expect(line).toContain("…");
    }
  });

  it("passes all statuses by default (existing DAG popup behaviour)", () => {
    const db = fixtureDb();
    seedOnePerStatus(db);

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES));

    expect(body.roots).toEqual(["closed", "in_progress", "open"]);
    expect(body.body).toContain("open");
    expect(body.body).toContain("in_progress");
    expect(body.body).toContain("closed");
    expect(body.body).toContain("CLOSED");
  });

  it("pressing c hides CLOSED tasks from the DAG body", () => {
    const db = fixtureDb();
    seedOnePerStatus(db);
    const statuses = new Set(TASK_STATUSES);
    statuses.delete("CLOSED");

    const body = buildDagBody(db, "demo", statuses);

    expect(body.roots).toEqual(["in_progress", "open"]);
    expect(body.body).not.toContain("closed");
    expect(body.body).toContain("open");
    expect(body.body).toContain("in_progress");
  });

  it("filter strip source reflects toggled status state", () => {
    const src = readFileSync("./src/cli/tui/use-status-filter.tsx", "utf8");
    expect(src).toContain("filters: ");
    expect(src).toContain('enabled ? "●" : "○"');
    expect(src).toContain('CLOSED: { key: "C", rest: "losed" }');
  });

  it("delegates chrome and body rendering through PopupShell + DrillScrollView", () => {
    const src = readFileSync("./src/cli/tui/popups/dag.tsx", "utf8");
    expect(src).toContain('import { PopupShell } from "../popup-shell.js"');
    expect(src).toContain("<PopupShell");
    expect(src).toContain("<DrillScrollView");
    expect(src).toContain("useDrillKeymap");
    expect(src).not.toContain("applyScroll");
    expect(src).not.toContain("isNavAction");
    expect(src).not.toContain("const before = drill.scrollTop");
    expect(src).not.toContain("onClose: () => {}");
    expect(src).toContain("onScrollChange:");
    expect(src).toContain("<StatusFilterStrip");
    expect(src).toContain("includeTitle: false");
    expect(src).toContain("truncateDagBody(body, contentWidth)");
    expect(src).not.toContain("<TitledBox");
  });

  it("yank helper produces the focused task tree command", () => {
    expect(dagYankCommand("root_a", "demo")).toBe("mu task tree root_a -w demo");
  });

  it("useDrillKeymap onScrollChange reports the same scrollTop that it stores", async () => {
    const capture = { scrolls: [] as number[], changes: [] as number[] };
    const stdout = createInkCaptureStream({ columns: 100, rows: 24 });
    const instance = render(
      createElement(DrillScrollChangeHarness, {
        body: numberedLines(20),
        viewport: 5,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    instance.rerender(
      createElement(DrillScrollChangeHarness, {
        body: numberedLines(20),
        viewport: 5,
        capture,
        action: { kind: "jumpBottom" },
      }),
    );
    await waitForChange(capture, 15);

    expect(capture.scrolls).toContain(15);
    instance.unmount();
  });
});

interface DrillScrollChangeHarnessProps {
  body: string;
  viewport: number;
  capture: { scrolls: number[]; changes: number[] };
  action?: PopupAction;
}

function DrillScrollChangeHarness({
  body,
  viewport,
  capture,
  action,
}: DrillScrollChangeHarnessProps): ReactElement {
  const drill = useDrillKeymap({
    body,
    viewport,
    resetKey: "dag-root-focus",
    onClose: () => {},
    onScrollChange: (newTop) => capture.changes.push(newTop),
  });
  const lastAction = useRef<PopupAction | undefined>(undefined);
  useEffect(() => {
    capture.scrolls.push(drill.scrollTop);
  }, [capture, drill.scrollTop]);
  useEffect(() => {
    if (action === undefined || action === lastAction.current) return;
    lastAction.current = action;
    drill.dispatch(action);
  }, [action, drill.dispatch]);
  return createElement(Box, null, createElement(Text, null, `scroll:${drill.scrollTop}`));
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

/** Wait until BOTH the onScrollChange callback has fired with `expected`
 *  AND a subsequent render has recorded the same scrollTop.
 *
 *  These are two separate events: `changes` is pushed by the callback,
 *  `scrolls` by the render that follows it. Polling only `changes` left the
 *  assertion on `scrolls` racing the reconciler — it happened to pass under
 *  ink 5's flush timing and fails under ink 7's. */
async function waitForChange(
  capture: { changes: number[]; scrolls: number[] },
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (capture.changes.includes(expected) && capture.scrolls.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(capture.changes).toContain(expected);
  expect(capture.scrolls).toContain(expected);
}
