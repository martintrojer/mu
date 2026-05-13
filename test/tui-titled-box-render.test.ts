import { Box, Text, render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TitledBox } from "../src/cli/tui/titled-box.js";
import { CaptureStream, createInkCaptureStream, waitForInkOutput } from "./_ink-render.js";

afterEach(() => {
  CaptureStream.cleanup();
});

describe("TitledBox constrained-frame rendering", () => {
  it("does not draw child body text inside the rounded bottom border when cards shrink", async () => {
    const stdout = createInkCaptureStream({ columns: 34, rows: 20 });

    const cards = Array.from({ length: 9 }, (_, i) => {
      const n = i + 1;
      return createElement(
        TitledBox,
        { key: n, title: `Card ${n}` },
        createElement(Text, null, `card-${n}-row-1`),
        createElement(Text, null, `card-${n}-row-2`),
      );
    });

    const instance = render(
      createElement(Box, { flexDirection: "column", height: 20, overflow: "hidden" }, cards),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );

    await waitForInkOutput(stdout);
    instance.unmount();

    const lines = stdout.output.split("\n");
    expect(lines.some((line) => line.includes("╰") && line.includes("row"))).toBe(false);
  });

  it("does not pad a phantom blank body row above an inset bottom label", async () => {
    const stdout = createInkCaptureStream({ columns: 34, rows: 34 });

    const trackRows = Array.from({ length: 8 }, (_, i) =>
      createElement(Text, { key: i }, `Track ${i + 1}`),
    );

    const instance = render(
      createElement(
        Box,
        { flexDirection: "column", height: 34, overflow: "hidden" },
        createElement(TitledBox, { title: "Tracks", bottomLabel: "+2 more · Shift+2" }, trackRows),
        createElement(Box, { flexGrow: 1 }),
        createElement(Text, null, "status"),
      ),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );

    await waitForInkOutput(stdout);
    instance.unmount();

    const lines = stdout.output.split("\n");
    const bottomLabelIndex = lines.findIndex((line) => line.includes("╰─ +2 more · Shift+2"));
    expect(bottomLabelIndex).toBeGreaterThan(0);
    expect(lines[bottomLabelIndex - 1]).toContain("Track 8");
    expect(lines[bottomLabelIndex - 1]).not.toMatch(/^│\s*│$/);
  });
});
