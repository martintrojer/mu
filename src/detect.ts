// mu — Pi status detector.
//
// Derives an agent's runtime status (busy / needs_input / needs_permission)
// from its tmux pane scrollback. 0.1.0 is pi-only — we know pi's exact
// markers from its source. Heterogeneous CLI support (claude, codex) is
// on the roadmap and will land alongside ground-truth scrollback fixtures.
//
// Algorithm (cribbed from a prior internal multi-agent runtime's per-CLI detector):
//
//   1. Take the last TAIL_WINDOW_LINES (100) lines of scrollback.
//   2. Strip trailing blank lines (TUIs pad blanks below content).
//   3. From what remains, take the last TAIL_LINES (20).
//   4. If a permission pattern is present in the tail → needs_permission.
//   5. Else if a busy pattern is present → busy.
//   6. Else → needs_input.
//
// The tail-window is what makes detection robust: pi's startup banner
// contains "to interrupt" in its keybindings hint list. By only looking
// at the bottom of the pane, we ignore stale matches that have scrolled
// out of view.

/**
 * The full agent lifecycle status. Most values are scrollback-derived
 * (`DetectedStatus`); the rest are set by the lifecycle layer.
 */
export type AgentStatus =
  | "spawning"
  | "busy"
  | "needs_input"
  | "needs_permission"
  | "free"
  | "unreachable"
  | "terminated";

/** Status that can be inferred from pane scrollback. */
export type DetectedStatus = "busy" | "needs_input" | "needs_permission";

/**
 * Number of lines from the bottom of the scrollback to consider.
 * Larger than TAIL_LINES so we can strip trailing blanks first without
 * running out of content.
 */
const TAIL_WINDOW_LINES = 100;

/**
 * After stripping trailing blanks from the window, look at this many lines.
 * Narrow enough that a stale prompt one screen up doesn't match.
 */
const TAIL_LINES = 20;

/**
 * Pi prints `Working... (Esc to interrupt)` via its loading animation while
 * streaming an LLM response or running a tool. We require the closing paren
 * (`to interrupt)`) to distinguish from pi's startup banner, which renders
 * the same hint as `<key> to interrupt` (no parens) in a list of
 * keybindings. Without the paren, a fresh pane with the banner still
 * visible would false-positive busy.
 */
const PI_BUSY_PATTERNS: readonly string[] = ["to interrupt)"];

/**
 * Pi's confirm / select / input dialogs render footer hints like
 * `(Esc to cancel, Enter to submit)`. Both `to submit)` (with closing
 * paren) and `to cancel,` (with the comma artifact of being the first of
 * the parenthesised pair) only appear inside dialog footers — not in
 * prose, not in the banner.
 */
const PI_PERMISSION_PATTERNS: readonly string[] = ["to submit)", "to cancel,"];

/**
 * Run the detector against pane scrollback and return the inferred
 * status. Permission overrides busy.
 */
export function detectPiStatus(scrollback: string): DetectedStatus {
  const tail = extractTail(scrollback);
  if (matchesAny(tail, PI_PERMISSION_PATTERNS)) return "needs_permission";
  if (matchesAny(tail, PI_BUSY_PATTERNS)) return "busy";
  return "needs_input";
}

/**
 * Public for tests — extract the tail window the detector actually
 * inspects. Take last TAIL_WINDOW_LINES, strip trailing blanks, take
 * last TAIL_LINES.
 */
export function extractTail(scrollback: string): string {
  const lines = scrollback.split("\n");
  const window = lines.slice(-TAIL_WINDOW_LINES);
  // Strip trailing blank lines (Codex/pi pad with blanks below content).
  let end = window.length;
  while (end > 0 && (window[end - 1] ?? "").trim() === "") {
    end--;
  }
  const start = Math.max(0, end - TAIL_LINES);
  return window.slice(start, end).join("\n");
}

function matchesAny(text: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (text.includes(pattern)) return true;
  }
  return false;
}
