// Static-source assertion that every popup's local Shell/PopupShell
// component fills the popup pane on BOTH axes by delegating to
// TitledBox with `flexGrow={1}`:
//   - flexGrow={1}    → vertical: occupy room granted by App's
//                       height-pinned popup branch.
//   - width={cols}    → horizontal: TitledBox derives this internally
//                       from useStdout().columns (titled-box.tsx).
//
// Without either, ink's Yoga layout sizes the Shell to its content
// and the popup renders as a narrow strip in the upper-left of the
// pane (the symptom of bug_tui_popups_fill_pane).
//
// Pre-nit_tui_drill_inset_title_and_hints each Shell hand-rolled a
// `<Box borderStyle="round">` with explicit `flexGrow={1}` /
// `width={cols}` / `useStdout()`. Layer 1 of that nit collapsed
// every Shell into a TitledBox-only delegate so the popup's title
// inset into the top border (lazygit/btop convention) and a
// per-popup hint can inset into the bottom border. The horizontal-
// fill + edge-to-edge invariants now live inside TitledBox; we just
// verify the Shell wires `flexGrow={1}` through.
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

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");

function load(name: string): string {
  return readFileSync(join(POPUPS_DIR, name), "utf8");
}

const AGENTS = load("agents.tsx");
const LOG = load("log.tsx");
const READY = load("ready.tsx");
const TRACKS = load("tracks.tsx");
const WORKSPACES = load("workspaces.tsx");
const INPROGRESS = load("inprogress.tsx");
const BLOCKED = load("blocked.tsx");
const RECENT = load("recent.tsx");
const DOCTOR = load("doctor.tsx");

// Each shell function definition starts with `function Shell(` or
// `function PopupShell(`. We slice from that header to the closing
// `}` of its first containing return (cheap heuristic: the popup
// files have no other top-level Shell/PopupShell, and the function
// body is short). For robustness we slice to EOF — the Shell is
// always defined last in each file.
function shellSource(src: string, fnName: "Shell" | "PopupShell"): string {
  const anchor = `function ${fnName}(`;
  const i = src.indexOf(anchor);
  expect(i, `${fnName} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(i);
}

describe("popup Shell / PopupShell fills the pane (anti-narrow-strip)", () => {
  const cases: ReadonlyArray<{ name: string; src: string; fn: "Shell" | "PopupShell" }> = [
    { name: "agents.tsx", src: AGENTS, fn: "Shell" },
    { name: "log.tsx", src: LOG, fn: "Shell" },
    { name: "ready.tsx", src: READY, fn: "PopupShell" },
    { name: "tracks.tsx", src: TRACKS, fn: "Shell" },
    { name: "workspaces.tsx", src: WORKSPACES, fn: "Shell" },
    { name: "inprogress.tsx", src: INPROGRESS, fn: "Shell" },
    { name: "blocked.tsx", src: BLOCKED, fn: "Shell" },
    { name: "recent.tsx", src: RECENT, fn: "Shell" },
    { name: "doctor.tsx", src: DOCTOR, fn: "Shell" },
  ];

  for (const { name, src, fn } of cases) {
    describe(name, () => {
      const shell = shellSource(src, fn);

      it(`${fn} delegates to <TitledBox> (no hand-rolled rounded box)`, () => {
        // Post-Layer-1 each Shell renders a single TitledBox.
        // The hand-rolled `<Box borderStyle="round">` from the
        // pre-nit era is gone; if it ever comes back, this
        // assertion catches it.
        expect(shell).toMatch(/<TitledBox\b/);
        expect(shell).not.toMatch(/borderStyle="round"/);
      });

      it(`${fn} passes flexGrow={1} into TitledBox (vertical fill)`, () => {
        expect(shell).toMatch(/flexGrow=\{1\}/);
      });

      it(`${fn} passes the title through unchanged`, () => {
        expect(shell).toMatch(/title=\{title\}/);
      });

      it(`${name} imports TitledBox from titled-box`, () => {
        expect(src).toMatch(/from "\.\.\/titled-box\.js"/);
        expect(src).toMatch(/\bTitledBox\b/);
      });
    });
  }
});

describe("popup body region wraps content in flexGrow={1} (sticky bottom hint)", () => {
  // Each popup that has a list-of-rows + bottom hint should wrap
  // the rows in `<Box flexDirection="column" flexGrow={1}>` so the
  // hint sticks to the bottom of the Shell rather than floating
  // directly beneath the rows.
  const cases: ReadonlyArray<{ name: string; src: string }> = [
    { name: "agents.tsx", src: AGENTS },
    { name: "log.tsx", src: LOG },
    { name: "ready.tsx", src: READY },
    { name: "tracks.tsx", src: TRACKS },
    { name: "workspaces.tsx", src: WORKSPACES },
    { name: "inprogress.tsx", src: INPROGRESS },
    { name: "blocked.tsx", src: BLOCKED },
    { name: "recent.tsx", src: RECENT },
    { name: "doctor.tsx", src: DOCTOR },
  ];

  for (const { name, src } of cases) {
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
  const cases: ReadonlyArray<{ name: string; src: string }> = [
    { name: "agents.tsx", src: AGENTS },
    { name: "blocked.tsx", src: BLOCKED },
    { name: "doctor.tsx", src: DOCTOR },
    { name: "inprogress.tsx", src: INPROGRESS },
    { name: "log.tsx", src: LOG },
    { name: "ready.tsx", src: READY },
    { name: "recent.tsx", src: RECENT },
    { name: "tracks.tsx", src: TRACKS },
    { name: "workspaces.tsx", src: WORKSPACES },
  ];

  for (const { name, src } of cases) {
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
