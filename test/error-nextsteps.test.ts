// Verifies every exported typed error class with errorNextSteps()
// carries actionable, contextual recovery hints.
//
// One test per error class. Tests don't assert the exact text of the
// hints (those evolve); they assert that the error implements
// HasNextSteps, returns a non-empty array of well-formed NextStep
// records, and that at least one command contains the constructor
// context that makes the hint copy-pasteable rather than generic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  NoForegroundProcessError,
  WorkspacePreservedError,
} from "../src/agents.js";
import {
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
} from "../src/archives.js";
import { NameAmbiguousError } from "../src/cli.js";
import { SchemaTooOldError, WorkstreamNotFoundError, openDb } from "../src/db.js";
import {
  ImportBucketInvalidError,
  ImportEdgeRefMissingError,
  ImportFrontmatterParseError,
  ImportSourceNotInBucketError,
  WorkstreamAlreadyExistsError,
} from "../src/importing.js";
import { hasNextSteps } from "../src/output.js";
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
import { WorkstreamNameInvalidError } from "../src/workstream.js";

interface NextStepLike {
  intent: string;
  command: string;
}

interface NextStepsCase {
  error: Error;
  label: string;
  expectedTokens: string[];
}

const staleWorkspace = {
  agentName: "stale-agent",
  workstreamName: "stale-ws",
  commitsBehindMain: 12,
  isStale: true,
};

const cases: NextStepsCase[] = [
  // src/tasks/errors.ts
  { error: new TaskNotFoundError("foo"), label: "TaskNotFoundError", expectedTokens: ["foo"] },
  {
    error: new TaskIdInvalidError("Bad ID"),
    label: "TaskIdInvalidError",
    expectedTokens: ["bad_id"],
  },
  { error: new TaskExistsError("foo"), label: "TaskExistsError", expectedTokens: ["foo"] },
  {
    error: new TaskNotInWorkstreamError("foo", "expected", "actual"),
    label: "TaskNotInWorkstreamError",
    expectedTokens: ["foo", "actual"],
  },
  {
    error: new TaskAlreadyOwnedError("foo", "alice"),
    label: "TaskAlreadyOwnedError",
    expectedTokens: ["foo", "alice"],
  },
  {
    error: new TaskHasOpenDependentsError("foo", "reject", ["bar"]),
    label: "TaskHasOpenDependentsError",
    expectedTokens: ["foo"],
  },
  {
    error: new ClaimerNotRegisteredError("pi-mu", "%6441"),
    label: "ClaimerNotRegisteredError (with pane)",
    expectedTokens: ["%6441"],
  },
  {
    // No-pane variant has no entity to interpolate, but it still must
    // produce the anonymous / --for / adopt recovery options.
    error: new ClaimerNotRegisteredError("pi-mu", null),
    label: "ClaimerNotRegisteredError (no pane)",
    expectedTokens: ["--self", "--for", "<pane-id>"],
  },
  {
    error: new TaskClaimStaleWorkspaceError(staleWorkspace),
    label: "TaskClaimStaleWorkspaceError",
    expectedTokens: ["stale-agent", "stale-ws"],
  },
  { error: new CycleError("a", "b"), label: "CycleError", expectedTokens: ["a", "b"] },
  {
    error: new ReaperDetectedDuringWaitError("wait_task", "worker-1", "wait-ws"),
    label: "ReaperDetectedDuringWaitError",
    expectedTokens: ["wait_task", "wait-ws"],
  },
  {
    error: new StallDetectedDuringWaitError("wait_task", "worker-1", "wait-ws", 300),
    label: "StallDetectedDuringWaitError",
    expectedTokens: ["wait_task", "worker-1", "wait-ws"],
  },
  {
    // CrossWorkstreamEdgeError's recovery is to move or duplicate the
    // BLOCKER, so the dependent id legitimately doesn't appear in all
    // commands. Pin the blocker + destination workstream context.
    error: new CrossWorkstreamEdgeError("blocker", "wsA", "dep", "wsB"),
    label: "CrossWorkstreamEdgeError",
    expectedTokens: ["blocker", "wsB"],
  },

  // src/agents/errors.ts + src/agents/kick.ts
  {
    error: new AgentSpawnCliNotFoundError("pi-meta", "pi-meta", "MU_PI_META_COMMAND"),
    label: "AgentSpawnCliNotFoundError",
    expectedTokens: ["MU_PI_META_COMMAND", "pi-meta"],
  },
  { error: new AgentExistsError("alice"), label: "AgentExistsError", expectedTokens: ["alice"] },
  {
    error: new AgentNotFoundError("alice"),
    label: "AgentNotFoundError",
    expectedTokens: ["alice"],
  },
  {
    error: new AgentNotInWorkstreamError("alice", "expected", "actual"),
    label: "AgentNotInWorkstreamError",
    expectedTokens: ["alice", "actual"],
  },
  {
    error: new AgentDiedOnSpawnError("scout-perf-1", "%42", "panic: died"),
    label: "AgentDiedOnSpawnError",
    expectedTokens: ["scout-perf-1"],
  },
  {
    error: new AgentSpawnStartupError(
      "alice",
      "%15",
      "Error: No API key found for amazon-bedrock",
      "Error: No API key found for amazon-bedrock\n> ",
    ),
    label: "AgentSpawnStartupError",
    expectedTokens: ["alice"],
  },
  {
    error: new WorkspacePreservedError("alice", "/path/to/ws"),
    label: "WorkspacePreservedError",
    expectedTokens: ["alice", "/path/to/ws"],
  },
  {
    error: new NoForegroundProcessError("alice", "/dev/ttys001", "shell-only"),
    label: "NoForegroundProcessError",
    expectedTokens: ["alice"],
  },

  // src/tmux.ts
  {
    error: new TmuxError(["list-panes"], "no server", "", 1),
    label: "TmuxError",
    expectedTokens: ["doctor", "list-panes"],
  },
  { error: new PaneNotFoundError("%999"), label: "PaneNotFoundError", expectedTokens: ["%999"] },

  // src/workspace/core.ts
  {
    error: new WorkspaceExistsError("alice"),
    label: "WorkspaceExistsError",
    expectedTokens: ["alice"],
  },
  {
    error: new WorkspaceNotFoundError("alice"),
    label: "WorkspaceNotFoundError",
    expectedTokens: ["alice"],
  },
  {
    error: new WorkspacePathNotEmptyError("alice", "auth", "/path/to/ws"),
    label: "WorkspacePathNotEmptyError",
    expectedTokens: ["alice", "auth", "/path/to/ws"],
  },
  {
    error: new HomeDirAsProjectRootError("alice", "auth", "/Users/alice"),
    label: "HomeDirAsProjectRootError",
    expectedTokens: ["alice", "auth", "<your-project>"],
  },

  // src/vcs/types.ts
  {
    error: new WorkspaceVcsRequiredError("refresh", "/path/to/ws"),
    label: "WorkspaceVcsRequiredError",
    expectedTokens: ["workspace", "<jj|sl|git>"],
  },
  {
    error: new WorkspaceDirtyError("/path/to/ws", ["src/file.ts"], "recreate"),
    label: "WorkspaceDirtyError",
    expectedTokens: ["/path/to/ws", "--force"],
  },
  {
    error: new WorkspaceConflictError("/path/to/ws", "origin/main", ["src/file.ts"]),
    label: "WorkspaceConflictError",
    expectedTokens: ["/path/to/ws", "rebase --abort"],
  },

  // src/workstream.ts / src/db.ts
  {
    error: new WorkstreamNameInvalidError("mu-foo"),
    label: "WorkstreamNameInvalidError",
    expectedTokens: ["foo"],
  },
  {
    error: new WorkstreamNotFoundError("ghost"),
    label: "WorkstreamNotFoundError",
    expectedTokens: ["ghost"],
  },
  {
    error: new SchemaTooOldError(4, 5),
    label: "SchemaTooOldError",
    expectedTokens: ["migrate-v4-to-v5", "sqlite3"],
  },

  // src/snapshots/*
  {
    error: new SnapshotNotFoundError(9999),
    label: "SnapshotNotFoundError",
    expectedTokens: ["snapshot"],
  },
  {
    error: new SnapshotVersionMismatchError(42, 6, 7),
    label: "SnapshotVersionMismatchError (older)",
    expectedTokens: ["schema_version = 7"],
  },
  {
    error: new SnapshotVersionMismatchError(43, 8, 7),
    label: "SnapshotVersionMismatchError (newer)",
    expectedTokens: ["@latest"],
  },
  {
    error: new SnapshotFileMissingError(42, "/path/to/snap.db"),
    label: "SnapshotFileMissingError",
    expectedTokens: ["42"],
  },
  {
    error: new PruneOptionsInvalidError("bad prune flags"),
    label: "PruneOptionsInvalidError",
    expectedTokens: ["prune --help"],
  },

  // src/archives/core.ts
  {
    error: new ArchiveNotFoundError("release-v1"),
    label: "ArchiveNotFoundError",
    expectedTokens: ["release-v1"],
  },
  {
    error: new ArchiveAlreadyExistsError("release-v1"),
    label: "ArchiveAlreadyExistsError",
    expectedTokens: ["release-v1"],
  },
  {
    error: new ArchiveLabelInvalidError("Bad Label!"),
    label: "ArchiveLabelInvalidError",
    expectedTokens: ["bad_label_"],
  },

  // src/importing.ts
  {
    error: new ImportBucketInvalidError("/tmp/mu-bucket", "manifest.json missing"),
    label: "ImportBucketInvalidError",
    expectedTokens: ["/tmp/mu-bucket", "manifest.json"],
  },
  {
    error: new ImportSourceNotInBucketError("/tmp/mu-bucket", "ghost", ["alpha", "beta"]),
    label: "ImportSourceNotInBucketError",
    expectedTokens: ["/tmp/mu-bucket", "manifest.json"],
  },
  {
    error: new WorkstreamAlreadyExistsError("existing-ws"),
    label: "WorkstreamAlreadyExistsError",
    expectedTokens: ["existing-ws", "--workstream <new-name>"],
  },
  {
    error: new ImportFrontmatterParseError("/tmp/mu-bucket/ws/tasks/foo.md", 3, "bad"),
    label: "ImportFrontmatterParseError",
    expectedTokens: ["/tmp/mu-bucket/ws/tasks/foo.md"],
  },
  {
    error: new ImportEdgeRefMissingError("from_task", "missing_task", "blocks"),
    label: "ImportEdgeRefMissingError",
    expectedTokens: ["from_task", "<bucket>"],
  },

  // src/cli/handle.ts
  {
    error: new NameAmbiguousError("dupe", ["ws-a", "ws-b"], "task"),
    label: "NameAmbiguousError",
    expectedTokens: ["ws-a/dupe", "ws-b/dupe"],
  },
];

function assertWellFormedSteps(err: Error): NextStepLike[] {
  expect(hasNextSteps(err)).toBe(true);
  const steps = (err as unknown as { errorNextSteps: () => unknown[] }).errorNextSteps();
  expect(Array.isArray(steps)).toBe(true);
  expect(steps.length).toBeGreaterThan(0);
  for (const s of steps as Array<{ intent?: unknown; command?: unknown }>) {
    expect(typeof s.intent).toBe("string");
    expect(typeof s.command).toBe("string");
    expect((s.intent as string).trim().length).toBeGreaterThan(0);
    expect((s.command as string).trim().length).toBeGreaterThan(0);
  }
  return steps as NextStepLike[];
}

function commandContainsEveryToken(steps: NextStepLike[], tokens: string[]): void {
  const commands = steps.map((s) => s.command);
  for (const token of tokens) {
    expect(
      commands.some((c) => c.includes(token)),
      `expected at least one step's command to mention '${token}'; got: ${JSON.stringify(commands)}`,
    ).toBe(true);
  }
}

describe("typed errors all carry actionable errorNextSteps()", () => {
  for (const { error, label, expectedTokens } of cases) {
    it(`${label}: implements HasNextSteps with non-empty, well-formed, contextual steps`, () => {
      const steps = assertWellFormedSteps(error);
      commandContainsEveryToken(steps, expectedTokens);
    });
  }

  it("inventory matches exported error classes", async () => {
    const modules = await Promise.all([
      import("../src/agents.js"),
      import("../src/tasks.js"),
      import("../src/archives.js"),
      import("../src/importing.js"),
      import("../src/snapshots.js"),
      import("../src/vcs.js"),
      import("../src/workspace.js"),
      import("../src/db.js"),
      import("../src/workstream.js"),
      import("../src/tmux.js"),
      import("../src/cli.js"),
    ]);

    const exportedNames = new Set<string>();
    for (const moduleExports of modules) {
      for (const exported of Object.values(moduleExports)) {
        if (isErrorConstructorWithNextSteps(exported)) {
          exportedNames.add(exported.name);
        }
      }
    }

    const coveredNames = new Set(cases.map((c) => c.error.name));
    const missing = [...exportedNames].filter((name) => !coveredNames.has(name)).sort();
    expect(missing).toEqual([]);
    expect(coveredNames.size).toBe(exportedNames.size);
    expect(cases.length).toBeGreaterThanOrEqual(exportedNames.size);
  });
});

function isErrorConstructorWithNextSteps(
  value: unknown,
): value is { name: string; prototype: Error & { errorNextSteps: () => unknown } } {
  if (typeof value !== "function") return false;
  const prototype = (value as { prototype?: unknown }).prototype;
  if (!(prototype instanceof Error)) return false;
  return typeof (prototype as { errorNextSteps?: unknown }).errorNextSteps === "function";
}

describe("error-specific structured-step assertions", () => {
  it("ClaimerNotRegisteredError pins the exact pane id when given", () => {
    const err = new ClaimerNotRegisteredError("pi-mu", "%42");
    const steps = err.errorNextSteps();
    const adopt = steps.find((s) => s.command.startsWith("mu agent adopt"));
    expect(adopt?.command).toBe("mu agent adopt %42");
  });

  it("TaskNotInWorkstreamError suggests the actual workstream", () => {
    const err = new TaskNotInWorkstreamError("foo", "wsA", "wsB");
    const steps = err.errorNextSteps();
    const useActual = steps.find((s) => s.command.includes("-w wsB"));
    expect(useActual).toBeDefined();
  });

  it("AgentNotInWorkstreamError suggests the actual workstream", () => {
    const err = new AgentNotInWorkstreamError("alice", "wsA", "wsB");
    const steps = err.errorNextSteps();
    const useActual = steps.find((s) => s.command.includes("wsB"));
    expect(useActual).toBeDefined();
  });

  it("WorkstreamNameInvalidError suggests a sanitised name (lowercases the mu- prefix too)", () => {
    const err = new WorkstreamNameInvalidError("Mu-Auth.Refactor");
    const steps = err.errorNextSteps();
    const init = steps.find((s) => s.command.startsWith("mu workstream init"));
    expect(init?.command).toContain("auth_refactor");
    // The 'mu-' prefix must be stripped REGARDLESS of input case (the
    // ws name will be lowercased anyway). Surfaced via dogfood: the
    // first version of this fix only matched a lowercase prefix, so
    // 'Mu-Foo' came out as 'mu workstream init mu-foo' — still invalid.
    expect(init?.command).not.toContain("mu-");
  });

  it("WorkstreamNameInvalidError uses a direct intent for the mu- prefix branch (no 'best guess' hedge)", () => {
    // workstream_init_name_rejected_mu (feedback ws): the rationale
    // for rejecting `mu-foo` lives on stderr but the only loud action
    // line was "Try a sanitized name (best guess)". Dogfooding agents
    // skipped past the rationale and treated the hedge as a hint, not
    // a fix. For the prefix branch the correction is unambiguous, so
    // the intent must read as a direct retry.
    const prefix = new WorkstreamNameInvalidError("mu-feedback");
    const prefixSteps = prefix.errorNextSteps();
    const prefixInit = prefixSteps.find((s) => s.command.startsWith("mu workstream init"));
    expect(prefixInit?.intent).toBe("Retry without the 'mu-' prefix");
    expect(prefixInit?.command).toBe("mu workstream init feedback");

    // For the regex/mangle branch the sanitiser really is guessing
    // (`.`, `:`, case all collapse), so the hedge is honest and stays.
    const mangle = new WorkstreamNameInvalidError("roadmap-v0.2");
    const mangleSteps = mangle.errorNextSteps();
    const mangleInit = mangleSteps.find((s) => s.command.startsWith("mu workstream init"));
    expect(mangleInit?.intent).toBe("Try a sanitized name (best guess)");
  });

  it("PaneNotFoundError suggests scanning for live panes", () => {
    const err = new PaneNotFoundError("%999");
    const steps = err.errorNextSteps();
    expect(steps.some((s) => s.command.includes("list-panes"))).toBe(true);
  });

  // agent_spawn_liveness_check_trips_on: the spawn-died Next: block
  // used to suggest only the global env-var override, which is
  // overkill for one-off spawns (and silently affects every later
  // spawn in the same shell). The per-spawn `--command` recipe must
  // be advertised AND must come BEFORE the env-var step.
  it("AgentDiedOnSpawnError advertises per-spawn --command override before the global env-var", () => {
    const err = new AgentDiedOnSpawnError("scout-perf-1", "%42", undefined);
    const steps = err.errorNextSteps();

    const perSpawnIdx = steps.findIndex(
      (s) => s.command.startsWith("mu agent spawn ") && s.command.includes('--command "'),
    );
    expect(
      perSpawnIdx,
      `expected a per-spawn --command step; got: ${JSON.stringify(steps)}`,
    ).toBeGreaterThanOrEqual(0);

    // Agent name is interpolated into the per-spawn recipe so the
    // operator can copy-paste it verbatim.
    expect(steps[perSpawnIdx]?.command).toContain("scout-perf-1");

    const globalIdx = steps.findIndex((s) => s.command.includes("MU_PI_COMMAND"));
    expect(globalIdx, "expected the global env-var step to still exist").toBeGreaterThanOrEqual(0);

    // Per-spawn (right scope for one-offs) must come first.
    expect(perSpawnIdx).toBeLessThan(globalIdx);
  });
});

// Regression: nextsteps_audit_task_not_found_workstream_col
//
// Several typed errors suggest `mu sql "..."` recipes as next steps.
// Pre-v5 these recipes referenced the long-gone `tasks.workstream`
// (TEXT) column; v5 replaced it with `tasks.workstream_id` (FK →
// workstreams.id). The hint a user sees first on a missed-task lookup
// must actually run.
//
// This test extracts every SELECT-style `mu sql` recipe from
// TaskNotFoundError.errorNextSteps() and executes it against a
// freshly-opened v-current DB. Any "no such column" error fails the
// test loudly, instead of waiting for an end user to be the canary.
describe("TaskNotFoundError SQL recipes execute against the live schema", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-test-nextsteps-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('every `mu sql "SELECT ..."` recipe parses and runs (no stale columns)', () => {
    const err = new TaskNotFoundError("foo");
    const steps = err.errorNextSteps();
    const recipes = steps.map((s) => s.command).filter((c) => c.startsWith('mu sql "SELECT'));
    expect(recipes.length).toBeGreaterThan(0);

    const db = openDb({ path: dbPath });
    try {
      for (const recipe of recipes) {
        // Strip `mu sql "..."` wrapper to get raw SQL.
        const sql = recipe.replace(/^mu sql "(.*)"$/, "$1");
        expect(() => db.prepare(sql).all()).not.toThrow();
      }
    } finally {
      db.close();
    }
  });
});
