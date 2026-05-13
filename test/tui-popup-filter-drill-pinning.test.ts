// Regression tests for bug_filter_drill_opens_wrong_task.
//
// PRE-FIX BUG: every list popup that wired the '/' substring filter
// guarded `applyFilter(...)` behind `mode === "drill" ? source : ...`.
// Pressing Enter to drill flipped `mode`, dropped the text filter,
// re-resolved `visibleTasks`, and `safeCursor = min(cursor, len-1)`
// landed on a DIFFERENT task than the one the user visually
// selected — drill rendered the wrong task.
//
// FIX: drop the mode-conditional (filter applies uniformly) and
// capture the focused row identity at the moment Enter is pressed
// (defensive: even if visibleTasks shifts under us, the drill stays
// pinned to the intended task).
//
// This file lives outside the per-popup test files so it doesn't
// step on parallel test-file conversions in flight (worker-3 /
// worker-4). Each per-popup test still pins its own static-source
// invariants; this file exercises the cross-popup behaviour
// invariant that the bug class is fixed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AllTasksPopup } from "../src/cli/tui/popups/all-tasks.js";
import { BlockedPopup } from "../src/cli/tui/popups/blocked.js";
import { InProgressPopup } from "../src/cli/tui/popups/inprogress.js";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";
import { RecentPopup } from "../src/cli/tui/popups/recent.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addTask, listTasks, setTaskStatus } from "../src/tasks.js";
import { sortTasks } from "../src/tasks/sort.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-filter-drill-pin-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

/**
 * Seed N noise tasks at HIGH impact (so they sort to the top under
 * ROI) plus three "abc"-prefixed matches at LOW impact (so they
 * sort to the BOTTOM). The bug-detection trick: in the filtered
 * view the three abc_* matches occupy positions 0/1/2; in the
 * unfiltered view they're at positions 50/51/52 (last). With cursor
 * at filtered-row 1 the user sees abc_second selected; pre-fix the
 * drill resolved unfiltered[1] = a noise task. The two indices MUST
 * differ for the regression test to bite.
 */
function seedNoiseAndAbcMatches(db: Db, status: TaskRow["status"]): TaskRow[] {
  for (let i = 0; i < 50; i++) {
    const id = `noise_${String(i).padStart(2, "0")}`;
    addTask(db, {
      workstream: "demo",
      localId: id,
      title: `noise task ${i}`,
      // Higher impact than abc_* matches → noise sorts to TOP under
      // ROI; abc_* matches sit at the BOTTOM of the unfiltered list.
      impact: 90,
      effortDays: 1,
    });
    if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
  }
  const matchIds = ["abc_first", "abc_second", "abc_third"];
  for (const id of matchIds) {
    addTask(db, {
      workstream: "demo",
      localId: id,
      title: `${id} matches`,
      impact: 10,
      effortDays: 1,
    });
    if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
  }
  return sortTasks(listTasks(db, "demo"), "roi");
}

/**
 * Minimal WorkstreamSnapshot stub — only the fields the popup under
 * test reads need to be populated. The popup-shaped helper below
 * picks the right slot per popup.
 */
function snapshotFor(slot: keyof WorkstreamSnapshot, tasks: TaskRow[]): WorkstreamSnapshot {
  const base: WorkstreamSnapshot = {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
    },
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
  return { ...base, [slot]: tasks } as WorkstreamSnapshot;
}

interface PopupCase {
  label: string;
  popup: typeof AllTasksPopup | typeof ReadyPopup;
  status: TaskRow["status"];
  /** Snapshot field that backs the popup's source list. */
  slot: keyof WorkstreamSnapshot;
  /** Title regex matched against the rendered drill frame. */
  drillTitleContains: string;
}

const POPUP_CASES: PopupCase[] = [
  {
    label: "AllTasksPopup",
    popup: AllTasksPopup,
    status: "OPEN",
    slot: "allTasks",
    drillTitleContains: "All tasks · abc_second",
  },
  {
    label: "ReadyPopup",
    popup: ReadyPopup,
    status: "OPEN",
    slot: "ready",
    drillTitleContains: "Tasks · abc_second",
  },
  {
    label: "InProgressPopup",
    popup: InProgressPopup,
    status: "IN_PROGRESS",
    slot: "inProgress",
    drillTitleContains: "In-progress · abc_second",
  },
  {
    label: "RecentPopup",
    popup: RecentPopup,
    status: "CLOSED",
    slot: "recentClosed",
    drillTitleContains: "Recent · abc_second",
  },
  {
    label: "BlockedPopup",
    popup: BlockedPopup,
    status: "OPEN",
    slot: "blocked",
    drillTitleContains: "Blocked · abc_second",
  },
];

describe("bug_filter_drill_opens_wrong_task — drill stays pinned to focused row", () => {
  for (const tc of POPUP_CASES) {
    it(`${tc.label}: '/abc' filter, j once, Enter — drills into the SECOND filtered match (not unfiltered[1])`, async () => {
      const db = fixtureDb();
      const tasks = seedNoiseAndAbcMatches(db, tc.status);
      const snap = snapshotFor(tc.slot, tasks);

      const stdin = createInkInputStream();
      const stdout = createInkCaptureStream({ columns: 120, rows: 30 });
      let mode: "list" | "drill" = "list";
      const props: Record<string, unknown> = {
        yank: async () => {},
        onClose: () => {},
        snapshot: snap,
        fastTickNonce: 0,
        slowTickNonce: 0,
        mode,
        onModeChange: (next: "list" | "drill") => {
          mode = next;
          instance.rerender(createElement(tc.popup, { ...props, mode: next } as never));
        },
        db,
        workstream: "demo",
      };
      const instance = render(createElement(tc.popup, props as never), {
        stdout,
        stdin,
        stderr: process.stderr,
        debug: false,
        patchConsole: false,
      });

      await waitForInkOutput(stdout);
      // Open '/', type "abc" (char-by-char), commit.
      await simulateInput(stdin, "/");
      await simulateInput(stdin, "a");
      await simulateInput(stdin, "b");
      await simulateInput(stdin, "c");
      await simulateInput(stdin, "enter");
      await waitForInkOutput(stdout);
      // j once → cursor on the second filtered match. The three
      // abc_* matches are top-of-list (impact=100 > 50 noise).
      await simulateInput(stdin, "j");
      await waitForInkOutput(stdout);
      // Enter → drill. Title MUST contain abc_second (the visually
      // selected row), NOT noise_<anything> (what the unfiltered
      // index 1 would have been pre-fix).
      await simulateInput(stdin, "enter");
      await waitForInkOutput(stdout);
      const drillFrame = latestRenderedFrame(stdout).join("\n");
      expect(drillFrame).toContain(tc.drillTitleContains);
      expect(drillFrame).not.toMatch(/· noise_\d/);
      instance.unmount();
    });
  }
});
