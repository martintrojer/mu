// Tests for src/cli/tui/popups/doctor.tsx (feat_popup_9_doctor,
// workstream `tui-impl`).
//
// Same shape as test/tui-popup-blocked.test.ts: pure-helper +
// import-graph + static-source assertions. We can't snapshot ink
// output without ink-testing-library (network-blocked).
//
// Doctor popup is DIFFERENT from popups 6/7/8 — rows are NOT
// tasks, so the drill MUST NOT chain into TaskDetailDrill. The
// drill is a small ad-hoc detail view of the focused check via
// the shared DrillScrollView leaf.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DoctorPopup, renderDrillBody } from "../src/cli/tui/popups/doctor.js";
import {
  type DoctorCheck,
  remediationParagraph,
  yankCommandForCheck,
} from "../src/doctor-summary.js";

const SRC_RAW = readFileSync("./src/cli/tui/popups/doctor.tsx", "utf-8");
// Strip `// ...` line comments + `/* ... */` block comments so the
// import-graph / yank-matrix assertions don't false-positive on
// prose mentions of the forbidden tokens (e.g. "NOT TaskDetailDrill").
function stripComments(src: string): string {
  // Strip line comments FIRST so a `// ... src/cli/tui/*.` line
  // (yes, those exist in the source headers) doesn't open a false
  // block comment when the block-comment regex runs over it.
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
const SRC = stripComments(SRC_RAW);
const APP_SRC = readFileSync("./src/cli/tui/app.tsx", "utf-8");
const KEYS_SRC = readFileSync("./src/cli/tui/keys.ts", "utf-8");
const SUMMARY_SRC = readFileSync("./src/doctor-summary.ts", "utf-8");

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

describe("DoctorPopup: data source — ALL checks (not just non-OK)", () => {
  it("calls loadDoctorChecks(db, snapshot) — NOT snapshot.doctor.checks", () => {
    // The card filters to non-OK rows; the popup must show every
    // check. loadDoctorChecks is the SDK seam that returns the
    // full array.
    expect(SRC).toMatch(/loadDoctorChecks\s*\(/);
  });

  it("does NOT silently fall back to snapshot.doctor (the truncated set)", () => {
    // The popup MUST go through loadDoctorChecks; reading
    // snapshot.doctor.checks would be wrong (Card 9 may pre-filter
    // it in future).
    expect(SRC).not.toContain("snapshot.doctor.checks");
    expect(SRC).not.toContain("snap.doctor.checks");
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

  it("uses the shared DrillScrollView leaf for the drill body", () => {
    expect(SRC).toContain("DrillScrollView");
    expect(SRC).toMatch(/from\s+"\.\/drill\.js"/);
  });

  it("drill mode is plumbed via the standard list ↔ drill toggle", () => {
    expect(SRC).toContain('onModeChange("drill")');
    expect(SRC).toContain('onModeChange("list")');
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

describe("DoctorPopup: '/' filter (consumes the shared primitive)", () => {
  it("imports usePopupFilter / applyFilter / FilterPrompt", () => {
    expect(SRC).toContain("usePopupFilter");
    expect(SRC).toContain("applyFilter");
    expect(SRC).toContain("FilterPrompt");
  });

  it("blob includes name + status + detail (matches spec)", () => {
    // Per spec FILTER block: blob = `${name} ${status} ${detail}`.
    expect(SRC).toMatch(/c\.name.*c\.status.*c\.detail/s);
  });
});

describe("DoctorPopup: list layout — glyph + check + STATUS + detail", () => {
  it("renders all four columns: glyph, check name, status, detail", () => {
    expect(SRC).toContain("glyph");
    expect(SRC).toContain("check name");
    expect(SRC).toContain("status");
    expect(SRC).toContain("detail");
  });

  it("only the detail column is CLIPPABLE (everything else is PROTECTED)", () => {
    // Per feat_column_aligned_lists clipping policy.
    const clipMatches = SRC.match(/kind:\s*"clip"/g) ?? [];
    expect(clipMatches.length).toBe(1);
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

  it("app.tsx renderPopup has a case 9 → <DoctorPopup />", () => {
    expect(APP_SRC).toMatch(/case 9:\s*\n\s*return <DoctorPopup/);
  });

  it("app.tsx popupNameForId(9) returns 'Doctor'", () => {
    expect(APP_SRC).toMatch(/case 9:\s*\n\s*return "Doctor"/);
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
