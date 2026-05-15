// Tests for src/cli/tui/popups/doctor.tsx (feat_popup_9_doctor,
// workstream `tui-impl`).
//
// Doctor popup is DIFFERENT from task popups — rows are NOT tasks, so
// the drill MUST NOT chain into TaskDetailDrill. The drill is a small
// ad-hoc detail view of the focused check via the shared DrillScrollView
// leaf.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DoctorPopup, renderDrillBody } from "../src/cli/tui/popups/doctor.js";
import { type Db, openDb } from "../src/db.js";
import { type DoctorCheck, remediationParagraph } from "../src/doctor-summary.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

const SRC_RAW = readFileSync("./src/cli/tui/popups/doctor.tsx", "utf-8");
// Strip `// ...` line comments + `/* ... */` block comments so the
// import-graph assertions don't false-positive on prose mentions of
// forbidden tokens (e.g. "NOT TaskDetailDrill").
function stripComments(src: string): string {
  // Strip line comments FIRST so a `// ... src/cli/tui/*.` line
  // (yes, those exist in the source headers) doesn't open a false
  // block comment when the block-comment regex runs over it.
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
const SRC = stripComments(SRC_RAW);
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const LAYOUT_SRC = readFileSync("./src/cli/tui/layout.ts", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const SUMMARY_SRC = readFileSync("./src/doctor-summary.ts", "utf-8");
const originalStdoutColumns = process.stdout.columns;
let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  Object.defineProperty(process.stdout, "columns", {
    value: originalStdoutColumns,
    configurable: true,
  });
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-doctor-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function snapshot(over: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
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
    ...over,
  };
}

interface HarnessProps {
  db: Db;
  snapshot: WorkstreamSnapshot;
  yanked: string[];
  closed: { value: boolean };
}

function DoctorHarness({ db, snapshot, yanked, closed }: HarnessProps): JSX.Element {
  const [mode, setMode] = useState<"list" | "drill">("list");
  return createElement(DoctorPopup, {
    yank: async (command: string) => {
      yanked.push(command);
    },
    onClose: () => {
      closed.value = true;
    },
    snapshot,
    mode,
    onModeChange: setMode,
    db,
    workstream: "demo",
  });
}

async function renderDoctorPopup(
  db: Db,
  snapshotValue: WorkstreamSnapshot,
): Promise<{
  stdin: ReturnType<typeof createInkInputStream>;
  stdout: CaptureStream;
  yanked: string[];
  closed: { value: boolean };
  unmount: () => void;
}> {
  Object.defineProperty(process.stdout, "columns", { value: 140, configurable: true });
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 140, rows: 30 });
  const yanked: string[] = [];
  const closed = { value: false };
  const instance = render(
    createElement(DoctorHarness, { db, snapshot: snapshotValue, yanked, closed }),
    {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    },
  );
  await waitForInkOutput(stdout);
  return { stdin, stdout, yanked, closed, unmount: () => instance.unmount() };
}

function frameText(stdout: CaptureStream): string {
  return latestRenderedFrame(stdout).join("\n");
}

async function waitForFrame(stdout: CaptureStream, needle: string): Promise<string> {
  const deadline = Date.now() + 1000;
  let text = frameText(stdout);
  while (Date.now() < deadline) {
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = frameText(stdout);
  }
  throw new Error(`timed out waiting for ${needle}; last frame:\n${text}`);
}

async function typeFilter(
  stdin: ReturnType<typeof createInkInputStream>,
  query: string,
): Promise<void> {
  await simulateInput(stdin, "/");
  for (const ch of query) await simulateInput(stdin, ch);
  await simulateInput(stdin, "enter");
}

async function clearFilter(stdin: ReturnType<typeof createInkInputStream>): Promise<void> {
  await simulateInput(stdin, "/");
  await simulateInput(stdin, "escape");
}

describe("DoctorPopup: export contract", () => {
  it("is exported as a function", () => {
    expect(typeof DoctorPopup).toBe("function");
  });

  it("re-uses Card 9's pure helpers (no duplication)", () => {
    // Mirrors Card 9; the popup imports glyphFor / colorForStatus
    // rather than re-derive them.
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("colorForStatus");
    expect(SRC).toMatch(/from\s+"\.\.\/cards\/doctor\.js"/);
  });

  it("imports loadDoctorChecks (the popup's all-checks SDK seam)", () => {
    expect(SRC).toContain("loadDoctorChecks");
    expect(SRC).toMatch(/from\s+"\.\.\/\.\.\/\.\.\/doctor-summary\.js"/);
  });
});

describe("DoctorPopup: behaviour", () => {
  it("renders every doctor check, filters by detail text, and yanks the focused remediation command", async () => {
    const db = fixtureDb();
    const snap = snapshot({
      view: {
        agents: [],
        orphans: [{ paneId: "%99", title: "lost", command: "pi" }],
        report: { prunedGhosts: 2, statusChanges: 0, orphans: [], mode: "report-only" },
      },
      workspaceOrphans: [{ agentName: "worker-1", workstreamName: "demo", path: "/tmp/orphan" }],
    });
    const r = await renderDoctorPopup(db, snap);
    try {
      let text = frameText(r.stdout);
      expect(text).toContain("Doctor · popup (1/7)");
      expect(text).toContain("schema");
      expect(text).toContain("agents");
      expect(text).toContain("2 ghost panes");
      expect(text).toContain("panes");
      expect(text).toContain("1 orphan pane");
      expect(text).toContain("workspaces");
      expect(text).toContain("1 orphan dir");

      await typeFilter(r.stdin, "orphan dir");
      text = await waitForFrame(r.stdout, "[filter] orphan dir");
      expect(text).toContain("workspaces");
      expect(text).toContain("1 orphan dir");
      expect(text).not.toContain("agents");
      expect(text).not.toContain("2 ghost panes");

      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["mu workspace orphans"]);
    } finally {
      r.unmount();
    }
  });

  it("Enter drills into remediation details; y yanks there too; Esc returns to all checks", async () => {
    const db = fixtureDb();
    const snap = snapshot({
      view: {
        agents: [],
        orphans: [],
        report: { prunedGhosts: 2, statusChanges: 0, orphans: [], mode: "report-only" },
      },
    });
    const r = await renderDoctorPopup(db, snap);
    try {
      await typeFilter(r.stdin, "ghost");
      await waitForFrame(r.stdout, "[filter] ghost");
      await clearFilter(r.stdin);
      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "enter");
      let text = await waitForFrame(r.stdout, "Doctor · agents (detail)");
      expect(text).toContain("Doctor · agents (detail)");
      expect(text).toContain("agents · warn");
      expect(text).toContain("status:  warn");
      expect(text).toContain("detail:  2 ghost panes");
      expect(text).toContain("mu agent list");
      expect(text).not.toContain("TaskDetailDrill");

      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["mu agent list"]);

      await simulateInput(r.stdin, "escape");
      text = await waitForFrame(r.stdout, "Doctor · popup (5/7)");
      expect(text).toContain("agents");
      expect(text).toContain("2 ghost panes");
      expect(text).not.toContain("Doctor · agents (detail)");
    } finally {
      r.unmount();
    }
  });
});

describe("DoctorPopup: drill is NOT TaskDetailDrill (rows aren't tasks)", () => {
  it("does NOT import TaskDetailDrill / renderNotes (popup-recursion DOES NOT apply)", () => {
    // Per spec: rows are doctor checks, not tasks. The drill must
    // be a small ad-hoc detail view, NOT the shared
    // TaskDetailDrill leaf used by popups 3/6/7.
    expect(SRC).not.toContain("TaskDetailDrill");
    expect(SRC).not.toContain("renderNotes");
    expect(SRC).not.toMatch(/from\s+"\.\/task-detail\.js"/);
  });
});

describe("DoctorPopup: yank intents — informational only (read-only pledge)", () => {
  it("never spells a mutating verb in any actual yank() call (read-only pledge)", () => {
    // Defensive: no mutating mu verbs surface as yanks. Scope to
    // lines that actually call `yank(...)` or that are
    // returned-from `yankCommandForCheck` so the prose remediation
    // paragraphs (which legitimately mention `mu agent close` as
    // an instruction the operator may RUN MANUALLY, not paste
    // blindly) don't false-positive. Note: yankCommandForCheck
    // itself now lives in src/doctor-summary.ts (per task
    // review_tui_doctor_remediation_lives_in_popup) so the
    // popup-source scope only has to police the inline `yank(...)`
    // call sites here.
    const yankSites = SRC.split("\n")
      .filter((line) => /\byank\s*\(/.test(line) || /\breturn\s+"mu /.test(line))
      .join("\n");
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
      "mu agent close",
      "mu agent kick",
      "mu workspace free",
      "mu workspace recreate",
      "mu workspace refresh",
      "mu undo",
    ]) {
      expect(yankSites, `forbidden mutating yank: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("DoctorPopup: drill body renderer (pure)", () => {
  const sample: DoctorCheck = {
    name: "agents",
    status: "warn",
    detail: "2 ghost panes; run `mu agent list`",
  };

  it("includes the check name + status + detail + remediation hint", () => {
    const body = renderDrillBody(sample);
    expect(body).toContain("agents");
    expect(body).toContain("status:  warn");
    expect(body).toContain("2 ghost panes");
    expect(body).toContain("remediation hint");
    expect(body).toContain("mu agent list");
  });

  it("ends with the multi-line remediation paragraph", () => {
    const body = renderDrillBody(sample);
    const para = remediationParagraph(sample);
    for (const ln of para) expect(body).toContain(ln);
  });

  it("renders multi-line output (drill body is a paragraph, not a one-liner)", () => {
    const body = renderDrillBody(sample);
    expect(body.split("\n").length).toBeGreaterThan(3);
  });
});

describe("doctor-summary: loadDoctorChecks SDK seam", () => {
  it("is exported from src/doctor-summary.ts", () => {
    expect(SUMMARY_SRC).toContain("export function loadDoctorChecks");
  });

  it("returns DoctorCheck[] (the popup's all-checks shape)", () => {
    // Re-exported through src/index.ts so consumers outside the
    // TUI can reach it.
    const indexSrc = readFileSync("./src/index.ts", "utf-8");
    expect(indexSrc).toContain("loadDoctorChecks");
  });
});

describe("App ↔ keys wiring for popup 9", () => {
  it("app.tsx imports DoctorPopup", () => {
    expect(APP_SRC).toContain('from "./popups/doctor.js"');
    expect(APP_SRC).toContain("DoctorPopup");
  });

  it("app.tsx POPUP_REGISTRY maps 9 → DoctorPopup", () => {
    expect(APP_SRC).toMatch(/9: DoctorPopup/);
  });

  it("layout.ts CARD_CONFIGS[9].label is 'Doctor' (drives popupNameForId)", () => {
    // Post-review_tui_card_key_from_id_redundant: popupNameForId
    // reads CARD_CONFIGS[id].label instead of a 24-line switch.
    expect(LAYOUT_SRC).toMatch(/9:\s*\{[^}]*label:\s*"Doctor"/);
  });

  it("app.tsx PopupId union includes 9", () => {
    expect(APP_SRC).toMatch(/type PopupId = [^\n]*\b9\b[^\n]*null/);
  });

  it("keys.ts maps '(' → openPopup(9)", () => {
    // Glyph map should now include "(": 9 (no longer reserved-noop).
    expect(KEYS_SRC).toMatch(/"\(":\s*9/);
  });

  it("keys.ts openPopup union widened to include 9", () => {
    expect(KEYS_SRC).toMatch(/openPopup[^}]*\b9\b/);
  });
});
