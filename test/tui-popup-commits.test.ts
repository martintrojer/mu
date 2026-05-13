// Tests for src/cli/tui/popups/commits.tsx (feat_tui_commits_card).

import { readFileSync } from "node:fs";
import { render } from "ink";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommitsPopup,
  commitFilterBlob,
  formatBackend,
  shortSha,
  showCommandForBackend,
} from "../src/cli/tui/popups/commits.js";
import { wrapAnsiLines } from "../src/cli/tui/wrap-ansi.js";
import type { Db } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { CommitSummary } from "../src/vcs.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
  waitForInkOutput,
} from "./_ink-render.js";

const mockVcs = vi.hoisted(() => ({
  showText: "commit 1111111\n+ mocked git show body",
  showError: null as string | null,
  calls: [] as Array<{ path: string; sha: string }>,
}));

vi.mock("../src/vcs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs.js")>();
  return {
    ...actual,
    detectBackend: vi.fn(async (_path: string) => ({
      name: "git",
      showCommit: async (showPath: string, sha: string) => {
        mockVcs.calls.push({ path: showPath, sha });
        if (mockVcs.showError !== null) {
          return { text: "", truncated: false, error: mockVcs.showError };
        }
        return { text: mockVcs.showText, truncated: false };
      },
    })),
  };
});

const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const ESC = "\u001B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const PARTIAL_ANSI_RE = new RegExp(`${ESC}(?:$|\\[[0-?]*[ -/]?$)`);

const originalStdoutColumns = process.stdout.columns;

afterEach(() => {
  mockVcs.showText = "commit 1111111\n+ mocked git show body";
  mockVcs.showError = null;
  mockVcs.calls = [];
  Object.defineProperty(process.stdout, "columns", {
    value: originalStdoutColumns,
    configurable: true,
  });
  CaptureStream.cleanup();
});

function commit(over: Partial<CommitSummary> = {}): CommitSummary {
  return {
    sha: "1234567890abcdef",
    subject: "ship commits popup",
    body: "",
    author: "tester",
    authorDate: "2026-05-11T00:00:00Z",
    relTime: "4m",
    ...over,
  };
}

function snapshot(over: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
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
  snapshot: WorkstreamSnapshot;
  yanked: string[];
  footer: string[];
  closed: { value: boolean };
}

function CommitsHarness({ snapshot, yanked, footer, closed }: HarnessProps): JSX.Element {
  const [mode, setMode] = useState<"list" | "drill">("list");
  return createElement(CommitsPopup, {
    yank: async (command: string) => {
      yanked.push(command);
    },
    onClose: () => {
      closed.value = true;
    },
    snapshot,
    slowTickNonce: 0,
    mode,
    onModeChange: setMode,
    onFooter: (command: string) => {
      footer.push(command);
    },
    db: {} as Db,
    workstream: "demo",
  });
}

async function renderCommitsPopup(snapshotValue: WorkstreamSnapshot): Promise<{
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
  const footer: string[] = [];
  const closed = { value: false };
  const instance = render(
    createElement(CommitsHarness, { snapshot: snapshotValue, yanked, footer, closed }),
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

describe("CommitsPopup export + pure helpers", () => {
  it("is exported as a function", () => {
    expect(typeof CommitsPopup).toBe("function");
  });

  it("shortSha returns seven characters", () => {
    expect(shortSha("abcdef0123456789")).toBe("abcdef0");
  });

  it("formatBackend labels missing detection distinctly", () => {
    expect(formatBackend("git")).toBe("git");
    expect(formatBackend(null)).toBe("(no vcs)");
  });

  it("showCommandForBackend covers all VCS backends", () => {
    expect(showCommandForBackend("git", "abc")).toBe("git show abc");
    expect(showCommandForBackend("jj", "abc")).toBe("jj show abc");
    expect(showCommandForBackend("sl", "abc")).toBe("sl show abc");
    expect(showCommandForBackend("none", "abc")).toContain("no VCS backend");
  });

  it("commitFilterBlob searches sha, subject, author, and relTime", () => {
    expect(commitFilterBlob(commit())).toContain("1234567");
    expect(commitFilterBlob(commit())).toContain("ship commits popup");
    expect(commitFilterBlob(commit())).toContain("tester");
    expect(commitFilterBlob(commit())).toContain("4m");
  });
});

describe("CommitsPopup ANSI wrapping", () => {
  it("wraps ANSI show output without splitting escape sequences or leaking active SGR", () => {
    const body = `${RED}-${"a".repeat(12)}${RESET}\n${GREEN}+${"b".repeat(12)}${RESET}`;
    const wrapped = wrapAnsiLines(body, 5).split("\n");

    expect(wrapped.map((line) => line.replace(ANSI_RE, ""))).toEqual([
      "-aaaa",
      "aaaaa",
      "aaa",
      "+bbbb",
      "bbbbb",
      "bbb",
    ]);
    for (const line of wrapped) {
      expect(line).not.toMatch(PARTIAL_ANSI_RE);
      expect(line.match(ANSI_RE)?.join("") ?? "").not.toContain("\n");
      expect(line.endsWith(RESET)).toBe(true);
    }
  });
});

describe("CommitsPopup behaviour", () => {
  it("renders recent commits, filters by commit metadata, and yanks the focused show command", async () => {
    const snap = snapshot({
      recentCommits: [
        commit({
          sha: "1111111111111111",
          subject: "alpha subject",
          author: "alice",
          relTime: "1m",
        }),
        commit({
          sha: "2222222222222222",
          subject: "beta subject",
          author: "bob",
          relTime: "2m",
        }),
      ],
      commitsBackend: "git",
    });
    const r = await renderCommitsPopup(snap);
    try {
      let text = frameText(r.stdout);
      expect(text).toContain("Commits · git (1/2)");
      expect(text).toContain("1111111");
      expect(text).toContain("alpha subject");
      expect(text).toContain("bob");

      await simulateInput(r.stdin, "j");
      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["git show 2222222222222222"]);

      await typeFilter(r.stdin, "alice");
      text = await waitForFrame(r.stdout, "[filter] alice");
      expect(text).toContain("1111111");
      expect(text).toContain("alpha subject");
      expect(text).not.toContain("2222222");
      expect(text).not.toContain("beta subject");
    } finally {
      r.unmount();
    }
  });

  it("Enter drills into VCS show output, y yanks there too, and Esc returns to the list", async () => {
    const snap = snapshot({
      recentCommits: [commit({ sha: "1111111111111111", subject: "alpha subject" })],
      commitsBackend: "git",
    });
    const r = await renderCommitsPopup(snap);
    try {
      await simulateInput(r.stdin, "enter");
      let text = await waitForFrame(r.stdout, "+ mocked git show body");
      expect(text).toContain("Commits · git · 1111111");
      expect(text).toContain("git show 1111111111111111 · alpha subject");
      expect(mockVcs.calls).toEqual([{ path: process.cwd(), sha: "1111111111111111" }]);

      await simulateInput(r.stdin, "y");
      expect(r.yanked).toEqual(["git show 1111111111111111"]);

      await simulateInput(r.stdin, "escape");
      text = await waitForFrame(r.stdout, "Commits · git (1/1)");
      expect(text).toContain("alpha subject");
      expect(text).not.toContain("mocked git show body");
    } finally {
      r.unmount();
    }
  });
});

describe("App / keys wiring for Commits popup", () => {
  it("App imports and renders CommitsPopup via numeric popup id 0", () => {
    expect(APP_SRC).toContain('from "./popups/commits.js"');
    expect(APP_SRC).toMatch(/0: CommitsPopup/);
    // Post-review_tui_card_key_from_id_redundant: popupNameForId
    // reads CARD_CONFIGS[id].label instead of a 24-line switch.
    const layoutSrc = readFileSync("./src/cli/tui/layout.ts", "utf-8");
    expect(layoutSrc).toMatch(/0:\s*\{[^}]*label:\s*"Commits"/);
  });

  it("keys maps Shift+0 ')' to openPopup(0), drops l/L, and keeps Shift+8 (*) as Recent", () => {
    expect(KEYS_SRC).toMatch(/"\)":\s*0/);
    expect(KEYS_SRC).not.toMatch(/input === "l" \|\| input === "L"/);
    expect(KEYS_SRC).not.toMatch(/cardId: "commits"/);
    expect(KEYS_SRC).toMatch(/"\*":\s*8/);
  });
});
