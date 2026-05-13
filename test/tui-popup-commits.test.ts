// Tests for src/cli/tui/popups/commits.tsx (feat_tui_commits_card).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CommitsPopup,
  commitFilterBlob,
  formatBackend,
  shortSha,
  showCommandForBackend,
} from "../src/cli/tui/popups/commits.js";
import { wrapAnsiLines } from "../src/cli/tui/wrap-ansi.js";
import type { CommitSummary } from "../src/vcs.js";

const SRC = readFileSync("./src/cli/tui/popups/commits.tsx", "utf-8");
const DRILL_SRC = readFileSync("./src/cli/tui/popups/drill.tsx", "utf-8");
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const ESC = "\u001B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const PARTIAL_ANSI_RE = new RegExp(`${ESC}(?:$|\\[[0-?]*[ -/]?$)`);

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

describe("CommitsPopup source invariants", () => {
  it("uses shared PopupShell, ListRow, usePopupFilter, central scroll, and useDrillKeymap", () => {
    expect(SRC).toContain('from "../popup-shell.js"');
    expect(SRC).toContain('from "../list-row.js"');
    expect(SRC).toContain("usePopupFilter");
    expect(SRC).toContain("applyFilter");
    expect(SRC).toContain("applyCursor");
    expect(SRC).toContain("centredVisibleSlice");
    expect(SRC).toContain("useDrillKeymap");
    expect(SRC).toContain("<DrillScrollView");
    expect(DRILL_SRC).toContain("useWrappedBody");
    expect(DRILL_SRC).toContain("wrappedBody ?? wrapDrillBody(body, wrapWidth)");
  });

  it("reads snapshot.recentCommits and filters sha + subject + author + relTime", () => {
    expect(SRC).toContain("snapshot?.recentCommits");
    expect(SRC).toMatch(/sha.*subject.*author.*relTime/s);
  });

  it("shows commits via the VcsBackend.showCommit seam, not git-only helper", () => {
    expect(SRC).toContain("detectBackend");
    expect(SRC).toContain("loadShowPreservingBody");
    expect(SRC).not.toContain("runGitShow");
    expect(SRC).not.toContain("node:child_process");
  });

  it("renders the detected backend in list, empty, and drill titles", () => {
    expect(SRC).toContain("snapshot?.commitsBackend");
    expect(SRC).toContain("formatBackend(backendName)");
    expect(SRC).toContain('"(no vcs)"');
  });

  it("yank matrix yanks backend-specific show commands in list and drill modes", () => {
    expect(SRC).toContain("showCommandForBackend");
    expect(SRC).toContain("git show");
    expect(SRC).toContain("jj show");
    expect(SRC).toContain("sl show");
    expect(SRC).toMatch(/onYank:[\s\S]*yank\(showCommand\)/);
    expect(SRC).toMatch(/case "yank":[\s\S]*showCommandForBackend/);
  });

  it("drill-mode `t` launches tuicr for the focused sha in the project cwd", () => {
    expect(SRC).toContain('from "../tuicr.js"');
    expect(SRC).toMatch(
      /onTuicr:[\s\S]*runTuicrInteractive\(\{ rev: focused\.sha, cwd: projectRoot \}\)/,
    );
    expect(SRC).toContain("onFooter?.(r.error");
    expect(SRC).toContain("t tuicr");
  });

  it("passes focused sha as useDrillKeymap resetKey so slow-tick body refreshes do not jump to top", () => {
    expect(SRC).toContain('resetKey: focused?.sha ?? ""');
  });
});

describe("App / keys wiring for Commits popup", () => {
  it("App imports and renders CommitsPopup via numeric popup id 0", () => {
    expect(APP_SRC).toContain('from "./popups/commits.js"');
    expect(APP_SRC).toMatch(/0: CommitsPopup/);
    expect(APP_SRC).toMatch(/popupNameForId[\s\S]*case 0:[\s\S]*return "Commits"/);
  });

  it("keys maps Shift+0 ')' to openPopup(0), drops l/L, and keeps Shift+8 (*) as Recent", () => {
    expect(KEYS_SRC).toMatch(/"\)":\s*0/);
    expect(KEYS_SRC).not.toMatch(/input === "l" \|\| input === "L"/);
    expect(KEYS_SRC).not.toMatch(/cardId: "commits"/);
    expect(KEYS_SRC).toMatch(/"\*":\s*8/);
  });
});
