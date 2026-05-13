// Tests for src/cli/tui/popups/blocked.tsx (feat_popup_7_blocked,
// workstream `tui-impl`).
//
// Same shape as test/tui-popup-workspaces.test.ts: pure-helper +
// import-graph + static-source assertions. We can't snapshot ink
// output without ink-testing-library (network-blocked).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedPopup } from "../src/cli/tui/popups/blocked.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { addTask, listBlocked } from "../src/tasks.js";
import {
  CaptureStream,
  type InkInputStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

const SRC = readFileSync("./src/cli/tui/popups/blocked.tsx", "utf-8");
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const LAYOUT_SRC = readFileSync("./src/cli/tui/layout.ts", "utf-8");

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-blocked-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedBlockedTasks(db: Db): void {
  addTask(db, {
    workstream: "demo",
    localId: "needle2_blocker",
    title: "blocking prerequisite",
    impact: 50,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "other_blocker",
    title: "unrelated prerequisite",
    impact: 50,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "target_blocked",
    title: "needle1 blocked work",
    impact: 50,
    effortDays: 1,
    blockedBy: ["needle2_blocker"],
  });
  addTask(db, {
    workstream: "demo",
    localId: "noise_blocked",
    title: "ordinary blocked work",
    impact: 50,
    effortDays: 1,
    blockedBy: ["other_blocker"],
  });
}

function snapshotFor(db: Db): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
    },
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: listBlocked(db, "demo"),
    recentClosed: [],
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

function mountBlockedPopup(opts: { db: Db; snapshot: WorkstreamSnapshot }): {
  stdin: InkInputStream;
  stdout: CaptureStream;
  unmount: () => void;
} {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: 24 });
  const instance = render(
    createElement(BlockedPopup, {
      yank: async () => {},
      onClose: () => {},
      snapshot: opts.snapshot,
      fastTickNonce: 0,
      mode: "list",
      onModeChange: () => {},
      db: opts.db,
      workstream: opts.snapshot.workstreamName,
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );
  return { stdin, stdout, unmount: () => instance.unmount() };
}

async function typeCommittedFilter(stdin: InkInputStream, query: string): Promise<void> {
  await simulateInput(stdin, "/");
  for (const char of query) await simulateInput(stdin, char);
  await simulateInput(stdin, "enter");
}

async function renderFilteredBlocked(query: string): Promise<string> {
  const db = fixtureDb();
  seedBlockedTasks(db);
  const snapshot = snapshotFor(db);
  const { stdin, stdout, unmount } = mountBlockedPopup({ db, snapshot });
  await waitForInkOutput(stdout);
  await typeCommittedFilter(stdin, query);
  await waitForInkOutput(stdout);
  const text = latestRenderedFrame(stdout).join("\n");
  unmount();
  return text;
}

describe("BlockedPopup: export contract", () => {
  it("is exported as a function", () => {
    expect(typeof BlockedPopup).toBe("function");
  });

  it("re-uses card 7's pure helpers (no duplication)", () => {
    // Mirrors Card 7; the popup imports helpers rather than re-derive.
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("stillGating");
    expect(SRC).toMatch(/from\s+"\.\.\/cards\/blocked\.js"/);
  });
});

describe("BlockedPopup: yank intents (read-only)", () => {
  it("list-mode yank → `mu task tree <id> -w <ws>` (the blocked diagnostic)", () => {
    // The KEY MAP block in the spec: "y on focused row → yank
    // `mu task tree <id> -w <ws>` (the most useful action: 'show me
    // what's blocking this')".
    expect(SRC).toContain("mu task tree");
  });

  it("drill-mode yank → `mu task notes <id>` (matches the leaf)", () => {
    // Drill view is TaskDetailDrill — yank should match what the
    // user is reading.
    expect(SRC).toContain("mu task notes");
  });

  it("never spells a mutating verb (read-only pledge)", () => {
    // Defensive: no mutating mu task verbs surface as yanks.
    for (const forbidden of [
      "mu task close",
      "mu task open",
      "mu task claim",
      "mu task release",
      "mu task reject",
      "mu task defer",
      "mu task block",
      "mu task unblock",
      "mu task delete",
    ]) {
      expect(SRC, `forbidden mutating yank: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("BlockedPopup: drill IS TaskDetailDrill (rows ARE tasks)", () => {
  it("imports TaskDetailDrill + useNotesDrill (drill-recursion contract)", () => {
    // Per feat_track_drill_chains_to_task_drill: rows that ARE
    // tasks chain into the shared TaskDetailDrill leaf.
    expect(SRC).toContain("TaskDetailDrill");
    expect(SRC).toMatch(/from\s+"\.\/task-detail\.js"/);
    // Post-review_tui_task_popups_duplicated_template: the per-popup
    // renderNotes useMemo moved into the shared useNotesDrill hook.
    expect(SRC).toContain("useNotesDrill");
    expect(SRC).toMatch(/from\s+"\.\.\/use-notes-drill\.js"/);
  });

  it("drill mode is plumbed via the standard onModeChange list ↔ drill toggle", () => {
    expect(SRC).toContain('onModeChange("drill")');
    expect(SRC).toContain('onModeChange("list")');
  });
});

describe("BlockedPopup: '/' filter (consumes the shared primitive)", () => {
  it("imports usePopupFilter / applyFilter / FilterPrompt", () => {
    expect(SRC).toContain("usePopupFilter");
    expect(SRC).toContain("applyFilter");
    expect(SRC).toContain("FilterPrompt");
  });
});

describe("BlockedPopup '/' filter behaviour", () => {
  it("matches by task title substring", async () => {
    const text = await renderFilteredBlocked("needle1");

    expect(text).toContain("target_blocked");
    expect(text).toContain("needle1 blocked work");
    expect(text).not.toContain("noise_blocked");
    expect(text).not.toContain("ordinary blocked work");
  });

  it("matches by blocker id substring", async () => {
    const text = await renderFilteredBlocked("needle2");

    expect(text).toContain("target_blocked");
    expect(text).toContain("needle2_blocker");
    expect(text).not.toContain("noise_blocked");
    expect(text).not.toContain("other_blocker");
  });
});

describe("BlockedPopup: source rows come from snapshot.blocked", () => {
  it("reads snapshot.blocked (NOT ready/inProgress)", () => {
    expect(SRC).toMatch(/snapshot\??\.blocked/);
    // Must not template-leak from popups/ready.tsx — the source
    // rows for THIS popup are the blocked slice.
    expect(SRC).not.toMatch(/snapshot\.ready/);
    expect(SRC).not.toMatch(/snapshot\.inProgress/);
  });

  it("uses getTaskEdgesWithStatus to compute per-row blockers", () => {
    expect(SRC).toContain("getTaskEdgesWithStatus");
  });
});

describe("BlockedPopup: list layout matches Card 7 columns + extras", () => {
  it("renders all seven popup columns: glyph, id, status, #blockers, top, ROI, title", () => {
    expect(SRC).toContain("glyph");
    expect(SRC).toContain("task id");
    expect(SRC).toContain("status");
    expect(SRC).toContain("#blockers");
    expect(SRC).toContain("top-blocker");
    expect(SRC).toContain("ROI");
  });

  it("only the title column is CLIPPABLE (everything else is PROTECTED)", () => {
    // Per feat_column_aligned_lists clipping policy.
    const clipMatches = SRC.match(/kind:\s*"clip"/g) ?? [];
    expect(clipMatches.length).toBe(1);
  });
});

describe("App ↔ keys wiring for popup 7", () => {
  it("app.tsx imports BlockedPopup", () => {
    expect(APP_SRC).toContain('from "./popups/blocked.js"');
    expect(APP_SRC).toContain("BlockedPopup");
  });

  it("app.tsx POPUP_REGISTRY maps 7 → BlockedPopup", () => {
    expect(APP_SRC).toMatch(/7: BlockedPopup/);
  });

  it("layout.ts CARD_CONFIGS[7].label is 'Blocked' (drives popupNameForId)", () => {
    // Post-review_tui_card_key_from_id_redundant: popupNameForId
    // reads CARD_CONFIGS[id].label instead of a 24-line switch.
    expect(LAYOUT_SRC).toMatch(/7:\s*\{[^}]*label:\s*"Blocked"/);
  });

  it("app.tsx PopupId union includes 7", () => {
    expect(APP_SRC).toMatch(/type PopupId = [^\n]*\b7\b[^\n]*null/);
  });

  it("keys.ts maps '&' → openPopup(7)", () => {
    // Glyph map should now include "&": 7 (no longer reserved-noop).
    expect(KEYS_SRC).toMatch(/"&":\s*7/);
  });
});
