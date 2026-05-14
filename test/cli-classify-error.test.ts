// Unit coverage for src/cli.ts:classifyError().
//
// classifyError maps a typed error class to the (label, exit-code)
// pair the CLI's emitError() uses. The mapping is the canonical source
// of truth for VOCABULARY.md's exit-code table:
//   0 = success          1 = generic            2 = usage
//   3 = not found        4 = conflict           5 = substrate
//   6 = reaper           7 = stall
//
// The cases below intentionally follow the same order as
// src/cli/handle.ts:classifyError(). When a new class is added to that
// switch, the missing adjacent row should be obvious in review.

import { describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  WorkspacePreservedError,
} from "../src/agents.js";
import {
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  ArchiveSourceAmbiguousError,
} from "../src/archives.js";
import { NameAmbiguousError, UsageError, classifyError } from "../src/cli.js";
import {
  DbExportTargetExistsError,
  DbImportConflictError,
  DbImportManifestMissingError,
  DbImportSchemaTooNewError,
  DbImportSchemaTooOldError,
  DbImportSourceStaleError,
  DbReplayLocalIdConflictError,
  DbReplayWorkstreamMissingError,
} from "../src/db-sync.js";
import { SchemaTooOldError, WorkstreamNotFoundError } from "../src/db.js";
import {
  PruneOptionsInvalidError,
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
} from "../src/snapshots.js";
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
} from "../src/tasks.js";
import { PaneNotFoundError, TmuxError } from "../src/tmux.js";
import {
  WorkspaceConflictError,
  WorkspaceDirtyError,
  WorkspaceVcsRequiredError,
} from "../src/vcs.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
} from "../src/workspace.js";
import { WorkstreamExistsError, WorkstreamNameInvalidError } from "../src/workstream.js";

describe("classifyError exit-code map", () => {
  // (instance, expected exit code, expected label)
  const cases: Array<[Error, number, string]> = [
    // switch branch 1: usage / invalid operator input
    [new UsageError("bad flag"), 2, "error"],
    [new WorkstreamNameInvalidError("Bad-Name"), 2, "error"],
    [new ArchiveLabelInvalidError("Bad Label!"), 2, "error"],
    [new PruneOptionsInvalidError("--keep-last requires a number"), 2, "error"],

    // switch branch 2: resolve-time misses
    [new AgentNotFoundError("alice"), 3, "not found"],
    [new TaskNotFoundError("foo"), 3, "not found"],
    // schema_v5_cli_boundary — the resolve-time miss for the SDK
    // boundary's first leg (operator-name → workstreams.id).
    [new WorkstreamNotFoundError("ghost"), 3, "not found"],
    [new WorkspaceNotFoundError("alice"), 3, "not found"],
    [new SnapshotNotFoundError(9999), 3, "not found"],
    [new ArchiveNotFoundError("missing-archive"), 3, "not found"],

    // switch branch 3: conflicts / state mismatches
    [new NameAmbiguousError("dupe", ["ws-a", "ws-b"], "task"), 4, "conflict"],
    [new AgentExistsError("alice"), 4, "conflict"],
    [new TaskExistsError("foo"), 4, "conflict"],
    [new TaskAlreadyOwnedError("foo", "alice"), 4, "conflict"],
    [
      new TaskClaimStaleWorkspaceError({
        agentName: "alice",
        workstreamName: "stale-ws",
        commitsBehindMain: 12,
        isStale: true,
      }),
      4,
      "conflict",
    ],
    [new TaskNotInWorkstreamError("foo", "wsA", "wsB"), 4, "conflict"],
    [new AgentNotInWorkstreamError("alice", "wsA", "wsB"), 4, "conflict"],
    [new CycleError("a", "b"), 4, "conflict"],
    [new TaskHasOpenDependentsError("foo", "reject", ["bar"]), 4, "conflict"],
    [new CrossWorkstreamEdgeError("blocker", "wsA", "dep", "wsB"), 4, "conflict"],
    [new WorkspaceExistsError("alice"), 4, "conflict"],
    [new WorkspacePathNotEmptyError("alice", "ws", "/tmp/ws/alice"), 4, "conflict"],
    [new WorkspacePreservedError("alice", "/tmp/ws/alice"), 4, "conflict"],
    [new HomeDirAsProjectRootError("alice", "ws", "/Users/alice"), 4, "conflict"],
    [new WorkspaceVcsRequiredError("refresh", "/tmp/ws/alice"), 4, "conflict"],
    [new WorkspaceDirtyError("/tmp/ws/alice", ["src/file.ts"]), 4, "conflict"],
    [new ClaimerNotRegisteredError("pi-mu", "%6441"), 4, "conflict"],
    [new SnapshotVersionMismatchError(42, 6, 7), 4, "conflict"],
    [new SchemaTooOldError(4, 5), 4, "conflict"],
    [new TaskIdInvalidError("Bad ID"), 4, "conflict"],
    [new ArchiveAlreadyExistsError("release-v1"), 4, "conflict"],
    [new ArchiveSourceAmbiguousError("wave", ["alpha", "beta"]), 4, "conflict"],
    [new WorkstreamExistsError("existing-ws"), 4, "conflict"],

    // switch branches 4-10: db sync typed failures
    [new DbImportManifestMissingError("/tmp/mu.db.manifest.json"), 8, "db import manifest missing"],
    [new DbImportSchemaTooOldError(7), 9, "db import schema too old"],
    [new DbImportSchemaTooNewError(9), 10, "db import schema too new"],
    [new DbImportSourceStaleError(["alpha"]), 11, "db import source stale"],
    [new DbImportConflictError(["alpha"]), 12, "db import conflict"],
    [new DbReplayWorkstreamMissingError("alpha"), 13, "db replay workstream missing"],
    [
      new DbReplayLocalIdConflictError("alpha", [
        {
          localId: "t1",
          local: { title: "Local", status: "OPEN" },
          sidecar: { title: "Sidecar", status: "CLOSED" },
        },
      ]),
      14,
      "db replay local-id conflict",
    ],

    // switch branch 11: export target conflict
    [new DbExportTargetExistsError("/tmp/export.db"), 4, "conflict"],

    // switch branches 12-14: spawn failures
    [
      new AgentSpawnCliNotFoundError("pi-meta", "pi-meta", "MU_PI_META_COMMAND"),
      1,
      "spawn cli not found",
    ],
    [new AgentDiedOnSpawnError("alice", "%15", "panic: died"), 1, "spawn failed"],
    [
      new AgentSpawnStartupError(
        "alice",
        "%15",
        "Error: No API key found for amazon-bedrock",
        "Error: No API key found for amazon-bedrock\n> ",
      ),
      1,
      "spawn startup error",
    ],

    // switch branch 7: tmux substrate
    [new TmuxError(["list-panes"], "no server", "", 1), 5, "tmux"],
    [new PaneNotFoundError("%999"), 5, "tmux"],

    // switch branch 8: VCS conflict during workspace refresh
    [
      new WorkspaceConflictError("/tmp/ws/alice", "origin/main", ["src/file.ts"]),
      5,
      "workspace conflict",
    ],

    // switch branches 9-10: wait-specific process states
    [new ReaperDetectedDuringWaitError("wait_task", "worker-1", "ws"), 6, "reaper"],
    [new StallDetectedDuringWaitError("wait_task", "worker-1", "ws", 300), 7, "stall"],

    // switch branch 11: snapshot row exists but the substrate file is gone
    [new SnapshotFileMissingError(42, "/tmp/missing.db"), 5, "snapshot file missing"],

    // final fallthrough: generic catch-all (non-typed errors)
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
