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

import Table from "cli-table3";
import type { Command } from "commander";
import picocolors from "picocolors";

/**
 * Should we emit ANSI color escapes from this process?
 *
 * picocolors ships an `isColorSupported` flag, but it bakes its env
 * inspection (NO_COLOR / FORCE_COLOR / isTTY) ONCE at module-load
 * time. That makes the function untestable without dynamic re-imports
 * — and worse, it loses colors whenever stdout is a pipe, most
 * painfully under `watch --color mu state` and `tmux display-popup -E
 * 'mu state' | cat`, where the surrounding pane is a real terminal but
 * our own stdout is a pipe.
 *
 * We therefore re-implement the decision from scratch at call time,
 * reading every signal directly from `process.env` / `process.stdout`
 * so tests can flip env vars and observe the result without the
 * vi.resetModules + vi.doMock dance (per task
 * review_test_color_enabled_no_color_module_load_caveat).
 *
 * Order of precedence (first match wins):
 *   - `NO_COLOR` set (cross-tool opt-out, https://no-color.org/) →
 *     OFF, even when TMUX/MU_FORCE_COLOR/FORCE_COLOR are set. We
 *     treat any defined value (including "") as set, matching the
 *     no-color.org convention and picocolors' own behavior.
 *   - `MU_FORCE_COLOR` set → ON (mu-specific override).
 *   - `FORCE_COLOR` set → ON (the standard env var picocolors / chalk
 *     consult).
 *   - `TMUX` set → ON (the load-bearing fix for `watch` inside tmux:
 *     the surrounding pane is a real terminal even though our stdout
 *     is a pipe).
 *   - Fall back to the standard TTY heuristic: stdout is a TTY AND
 *     TERM !== "dumb". This mirrors what picocolors itself does in
 *     `isColorSupported` for the happy-path case.
 *
 * See task hud_colors_stripped_under_watch_and for the original repro.
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.MU_FORCE_COLOR !== undefined) return true;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (process.env.TMUX !== undefined) return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
}

/**
 * The single picocolors instance the rest of the codebase imports.
 * Built once at module load with `colorEnabled()` baked in, so every
 * caller (cli.ts, src/cli/*.ts) renders consistently regardless of
 * isTTY heuristics. Any other module that needs `pc` should import
 * this one rather than reaching for `picocolors` directly.
 */
// picocolors is still used as the renderer (createColors honors the
// flag we pass), but the *decision* of whether to render is ours.
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
 * Build a cli-table3 Table with the mu-standard safety belt:
 * `wordWrap: false` (cells wider than their column truncate with `…`
 * instead of wrapping to a second visual row), per-column max widths
 * applied only where the caller asks (`null` = auto), and a default
 * borderless style mirroring the state/workspace/workstream tables.
 *
 * Callers should pre-truncate values they care about via the
 * `truncate()` / `truncateFront()` helpers in cli.ts (the proactive
 * path); `wordWrap: false` is the safety belt for the cells they
 * miss. This is load-bearing for renderers with fixed row budgets:
 * a single wrapped cell silently blows out the promised section height.
 *
 * Surfaced live by `mu workspace list` blowing the terminal width on
 * the `path` column (tables_truncate_long_cols_audit). Don't try to
 * cap every column — apply `colWidths` only on the column(s) the
 * operator is least likely to read in full and most likely to be
 * long. Don't add a `--full` / `--no-truncate` flag per verb either;
 * `--json` already emits the full value.
 */
export function muTable(opts: {
  head: string[];
  /** Per-column max widths in cells (`null` = auto width). When
   *  supplied, the array length must match `head`. cli-table3
   *  truncates with `…` because we set `wordWrap: false`. */
  colWidths?: (number | null)[];
  /** Style override; defaults to `{ head: [], border: [] }` (mu's
   *  borderless look). Pass `{ head: [] }` to keep cli-table3's
   *  default border styling. */
  style?: { head?: string[]; border?: string[] };
}): InstanceType<typeof Table> {
  return new Table({
    head: opts.head,
    ...(opts.colWidths !== undefined ? { colWidths: opts.colWidths } : {}),
    style: opts.style ?? { head: [], border: [] },
    wordWrap: false,
  });
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
 * === "function"` rather than instanceof so cross-realm errors (e.g.
 * thrown from a different module instance after a hot-reload) still
 * surface their nextSteps.
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

// ─── Usage rendering for the validation-error contract ──────────────
//
// Every operator-error path (commander-thrown CommanderError, handler-
// thrown UsageError, typed *Invalid* errors) gets the same surface:
// (1) the error line, (2) the failing subcommand's --help. The human
// path prints commander's own helpInformation() (so future commander
// version bumps automatically pick up any rendering improvements);
// the --json path renders a structured shape so a script orchestrator
// can introspect the verb without re-shelling for --help.
//
// Why structured-not-string for JSON: the entire point of --json is
// that consumers never have to free-text-parse mu output. Embedding a
// multi-kilobyte rendered help blob in the JSON envelope defeats that
// — every option is already structured on the Command object.

/** Structured rendition of a verb's --help, for JSON error envelopes. */
export interface UsageJson {
  /** Full canonical name including parent commands (e.g. "mu task add"). */
  command: string;
  /** The single-line synopsis (e.g. "mu task add [options] [id]"). */
  synopsis: string;
  /** Verb description (the one-paragraph prose under the synopsis). */
  description: string;
  /** Positional arguments in declared order. */
  args: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  /** Options in declared order. `mandatory: true` iff the option was
   *  declared via `.requiredOption()` (i.e. the operator MUST pass it).
   *  `valueRequired: true` for `<value>`-style options whose value is
   *  required when the flag IS passed. The two are independent. */
  options: Array<{
    flags: string;
    description: string;
    mandatory: boolean;
    valueRequired: boolean;
  }>;
}

/** Walk parent chain so subcommand renderings include the full path
 *  ("mu task add" not just "add"). */
function commandFullName(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.join(" ");
}

/** Extract the structured usage shape for `--json` error envelopes. */
export function renderUsageJson(cmd: Command): UsageJson {
  return {
    command: commandFullName(cmd),
    synopsis: `${commandFullName(cmd)} ${cmd.usage()}`,
    description: cmd.description(),
    args: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
      description: a.description ?? "",
    })),
    options: cmd.options.map((o) => ({
      flags: o.flags,
      description: o.description ?? "",
      mandatory: o.mandatory ?? false,
      valueRequired: o.required ?? false,
    })),
  };
}

/** Render the human --help block (commander's own `helpInformation()`)
 *  to stderr. Single source of truth for the post-error help dump. */
export function printUsageHuman(cmd: Command): void {
  // helpInformation() returns the full "Usage: ...\n\n<desc>\n\nOptions:\n  ..." block.
  // Print to stderr (errors only) so success-path stdout is never polluted.
  process.stderr.write(`\n${cmd.helpInformation()}`);
}
