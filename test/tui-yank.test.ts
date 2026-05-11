// Tests for src/cli/tui/yank.ts (Wave 4 Task 18 of
// docs/plans/2026-05-11-interactive-tui.md).
//
// The probe inspects platform + env + which-binary-is-on-PATH, so it's
// hard to test exhaustively in a single CI environment. Approach:
//   - probeClipboardBackend on the host platform: assert it returns a
//     valid shape (kind: "cli" | "osc52" | null with the expected fields).
//   - yank with backend === null: returns { copied: false, backend: null }.
//   - yank with a fake CLI backend pointing at /bin/true: copied: true.
//   - yank with a fake CLI backend pointing at /bin/false: copied: false
//     and error populated.
// We avoid mocking execa because that would test the mock; instead we
// route to real binaries (`true`, `false`) that exist on every Unix.

import { describe, expect, it } from "vitest";
import { probeClipboardBackend, yank } from "../src/cli/tui/yank.js";

describe("probeClipboardBackend", () => {
  it("returns a valid backend shape on the host platform", async () => {
    const b = await probeClipboardBackend();
    // Will be 'cli' on macOS (pbcopy is always present) and 'osc52'
    // elsewhere as a guaranteed fallback. Should never be null on
    // supported platforms.
    expect(b).not.toBeNull();
    if (b?.kind === "cli") {
      expect(b.cmd).toBeTruthy();
      expect(Array.isArray(b.args)).toBe(true);
    } else if (b?.kind === "osc52") {
      expect(b.kind).toBe("osc52");
    }
  });
});

describe("yank", () => {
  it("returns {copied:false, backend:null} for null backend", async () => {
    const r = await yank("test text", null);
    expect(r).toEqual({ copied: false, backend: null });
  });

  it("returns {copied:true} when CLI backend succeeds", async () => {
    // `true` exits 0 regardless of stdin → simulates a working
    // pbcopy/xclip without depending on the platform.
    const r = await yank("hello", { kind: "cli", cmd: "true", args: [] });
    expect(r.copied).toBe(true);
    expect(r.backend).toBe("true");
  });

  it("returns {copied:false, error} when CLI backend fails", async () => {
    // `false` exits 1 → simulates pbcopy/xclip throwing.
    const r = await yank("hello", { kind: "cli", cmd: "false", args: [] });
    expect(r.copied).toBe(false);
    expect(r.backend).toBe("false");
    expect(r.error).toBeTruthy();
  });

  it("returns {copied:false, error} when CLI backend binary doesn't exist", async () => {
    const r = await yank("hello", {
      kind: "cli",
      cmd: "this-binary-does-not-exist-anywhere",
      args: [],
    });
    expect(r.copied).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
