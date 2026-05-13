// Tests for src/cli/tui/popups/workspaces.tsx (feat_popup_5_workspaces,
// workstream `tui-impl`).
//
// We can't snapshot ink output without ink-testing-library (network-
// blocked). Instead we exercise:
//   1. The pure helpers (formatDirty / colorForDirty) directly.
//   2. The import-graph contract (popup is exported, app.tsx wires it).
//   3. Static-source assertions for the key wiring (yank intent,
//      drill data source, filter primitive consumption, columns, etc.)
//
// Mirrors the structure of test/tui-popup-agents.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadShowPreservingBody } from "../src/cli/tui/popups/show-loader.js";
import { WorkspacesPopup, colorForDirty, formatDirty } from "../src/cli/tui/popups/workspaces.js";

const SRC = readFileSync("./src/cli/tui/popups/workspaces.tsx", "utf-8");
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");

describe("WorkspacesPopup: export contract", () => {
  it("is exported as a function", () => {
    expect(typeof WorkspacesPopup).toBe("function");
  });

  it("re-uses card 5's pure colour/glyph helpers (no duplication)", () => {
    // Mirrors Card 5; the popup MUST import the four helpers rather
    // than re-derive them. Keeps the popup ↔ card visually in sync.
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("colorForGlyph");
    expect(SRC).toContain("colorForBehind");
    expect(SRC).toContain("formatBehind");
    expect(SRC).toMatch(/from\s+"\.\.\/cards\/workspaces\.js"/);
  });
});

describe("WorkspacesPopup: pure helpers", () => {
  describe("formatDirty", () => {
    it("yes when dirty", () => expect(formatDirty(true)).toBe("yes"));
    it("no when clean", () => expect(formatDirty(false)).toBe("no"));
    it("— when unknown (null)", () => expect(formatDirty(null)).toBe("—"));
    it("— when unknown (undefined)", () => expect(formatDirty(undefined)).toBe("—"));
  });
  describe("colorForDirty", () => {
    it("red when dirty", () => expect(colorForDirty(true)).toBe("red"));
    it("undefined when clean", () => expect(colorForDirty(false)).toBeUndefined());
    it("undefined when unknown", () => {
      expect(colorForDirty(null)).toBeUndefined();
      expect(colorForDirty(undefined)).toBeUndefined();
    });
  });
});

describe("WorkspacesPopup: yank intents (read-only)", () => {
  it("list-mode yank → `cd $(mu workspace path <agent> -w <ws>)` (canonical entry)", () => {
    expect(SRC).toContain("cd $(mu workspace path");
  });

  it("drill-mode yank → `git show <sha>` (cherry-pick discovery)", () => {
    expect(SRC).toContain("git show");
  });

  it("never spells a mutating verb (read-only pledge)", () => {
    // The popup's own act-intents must stay read-only. We sanity-
    // check that none of the workspace-mutating mu verbs surface as
    // yank templates. (They'd fail review even if asserted, so this
    // is a defensive net.)
    for (const forbidden of [
      "mu workspace free",
      "mu workspace recreate",
      "mu workspace refresh",
    ]) {
      expect(SRC, `forbidden mutating yank: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("WorkspacesPopup: drill is the commits-since-fork list (NOT TaskDetailDrill)", () => {
  it("drill data source is listCommitsForWorkspace (workspace SDK)", () => {
    // Drill loads commits via the existing typed verb. NOT the
    // task-notes path (TaskDetailDrill); workspaces aren't tasks.
    expect(SRC).toContain("listCommitsForWorkspace");
  });

  it("does not import TaskDetailDrill (workspaces aren't tasks)", () => {
    // Comments may mention TaskDetailDrill (e.g. "Drill is NOT
    // TaskDetailDrill"); the load-bearing assertion is no import.
    expect(SRC).not.toMatch(/from\s+"[^"]*task-detail[^"]*"/);
    expect(SRC).not.toMatch(/import[^;]*TaskDetailDrill/);
  });

  it("drill mode is plumbed via the standard onModeChange list ↔ drill toggle", () => {
    expect(SRC).toContain('onModeChange("drill")');
    expect(SRC).toContain('onModeChange("list")');
  });
});

describe("WorkspacesPopup: Enter on focused commit drills into git show diff (feat_workspaces_drill_git_show)", () => {
  it("loadShow preserves the previous body while the backend refetch is pending", async () => {
    const states: string[] = [];
    let text = "previous diff body";
    let error: string | null = "old error";
    let loading = false;
    let resolveShow: ((value: { text: string; truncated: boolean }) => void) | undefined;
    const showPromise = new Promise<{ text: string; truncated: boolean }>((resolve) => {
      resolveShow = resolve;
    });

    const pending = loadShowPreservingBody(
      "/repo",
      "abc123",
      async () => ({
        showCommit: async () => showPromise,
      }),
      {
        setText: (next) => {
          text = next;
          states.push(`text:${next}`);
        },
        setError: (next) => {
          error = next;
          states.push(`error:${next ?? "null"}`);
        },
        setLoading: (next) => {
          loading = next;
          states.push(`loading:${String(next)}`);
        },
      },
    );

    await Promise.resolve();
    expect(loading).toBe(true);
    expect(error).toBeNull();
    expect(text).toBe("previous diff body");
    expect(states).not.toContain("text:");

    if (resolveShow === undefined) throw new Error("show promise was not captured");
    resolveShow({ text: "new diff body", truncated: false });
    await pending;

    expect(text).toBe("new diff body");
    expect(loading).toBe(false);
  });

  it("clears the body on an actual show error", async () => {
    let text = "previous diff body";
    let error: string | null = null;
    await loadShowPreservingBody(
      "/repo",
      "bad",
      async () => ({
        showCommit: async () => ({ text: "", truncated: false, error: "bad revision" }),
      }),
      {
        setText: (next) => {
          text = next;
        },
        setError: (next) => {
          error = next;
        },
        setLoading: () => {},
      },
    );

    expect(error).toBe("bad revision");
    expect(text).toBe("");
  });

  it("delegates git show through the shared VcsBackend.showCommit seam", () => {
    expect(SRC).toContain("detectBackend");
    expect(SRC).toContain("loadShowPreservingBody");
    expect(SRC).not.toContain("node:child_process");
    expect(SRC).not.toMatch(/\bexecFile\b/);
  });

  it("renders the diff via the shared <DrillScrollView> primitive (mirrors log.tsx)", () => {
    // Spec mirrors commit 0e3f6db (Log popup Enter drill): same
    // shared primitive, same scroll-state pattern.
    expect(SRC).toContain('from "./drill.js"');
    expect(SRC).toContain("<DrillScrollView");
    // Per review_dedup_drill_keymap the per-popup applyScroll /
    // setShowScrollTop skeleton now lives in useDrillKeymap.
    expect(SRC).toContain("useDrillKeymap");
    expect(SRC).toContain("showDrill.scrollTop");
    expect(SRC).not.toContain("setShowScrollTop");
  });

  it("Enter in drill mode triggers show mode; slow tick/effect fetches the body", () => {
    // The drill-mode keymap's `case "drill"` branch enters the
    // third level; the slow-tick effect owns the subprocess fetch so
    // the body also refreshes while held open.
    expect(SRC).toMatch(/case "drill":\s*\{[^}]*setShowSha\(c\.sha\)/);
    expect(SRC).toMatch(/if \(inShow && focused !== undefined && showSha !== null\)/);
    expect(SRC).toMatch(/loadShow\(focused\.path,\s*showSha\)/);
    expect(SRC).toMatch(/\[inShow, focused, showSha, loadShow, slowTickNonce\]/);
  });

  it("show mode is popup-local (does NOT widen <App>'s PopupMode union)", () => {
    // Spec: "keep mode local to workspaces.tsx if PopupMode is
    // currently a union of 'list' | 'drill' only". The union must
    // stay binary; the third level rides on the local showSha
    // sentinel inside drill mode.
    expect(APP_SRC).toMatch(/export type PopupMode = "list" \| "drill";/);
    // The popup itself doesn't widen its accepted mode either.
    expect(SRC).toContain('mode: "list" | "drill"');
  });

  it("y in show mode yanks `git show <sha>` (the COMMAND, per spec)", () => {
    // Spec: "'y' in 'show' mode yanks `git show <sha>` (the same as
    // drill mode — operator wants the command, not the captured
    // output)."
    expect(SRC).toMatch(/yank\(`git show \$\{showSha\}`\)/);
  });

  it("t in show mode launches tuicr for the focused commit in the project cwd", () => {
    expect(SRC).toContain('from "../tuicr.js"');
    expect(SRC).toMatch(
      /onTuicr:[\s\S]*runTuicrInteractive\(\{ rev: showSha, cwd: projectRoot \}\)/,
    );
    expect(SRC).toContain("onFooter?.(r.error");
    expect(SRC).toContain("t tuicr");
  });

  it("resets show-state on focused-workspace change + on leaving drill", () => {
    // Spec STATE LIFECYCLE block: reset on (a) mode change away
    // from show / drill, (b) focused workspace change.
    expect(SRC).toMatch(/setShowSha\(null\)/);
    expect(SRC).toMatch(/focused\?\.agentName/);
    // Mode-change-away effect.
    expect(SRC).toMatch(/if \(mode !== "drill"\)/);
  });

  it("Esc/q in show mode backs out to commits list (does NOT close popup)", () => {
    // The show-mode close callback clears showSha but does NOT call
    // onClose / onModeChange("list") — dropping showSha back-rolls
    // to the commits-drill view, exactly like log.tsx's drill back
    // returns to the events list.
    const showHookBlock = SRC.match(/const showDrill = useDrillKeymap\(\{[\s\S]*?\}\);/);
    expect(showHookBlock).not.toBeNull();
    expect(showHookBlock?.[0]).toContain("onClose: () => setShowSha(null)");
    expect(showHookBlock?.[0]).not.toContain("onClose()");
    expect(showHookBlock?.[0]).not.toContain('onModeChange("list")');
  });

  it("passes showSha as useDrillKeymap resetKey so slow-tick body refreshes do not jump to top", () => {
    expect(SRC).toContain('resetKey: showSha ?? ""');
  });
});

describe("WorkspacesPopup: '/' filter (consumes the shared primitive)", () => {
  it("imports usePopupFilter / applyFilter / FilterPrompt", () => {
    expect(SRC).toContain("usePopupFilter");
    expect(SRC).toContain("applyFilter");
    expect(SRC).toContain("FilterPrompt");
  });

  it("blob includes agent + backend + parent_ref + dirty marker (matches spec)", () => {
    // The spec MATCHING RULES: search blob =
    //   `${agent} ${backend} ${parent_ref} ${dirty?'dirty':''}`
    expect(SRC).toMatch(/agentName.*backend.*parentRef/s);
    expect(SRC).toContain('"dirty"');
  });

  it("the commits drill ALSO wires its own filter (sha + subject)", () => {
    // Spec: "DO plug into use-popup-filter for the commits view too
    //  — '/' substring search across sha+subject is helpful when
    //  there are 30+ commits."
    expect(SRC).toMatch(/sha.*subject/);
    // Two distinct filter instances (workspace list + commits drill).
    const matches = SRC.match(/usePopupFilter\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("WorkspacesPopup: list layout is Card 5 columns + 2 extras", () => {
  it("renders all seven popup columns: glyph, agent, backend, behind, dirty, parent_ref, path", () => {
    // The spec's POPUP LAYOUT block — extras over the card:
    //   dirty? + path. The other five mirror Card 5.
    expect(SRC).toContain("status glyph");
    expect(SRC).toContain("agent name");
    expect(SRC).toContain("backend");
    expect(SRC).toContain("commits-behind");
    expect(SRC).toContain("dirty?");
    expect(SRC).toContain("parent_ref short");
    expect(SRC).toContain("path");
  });

  it("only the path column is CLIPPABLE (everything else is PROTECTED)", () => {
    // Per feat_column_aligned_lists clipping policy. Yank-bearing
    // tokens must not truncate.
    const clipMatches = SRC.match(/kind:\s*"clip"/g) ?? [];
    expect(clipMatches.length).toBeGreaterThanOrEqual(1);
    // Drill list also clips subject (sha is protected).
    expect(clipMatches.length).toBeLessThanOrEqual(2);
  });
});

describe("App ↔ keys wiring for popup 5", () => {
  it("app.tsx imports WorkspacesPopup", () => {
    expect(APP_SRC).toContain('from "./popups/workspaces.js"');
    expect(APP_SRC).toContain("WorkspacesPopup");
  });

  it("app.tsx POPUP_REGISTRY maps 5 → WorkspacesPopup", () => {
    expect(APP_SRC).toMatch(/5: WorkspacesPopup/);
  });

  it("app.tsx popupNameForId(5) returns 'Workspaces'", () => {
    expect(APP_SRC).toMatch(/popupNameForId[\s\S]*case 5:[\s\S]*return "Workspaces"/);
  });

  it("app.tsx PopupId union includes 5", () => {
    // Match a regex so additional slot promotions (slot-7 popup,
    // slot-6 popup, ...) don't false-fire on the literal union.
    expect(APP_SRC).toMatch(/type PopupId = [^\n]*\b5\b[^\n]*null/);
  });

  it("keys.ts maps '%' → openPopup(5)", () => {
    // The glyph map should now include "%": 5 (not a placeholder
    // noop). Per the task brief KEYS WIRING block.
    expect(KEYS_SRC).toMatch(/"%":\s*5/);
  });
});
