// Static-source regression scan: NO popup file may carry a
// module-scope `const VIEWPORT = 20` (or any literal-int VIEWPORT
// constant). Catches the next copy-paste oversight of the kind
// fixed by bug_tui_inprogress_recent_drill_viewport_clipped, where
// inprogress.tsx and recent.tsx still held the stale module-scope
// 20 long after every other popup had migrated to the dynamic
// `popupViewport(rows)` (and now `usePopupViewport()`) seam.
//
// Glob-walk every .tsx in src/cli/tui/popups/ rather than a curated
// list — the curated list is exactly how the previous regression
// hid (the list missed inprogress + recent for one whole release).
//
// Sibling of test/tui-popup-viewport.test.ts which exercises the
// hook + boundary math; this file is purely the negative
// "const VIEWPORT = …" regression scan.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");

function popupTsxFiles(): string[] {
  return readdirSync(POPUPS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .sort();
}

describe("popup files never hardcode `const VIEWPORT = …`", () => {
  // The bug: inprogress.tsx / recent.tsx kept the legacy
  //
  //     const VIEWPORT = 20;
  //
  // at module scope long after every other popup migrated to
  // `popupViewport(rows)`. Drill view passed VIEWPORT (literal 20)
  // to TaskDetailDrill so notes were clipped to 20 rows even on
  // a 60-row pane. The fix introduces `usePopupViewport()` and
  // drops the constant from BOTH files; this scan ensures no future
  // popup re-introduces a sibling literal.
  const files = popupTsxFiles();
  // Sanity: discovery must have found the popups; otherwise the
  // assertions below trivially pass and we'd silently lose coverage.
  it("discovered at least the 9 known popups", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const name of files) {
    it(`${name} contains no module-scope \`const VIEWPORT =\``, () => {
      const src = readFileSync(join(POPUPS_DIR, name), "utf8");
      // Match a const VIEWPORT = ... declaration at module scope
      // (line-start; a function-local one would be indented). The
      // regex stays tight enough that a comment like
      // "Replaces the prior hardcoded VIEWPORT = 20" doesn't trip
      // it (those comments start with `//`, not `const`).
      expect(src).not.toMatch(/^const\s+VIEWPORT\s*=/m);
    });
  }
});
