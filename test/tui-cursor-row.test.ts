// Tests for src/cli/tui/popups/cursor-row.tsx and the cross-popup
// usage contract. See bug_tui_popup_cursor_highlight_color_leak
// (workstream `tui-impl`).
//
// Two layers:
//
// (1) Pure-source assertions that every list popup imports
//     CursorRow from ./cursor-row.js and uses it inside its
//     selected-row branch (i.e. the patchy per-cell `inverse={sel}`
//     pattern is gone). Cheap regression guard against future
//     popups regressing to the leaky pattern.
//
// (2) Unit test of the CursorRow component itself: cells join with
//     a 2-space gutter, padEnd to contentWidth, wrapped in a single
//     <Text inverse> on a width-pinned <Box>. We do this via React
//     element introspection (no renderer needed) — same trick the
//     existing src/cli/tui tests use.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { COL_GUTTER } from "../src/cli/tui/columns.js";
import { CursorRow } from "../src/cli/tui/popups/cursor-row.js";

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");

// The 8 list popups that have a focused/cursor row. recent.tsx and
// task-detail.tsx don't have one; drill.tsx, viewport.ts,
// cursor-row.tsx are infrastructure.
const LIST_POPUPS = [
  "agents.tsx",
  "blocked.tsx",
  "doctor.tsx",
  "inprogress.tsx",
  "log.tsx",
  "ready.tsx",
  "tracks.tsx",
  "workspaces.tsx",
];

describe("CursorRow component", () => {
  it("joins padded cells with COL_GUTTER and padEnds to contentWidth", () => {
    const el = CursorRow({ cells: ["a", "bb", "c"], contentWidth: 20 });
    expect(isValidElement(el)).toBe(true);
    // Outer <Box width={contentWidth}>
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    expect(box.props.width).toBe(20);
    const text = box.props.children;
    expect(isValidElement(text)).toBe(true);
    expect(text.props.inverse).toBe(true);
    expect(text.props.wrap).toBe("truncate");
    const expected = ["a", "bb", "c"].join(" ".repeat(COL_GUTTER)).padEnd(20);
    expect(text.props.children).toBe(expected);
    expect(text.props.children.length).toBe(20);
  });

  it("does not pad when contentWidth is shorter than the joined line", () => {
    const el = CursorRow({ cells: ["aaaaa", "bbbbb"], contentWidth: 4 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const text = box.props.children;
    // 5 + 2 (gutter) + 5 = 12 chars; padEnd(4) is a no-op when the
    // string is already wider. Truncation is left to ink's wrap=truncate.
    expect(text.props.children).toBe("aaaaa  bbbbb");
  });

  it("handles a single cell and zero/negative contentWidth gracefully", () => {
    const single = CursorRow({ cells: ["only"], contentWidth: 10 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const sBox = single as any;
    expect(sBox.props.children.props.children).toBe("only".padEnd(10));

    const tiny = CursorRow({ cells: ["x"], contentWidth: 0 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const tBox = tiny as any;
    // padEnd with 0 (or via Math.max(0, n)) is a no-op; we just get
    // the joined string back.
    expect(tBox.props.children.props.children).toBe("x");
  });

  it("uses no per-cell colour or bold/dim styling on the wrapping Text", () => {
    const el = CursorRow({ cells: ["a", "b"], contentWidth: 10 });
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const box = el as any;
    const text = box.props.children;
    // The whole point of CursorRow: a SINGLE <Text inverse> with no
    // nested colour-bearing children. inner is a plain string.
    expect(typeof text.props.children).toBe("string");
    expect(text.props.color).toBeUndefined();
    expect(text.props.bold).toBeUndefined();
    expect(text.props.dimColor).toBeUndefined();
  });
});

describe("popups consume CursorRow for selected rows", () => {
  it("the source file exists in popups/", () => {
    const files = readdirSync(POPUPS_DIR);
    expect(files).toContain("cursor-row.tsx");
  });

  for (const name of LIST_POPUPS) {
    const path = join(POPUPS_DIR, name);
    const src = readFileSync(path, "utf8");

    it(`${name}: imports CursorRow from ./cursor-row.js`, () => {
      expect(src).toMatch(/import\s*\{\s*CursorRow\s*\}\s*from\s*["']\.\/cursor-row\.js["']/);
    });

    it(`${name}: uses <CursorRow .../> in the selected-row branch`, () => {
      expect(src).toMatch(/<CursorRow\b/);
    });

    it(`${name}: no leaky per-cell inverse={...} pattern remains`, () => {
      // The whole bug was wrapping nested coloured <Text> in a
      // single <Text inverse={sel}>. CursorRow replaces every such
      // selected-row branch — there should be no `inverse=` on any
      // <Text> in these popups (the inner CursorRow's <Text inverse>
      // lives in cursor-row.tsx, NOT in any of these files).
      expect(src).not.toMatch(/<Text[^>]*\binverse=/);
    });
  }
});
