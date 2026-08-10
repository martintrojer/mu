// mu — typed-error → exit-code mapping + CLI handler wrapper.
//
// Extracted from src/cli.ts (review_cli_ts_past_refactor_signal):
// classifyError + emitError + handle were ~150 LOC in the middle of
// cli.ts. They live here so cli.ts is just argument parsing /
// workstream resolution / program wiring; the typed-error catalogue
// belongs next to its own helper. cli.ts re-exports `classifyError`
// and `handle` for back-compat with existing tests + cli/* importers.
//
// Exit codes (from VOCABULARY.md / ARCHITECTURE.md):
//   0 = success
//   1 = generic error
//   2 = usage error (validation / missing-flag / type / mutex /
//       unknown subcommand) — commander-detected mistakes AND
//       handler-thrown UsageError. Both surfaces print the failing
//       subcommand's --help (human path) or include a structured
//       `usage` field (--json path). See `audit_cli_validation_uniformity`.
//   3 = not found (no such agent / task / pane)
//   4 = conflict (name collision, double-claim, cycle, etc.)
//   5 = substrate unavailable (tmux not running, DB locked)
//   6 = REAPER_DETECTED — `mu task wait` aborted because the
//       per-poll reconciler flipped a watched task IN_PROGRESS →
//       OPEN (the owning pane was dead). Only fires when the wait
//       target is CLOSED.
//   7 = STALL_DETECTED — `mu task wait --on-stall exit` aborted
//       because the existing --stuck-after predicate fired on a
//       watched task. Same target=CLOSED carve-out as exit 6; if
//       both fire in the same poll iteration, exit 6 wins.

import { type Command, CommanderError } from "commander";
import {
  AgentBusyError,
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  WorkspacePreservedError,
} from "../agents.js";
import {
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  ArchiveRestoreTargetExistsError,
} from "../archives.js";
import { type Db, openDb, SchemaTooOldError, WorkstreamNotFoundError } from "../db.js";
import { DriftDetectedError } from "../drift.js";
import { GroupIdAmbiguousError } from "../logs.js";
import { MuxError, NoMultiplexerError, PaneNotFoundError } from "../mux.js";
import {
  hasNextSteps,
  isJsonMode,
  type NextStep,
  pc,
  printNextStepsTo,
  printUsageHuman,
  renderUsageJson,
  type UsageJson,
} from "../output.js";
import { RebuildTargetExistsError, RebuildTargetIsSourceError } from "../rebuild.js";
import {
  ambientFlush,
  ambientIngest,
  SyncPeerNotFoundError,
  SyncPeerRefAmbiguousError,
  SyncSourceNotFoundError,
  syncEnabled,
} from "../sync.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
  TaskAlreadyOwnedError,
  TaskClaimStaleWorkspaceError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
} from "../tasks.js";
import { NothingToUndoError, UndoGroupNotFoundError, UndoSupersededError } from "../undo.js";
import { WorkspaceConflictError, WorkspaceDirtyError, WorkspaceVcsRequiredError } from "../vcs.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
} from "../workspace.js";
import {
  WorkstreamExistsError,
  WorkstreamNameInvalidError,
  WorkstreamNameReservedError,
} from "../workstream.js";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Internal CLI-control sentinel for handlers that already rendered their
 * success/partial-success payload and only need `handle()` to exit with a
 * non-zero code AFTER its DB-close finally has run. Unlike `UsageError` it
 * emits no stderr text; it is a return-code mechanism owned by handle().
 */
export class CliExitError extends Error {
  override readonly name = "CliExitError";
  constructor(public readonly exitCode: number) {
    super(`exit ${exitCode}`);
  }
}

// ─── Active-command tracking for the validation-error contract ──────
//
// `setActiveCommand` is called by `handle()` at the entry of every
// .action() body. `emitError()` reads it to render the failing
// subcommand's --help on usage errors. We thread it via module-local
// state (mirror of `isJsonMode` reading process.argv) instead of
// constructor-arg-ing every UsageError throw site — there are 27 of
// them, several inside helpers (resolveWorkstream, parseStatusFilter)
// that don't know which subcommand called them.
//
// Cleared in handle()'s finally so a sequence of test calls (which
// re-use the process) doesn't bleed state across cases.

let activeCommand: Command | undefined;

/** Test-only: introspect the current active command. */
export function getActiveCommandForTest(): Command | undefined {
  return activeCommand;
}

/** Test-only: clear stale state between vitest cases. */
export function clearActiveCommandForTest(): void {
  activeCommand = undefined;
}

/** Map a commander.CommanderError to (exitCode, label). The codes that
 *  represent successful early-exits (--help, --version) are mapped to
 *  exitCode 0 and a sentinel label so emitError can short-circuit
 *  without printing anything. All other codes are uniform exit 2 —
 *  the documented "usage error" lane that handler-thrown UsageError
 *  also occupies. */
function classifyCommanderError(err: CommanderError): { label: string; exitCode: number } {
  if (
    err.code === "commander.helpDisplayed" ||
    err.code === "commander.help" ||
    err.code === "commander.version"
  ) {
    return { label: "help", exitCode: 0 };
  }
  // Everything else is a usage mistake (missing required option,
  // unknown option, unknown command, missing argument, type-coercion
  // via InvalidArgumentError). Renumber commander's default exit 1
  // to mu's documented exit 2 so the surface is uniform with the
  // handler-thrown UsageError lane.
  return { label: "error", exitCode: 2 };
}

/** Predicate: is this error a usage-class one for which we should
 *  render the failing subcommand's --help? Three families:
 *    1. CommanderError (missing required option, unknown option,
 *       unknown command, missing argument, type-coercion failure).
 *    2. UsageError (handler-thrown mutex / arity / range checks).
 *    3. Typed *Invalid* domain errors that fault on a value the
 *       operator typed at the CLI (workstream name, archive label,
 *       task id, prune-flag combination). The verb's --help would
 *       have explained the constraint; show it.
 *
 */
function isUsageClassError(err: unknown): boolean {
  if (err instanceof CommanderError) return true;
  if (err instanceof UsageError) return true;
  if (
    err instanceof WorkstreamNameInvalidError ||
    err instanceof WorkstreamNameReservedError ||
    err instanceof TaskIdInvalidError ||
    // A malformed archive label is the same class as a malformed
    // workstream name: bad input shape, exit 2.
    err instanceof ArchiveLabelInvalidError
  ) {
    return true;
  }
  return false;
}

/**
 * Raised when a bare entity name is used at the CLI but the resolution
 * context (--workstream / $MU_SESSION / current tmux session) is empty
 * AND the same name lives in two or more workstreams. Exit 4 (conflict)
 * via classifyError. The errorNextSteps lists every candidate as a
 * runnable qualified-form invocation — a one-paste fix.
 *
 * See verb_arg_qualified_workstream_name for the design.
 */
export class NameAmbiguousError extends Error {
  override readonly name = "NameAmbiguousError";
  constructor(
    public readonly entityName: string,
    public readonly candidates: readonly string[],
    public readonly kind: "task" | "agent" | "workspace",
  ) {
    super(
      `${kind} name "${entityName}" exists in ${candidates.length} workstreams (${candidates.join(", ")}); pass -w <workstream> or use the qualified form <workstream>/${entityName}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return this.candidates.map((ws) => ({
      intent: `Target the ${ws} ${this.kind}`,
      command: `${ws}/${this.entityName}`,
    }));
  }
}

/**
 * Map a typed error to (label, exitCode). The label is the prefix
 * before the message in human output (e.g. "conflict", "not found");
 * the exit code is what the process exits with.
 *
 * Order matters: more-specific classes first. The fallthrough at the
 * end is the generic exit-1 catch-all.
 */
export function classifyError(err: unknown): { label: string; exitCode: number } {
  if (
    err instanceof UsageError ||
    err instanceof WorkstreamNameInvalidError ||
    err instanceof WorkstreamNameReservedError
  ) {
    return { label: "error", exitCode: 2 };
  }
  if (
    err instanceof AgentNotFoundError ||
    err instanceof TaskNotFoundError ||
    err instanceof WorkstreamNotFoundError ||
    err instanceof WorkspaceNotFoundError
  ) {
    // WorkstreamNotFoundError originates inside resolveWorkstreamId
    // (src/db.ts) — it's the canonical resolve-time miss for the
    // first leg of the SDK boundary (operator-name → surrogate id).
    // Without this entry it fell through to generic exit 1, robbing
    // operators of the same -> exit-3 mapping that AgentNotFoundError /
    // TaskNotFoundError get. (schema_v5_cli_boundary)
    return { label: "not found", exitCode: 3 };
  }
  if (
    err instanceof NameAmbiguousError ||
    err instanceof AgentBusyError ||
    err instanceof AgentExistsError ||
    err instanceof TaskExistsError ||
    err instanceof TaskAlreadyOwnedError ||
    err instanceof TaskClaimStaleWorkspaceError ||
    err instanceof TaskNotInWorkstreamError ||
    err instanceof AgentNotInWorkstreamError ||
    err instanceof CycleError ||
    err instanceof TaskHasOpenDependentsError ||
    err instanceof CrossWorkstreamEdgeError ||
    err instanceof WorkspaceExistsError ||
    err instanceof WorkspacePathNotEmptyError ||
    err instanceof WorkspacePreservedError ||
    err instanceof HomeDirAsProjectRootError ||
    err instanceof WorkspaceVcsRequiredError ||
    err instanceof WorkspaceDirtyError ||
    err instanceof ClaimerNotRegisteredError ||
    err instanceof SchemaTooOldError ||
    err instanceof TaskIdInvalidError ||
    err instanceof WorkstreamExistsError ||
    // Rebuild refuses to overwrite an existing target or to write onto
    // the source DB: both are name/state collisions, not usage errors.
    err instanceof RebuildTargetExistsError ||
    err instanceof RebuildTargetIsSourceError ||
    // An abbreviated group id matching several groups: the operator must
    // disambiguate. Guessing would be catastrophic for `mu undo`.
    err instanceof GroupIdAmbiguousError ||
    // Restore refuses to write onto an existing workstream: a name/state
    // collision the operator resolves by choosing another --as.
    err instanceof ArchiveRestoreTargetExistsError
  ) {
    return { label: "conflict", exitCode: 4 };
  }
  if (
    err instanceof UndoGroupNotFoundError ||
    err instanceof NothingToUndoError ||
    // A `--repair <peer>` ref or a `--from <path>` that names nothing:
    // the same resolve-time-miss lane as every other not-found.
    err instanceof SyncPeerNotFoundError ||
    err instanceof SyncSourceNotFoundError
  ) {
    return { label: "not found", exitCode: 3 };
  }
  if (err instanceof ArchiveNotFoundError) {
    return { label: "not found", exitCode: 3 };
  }
  if (err instanceof SyncPeerRefAmbiguousError) {
    // An abbreviated peer id matching several peers. Same rule as an
    // ambiguous group id: the operator disambiguates, mu never guesses.
    return { label: "conflict", exitCode: 4 };
  }
  if (err instanceof UndoSupersededError) {
    // A conflict in the precise sense the exit-code map means: the
    // requested change collides with existing state (later work), and the
    // operator must choose (--force) rather than retry.
    return { label: "conflict", exitCode: 4 };
  }
  if (err instanceof DriftDetectedError) {
    // 5 = substrate unavailable/inconsistent. Drift means the SQLite
    // substrate is internally inconsistent (the log and the tables
    // disagree), which is exactly that category — not a usage mistake (2)
    // and not a name collision (4).
    return { label: "drift", exitCode: 5 };
  }
  if (err instanceof AgentSpawnCliNotFoundError) {
    // Pre-flight failure: --cli's resolved binary isn't on PATH. We
    // refused before any side effect, so this is the cleanest
    // operator-typo lane there is. Generic exit 1 (substrate-class)
    // matches AgentDiedOnSpawnError / AgentSpawnStartupError below —
    // all three are "the spawn can't produce a working agent".
    return { label: "spawn cli not found", exitCode: 1 };
  }
  if (err instanceof AgentDiedOnSpawnError) {
    // Substrate-level failure (CLI exited at spawn). The message is
    // already rich (includes captured scrollback). Generic exit 1.
    return { label: "spawn failed", exitCode: 1 };
  }
  if (err instanceof AgentSpawnStartupError) {
    // Pane is alive but the spawned CLI parked at a known
    // provider-auth-failure prompt. Same generic exit 1 lane as
    // AgentDiedOnSpawnError — both are "the spawn looked OK to mu but
    // the operator can't actually use this agent". The error message
    // already carries the matched line + scrollback;
    // errorNextSteps() carries the remediation recipe.
    return { label: "spawn startup error", exitCode: 1 };
  }
  if (err instanceof NoMultiplexerError) {
    return { label: "no multiplexer", exitCode: 5 };
  }
  if (err instanceof MuxError || err instanceof PaneNotFoundError) {
    // MuxError is the base of the per-backend families (TmuxError, …),
    // so one instanceof covers every multiplexer.
    return { label: "mux", exitCode: 5 };
  }
  if (err instanceof WorkspaceConflictError) {
    // Rebase produced conflicts — the operator must `cd` and resolve.
    // Distinct from the typed-conflict-of-state family (exit 4) which
    // we refused before any side effect; here the side effect happened
    // and the workspace is half-rebased. Same exit-code lane as
    // TmuxError (substrate-level: action requires manual recovery).
    return { label: "workspace conflict", exitCode: 5 };
  }
  if (err instanceof ReaperDetectedDuringWaitError) {
    // task_wait_reconcile_dead_panes: distinct exit code (6) so
    // operator scripts can branch on "worker died, not a generic
    // failure" vs the timeout (5) and the typed conflict family (4).
    return { label: "reaper", exitCode: 6 };
  }
  if (err instanceof StallDetectedDuringWaitError) {
    // task_wait_stall_action_flag: distinct exit code (7) so
    // operator scripts can branch on "worker idle, ambiguous" vs
    // the unambiguous dead-pane (6). Same precedence rule lives at
    // the wait call site: if both fire in one poll, the
    // ReaperDetectedDuringWaitError throw runs first, so exit 6 wins.
    return { label: "stall", exitCode: 7 };
  }
  return { label: "error", exitCode: 1 };
}

/** Render error + nextSteps to stderr and return the resolved exit
 *  code. Returning the exitCode lets `handle` reuse it instead of
 *  re-classifying the same error twice (review_code_classify_error_called_twice).
 *
 *  audit_cli_validation_uniformity: usage-class errors (commander +
 *  UsageError + typed *Invalid*) ALSO emit the failing subcommand's
 *  --help (human path) or a structured `usage` field (JSON path). */
function emitError(err: unknown): number {
  if (err instanceof CliExitError) return err.exitCode;

  // Commander's --help / --version success-exits arrive as CommanderError
  // with exitCode 0. helpInformation() has already been written by
  // commander itself; nothing more to do.
  if (err instanceof CommanderError) {
    const { exitCode } = classifyCommanderError(err);
    if (exitCode === 0) return 0;
  }

  const message = err instanceof Error ? err.message : String(err);
  const { label, exitCode } =
    err instanceof CommanderError ? classifyCommanderError(err) : classifyError(err);
  const errClass = err instanceof Error ? err.name : "Error";
  const steps: NextStep[] = hasNextSteps(err) ? err.errorNextSteps() : [];
  // Strip commander's own "error: " prefix — we re-add our own "error: "
  // (red, in the human path) and don't want "error: error: ...".
  const cleanMessage =
    err instanceof CommanderError && message.startsWith("error: ")
      ? message.slice("error: ".length)
      : message;
  const usageCmd = isUsageClassError(err) ? activeCommand : undefined;
  const usage: UsageJson | undefined = usageCmd ? renderUsageJson(usageCmd) : undefined;

  if (isJsonMode()) {
    const envelope: Record<string, unknown> = {
      error: errClass,
      message: cleanMessage,
      nextSteps: steps,
      exitCode,
    };
    if (usage) envelope.usage = usage;
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
    return exitCode;
  }

  console.error(pc.red(`${label}: ${cleanMessage}`));
  if (steps.length > 0) {
    printNextStepsTo(steps, "stderr");
  }
  if (usageCmd) {
    printUsageHuman(usageCmd);
  }
  return exitCode;
}

export interface HandleOptions {
  /**
   * Opt OUT of the ambient sync hook. Exactly one verb sets this today:
   * `mu sql`, the escape hatch whose no-surprise-mutations property is
   * load-bearing. An operator running `mu sql "SELECT ..."` to inspect
   * state must see the state as it is, not as it becomes once a peer's
   * segment lands mid-query.
   */
  ambientSync?: false;
}

/** Wrap an async handler so typed errors become specific exit codes.
 *
 *  The optional `command` arg is the failing subcommand's `Command`
 *  (commander's `this` in a `.action(function () { ... })` body).
 *  When supplied, usage-class errors thrown inside `fn` will render
 *  that subcommand's --help (human) or `usage` JSON (--json).
 *
 *  THE AMBIENT-SYNC SEAM. `handle()` is the one place every verb passes
 *  through, and it is ALREADY async while most verb bodies are
 *  synchronous — which is exactly why the hook belongs here and nowhere
 *  else. `syncPass` is async (it takes a cross-process file lock); if the
 *  hook lived inside the verbs, ~63 synchronous handlers would have had
 *  to become async to await it. Here, one `await` before `fn(db)` and one
 *  after covers all of them, and no verb learns that sync exists.
 *
 *  Order is load-bearing: INGEST before the body (so the verb reads the
 *  freshest state transport has delivered) and FLUSH after (so the ops
 *  the verb just wrote are in this machine's segment before the process
 *  exits, rather than waiting for the next invocation).
 *
 *  Neither half can fail the command — see src/sync.ts. */
export function handle(
  fn: (db: Db) => Promise<void>,
  command?: Command,
  opts?: HandleOptions,
): () => Promise<void> {
  return async () => {
    let db: Db | undefined;
    let exitCode: number | undefined;
    activeCommand = command;
    // The single `if` the unconfigured single-machine case pays: one env
    // var read, no promise allocated, no filesystem touched.
    const ambient = opts?.ambientSync !== false && syncEnabled();
    try {
      db = openDb();
      if (ambient) await ambientIngest(db);
      await fn(db);
    } catch (err) {
      exitCode = emitError(err);
    } finally {
      activeCommand = undefined;
      // Flush even on the error path: the verb may have committed ops
      // before throwing (a cascade that hit a cycle halfway), and those
      // ops are already canonical in `ops`. Withholding them from the
      // segment would make this machine's history depend on whether the
      // command happened to exit 0.
      if (ambient && db !== undefined) {
        try {
          await ambientFlush(db);
        } catch {
          // ambientFlush is already total; belt and braces.
        }
      }
      try {
        db?.close();
      } catch {
        // best effort
      }
    }
    if (exitCode !== undefined) process.exit(exitCode);
  };
}

/** Translate a commander parse-time error into mu's wire format,
 *  then return the exit code. Used by the top-level `parseAsync` catch
 *  in cli.ts so commander mistakes go through the same emitError
 *  pipeline that handler-thrown errors use. */
export function emitParseError(err: unknown, failingCommand: Command | undefined): number {
  activeCommand = failingCommand;
  try {
    return emitError(err);
  } finally {
    activeCommand = undefined;
  }
}

/** Walk argv tokens against the program tree to find the deepest
 *  matching subcommand. Used by parseAsync's catch to identify which
 *  subcommand commander was processing when it threw. Stops at the
 *  first `-` (option) or unknown token. */
export function findCommandForArgv(root: Command, argv: readonly string[]): Command {
  let cur: Command = root;
  for (const t of argv) {
    if (t.startsWith("-")) break;
    const next: Command | undefined = cur.commands.find(
      (c) => c.name() === t || (c.aliases().includes(t) ?? false),
    );
    if (!next) break;
    cur = next;
  }
  return cur;
}
