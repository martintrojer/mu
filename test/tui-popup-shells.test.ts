// Static-source assertion that every fullscreen popup imports the
// shared PopupShell wrapper instead of redefining a local shell.
//
// PopupShell owns the anti-narrow-strip invariant by delegating to
// TitledBox with `flexGrow={1}`:
//   - flexGrow={1}    → vertical: occupy room granted by App's
//                       height-pinned popup branch.
//   - width={cols}    → horizontal: TitledBox derives this internally
//                       from useStdout().columns (titled-box.tsx).
//
// Without either, ink's Yoga layout sizes the popup chrome to its
// content and the popup renders as a narrow strip in the upper-left
// of the pane (the symptom of bug_tui_popups_fill_pane).
//
// We also assert that for popups with a "viewport + bottom hint"
// layout, the body region is itself wrapped in a flexGrow={1} box
// so the hint sticks to the popup's bottom (lazygit/btop "sticky
// bottom hint" convention).
//
// Crude string scan, but cheap and catches the regression. The
// alternative — render the popup against ink-testing-library — is
// not installable in this network-blocked environment.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TUI_DIR = join(import.meta.dirname, "..", "src", "cli", "tui");
const POPUPS_DIR = join(TUI_DIR, "popups");

function loadPopup(name: string): string {
  return readFileSync(join(POPUPS_DIR, name), "utf8");
}

function loadTui(name: string): string {
  return readFileSync(join(TUI_DIR, name), "utf8");
}

const AGENTS = loadPopup("agents.tsx");
const LOG = loadPopup("log.tsx");
const READY = loadPopup("ready.tsx");
const TRACKS = loadPopup("tracks.tsx");
const WORKSPACES = loadPopup("workspaces.tsx");
const INPROGRESS = loadPopup("inprogress.tsx");
const BLOCKED = loadPopup("blocked.tsx");
const COMMITS = loadPopup("commits.tsx");
const RECENT = loadPopup("recent.tsx");
const DOCTOR = loadPopup("doctor.tsx");
const POPUP_SHELL = loadTui("popup-shell.tsx");

const POPUP_CASES: ReadonlyArray<{ name: string; src: string }> = [
  { name: "agents.tsx", src: AGENTS },
  { name: "log.tsx", src: LOG },
  { name: "ready.tsx", src: READY },
  { name: "tracks.tsx", src: TRACKS },
  { name: "workspaces.tsx", src: WORKSPACES },
  { name: "inprogress.tsx", src: INPROGRESS },
  { name: "blocked.tsx", src: BLOCKED },
  { name: "commits.tsx", src: COMMITS },
  { name: "recent.tsx", src: RECENT },
  { name: "doctor.tsx", src: DOCTOR },
];

describe("shared PopupShell fills the pane (anti-narrow-strip)", () => {
  it("delegates to <TitledBox> (no hand-rolled rounded box)", () => {
    expect(POPUP_SHELL).toMatch(/<TitledBox\b/);
    expect(POPUP_SHELL).not.toMatch(/borderStyle="round"/);
  });

  it("passes flexGrow={1} into TitledBox (vertical fill)", () => {
    expect(POPUP_SHELL).toMatch(/flexGrow=\{1\}/);
  });

  it("passes title and nullable hint through to TitledBox", () => {
    expect(POPUP_SHELL).toMatch(/title=\{title\}/);
    expect(POPUP_SHELL).toMatch(/bottomLabel=\{hint \?\? undefined\}/);
  });

  it("imports TitledBox from titled-box", () => {
    expect(POPUP_SHELL).toMatch(/from "\.\/titled-box\.js"/);
    expect(POPUP_SHELL).toMatch(/\bTitledBox\b/);
  });
});

describe("popups consume the shared PopupShell", () => {
  for (const { name, src } of POPUP_CASES) {
    it(`${name} imports PopupShell instead of defining a local shell`, () => {
      expect(src).toMatch(/import \{ PopupShell \} from "\.\.\/popup-shell\.js";/);
      expect(src).toMatch(/<PopupShell\b/);
      expect(src).not.toMatch(/function Shell\s*\(/);
      expect(src).not.toMatch(/function PopupShell\s*\(/);
    });
  }
});

describe("popup body region wraps content in flexGrow={1} (sticky bottom hint)", () => {
  for (const { name, src } of POPUP_CASES) {
    it(`${name} contains a flexGrow={1} body wrapper`, () => {
      // Match either property order.
      expect(src).toMatch(
        /<Box[^>]*\bflexDirection="column"[^>]*\bflexGrow=\{1\}|<Box[^>]*\bflexGrow=\{1\}[^>]*\bflexDirection="column"/,
      );
    });
  }
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("drill-mode bottom hints stay yank-only (no duplicate StatusBar nav cluster)", () => {
  for (const { name, src } of POPUP_CASES) {
    it(`${name} drill-mode hint text does not repeat navigation keys`, () => {
      // List-mode hints are intentionally untouched, so don't ban
      // e.g. Recent's list-mode "Esc/q close" recipe. The duplicate
      // bug was specifically the drill-mode nav cluster: j/k scroll,
      // Ctrl-D/U half-page, and Esc/q back. Comments may document the
      // keymap, but renderable hint/text strings must not carry it.
      const renderable = stripComments(src);
      expect(renderable).not.toMatch(/j\/k\s+(?:scroll|nav)|Ctrl-D|Esc\/?q? back/);
    });
  }
});
