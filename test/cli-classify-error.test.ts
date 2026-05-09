// Unit coverage for src/cli.ts:classifyError().
//
// classifyError maps a typed error class to the (label, exit-code)
// pair the CLI's emitError() uses. The mapping is the canonical source
// of truth for VOCABULARY.md's exit-code table:
//   0 = success          1 = generic            2 = usage
//   3 = not found        4 = conflict           5 = substrate
//
// Surfaced by schema_v5_cli_boundary: WorkstreamNotFoundError (the
// resolve-time miss raised by src/db.ts:resolveWorkstreamId — the
// first leg of the SDK boundary, operator-name → surrogate id) was
// missing from the "not found" group and silently fell through to
// generic exit 1. This file pins that mapping (and a few sibling
// classes) so a future regression on the resolve-time error map is
// caught immediately at the unit level.
//
// Why a unit test rather than a CLI smoke test: the auto-ensure
// ergonomic in addTask / addApproval / insertAgent (each calls
// `ensureWorkstream` before `resolveWorkstreamId`) means no current
// CLI verb consistently triggers WorkstreamNotFoundError — so the
// only way to assert the error→exit mapping is to call the classifier
// directly. (If a future verb skips ensureWorkstream by design, a
// CLI smoke test should be added then.)

import { describe, expect, it } from "vitest";
import { AgentNotFoundError } from "../src/agents.js";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
} from "../src/approvals.js";
import { UsageError, classifyError } from "../src/cli.js";
import { SchemaTooOldError, WorkstreamNotFoundError } from "../src/db.js";
import { SnapshotNotFoundError } from "../src/snapshots.js";
import {
  CycleError,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
} from "../src/tasks.js";
import { PaneNotFoundError, TmuxError } from "../src/tmux.js";
import {
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
} from "../src/workspace.js";
import { WorkstreamNameInvalidError } from "../src/workstream.js";

describe("classifyError exit-code map", () => {
  // (instance, expected exit code, expected label)
  const cases: Array<[Error, number, string]> = [
    // exit 2: usage
    [new UsageError("bad flag"), 2, "error"],
    [new WorkstreamNameInvalidError("Bad-Name"), 2, "error"],

    // exit 3: not found (resolve-time misses)
    [new AgentNotFoundError("alice"), 3, "not found"],
    [new TaskNotFoundError("foo"), 3, "not found"],
    // schema_v5_cli_boundary — the resolve-time miss for the SDK
    // boundary's first leg (operator-name → workstreams.id).
    [new WorkstreamNotFoundError("ghost"), 3, "not found"],
    [new WorkspaceNotFoundError("alice"), 3, "not found"],
    [new ApprovalNotFoundError("app_xyz"), 3, "not found"],
    [new SnapshotNotFoundError(9999), 3, "not found"],

    // exit 4: conflict / state mismatch
    [new TaskExistsError("foo"), 4, "conflict"],
    [new TaskAlreadyOwnedError("foo", "alice"), 4, "conflict"],
    [new TaskNotInWorkstreamError("foo", "wsA", "wsB"), 4, "conflict"],
    [new CycleError("a", "b"), 4, "conflict"],
    [new WorkspaceExistsError("alice"), 4, "conflict"],
    [new WorkspacePathNotEmptyError("alice", "ws", "/p"), 4, "conflict"],
    [new ApprovalAlreadyDecidedError("app_xyz", "granted"), 4, "conflict"],
    [new ApprovalNotInWorkstreamError("app_xyz", "wsA", "wsB"), 4, "conflict"],
    [new SchemaTooOldError(0, 5), 4, "conflict"],

    // exit 5: substrate unavailable
    [new TmuxError(["list-panes"], "no server", "", 1), 5, "tmux"],
    [new PaneNotFoundError("%999"), 5, "tmux"],

    // exit 1: generic catch-all (non-typed errors)
    [new Error("some other thing"), 1, "error"],
  ];

  for (const [err, exit, label] of cases) {
    it(`${err.name || "Error"} → exit ${exit} (${label})`, () => {
      const result = classifyError(err);
      expect(result.exitCode).toBe(exit);
      expect(result.label).toBe(label);
    });
  }
});
