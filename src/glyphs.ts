// The one glyph vocabulary. Every symbol mu paints as *state* is
// defined here and nowhere else.
//
// WHY ONE FILE
// Glyphs were previously inlined at each render site: "✓" in the
// Recent card, "✓" again in the Workspaces card, "✓" a third time in
// the doctor card, "⛓" in Blocked, "⚠" in two CLI formatters. Three
// spellings of "ok" drifted apart once already (the busy gear vs
// murmur's play glyph), and each inline literal is a place the next
// drift can start. One meaning, one constant.
//
// WHY ONE FAMILY
// All state glyphs are classic Nerd Font `nf-fa-*` (Font Awesome 4)
// codepoints. Two properties matter:
//
//   1. SINGLE CODEPOINT, SINGLE CELL. Unicode emoji like ⚙️ are two
//      codepoints (base + variation selector) that terminals draw one
//      cell wide. cli-table3 sizes columns by string length, so a
//      table mixing 1- and 2-codepoint glyphs misaligns. nf-fa slots
//      are private-use, all length-1, all one cell.
//   2. STABLE SLOTS. Avoid `nf-md-*`: those PUA codepoints move
//      between Nerd Font releases and silently render as the wrong
//      icon (mu's `idle` once looked like a red shield under md-sleep).
//
// This matches murmur's dash (`src/dash-paint.ts` in ../murmur), which
// drives the same tmux panes from the other side. `busy` here and
// `running` there are both nf-fa-play on purpose: one symbol, one
// meaning, across both surfaces.
//
// Requires a Nerd Font on the operator's terminal. mu's substrate is
// pi, which assumes one. Without it every glyph renders as a
// placeholder box — and the columns still line up, which is the bug
// the family rule exists to prevent.
//
// NOT IN HERE
// Typographic punctuation that carries no state: the `•` list bullet,
// the `—` empty-cell dash, `…` truncation, box-drawing borders. Those
// are text, not vocabulary, and stay at their call sites.

import type { AgentStatus } from "./detect.js";

/**
 * Agent status → glyph.
 *
 * Also used for tmux pane titles (`composeAgentTitle`), which cannot
 * render ANSI colour, so the glyph must carry the whole signal.
 * `spawning` is included but rarely painted: the title renders before
 * status detection runs and the state is transient.
 */
export const AGENT_STATUS_GLYPH: Record<AgentStatus, string> = {
  spawning: "\uf251", // nf-fa-hourglass_start
  busy: "\uf04b", // nf-fa-play          — murmur's dash `running`
  needs_input: "\uf186", // nf-fa-moon_o        — murmur's dash `idle`
  needs_permission: "\uf023", // nf-fa-lock
  free: "\uf058", // nf-fa-check_circle
  unreachable: "\uf059", // nf-fa-question_circle
  terminated: "\uf057", // nf-fa-times_circle
};

/**
 * Single rendering helper for agent status glyphs. Keep callers off
 * AGENT_STATUS_GLYPH indexing so the fallback policy stays in one place.
 */
export function agentStatusGlyph(status: AgentStatus): string {
  return AGENT_STATUS_GLYPH[status] ?? GLYPH.unknown;
}

/**
 * Non-agent state glyphs, keyed by what they MEAN rather than what
 * they look like. A call site asks for `GLYPH.stale`, never for a
 * clock — so re-pointing the clock is a one-line edit here.
 *
 * `ok` / `fail` / `warn` deliberately reuse the same codepoints as the
 * agent statuses they rhyme with (`free`, `terminated`): a check-circle
 * means "fine" whether the row is an agent, a workspace or a doctor
 * check.
 */
export const GLYPH = {
  /** Healthy, clean, passing, closed-successfully. */
  ok: "\uf058", // nf-fa-check_circle
  /** Failed check. */
  fail: "\uf057", // nf-fa-times_circle
  /** Needs attention but not broken (idle-but-assigned, stale warning). */
  warn: "\uf071", // nf-fa-warning
  /** Workspace has uncommitted edits. */
  dirty: "\uf005", // nf-fa-star
  /** Workspace is ≥ WORKSPACE_STALE_THRESHOLD commits behind main. */
  stale: "\uf017", // nf-fa-clock_o
  /** Task is blocked by an incoming edge. */
  blocked: "\uf0c1", // nf-fa-link (chain)
  /** Track whose roots merged (diamond dependency). */
  merge: "\uf074", // nf-fa-random
  /** Agent owns more than one task (pane-title `⊕N` slot). */
  multi: "\uf055", // nf-fa-plus_circle
  /** Filter toggle: enabled / disabled. */
  on: "\uf111", // nf-fa-circle
  off: "\uf10c", // nf-fa-circle_o
  /** Status outside the known enum. */
  unknown: "\uf059", // nf-fa-question_circle
} as const;

// ─── Card-header digits ────────────────────────────────────────────
//
// Not state, but the same question ("which codepoint?") asked of the
// same file. Superscript digits prefix a TUI card's title with its
// toggle key (`╭─ ¹ Agents · 3 free ─...─╮`, the btop convention);
// the help overlay renders the same glyphs so the dashboard and the
// keymap speak one visual language.

const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

/**
 * Map a single decimal digit (0..9) to its Unicode superscript form.
 * Throws on out-of-range inputs so callers can't silently drop a key.
 */
export function superscriptDigit(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9) {
    throw new RangeError(`superscriptDigit: expected integer 0..9, got ${n}`);
  }
  const g = SUPERSCRIPT[n];
  // Defensive narrow for noUncheckedIndexedAccess; bounds checked above.
  if (g === undefined) {
    throw new RangeError(`superscriptDigit: unreachable for n=${n}`);
  }
  return g;
}
