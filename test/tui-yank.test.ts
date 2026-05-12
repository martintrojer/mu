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
import { osc52Sequence, probeClipboardBackend, yank } from "../src/cli/tui/yank.js";

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

// ─── OSC-52 (per review_tests_yank_osc52_unverified) ─────────────
//
// The OSC-52 branch (yank with `{kind:"osc52"}`) was uncovered: it
// writes to /dev/tty directly. SSH users without an X server depend
// on this code path. Pin the byte sequence by routing through an
// injected writer stub.

describe("osc52Sequence", () => {
  it("frames as ESC ] 52 ; c ; <base64> BEL (the canonical OSC-52 set form)", () => {
    const seq = osc52Sequence("hello");
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    expect(seq.startsWith(`${ESC}]52;c;`)).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);
  });

  it("base64-encodes the payload (mu task close <id> example)", () => {
    const text = "mu task close foo --evidence 'bar'";
    const seq = osc52Sequence(text);
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    // Strip the wrapper and decode — must round-trip.
    const inner = seq.slice(`${ESC}]52;c;`.length, -BEL.length);
    expect(Buffer.from(inner, "base64").toString("utf-8")).toBe(text);
  });

  it("is NOT terminated by ST (ESC \\) — BEL is the wider-supported form", () => {
    // Some terminals (notably older tmux + a handful of SSH clients)
    // accept BEL but not ST; pin the choice so a refactor doesn't
    // silently break those.
    const seq = osc52Sequence("x");
    const ESC = String.fromCharCode(0x1b);
    expect(seq).not.toMatch(new RegExp(`${ESC}\\\\$`));
  });
});

describe("yank({kind:'osc52'}) routes the OSC-52 sequence through the writer", () => {
  it("writes the canonical OSC-52 set sequence for the given text", async () => {
    let captured: string | null = null;
    const writer = async (d: string) => {
      captured = d;
    };
    const r = await yank("hello", { kind: "osc52" }, { osc52Writer: writer });
    expect(r).toEqual({ copied: true, backend: "osc52" });
    expect(captured).toBe(osc52Sequence("hello"));
  });

  it("reports {copied:false, error} when the writer throws (e.g. /dev/tty unavailable)", async () => {
    const r = await yank(
      "hello",
      {
        kind: "osc52",
      },
      {
        osc52Writer: async () => {
          throw new Error("ENXIO: no controlling terminal");
        },
      },
    );
    expect(r.copied).toBe(false);
    expect(r.backend).toBe("osc52");
    expect(r.error).toContain("ENXIO");
  });

  it("each yank invokes the writer exactly once (no double-emit, no missed-emit)", async () => {
    let calls = 0;
    const writer = async () => {
      calls += 1;
    };
    await yank("once", { kind: "osc52" }, { osc52Writer: writer });
    expect(calls).toBe(1);
  });
});

// ─── platform-conditional probe (per review_tests_yank_osc52_unverified) ──
//
// probeClipboardBackend reads process.platform + WAYLAND_DISPLAY +
// DISPLAY + WSL detection + which-binary-is-on-PATH; on a single CI
// platform only one branch executes. Inject a synthetic env so every
// branch runs.

describe("probeClipboardBackend: platform-conditional branches", () => {
  it("darwin + pbcopy present → pbcopy CLI backend", async () => {
    const b = await probeClipboardBackend({
      platform: "darwin",
      hasCommand: async (cmd) => cmd === "pbcopy",
      isWsl: async () => false,
    });
    expect(b).toEqual({ kind: "cli", cmd: "pbcopy", args: [] });
  });

  it("darwin without pbcopy → falls back to OSC-52 (never null)", async () => {
    const b = await probeClipboardBackend({
      platform: "darwin",
      hasCommand: async () => false,
      isWsl: async () => false,
    });
    expect(b).toEqual({ kind: "osc52" });
  });

  it("WSL → clip.exe wins (regardless of platform string)", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      hasCommand: async (cmd) => cmd === "clip.exe",
      isWsl: async () => true,
    });
    expect(b).toEqual({ kind: "cli", cmd: "clip.exe", args: [] });
  });

  it("linux + WAYLAND_DISPLAY + wl-copy → wl-copy with --type text/plain", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: true,
      x11: false,
      isWsl: async () => false,
      hasCommand: async (cmd) => cmd === "wl-copy",
    });
    expect(b).toEqual({ kind: "cli", cmd: "wl-copy", args: ["--type", "text/plain"] });
  });

  it("linux + DISPLAY + xclip → xclip with -selection clipboard arg vector", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: false,
      x11: true,
      isWsl: async () => false,
      hasCommand: async (cmd) => cmd === "xclip",
    });
    expect(b).toEqual({
      kind: "cli",
      cmd: "xclip",
      args: ["-selection", "clipboard", "-in", "-loops", "1", "-quiet"],
    });
  });

  it("linux + DISPLAY + only xsel present → xsel with --clipboard --input", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: false,
      x11: true,
      isWsl: async () => false,
      hasCommand: async (cmd) => cmd === "xsel",
    });
    expect(b).toEqual({ kind: "cli", cmd: "xsel", args: ["--clipboard", "--input"] });
  });

  it("linux + Wayland prefers wl-copy over xclip when both are present (XWayland sessions have both)", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: true,
      x11: true,
      isWsl: async () => false,
      hasCommand: async () => true,
    });
    expect(b).toEqual({ kind: "cli", cmd: "wl-copy", args: ["--type", "text/plain"] });
  });

  it("linux + DISPLAY + xclip+xsel both present → xclip wins (probe order)", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: false,
      x11: true,
      isWsl: async () => false,
      hasCommand: async (cmd) => cmd === "xclip" || cmd === "xsel",
    });
    expect(b).toEqual({
      kind: "cli",
      cmd: "xclip",
      args: ["-selection", "clipboard", "-in", "-loops", "1", "-quiet"],
    });
  });

  it("linux without any clipboard binary or display server → OSC-52 fallback (never null)", async () => {
    const b = await probeClipboardBackend({
      platform: "linux",
      wayland: false,
      x11: false,
      isWsl: async () => false,
      hasCommand: async () => false,
    });
    expect(b).toEqual({ kind: "osc52" });
  });

  it("unknown platform with no helpers → OSC-52 fallback (never null)", async () => {
    // The footer line is the FINAL fallback (UI shows '[no clipboard]'
    // for backend === null) but for a TTY we always have OSC-52.
    const b = await probeClipboardBackend({
      platform: "freebsd" as NodeJS.Platform,
      wayland: false,
      x11: false,
      isWsl: async () => false,
      hasCommand: async () => false,
    });
    expect(b).toEqual({ kind: "osc52" });
  });
});
