import { describe, expect, it } from "vitest";
import { unescapeNoteText } from "../src/cli/tasks.js";

describe("unescapeNoteText", () => {
  it("translates \\n / \\t / \\r to their control chars", () => {
    expect(unescapeNoteText("a\\nb\\tc\\rd")).toBe("a\nb\tc\rd");
  });

  it("treats \\\\ as a literal backslash and does not double-process", () => {
    // `\\n` in the input is backslash + backslash + n.  After translation
    // it should be a single backslash followed by a literal `n`, NOT a
    // newline.
    expect(unescapeNoteText("\\\\n")).toBe("\\n");
  });

  it("handles backslash + newline (\\\\\\n -> \\ + newline)", () => {
    expect(unescapeNoteText("\\\\\\n")).toBe("\\\n");
  });

  it("passes through content that previously could collide with the placeholder", () => {
    const dangerous = "\u{1F511}backslash\u{1F511}";
    expect(unescapeNoteText(dangerous)).toBe(dangerous);
  });

  it("leaves lone backslashes (no recognised escape following) untouched", () => {
    expect(unescapeNoteText("a\\zb")).toBe("a\\zb");
  });

  it("is a no-op on plain text", () => {
    expect(unescapeNoteText("FILES: a.rs:45")).toBe("FILES: a.rs:45");
  });
});
