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

import pc from "picocolors";

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
  if (steps.length === 0) return;
  const labelWidth = Math.max(...steps.map((s) => s.intent.length));
  console.log(pc.dim("Next:"));
  for (const step of steps) {
    const label = step.intent.padEnd(labelWidth);
    console.log(pc.dim(`  ${label} : ${step.command}`));
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
