// Tests for the Recent popup (popups/recent.tsx). The full keymap
// is covered via dispatchPopupKey in test/tui-keys.test.ts; here we
// exercise the small set of pure helpers + the static-source
// invariants that pin the popup to the precedent (popups/ready.tsx
// and popups/inprogress.tsx for the list-of-tasks pattern;
// cards/recent.tsx for column + glyph re-use; task-detail.tsx for
// the recursion contract).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RecentPopup, formatRoi, yankCommandForTask } from "../src/cli/tui/popups/recent.js";

const SRC = readFileSync("./src/cli/tui/popups/recent.tsx", "utf-8");

describe("RecentPopup (export contract)", () => {
  it("is exported as a function", () => {
    expect(typeof RecentPopup).toBe("function");
  });
});

describe("yankCommandForTask", () => {
  it("yanks `mu task open <id> -w <ws>`", () => {
    expect(yankCommandForTask("design_x", "tui-impl")).toBe("mu task open design_x -w tui-impl");
  });

  it("matches the CLOSED branch of the Tasks popup yank matrix", () => {
    // Stay consistent with popups/ready.tsx so the operator's
    // muscle memory transfers. The Tasks popup yields exactly this
    // shape for CLOSED rows (re-open is the typical act-intent).
    const cmd = yankCommandForTask("foo", "bar");
    expect(cmd).toContain("mu task open");
    expect(cmd).not.toContain("mu task close");
    expect(cmd).not.toContain("mu task release");
    expect(cmd).not.toContain("mu task claim");
    expect(cmd).not.toContain("--evidence");
  });
});

describe("formatRoi", () => {
  it("returns rounded integer for finite ROI", () => {
    expect(formatRoi(60, 0.2)).toBe("300");
    expect(formatRoi(75, 1)).toBe("75");
    expect(formatRoi(50, 3)).toBe("17");
  });

  it("returns ∞ for zero / negative effortDays", () => {
    expect(formatRoi(60, 0)).toBe("∞");
    expect(formatRoi(60, -1)).toBe("∞");
  });
});

describe("popups/recent.tsx static-source invariants", () => {
  it("re-uses Card 8 helpers (glyphFor / formatWhen / ageMs)", () => {
    // Visual lockstep with the card; new card-level helpers should
    // surface in the popup automatically.
    expect(SRC).toMatch(/from "\.\.\/cards\/recent\.js"/);
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("formatWhen");
    expect(SRC).toContain("ageMs");
  });

  it("consumes the shared TaskDetailDrill + useNotesDrill hook (recursion contract)", () => {
    // Per feat_track_drill_chains_to_task_drill: rows ARE tasks, so
    // Enter must chain into TaskDetailDrill. We assert the import
    // and the mode flip wired by the keymap switch.
    expect(SRC).toContain("TaskDetailDrill");
    // Post-review_tui_task_popups_duplicated_template: the per-popup
    // renderNotes useMemo moved into the shared useNotesDrill hook.
    expect(SRC).toContain("useNotesDrill");
    expect(SRC).toContain('onModeChange("drill")');
    expect(SRC).toContain('onModeChange("list")');
  });

  it("consumes usePopupFilter (per feat_popup_search_filter pledge)", () => {
    expect(SRC).toContain("usePopupFilter");
    expect(SRC).toContain("applyFilter");
    expect(SRC).toContain("FilterPrompt");
  });

  it("filter blob covers id + title + owner (matching rules)", () => {
    expect(SRC).toMatch(/\$\{t\.name\} \$\{t\.title\} \$\{t\.ownerName \?\? ""\}/);
  });

  it("reads only snapshot.recentClosed (no other task-list source)", () => {
    expect(SRC).toContain("snapshot.recentClosed");
    // Defensive: should not pull from snapshot.ready / .inProgress / .blocked.
    expect(SRC).not.toContain("snapshot.ready");
    expect(SRC).not.toContain("snapshot.inProgress");
    expect(SRC).not.toContain("snapshot.blocked");
  });

  it("yanks ONLY mu task open + mu task notes (no mutating verbs)", () => {
    // List-mode yank → open; drill-mode yank → notes. Anything
    // that mutates state (claim / release / close / reject / defer
    // / delete) would violate the read-only TUI pledge.
    // (`mu task open` toggles status back to OPEN but the TUI
    // itself never executes — it only puts the command on the
    // clipboard; the operator runs it in a shell.)
    expect(SRC).toContain("mu task open");
    expect(SRC).toContain("mu task notes");
    expect(SRC).not.toContain("mu task close");
    expect(SRC).not.toContain("mu task claim");
    expect(SRC).not.toContain("mu task release");
    expect(SRC).not.toContain("mu task reject");
    expect(SRC).not.toContain("mu task defer");
    expect(SRC).not.toContain("mu task delete");
  });
});

describe("popups/recent.tsx ↔ App / keys wiring", () => {
  it("App.tsx still renders RecentPopup for popup id 8", () => {
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    expect(app).toContain("RecentPopup");
    expect(app).toMatch(/case 8:\s*\n\s*return <RecentPopup/);
    expect(app).toMatch(/popupNameForId[\s\S]*case 8:[\s\S]*return "Recent"/);
  });

  it("keys.ts maps Shift+8 (*) to openPopup(8)", () => {
    const keys = readFileSync("./src/cli/tui/keys.ts", "utf-8");
    expect(keys).toMatch(/"\*":\s*8/);
    expect(keys).toMatch(/kind: "openPopup";[\s\S]*\b8\b/);
  });
});
