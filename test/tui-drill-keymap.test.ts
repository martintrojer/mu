// Static-source guard for review_dedup_drill_keymap (workstream
// `tui-impl`): scroll-based drill leaves share one useDrillKeymap
// hook instead of copy-pasting the totalLines → applyScroll →
// close/yank switch in every popup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");
const DRILL_SRC = readFileSync(join(POPUPS_DIR, "drill.tsx"), "utf8");

function loadPopup(name: string): string {
  return readFileSync(join(POPUPS_DIR, name), "utf8");
}

const DRILL_POPUP_CASES: ReadonlyArray<{ name: string; src: string }> = [
  { name: "agents.tsx", src: loadPopup("agents.tsx") },
  { name: "all-tasks.tsx", src: loadPopup("all-tasks.tsx") },
  { name: "blocked.tsx", src: loadPopup("blocked.tsx") },
  { name: "commits.tsx", src: loadPopup("commits.tsx") },
  { name: "doctor.tsx", src: loadPopup("doctor.tsx") },
  { name: "inprogress.tsx", src: loadPopup("inprogress.tsx") },
  { name: "log.tsx", src: loadPopup("log.tsx") },
  { name: "ready.tsx", src: loadPopup("ready.tsx") },
  { name: "recent.tsx", src: loadPopup("recent.tsx") },
];

const SPECIAL_DRILL_POPUP_CASES: ReadonlyArray<{ name: string; src: string }> = [
  { name: "tracks.tsx", src: loadPopup("tracks.tsx") },
  { name: "workspaces.tsx", src: loadPopup("workspaces.tsx") },
];

const ALL_POPUP_CASES = [...DRILL_POPUP_CASES, ...SPECIAL_DRILL_POPUP_CASES];

describe("useDrillKeymap", () => {
  it("lives beside DrillScrollView and owns scroll/close/yank dispatch", () => {
    expect(DRILL_SRC).toMatch(/export function useDrillKeymap\b/);
    expect(DRILL_SRC).toMatch(/export function useWrappedBody\b/);
    expect(DRILL_SRC).toMatch(/export function wrapDrillBody\b/);
    expect(DRILL_SRC).toContain("totalLines: lines.length");
    expect(DRILL_SRC).toMatch(/isNavAction\(action\)/);
    expect(DRILL_SRC).toMatch(/applyScroll\(s, action, totalLines, viewport\)/);
    expect(DRILL_SRC).toMatch(/case "close":/);
    expect(DRILL_SRC).toMatch(/case "yank":/);
    expect(DRILL_SRC).toMatch(/case "verb":/);
    expect(DRILL_SRC).toMatch(/action\.key === "t"/);
    expect(DRILL_SRC).toContain("resetKey?: string | number");
    expect(DRILL_SRC).toContain("const resetSignal = resetKey ?? body");
    expect(DRILL_SRC).toMatch(/clampScrollTop\(s, totalLines, viewport\)/);
    expect(DRILL_SRC).toContain("wrappedBody: WrappedDrillBody");
    expect(DRILL_SRC).toContain("wrappedLines: wrappedBody.lines");
  });

  it("wraps drill bodies through one shared helper instead of two raw wrapAnsiLines call sites", () => {
    const stripped = DRILL_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const rawWrapCalls = stripped.match(/wrapAnsiLines\(/g) ?? [];
    expect(rawWrapCalls).toHaveLength(1);
    expect(stripped).toContain("const wrapped = wrapAnsiLines(body, wrapWidth)");
    expect(stripped).toContain("wrappedBody ?? wrapDrillBody(body, wrapWidth)");
  });

  for (const { name, src } of ALL_POPUP_CASES) {
    it(`${name} imports and calls the shared drill keymap hook`, () => {
      expect(src).toMatch(/useDrillKeymap/);
      expect(src).toMatch(/useDrillKeymap\(\{/);
      expect(src).toMatch(/resetKey:/);
    });
  }

  for (const { name, src } of DRILL_POPUP_CASES) {
    it(`${name} drill mode dispatches to drill.dispatch(action)`, () => {
      expect(src).toMatch(/if \(mode === "drill"\) \{\s*drill\.dispatch\(action\);\s*return;\s*\}/);
    });
  }

  it("tracks delegates the task-detail leaf to the shared hook", () => {
    const src = loadPopup("tracks.tsx");
    expect(src).toMatch(/const taskDetailDrill = useDrillKeymap\(\{/);
    expect(src).toMatch(/taskDetailDrill\.dispatch\(action\);/);
  });

  it("workspaces delegates the git-show leaf to the shared hook", () => {
    const src = loadPopup("workspaces.tsx");
    expect(src).toMatch(/const showDrill = useDrillKeymap\(\{/);
    expect(src).toMatch(/showDrill\.dispatch\(action\);/);
  });

  it("dag delegates the forest body to the shared hook", () => {
    const src = loadPopup("dag.tsx");
    expect(src).toMatch(/const drill = useDrillKeymap\(\{/);
    expect(src).toContain("resetKey: workstream");
  });

  for (const { name, src } of ALL_POPUP_CASES) {
    it(`${name} no longer imports applyScroll or recomputes drill totalLines locally`, () => {
      expect(src).not.toMatch(/import \{[^}]*applyScroll/);
      expect(src).not.toMatch(/\bconst totalLines\b/);
    });
  }
});
