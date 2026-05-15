// Behaviour tests for src/cli/tui/app.tsx — the 714-LOC root state machine.
//
// Per testreview_tui_app_no_behaviour_coverage (workstream `tui-impl`):
// app.tsx had ZERO behaviour coverage. The static source-grep file
// (test/tui-app.test.ts) is kept alive as an anti-regression guard
// for the props-bag invariant, but it can't catch help-overlay,
// popup, tab-switch, or Ctrl-C bugs (and didn't, when those bugs
// shipped).
//
// This file mounts <App> via the CaptureStream + InkInputStream seam
// (test/_ink-render.ts, documented in test/README.md) and exercises
// the most load-bearing user-facing invariants:
//
//   1.  Initial render shows the dashboard cards.
//   2.  Press a digit → toggles a card (hides ↔ shows).
//   3.  Press "?" → opens help overlay; "?" again → closes.
//   4.  Press "Esc" inside the help overlay → closes it.
//   5.  Press a popup-promote glyph (e.g. "!" for slot 1) → opens that popup.
//   6.  Press "Esc" inside a popup → closes the popup but the App
//       keeps running (NOT exit). The app is still alive afterwards.
//   7.  Press "Tab" with two workstreams → active tab changes.
//   8.  Press "Ctrl-C" → ink's exitOnCtrlC unmounts the app.
//   9.  Press "+" → tick rate halves (clamped via fasterTick).
//
// Strategy notes:
//
//  - useDashboardSnapshot is mocked to return a fixed, fully-populated
//    snapshot synchronously. The App's poll loop is then a no-op; we
//    don't shell out to tmux/git/jj or burn 1s ticks. The mock also
//    lets us assert against deterministic visible text (card labels +
//    a known agent / task name). This focuses each test on the
//    keymap → state-mutation → render contract.
//
//  - Each test mounts via render(), drives stdin via simulateInput,
//    asserts on latestRenderedFrame, and unmounts in afterEach.
//
//  - Ctrl-C is delivered as "\x03" — ink's <App> reads the byte
//    directly off stdin and calls handleExit when exitOnCtrlC is true
//    (see node_modules/ink/build/components/App.js line ~143).

import { render } from "ink";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

// ─── Mock the snapshot loader ─────────────────────────────────────
//
// useDashboardSnapshot is what the App calls to keep the dashboard
// fresh. In production it spins setIntervals against fast/slow loaders
// that hit SQLite and tmux/jj subprocesses. For App-level keymap
// tests we don't care about the loader — we just want a deterministic
// snapshot the cards can render. Replace the hook with a synchronous
// stub that returns the fixture.
//
// We also re-export the public constants/helpers App imports so the
// rest of state.ts (TICK_DEFAULT_MS, fasterTick, slowerTick,
// DEFAULT_CARD_VISIBILITY, …) keeps working unchanged.

const SNAPSHOT_BY_WS = new Map<string, WorkstreamSnapshot>();

vi.mock("../src/cli/tui/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/tui/state.js")>();
  return {
    ...actual,
    useDashboardSnapshot: (
      _db: unknown,
      workstream: string,
      _tickMs: number,
      _enabled: boolean,
    ) => ({
      data: SNAPSHOT_BY_WS.get(workstream) ?? null,
      fastTickNonce: 0,
      slowTickNonce: 0,
      lastTickMs: 0,
      error: null,
    }),
  };
});

// Mute the mouse-mode subscriber: useMouse attaches a stdin "data"
// listener at module load time (see src/cli/tui/mouse.ts). In tests
// we pass a fake stdin to ink, but useMouse latches onto
// process.stdin, which is a real raw-mode tty — the listener does
// nothing harmful but the unmount cleanup wants the subscriber set
// emptied. The mock keeps useMouse a no-op so the test mount is
// pure stdin → render → assert.
vi.mock("../src/cli/tui/mouse.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/tui/mouse.ts")>();
  return {
    ...actual,
    useMouse: () => undefined,
    enableMouseMode: () => undefined,
    disableMouseMode: () => undefined,
  };
});

// Parked-detection: the App calls parkedStatus(db, ws) per slow-tick
// to drive the tab-strip dim. The mocked db here is `{} as Db`, so
// the SQL inside parkedStatus would crash with `db.prepare is not a
// function`. Stub it to a no-op (no workstream is parked in these
// tests).
vi.mock("../src/parked.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/parked.js")>();
  return {
    ...actual,
    parkedStatus: () => ({ parked: false }),
  };
});

// Yank backend probe: don't shell out to pbcopy/wl-copy/xclip during
// tests. Returning a no-op backend keeps the footer state-machine
// reachable (footer assertions aren't in scope for v1 of this file).
vi.mock("../src/cli/tui/yank.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/tui/yank.js")>();
  return {
    ...actual,
    probeClipboardBackend: async () => undefined,
    yank: async () => ({ copied: false, command: "" }),
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────

import { App } from "../src/cli/tui/app.js";

function freshSnapshot(workstreamName: string): WorkstreamSnapshot {
  return {
    workstreamName,
    view: {
      agents: [
        {
          name: `${workstreamName}-worker-1`,
          workstreamName,
          cli: "pi",
          paneId: "%101",
          status: "needs_input",
          role: "full-access",
          tab: null,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
      ],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
    },
    tracks: [],
    ready: [
      {
        name: `${workstreamName}-task-ready-1`,
        workstreamName,
        title: "ready task one",
        status: "OPEN",
        impact: 50,
        effortDays: 1,
        ownerName: null,
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ],
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
}

interface Mounted {
  stdin: ReturnType<typeof createInkInputStream>;
  stdout: CaptureStream;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
}

const COLUMNS = 160;
const ROWS = 50;

async function mountApp(opts: {
  workstreams: string[];
  initialActive?: number;
}): Promise<Mounted> {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: COLUMNS, rows: ROWS });
  const stderr = createInkCaptureStream({ columns: COLUMNS, rows: ROWS });
  const db = {} as Db; // mocked snapshot loader never touches it.
  const instance = render(
    createElement(App, {
      db,
      workstreams: opts.workstreams,
      ...(opts.initialActive !== undefined ? { initialActive: opts.initialActive } : {}),
    }),
    {
      stdout,
      stdin,
      stderr,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: true,
    },
  );
  await waitForInkOutput(stdout);
  return {
    stdin,
    stdout,
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}

function frame(stdout: CaptureStream): string {
  return latestRenderedFrame(stdout).join("\n");
}

async function waitForFrame(stdout: CaptureStream, needle: string): Promise<string> {
  const deadline = Date.now() + 1500;
  let text = frame(stdout);
  while (Date.now() < deadline) {
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = frame(stdout);
  }
  throw new Error(`timed out waiting for ${needle}; last frame:\n${text}`);
}

async function waitForFrameMissing(stdout: CaptureStream, needle: string): Promise<string> {
  const deadline = Date.now() + 1500;
  let text = frame(stdout);
  while (Date.now() < deadline) {
    if (!text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = frame(stdout);
  }
  throw new Error(`expected '${needle}' to disappear; last frame:\n${text}`);
}

let mounted: Mounted | null = null;

beforeEach(() => {
  SNAPSHOT_BY_WS.clear();
  SNAPSHOT_BY_WS.set("demo", freshSnapshot("demo"));
  SNAPSHOT_BY_WS.set("other", freshSnapshot("other"));
});

afterEach(() => {
  if (mounted !== null) {
    try {
      mounted.unmount();
    } catch {
      // ignore unmount races
    }
    mounted = null;
  }
  CaptureStream.cleanup();
});

describe("App: initial render", () => {
  it("dashboard renders the visible card titles + status bar", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    const text = frame(mounted.stdout);
    // Each card's titled-box label should be visible at startup.
    // Card titles as the TitledBox renders them. Note `Log` card's
    // box title is "Activity log", not the bare CARD_CONFIGS label
    // "Log".
    for (const label of [
      "Commits",
      "Agents",
      "Tracks",
      "Ready",
      "Activity log",
      "Workspaces",
      "In-progress",
      "Blocked",
      "Recent",
      "Doctor",
    ]) {
      expect(text, `missing card label: ${label}`).toContain(label);
    }
    // The seeded ready task title bleeds through too (sanity that
    // mocked snapshot data actually flowed into a card body).
    expect(text).toContain("ready task one");
    // Status bar carries a tick indicator (e.g. "1.00s").
    expect(text).toMatch(/\d\.\d\ds/);
  });
});

describe("App: card-toggle keys 1-9", () => {
  it("pressing '3' hides the Ready card, pressing '3' again shows it", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    expect(frame(mounted.stdout)).toContain("Ready");

    await simulateInput(mounted.stdin, "3");
    await waitForFrameMissing(mounted.stdout, "Ready");
    // Sanity: other cards are still visible.
    expect(frame(mounted.stdout)).toContain("Agents");

    await simulateInput(mounted.stdin, "3");
    await waitForFrame(mounted.stdout, "Ready");
  });

  it("pressing '1' hides the Agents card", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    expect(frame(mounted.stdout)).toContain("Agents");
    await simulateInput(mounted.stdin, "1");
    await waitForFrameMissing(mounted.stdout, "Agents");
  });
});

describe("App: help overlay (? and Esc)", () => {
  it("? opens the help overlay, ? closes it again", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });

    await simulateInput(mounted.stdin, "?");
    // The HELP overlay is titled "keys" (per Help component) and
    // carries the section header "keys · dashboard". The seeded
    // task title ("ready task one") is dashboard-only and a clean
    // sentinel for "help is on top" / "dashboard is back".
    const helpFrame = await waitForFrame(mounted.stdout, "keys · dashboard");
    expect(helpFrame).not.toContain("ready task one");

    await simulateInput(mounted.stdin, "?");
    await waitForFrame(mounted.stdout, "ready task one");
  });

  it("Esc inside the help overlay closes it", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    await simulateInput(mounted.stdin, "?");
    await waitForFrame(mounted.stdout, "keys · dashboard");

    await simulateInput(mounted.stdin, "escape");
    await waitForFrame(mounted.stdout, "ready task one");
  });
});

describe("App: popup open/close", () => {
  it("'!' opens the Agents popup; Esc closes the popup but App stays mounted", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });

    // Open the Agents popup via the popup-promote glyph.
    await simulateInput(mounted.stdin, "!");
    // The popup status-bar carries the popup label, e.g. "Agents · popup".
    await waitForFrame(mounted.stdout, "Agents · popup");
    // Dashboard-only card titles disappear when a popup takes over.
    expect(frame(mounted.stdout)).not.toContain("Activity log");

    // Esc closes the popup and we drop back to the dashboard.
    await simulateInput(mounted.stdin, "escape");
    await waitForFrame(mounted.stdout, "Activity log");

    // App is still running — we can interact with the dashboard.
    await simulateInput(mounted.stdin, "3");
    await waitForFrameMissing(mounted.stdout, "Ready");
  });
});

describe("App: multi-workstream Tab cycling", () => {
  it("Tab with two workstreams cycles the active tab", async () => {
    mounted = await mountApp({ workstreams: ["demo", "other"], initialActive: 0 });
    // Tab strip renders both workstream names when N > 1.
    const start = frame(mounted.stdout);
    expect(start).toContain("demo");
    expect(start).toContain("other");
    // The first agent's name carries the workstream prefix; we use it
    // to detect which ws's snapshot is currently rendered.
    expect(start).toContain("demo-worker-1");
    expect(start).not.toContain("other-worker-1");

    await simulateInput(mounted.stdin, "tab");
    await waitForFrame(mounted.stdout, "other-worker-1");
    expect(frame(mounted.stdout)).not.toContain("demo-worker-1");

    await simulateInput(mounted.stdin, "tab");
    await waitForFrame(mounted.stdout, "demo-worker-1");
  });
});

describe("App: Ctrl-C exits", () => {
  it("Ctrl-C unmounts the app via ink's exitOnCtrlC path", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    const exitPromise = mounted.waitUntilExit();
    await simulateInput(mounted.stdin, "\x03");
    await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("waitUntilExit did not resolve after Ctrl-C")), 1500),
      ),
    ]);
    // Mark mounted as null so afterEach doesn't double-unmount.
    mounted = null;
  });
});

describe("App: tick rate adjustment", () => {
  it("'+' halves the tick rate (status bar reflects the new value)", async () => {
    mounted = await mountApp({ workstreams: ["demo"] });
    // Default tick is 1.00s.
    expect(frame(mounted.stdout)).toContain("1.00s");

    await simulateInput(mounted.stdin, "+");
    // fasterTick(1000) = 500. Status bar formats as "0.50s".
    await waitForFrame(mounted.stdout, "0.50s");

    // Slow back down with '-'.
    await simulateInput(mounted.stdin, "-");
    await waitForFrame(mounted.stdout, "1.00s");
  });
});
