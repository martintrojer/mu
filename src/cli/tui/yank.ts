// Clipboard probe + yank for the TUI's act-intent flow (R1: model
// drives the CLI; the user yanks `mu …` commands rather than the TUI
// executing them). See design_yank_flow + investigate_clipboard in
// workstream `tui` for the matrix.
//
// Probe order:
//   darwin            → pbcopy
//   linux + Wayland   → wl-copy
//   linux + X11       → xclip → xsel
//   wsl               → clip.exe
//   fallback          → OSC-52 (works over SSH; needs terminal support)
//   final             → null  (UI shows "[no clipboard]" but the
//                              command is still visible in the footer)
//
// The probe is sync-style (relies on which/command-v paths existing or
// not) but execa returns Promises, so the API is async. Probe once per
// TUI session and cache the result.

import { writeFile } from "node:fs/promises";
import { execa } from "execa";

export type ClipboardBackend =
  | { kind: "cli"; cmd: string; args: string[] }
  | { kind: "osc52" }
  | null;

export interface YankResult {
  copied: boolean;
  backend: string | null;
  error?: string;
}

/** Injection seam for probeClipboardBackend tests — lets a test pin
 *  process.platform / WAYLAND_DISPLAY / DISPLAY / WSL detection /
 *  binary availability without monkey-patching globals. Defaults
 *  exercise the real environment. */
export interface ProbeEnv {
  platform?: NodeJS.Platform;
  wayland?: boolean;
  x11?: boolean;
  isWsl?: () => Promise<boolean>;
  hasCommand?: (cmd: string) => Promise<boolean>;
}

/**
 * Probe the environment for an available clipboard backend. Returns
 * null when nothing works (the TUI falls back to displaying the
 * command in the footer for manual mouse-select).
 *
 * Caller is expected to memoise the result for the lifetime of the
 * TUI session.
 */
export async function probeClipboardBackend(env: ProbeEnv = {}): Promise<ClipboardBackend> {
  const platform = env.platform ?? process.platform;
  const hasWayland = env.wayland ?? process.env.WAYLAND_DISPLAY !== undefined;
  const hasX = env.x11 ?? process.env.DISPLAY !== undefined;
  const wsl = env.isWsl ?? isWsl;
  const has = env.hasCommand ?? hasCommand;

  // macOS
  if (platform === "darwin" && (await has("pbcopy"))) {
    return { kind: "cli", cmd: "pbcopy", args: [] };
  }

  // WSL
  if (await wsl()) {
    if (await has("clip.exe")) {
      return { kind: "cli", cmd: "clip.exe", args: [] };
    }
  }

  // Linux: prefer Wayland over X11 (XWayland sessions often have both).
  if (platform === "linux") {
    if (hasWayland && (await has("wl-copy"))) {
      return { kind: "cli", cmd: "wl-copy", args: ["--type", "text/plain"] };
    }
    if (hasX) {
      if (await has("xclip")) {
        return {
          kind: "cli",
          cmd: "xclip",
          args: ["-selection", "clipboard", "-in", "-loops", "1", "-quiet"],
        };
      }
      if (await has("xsel")) {
        return { kind: "cli", cmd: "xsel", args: ["--clipboard", "--input"] };
      }
    }
  }

  // OSC-52 — best-effort over any terminal that supports it. Always
  // available as a fallback because we can write to /dev/tty without
  // any external dependency. The terminal may silently drop the
  // sequence (gnome-terminal, old tmux without `set-clipboard on`),
  // but we've done all we can — the footer line is the real fallback.
  return { kind: "osc52" };
}

/** Build the OSC-52 clipboard-set sequence for `text`. Exported for
 *  test assertions: a regression that swaps the BEL terminator for
 *  the (also-legal) ST `ESC \` would still copy in some terminals
 *  but break others; pinning the byte sequence catches both. */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
}

/** Check whether `cmd` exists on PATH. Returns false on any error. */
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execa("command", ["-v", cmd], { shell: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Detect WSL via /proc/version content. Returns false on any error. */
async function isWsl(): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const v = await readFile("/proc/version", "utf-8");
    return v.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Writer seam for the OSC-52 branch. Default writes to /dev/tty
 *  (so the sequence reaches the controlling terminal even though
 *  ink owns stdout). Tests inject a stub that captures the bytes. */
export type Osc52Writer = (data: string) => Promise<void>;

const defaultOsc52Writer: Osc52Writer = (data) => writeFile("/dev/tty", data);

/**
 * Copy `text` to the clipboard via the resolved backend. Returns a
 * structured result so the caller can render `[copied]` /
 * `[no clipboard]` in the footer/toast.
 */
export async function yank(
  text: string,
  backend: ClipboardBackend,
  opts: { osc52Writer?: Osc52Writer } = {},
): Promise<YankResult> {
  if (backend === null) {
    return { copied: false, backend: null };
  }

  if (backend.kind === "cli") {
    try {
      await execa(backend.cmd, backend.args, { input: text });
      return { copied: true, backend: backend.cmd };
    } catch (err) {
      return { copied: false, backend: backend.cmd, error: String(err) };
    }
  }

  // OSC-52: ESC ] 52 ; c ; <base64> BEL.
  const writer = opts.osc52Writer ?? defaultOsc52Writer;
  try {
    await writer(osc52Sequence(text));
    return { copied: true, backend: "osc52" };
  } catch (err) {
    return { copied: false, backend: "osc52", error: String(err) };
  }
}
