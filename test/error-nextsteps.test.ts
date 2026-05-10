// Verifies every typed error class carries actionable errorNextSteps().
//
// One test per error class. Tests don't assert the exact text of the
// hints (those evolve); they assert that the error implements
// HasNextSteps and returns a non-empty array of well-formed NextStep
// records.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  WorkspacePreservedError,
} from "../src/agents.js";
import { WorkstreamNotFoundError, openDb } from "../src/db.js";
import { hasNextSteps } from "../src/output.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskIdInvalidError,
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

describe("typed errors all carry actionable errorNextSteps()", () => {
  // (instance, label-for-test-name, expectedTokens)
  // expectedTokens are entity ids (taskId / agentName / paneId / slug /
  // workstream) that MUST appear in at least one step's command —
  // otherwise the steps are well-formed but generic and the user is
  // not actually pointed at the right entity. Without this column the
  // loop only checked 'is well-formed', not 'is contextual'
  // (review_test_error_nextsteps_too_loose).
  const cases: Array<[Error, string, string[]]> = [
    [new TaskNotFoundError("foo"), "TaskNotFoundError", ["foo"]],
    [new TaskExistsError("foo"), "TaskExistsError", ["foo"]],
    // TaskIdInvalidError: the user typed something invalid; the
    // recovery is to use the auto-derived path (--title) or the
    // sanitised candidate. The sanitised id appears in the second
    // step's command.
    [new TaskIdInvalidError("Bad ID"), "TaskIdInvalidError", ["bad_id"]],
    [
      new TaskNotInWorkstreamError("foo", "expected", "actual"),
      "TaskNotInWorkstreamError",
      ["foo", "actual"],
    ],
    [new TaskAlreadyOwnedError("foo", "alice"), "TaskAlreadyOwnedError", ["foo", "alice"]],
    [
      new ClaimerNotRegisteredError("pi-mu", "%6441"),
      "ClaimerNotRegisteredError (with pane)",
      ["%6441"],
    ],
    // No-pane variant has no entity to interpolate; skip token check.
    [new ClaimerNotRegisteredError("pi-mu", null), "ClaimerNotRegisteredError (no pane)", []],
    [new CycleError("a", "b"), "CycleError", ["a", "b"]],
    // CrossWorkstreamEdgeError's recovery is to move the BLOCKER, so
    // the dependent's id legitimately doesn't appear; only check the
    // entities the recovery actually references.
    [
      new CrossWorkstreamEdgeError("a", "wsA", "b", "wsB"),
      "CrossWorkstreamEdgeError",
      ["a", "wsB"],
    ],
    [new AgentExistsError("alice"), "AgentExistsError", ["alice"]],
    [new AgentNotFoundError("alice"), "AgentNotFoundError", ["alice"]],
    [
      new AgentNotInWorkstreamError("alice", "expected", "actual"),
      "AgentNotInWorkstreamError",
      ["alice", "actual"],
    ],
    [new AgentDiedOnSpawnError("alice", "%15", "panic: died"), "AgentDiedOnSpawnError", ["alice"]],
    // TmuxError doesn't carry a single id; check that its command
    // mentions doctor (its standard recovery hint).
    [new TmuxError(["list-panes"], "no server", "", 1), "TmuxError", ["doctor"]],
    [new PaneNotFoundError("%999"), "PaneNotFoundError", ["%999"]],
    [new WorkspaceExistsError("alice"), "WorkspaceExistsError", ["alice"]],
    [
      new WorkspacePathNotEmptyError("alice", "auth", "/path/to/ws"),
      "WorkspacePathNotEmptyError",
      ["/path/to/ws"],
    ],
    [new WorkspacePreservedError("alice", "/path/to/ws"), "WorkspacePreservedError", ["alice"]],
    [new WorkspaceNotFoundError("alice"), "WorkspaceNotFoundError", ["alice"]],
    [new WorkstreamNameInvalidError("mu-foo"), "WorkstreamNameInvalidError", ["foo"]],
    // WorkstreamNotFoundError is the resolve-time miss raised by
    // src/db.ts:resolveWorkstreamId — the first leg of the SDK
    // boundary (operator-name → surrogate id). schema_v5_cli_boundary.
    [new WorkstreamNotFoundError("ghost"), "WorkstreamNotFoundError", ["ghost"]],
  ];

  for (const [err, label, expectedTokens] of cases) {
    it(`${label}: implements HasNextSteps with non-empty, well-formed, contextual steps`, () => {
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
      // Every expected entity-id token must appear in at least one
      // step's command. Catches generic errorNextSteps()'s that
      // return ['mu --help'] regardless of the error's parameters.
      const commands = (steps as Array<{ command: string }>).map((s) => s.command);
      for (const token of expectedTokens) {
        expect(
          commands.some((c) => c.includes(token)),
          `expected at least one step's command to mention '${token}'; got: ${JSON.stringify(commands)}`,
        ).toBe(true);
      }
    });
  }
});

describe("error-specific structured-step assertions", () => {
  it("ClaimerNotRegisteredError pins the exact pane id when given", () => {
    const err = new ClaimerNotRegisteredError("pi-mu", "%42");
    const steps = err.errorNextSteps();
    const adopt = steps.find((s) => s.command.startsWith("mu adopt"));
    expect(adopt?.command).toBe("mu adopt %42");
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
