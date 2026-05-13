// Tests for the In-progress popup (popups/inprogress.tsx). The full
// keymap is covered via dispatchPopupKey in test/tui-keys.test.ts;
// here we exercise the small set of pure helpers + the static-source
// invariants that pin the popup to the precedent (popups/ready.tsx
// for the Tasks-popup pattern; cards/inprogress.tsx for column +
// glyph re-use; task-detail.tsx for the recursion contract).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InProgressPopup,
  formatRoi,
  yankCommandForTask,
} from "../src/cli/tui/popups/inprogress.js";

const SRC = readFileSync("./src/cli/tui/popups/inprogress.tsx", "utf-8");

describe("InProgressPopup (export contract)", () => {
  it("is exported as a function", () => {
    expect(typeof InProgressPopup).toBe("function");
  });
});

describe("yankCommandForTask", () => {
  it('yanks `mu task close <id> -w <ws> --evidence "..."`', () => {
    expect(yankCommandForTask("design_x", "tui-impl")).toBe(
      'mu task close design_x -w tui-impl --evidence "..."',
    );
  });

  it("matches the IN_PROGRESS branch of the Tasks popup yank matrix", () => {
    // Stay consistent with popups/ready.tsx so the operator's
    // muscle memory transfers. The Tasks popup yields exactly this
    // shape for IN_PROGRESS rows.
    const cmd = yankCommandForTask("foo", "bar");
    expect(cmd).toContain("mu task close");
    expect(cmd).toContain("--evidence");
    expect(cmd).not.toContain("mu task release");
    expect(cmd).not.toContain("mu task claim");
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

describe("popups/inprogress.tsx static-source invariants", () => {
  it("re-uses Card 6 helpers (glyphFor / formatSinceClaim / ageMs / isStale)", () => {
    // Visual lockstep with the card; new card-level helpers should
    // surface in the popup automatically.
    expect(SRC).toMatch(/from "\.\.\/cards\/inprogress\.js"/);
    expect(SRC).toContain("glyphFor");
    expect(SRC).toContain("formatSinceClaim");
    expect(SRC).toContain("ageMs");
    expect(SRC).toContain("isStale");
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

  it("reads only snapshot.inProgress (no other task-list source)", () => {
    expect(SRC).toContain("snapshot.inProgress");
    // Defensive: should not pull from snapshot.ready or .blocked etc.
    expect(SRC).not.toContain("snapshot.ready");
    expect(SRC).not.toContain("snapshot.blocked");
    expect(SRC).not.toContain("snapshot.recentClosed");
  });

  it("yanks ONLY mu task close + mu task notes (no mutating verbs)", () => {
    // List-mode yank → close --evidence; drill-mode yank → notes.
    // Anything that mutates state (claim / release / open / reject /
    // defer / delete) would violate the read-only TUI pledge.
    expect(SRC).toContain("mu task close");
    expect(SRC).toContain("mu task notes");
    expect(SRC).not.toContain("mu task claim");
    expect(SRC).not.toContain("mu task release");
    expect(SRC).not.toContain("mu task open");
    expect(SRC).not.toContain("mu task reject");
    expect(SRC).not.toContain("mu task defer");
    expect(SRC).not.toContain("mu task delete");
  });
});

describe("popups/inprogress.tsx ↔ App / keys wiring", () => {
  it("App.tsx renders InProgressPopup for popup id 6", () => {
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    expect(app).toContain("InProgressPopup");
    expect(app).toMatch(/6: InProgressPopup/);
    expect(app).toMatch(/popupNameForId[\s\S]*case 6:[\s\S]*return "In-progress"/);
  });

  it("App.tsx PopupId union includes 6", () => {
    const app = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    // Union widens as more popups land (slots 5/7/8 etc); we only
    // assert 6 is in.
    expect(app).toMatch(/type PopupId = [^\n]*\b6\b[^\n]*null/);
  });

  it("keys.ts maps Shift+6 (^) to openPopup(6)", () => {
    const keys = readFileSync("./src/cli/tui/keys.ts", "utf-8");
    expect(keys).toMatch(/"\^": 6/);
    expect(keys).toMatch(/kind: "openPopup";[\s\S]*\b6\b/);
  });
});
