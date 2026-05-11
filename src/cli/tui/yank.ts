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

/**
 * Probe the environment for an available clipboard backend. Returns
 * null when nothing works (the TUI falls back to displaying the
 * command in the footer for manual mouse-select).
 *
 * Caller is expected to memoise the result for the lifetime of the
 * TUI session.
 */
export async function probeClipboardBackend(): Promise<ClipboardBackend> {
  const platform = process.platform;

  // macOS
  if (platform === "darwin" && (await hasCommand("pbcopy"))) {
    return { kind: "cli", cmd: "pbcopy", args: [] };
  }

  // WSL
  if (await isWsl()) {
    if (await hasCommand("clip.exe")) {
      return { kind: "cli", cmd: "clip.exe", args: [] };
    }
  }

  // Linux: prefer Wayland over X11 (XWayland sessions often have both).
  if (platform === "linux") {
    const hasWayland = process.env.WAYLAND_DISPLAY !== undefined;
    const hasX = process.env.DISPLAY !== undefined;
    if (hasWayland && (await hasCommand("wl-copy"))) {
      return { kind: "cli", cmd: "wl-copy", args: ["--type", "text/plain"] };
    }
    if (hasX) {
      if (await hasCommand("xclip")) {
        return {
          kind: "cli",
          cmd: "xclip",
          args: ["-selection", "clipboard", "-in", "-loops", "1", "-quiet"],
        };
      }
      if (await hasCommand("xsel")) {
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

/**
 * Copy `text` to the clipboard via the resolved backend. Returns a
 * structured result so the caller can render `[copied]` /
 * `[no clipboard]` in the footer/toast.
 */
export async function yank(text: string, backend: ClipboardBackend): Promise<YankResult> {
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

  // OSC-52: ESC ] 52 ; c ; <base64> BEL — write to /dev/tty so the
  // sequence reaches the controlling terminal even though ink owns
  // stdout for ink's rendering.
  try {
    const seq = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
    await writeFile("/dev/tty", seq);
    return { copied: true, backend: "osc52" };
  } catch (err) {
    return { copied: false, backend: "osc52", error: String(err) };
  }
}
