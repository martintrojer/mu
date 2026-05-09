// Verifies every typed error class carries actionable errorNextSteps().
//
// One test per error class. Tests don't assert the exact text of the
// hints (those evolve); they assert that the error implements
// HasNextSteps and returns a non-empty array of well-formed NextStep
// records.

import { describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  WorkspacePreservedError,
} from "../src/agents.js";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ApprovalNotInWorkstreamError,
} from "../src/approvals.js";
import { WorkstreamNotFoundError } from "../src/db.js";
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
    // ApprovalNotFoundError: slugs are short + the approve list is
    // small, so the recovery is intentionally generic ('mu approve
    // list'). No entity-token assertion.
    [new ApprovalNotFoundError("abc12345"), "ApprovalNotFoundError", []],
    [
      new ApprovalAlreadyDecidedError("abc12345", "granted"),
      "ApprovalAlreadyDecidedError",
      ["abc12345"],
    ],
    [
      new ApprovalNotInWorkstreamError("abc12345", "wsA", "wsB"),
      "ApprovalNotInWorkstreamError",
      ["abc12345", "wsB"],
    ],
    [
      new ApprovalNotInWorkstreamError("abc12345", "wsA", null),
      "ApprovalNotInWorkstreamError (global)",
      ["abc12345"],
    ],
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

  it("PaneNotFoundError suggests scanning for live panes", () => {
    const err = new PaneNotFoundError("%999");
    const steps = err.errorNextSteps();
    expect(steps.some((s) => s.command.includes("list-panes"))).toBe(true);
  });
});
