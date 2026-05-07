// Tests for src/detect.ts. Validates the tail-window extraction and the
// pi-specific patterns against realistic scrollback shapes.

import { describe, expect, it } from "vitest";
import { detectPiStatus, extractTail } from "../src/detect.js";

// ─── extractTail ────────────────────────────────────────────────────────

describe("extractTail", () => {
  it("returns empty string for empty input", () => {
    expect(extractTail("")).toBe("");
  });

  it("returns the input verbatim when shorter than the tail window", () => {
    const scrollback = "line 1\nline 2\nline 3";
    expect(extractTail(scrollback)).toBe(scrollback);
  });

  it("returns at most the last 20 non-blank lines", () => {
    // 50 numbered lines, no trailing blanks.
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const tail = extractTail(lines.join("\n"));
    const tailLines = tail.split("\n");
    expect(tailLines).toHaveLength(20);
    expect(tailLines[0]).toBe("line 31");
    expect(tailLines[19]).toBe("line 50");
  });

  it("strips trailing blank lines before taking the last 20", () => {
    // 30 content lines + 10 blank trailing lines.
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => `content ${i + 1}`),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const tail = extractTail(lines.join("\n"));
    const tailLines = tail.split("\n");
    expect(tailLines).toHaveLength(20);
    expect(tailLines[19]).toBe("content 30");
  });

  it("drops content older than the 100-line window", () => {
    // 200 lines; only the last 100 should be considered, of which we
    // emit the last 20.
    const lines = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
    const tail = extractTail(lines.join("\n"));
    const tailLines = tail.split("\n");
    expect(tailLines).toHaveLength(20);
    expect(tailLines[0]).toBe("L181");
    expect(tailLines[19]).toBe("L200");
    // L1 is excluded.
    expect(tail).not.toContain("L1\n");
  });

  it("treats whitespace-only lines as blank when stripping", () => {
    const lines = ["content", "  ", "\t", " "];
    const tail = extractTail(lines.join("\n"));
    expect(tail).toBe("content");
  });
});

// ─── detectPiStatus — synthetic minimal cases ──────────────────────────

describe("detectPiStatus — minimal cases", () => {
  it("empty scrollback → needs_input", () => {
    expect(detectPiStatus("")).toBe("needs_input");
  });

  it("whitespace-only scrollback → needs_input", () => {
    expect(detectPiStatus("\n\n\n   \n  ")).toBe("needs_input");
  });

  it("plain prompt → needs_input", () => {
    expect(detectPiStatus("❯ ")).toBe("needs_input");
  });

  it('"to interrupt)" (with paren) in tail → busy', () => {
    expect(detectPiStatus("Working... (Esc to interrupt)")).toBe("busy");
  });

  it('"to interrupt" without paren does NOT trigger busy (banner false-positive guard)', () => {
    // Pi's startup banner renders `<key> to interrupt` (no parens) as part
    // of a keybindings list. We only match the parenthesised loading-
    // animation form to avoid false-firing when the banner is in the tail.
    expect(detectPiStatus("  esc to interrupt   ctrl+c to clear")).toBe("needs_input");
  });

  it('"to submit)" in tail → needs_permission', () => {
    expect(detectPiStatus("(Esc to cancel, Enter to submit)")).toBe("needs_permission");
  });

  it('comma form "to cancel," in tail → needs_permission', () => {
    expect(detectPiStatus("(Esc to cancel, Enter to confirm)")).toBe("needs_permission");
  });

  it('plain "to cancel" without comma does NOT trigger permission (false-positive guard)', () => {
    // We only match the comma form so generic "Press Esc to cancel"
    // status text doesn't trigger needs_permission.
    expect(detectPiStatus("Press Esc to cancel this operation")).toBe("needs_input");
  });

  it('plain "to submit" without paren does NOT trigger permission', () => {
    // Avoid false positives on prose like "click submit to submit the form".
    expect(detectPiStatus("Press Enter to submit your changes")).toBe("needs_input");
  });

  it("permission overrides busy when both are visible", () => {
    const scrollback = "Working... (Esc to interrupt)\n(Esc to cancel, Enter to submit)";
    expect(detectPiStatus(scrollback)).toBe("needs_permission");
  });
});

// ─── detectPiStatus — tail-window robustness ───────────────────────────

describe("detectPiStatus — tail-window excludes stale matches", () => {
  it("'to interrupt' in pi's startup banner alone → needs_input (scrolled out)", () => {
    // Realistic shape: pi's verbose startup banner is at the top with
    // keybindings hints (which contain "to interrupt"), followed by a
    // long interaction that has long since scrolled the banner out.
    const banner = `pi v0.65.0
  esc        to interrupt
  ctrl+c     to clear
  ctrl+d     to exit (empty)`;
    const interaction = Array.from(
      { length: 90 },
      (_, i) => `> command ${i + 1}\n  output ${i + 1}`,
    ).join("\n");
    expect(detectPiStatus(`${banner}\n${interaction}`)).toBe("needs_input");
  });

  it("'to interrupt' at the very bottom (live loading animation) → busy", () => {
    const interaction = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const scrollback = `${interaction}\nWorking... (Esc to interrupt)`;
    expect(detectPiStatus(scrollback)).toBe("busy");
  });

  it("trailing blank lines below loading animation still detect busy", () => {
    // tmux often pads blanks below TUI content; our strip-trailing-blanks
    // step keeps the busy marker visible.
    const scrollback = "Working... (Esc to interrupt)\n\n\n\n\n";
    expect(detectPiStatus(scrollback)).toBe("busy");
  });

  it("trailing blank lines below confirm dialog still detect needs_permission", () => {
    const scrollback = "Allow this command?\n(Esc to cancel, Enter to submit)\n\n\n";
    expect(detectPiStatus(scrollback)).toBe("needs_permission");
  });

  it("very long scrollback with 'to interrupt' >100 lines back → needs_input", () => {
    // 150 lines: the marker is at line 1, far outside the tail window.
    const lines = ["Working... (Esc to interrupt)"];
    for (let i = 0; i < 149; i++) lines.push(`> idle line ${i + 1}`);
    expect(detectPiStatus(lines.join("\n"))).toBe("needs_input");
  });

  it("loading animation 30 lines back (within 100-line window but beyond 20-line tail) → needs_input", () => {
    // 50 lines of trailing prompt activity after the loading animation
    // means it's no longer "live" — most likely the operation finished
    // and the prompt is back. Tail-window correctly returns needs_input.
    const lines = ["Working... (Esc to interrupt)"];
    for (let i = 0; i < 50; i++) lines.push(`> done line ${i + 1}`);
    expect(detectPiStatus(lines.join("\n"))).toBe("needs_input");
  });
});

// ─── detectPiStatus — realistic scrollback fixtures ────────────────────

describe("detectPiStatus — realistic scrollback fixtures", () => {
  it("idle pi sitting at the prompt (banner present) → needs_input", () => {
    // The banner contains 'esc to interrupt' (no parens); our paren-aware
    // pattern correctly ignores it.
    const scrollback = `pi v0.65.0
  esc to interrupt   ctrl+c to clear   ctrl+d to exit

> what's the time?

The current time is 16:00.

> `;
    expect(detectPiStatus(scrollback)).toBe("needs_input");
  });

  it("pi mid-stream with loading animation → busy", () => {
    // What the bottom of the pane looks like while pi is streaming a
    // response: prior conversation + the working indicator.
    const scrollback = `pi v0.65.0
  esc to interrupt   ctrl+c to clear

> implement the auth module

I'll start by reading the existing structure.

[tool: read auth.rs]

Working...  (Esc to interrupt)`;
    expect(detectPiStatus(scrollback)).toBe("busy");
  });

  it("pi showing a confirm dialog for a destructive command → needs_permission", () => {
    // What the bottom looks like when pi calls ctx.ui.confirm() and is
    // waiting for the user to respond.
    const scrollback = `> rm -rf node_modules
[bash] About to run: rm -rf node_modules

Allow this command?
(Esc to cancel, Enter to submit)`;
    expect(detectPiStatus(scrollback)).toBe("needs_permission");
  });

  it("pi showing a select dialog (model picker, etc.) → needs_permission", () => {
    const scrollback = `Choose a model:
  > anthropic/claude-sonnet-4
    openai/gpt-5
    google/gemini-2.5

(Esc to cancel, Enter to submit)`;
    expect(detectPiStatus(scrollback)).toBe("needs_permission");
  });

  it("fresh pi pane with banner but no interaction → needs_input", () => {
    // Banner contains 'esc to interrupt' (no parens), 'to clear', 'to exit'.
    // None of these match our parenthesised patterns. Status is needs_input
    // immediately after spawn — no banner false-positive.
    const scrollback = `pi v0.65.0
  esc to interrupt   ctrl+c to clear   ctrl+d to exit (empty)
  ctrl+z to suspend  ctrl+e for external editor

> `;
    expect(detectPiStatus(scrollback)).toBe("needs_input");
  });
});
