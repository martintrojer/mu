// mu — self-documenting output helpers.
//
// Every successful verb output should answer "what changed AND what's
// the natural next step?". Every error should answer "why AND what are
// the actionable resolutions?". The same data shape feeds both human
// (dim text) and JSON (`nextSteps` array) consumers.
//
// Why a separate module: this is shared by cli.ts (success-path
// rendering), the typed errors in src/agents.ts / src/tasks.ts /
// src/workstream.ts (error nextSteps), and tests. Keeping the type +
// helpers in one place avoids circular imports.

import picocolors from "picocolors";

/**
 * Should we emit ANSI color escapes from this process?
 *
 * picocolors auto-detects color support from `process.stdout.isTTY &&
 * env.TERM !== 'dumb'`. That works for plain shells but loses colors
 * whenever stdout is a pipe — most painfully under `watch --color mu
 * hud` and `tmux display-popup -E mu hud | cat`, where the surrounding
 * pane is a real terminal but our own stdout is a pipe.
 *
 * We force colors on when ANY of:
 *   - picocolors' own auto-detect says yes (`isColorSupported` — TTY +
 *     non-dumb TERM, the normal happy path);
 *   - `MU_FORCE_COLOR` is set (mu-specific override; doesn't require
 *     users to know the picocolors / chalk convention);
 *   - `FORCE_COLOR` is set (the standard env var picocolors itself
 *     consults inside `isColorSupported`, but we re-check it for clarity
 *     and to keep the helper self-contained / testable);
 *   - `TMUX` is set (the load-bearing fix for `watch` inside tmux: the
 *     surrounding pane is a real terminal even though our stdout is a
 *     pipe).
 *
 * `NO_COLOR` (the cross-tool opt-out convention, https://no-color.org/)
 * trumps every other signal — including TMUX/MU_FORCE_COLOR/FORCE_COLOR.
 * We respect it explicitly because the TMUX clause would otherwise
 * override picocolors' own NO_COLOR check, surprising users who set
 * NO_COLOR globally and then run mu inside tmux.
 *
 * See task hud_colors_stripped_under_watch_and for the full repro.
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return (
    picocolors.isColorSupported ||
    process.env.MU_FORCE_COLOR !== undefined ||
    process.env.FORCE_COLOR !== undefined ||
    process.env.TMUX !== undefined
  );
}

/**
 * The single picocolors instance the rest of the codebase imports.
 * Built once at module load with `colorEnabled()` baked in, so every
 * caller (cli.ts, src/cli/*.ts) renders consistently regardless of
 * isTTY heuristics. Any other module that needs `pc` should import
 * this one rather than reaching for `picocolors` directly.
 */
export const pc = picocolors.createColors(colorEnabled());

/**
 * One actionable next step. The `intent` is human-prose ("Drop notes
 * as you work"); the `command` is a literal shell command the user (or
 * an LLM) can copy-paste or `eval` directly.
 *
 * Used both for success-path hints (post-verb) and for typed-error
 * resolutions (in the error message + JSON output).
 */
export interface NextStep {
  /** Short human-prose label, e.g. "Drop notes as you work". */
  intent: string;
  /** Literal shell command, e.g. `mu task note foo "..."`. */
  command: string;
}

/**
 * Print a block of next-step hints to stdout, dimmed so humans can
 * skim past them but agents reading the captured output still get
 * them. No-op when the array is empty.
 *
 * Format:
 *
 *   Next:
 *     <intent padded>: <command>
 *     <intent padded>: <command>
 *
 * The padding aligns the colons so visual scanning is easy.
 */
export function printNextSteps(steps: readonly NextStep[]): void {
  printNextStepsTo(steps, "stdout");
}

/** Same as `printNextSteps` but routes to either stdout or stderr.
 *  Errors emit nextSteps to stderr (so success vs failure paths
 *  capture cleanly when scripts redirect them separately); success
 *  paths emit to stdout. Single source of truth for the formatting
 *  (review_code_print_next_steps_duplicated). */
export function printNextStepsTo(steps: readonly NextStep[], sink: "stdout" | "stderr"): void {
  if (steps.length === 0) return;
  const labelWidth = Math.max(...steps.map((s) => s.intent.length));
  const out = sink === "stderr" ? console.error : console.log;
  out(pc.dim("Next:"));
  for (const step of steps) {
    const label = step.intent.padEnd(labelWidth);
    out(pc.dim(`  ${label} : ${step.command}`));
  }
}

/**
 * The typed-error wire format for `--json` output. Errors that carry
 * actionable resolutions (most of them) implement `errorNextSteps()`;
 * the handler in cli.ts wraps them in this shape and emits to stderr.
 */
export interface ErrorJson {
  /** Class name (e.g. "ClaimerNotRegisteredError"). */
  error: string;
  /** Human-readable message (the same one printed to stderr in non-JSON mode). */
  message: string;
  /** Actionable resolutions. May be empty. */
  nextSteps: NextStep[];
  /** Process exit code that will follow. */
  exitCode: number;
}

/**
 * Marker interface for typed errors that carry actionable resolutions.
 * The handler checks this with a duck-typed `typeof err.errorNextSteps
 * === "function"` rather than instanceof so both legacy and new errors
 * coexist during the rollout.
 */
export interface HasNextSteps {
  errorNextSteps(): NextStep[];
}

/**
 * Detect whether the current invocation requested `--json`. Used by the
 * error handler to decide between human-prose stderr and structured
 * JSON stderr. Reads `process.argv` directly because commander has
 * already consumed it by the time the handler runs, and threading it
 * through every verb wrapper would be invasive.
 *
 * Tolerates `--json=...` form (commander supports both) but mu's verbs
 * only use the bare `--json` flag.
 */
export function isJsonMode(): boolean {
  return process.argv.some((a) => a === "--json" || a.startsWith("--json="));
}

/**
 * Has the current err object produced its own actionable nextSteps?
 * Encapsulates the duck-type check so the handler stays readable.
 */
export function hasNextSteps(err: unknown): err is HasNextSteps {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { errorNextSteps?: unknown }).errorNextSteps === "function"
  );
}
