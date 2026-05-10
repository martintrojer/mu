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
//   2 = usage error (commander default)
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

import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  WorkspacePreservedError,
} from "../agents.js";
import {
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
} from "../archives.js";
import { type Db, SchemaTooOldError, WorkstreamNotFoundError, openDb } from "../db.js";
import { LegacyExportLayoutError } from "../exporting.js";
import {
  ImportBucketInvalidError,
  ImportEdgeRefMissingError,
  ImportFrontmatterParseError,
  ImportLegacyLayoutError,
  ImportSourceNotInBucketError,
  WorkstreamAlreadyExistsError,
} from "../importing.js";
import { type NextStep, hasNextSteps, isJsonMode, pc, printNextStepsTo } from "../output.js";
import {
  PruneOptionsInvalidError,
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
} from "../snapshots.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
} from "../tasks.js";
import { PaneNotFoundError, TmuxError } from "../tmux.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
} from "../workspace.js";
import { WorkstreamNameInvalidError } from "../workstream.js";

export class UsageError extends Error {
  override readonly name = "UsageError";
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
    err instanceof ArchiveLabelInvalidError ||
    err instanceof LegacyExportLayoutError ||
    err instanceof ImportBucketInvalidError ||
    err instanceof ImportLegacyLayoutError ||
    err instanceof ImportFrontmatterParseError ||
    err instanceof ImportEdgeRefMissingError ||
    err instanceof PruneOptionsInvalidError
  ) {
    return { label: "error", exitCode: 2 };
  }
  if (
    err instanceof AgentNotFoundError ||
    err instanceof TaskNotFoundError ||
    err instanceof WorkstreamNotFoundError ||
    err instanceof WorkspaceNotFoundError ||
    err instanceof SnapshotNotFoundError ||
    err instanceof ArchiveNotFoundError
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
    err instanceof AgentExistsError ||
    err instanceof TaskExistsError ||
    err instanceof TaskAlreadyOwnedError ||
    err instanceof TaskNotInWorkstreamError ||
    err instanceof AgentNotInWorkstreamError ||
    err instanceof CycleError ||
    err instanceof TaskHasOpenDependentsError ||
    err instanceof CrossWorkstreamEdgeError ||
    err instanceof WorkspaceExistsError ||
    err instanceof WorkspacePathNotEmptyError ||
    err instanceof WorkspacePreservedError ||
    err instanceof HomeDirAsProjectRootError ||
    err instanceof ClaimerNotRegisteredError ||
    err instanceof SnapshotVersionMismatchError ||
    err instanceof SchemaTooOldError ||
    err instanceof TaskIdInvalidError ||
    err instanceof ArchiveAlreadyExistsError ||
    err instanceof ImportSourceNotInBucketError ||
    err instanceof WorkstreamAlreadyExistsError
  ) {
    return { label: "conflict", exitCode: 4 };
  }
  if (err instanceof AgentDiedOnSpawnError) {
    // Substrate-level failure (CLI exited at spawn). The message is
    // already rich (includes captured scrollback). Generic exit 1.
    return { label: "spawn failed", exitCode: 1 };
  }
  if (err instanceof TmuxError || err instanceof PaneNotFoundError) {
    return { label: "tmux", exitCode: 5 };
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
  if (err instanceof SnapshotFileMissingError) {
    // Substrate-level: the .db file is gone but the row still says it
    // should be there. Same flavour as `tmux` errors above.
    return { label: "snapshot file missing", exitCode: 5 };
  }
  return { label: "error", exitCode: 1 };
}

/** Render error + nextSteps to stderr and return the resolved exit
 *  code. Returning the exitCode lets `handle` reuse it instead of
 *  re-classifying the same error twice (review_code_classify_error_called_twice). */
function emitError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const { label, exitCode } = classifyError(err);
  const errClass = err instanceof Error ? err.name : "Error";
  const steps: NextStep[] = hasNextSteps(err) ? err.errorNextSteps() : [];

  if (isJsonMode()) {
    process.stderr.write(
      `${JSON.stringify({
        error: errClass,
        message,
        nextSteps: steps,
        exitCode,
      })}\n`,
    );
    return exitCode;
  }

  console.error(pc.red(`${label}: ${message}`));
  if (steps.length > 0) {
    // Dim the next-step block so humans skim past; agents reading the
    // captured error still get them.
    printNextStepsTo(steps, "stderr");
  }
  return exitCode;
}

/** Wrap an async handler so typed errors become specific exit codes. */
export function handle(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    let db: Db | undefined;
    try {
      db = openDb();
      await fn(db);
    } catch (err) {
      const exitCode = emitError(err);
      process.exit(exitCode);
    } finally {
      try {
        db?.close();
      } catch {
        // best effort
      }
    }
  };
}
