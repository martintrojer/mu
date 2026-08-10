// mu — multiplexer backend detection.
//
// Picks the ONE backend a given mu invocation drives. Mirrors
// detectBackend() in src/vcs/index.ts, with one difference: the VCS
// backend is a property of a directory, so it is re-detected per call;
// the mux backend is a property of the PROCESS, so it is resolved once
// and cached (see `activeMux`).

import { herdrBackend } from "./herdr.js";
import { tmuxBackend } from "./tmux.js";
import { type MuxBackend, type MuxBackendName, NoMultiplexerError } from "./types.js";

/** Every backend mu knows about, in detection-precedence order. tmux is
 *  the incumbent and wins pure availability ties; herdr is selected by
 *  the narrower `$HERDR_ENV` ambient signal (see `detectMux`). */
const BACKENDS: readonly MuxBackend[] = [tmuxBackend, herdrBackend];

/** Look up a backend by name. Throws on unknown name. Backs `MU_MUX`. */
export function muxByName(name: MuxBackendName): MuxBackend {
  for (const backend of BACKENDS) {
    if (backend.name === name) return backend;
  }
  throw new Error(`unknown mux backend: ${name}`);
}

/** Valid `MU_MUX` values, for error messages. */
const KNOWN_NAMES: readonly string[] = BACKENDS.map((b) => b.name);

/**
 * Resolve the active multiplexer backend.
 *
 * The ladder, in order:
 *
 *   1. `MU_MUX=<name>`  — explicit override. Also the test seam. An
 *      unknown value throws rather than silently falling through: a
 *      typo'd backend name should fail loud, not quietly run on tmux.
 *   2. Ambient signal    — an env var proving the CALLER is already
 *      inside a managed pane of that mux ($HERDR_ENV for herdr, $TMUX
 *      or $TMUX_PANE for tmux). The most specific signal wins, since a
 *      mux can run nested inside another: herdr panes routinely host a
 *      tmux server, so BOTH sets of vars can be present at once and
 *      $HERDR_ENV — the narrower claim — is checked first.
 *   3. Availability      — whichever backend's binary actually runs.
 *      Ties break in BACKENDS order (tmux is the incumbent).
 *   4. Throw `NoMultiplexerError`.
 *
 * Note rungs 2 and 3 are separate on purpose. `$TMUX` says "the caller
 * is in a tmux pane"; `tmux -V` says "tmux works here". mu can spawn a
 * detached session from a plain shell, so rung 3 alone is sufficient to
 * operate — rung 2 exists only to pick the RIGHT mux when several are
 * installed.
 */
export async function detectMux(): Promise<MuxBackend> {
  const override = process.env.MU_MUX;
  if (override !== undefined && override.length > 0) {
    return muxByName(override as MuxBackendName);
  }

  // herdr FIRST. herdr can run inside tmux and vice versa, so both
  // signals can be live simultaneously; `$HERDR_ENV=1` is the narrower
  // one (herdr sets it only in panes IT manages) and must win. The
  // exact-"1" comparison is what `herdr --skill` mandates: any other
  // value, including "0" or "true", is not the documented contract.
  if (process.env.HERDR_ENV === "1") return herdrBackend;

  // Both vars, not just $TMUX: tmux sets $TMUX_PANE in every pane too,
  // and some setups (sudo -E, direnv, ssh with a restrictive SendEnv)
  // pass one through but not the other. Either one proves we are in a
  // tmux pane, which is what this rung is asking.
  if (process.env.TMUX || process.env.TMUX_PANE) return tmuxBackend;

  for (const backend of BACKENDS) {
    if (await backend.available()) return backend;
  }

  throw new NoMultiplexerError(KNOWN_NAMES);
}

// ─── Process-wide active backend ───────────────────────────────────────

let cached: MuxBackend | undefined;

/**
 * The active backend, resolved once per process and memoized.
 *
 * Memoized because detection can shell out (`tmux -V`) and mu is a
 * short-lived CLI that touches the mux many times per invocation; the
 * answer cannot change mid-process in any way that mu should react to.
 */
export async function activeMux(): Promise<MuxBackend> {
  if (cached === undefined) cached = await detectMux();
  return cached;
}

/**
 * Install a backend directly, bypassing detection. Returns the previous
 * value so tests can restore it. Mirrors `setTmuxExecutor`.
 *
 * Production code never calls this — use `activeMux()`.
 */
export function setMuxForTests(backend: MuxBackend | undefined): MuxBackend | undefined {
  const previous = cached;
  cached = backend;
  return previous;
}

/** Drop the memoized backend so the next `activeMux()` re-detects. */
export function resetMux(): void {
  cached = undefined;
}
