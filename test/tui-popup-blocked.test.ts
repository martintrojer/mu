// Tests for src/cli/tui/popups/blocked.tsx (feat_popup_7_blocked,
// workstream `tui-impl`).
//
// Same shape as test/tui-popup-workspaces.test.ts: pure-helper +
// import-graph + static-source assertions. We can't snapshot ink
// output without ink-testing-library (network-blocked).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockedPopup } from "../src/cli/tui/popups/blocked.js";

const SRC = readFileSync("./src/cli/tui/popups/blocked.tsx", "utf-8");
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const LAYOUT_SRC = readFileSync("./src/cli/tui/layout.ts", "utf-8");

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

  it("blob includes id + title + blocker ids (matches spec)", () => {
    // Per spec FILTER block: blob = `${id} ${title} ${blockerIds.join(" ")}`.
    expect(SRC).toMatch(/t\.name.*t\.title.*blockers\.join/s);
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
