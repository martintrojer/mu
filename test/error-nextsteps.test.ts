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
import { hasNextSteps } from "../src/output.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
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

describe("typed errors all carry actionable errorNextSteps()", () => {
  // (instance, label-for-test-name)
  const cases: Array<[Error, string]> = [
    [new TaskNotFoundError("foo"), "TaskNotFoundError"],
    [new TaskExistsError("foo"), "TaskExistsError"],
    [new TaskNotInWorkstreamError("foo", "expected", "actual"), "TaskNotInWorkstreamError"],
    [new TaskAlreadyOwnedError("foo", "alice"), "TaskAlreadyOwnedError"],
    [new ClaimerNotRegisteredError("pi-mu", "%6441"), "ClaimerNotRegisteredError (with pane)"],
    [new ClaimerNotRegisteredError("pi-mu", null), "ClaimerNotRegisteredError (no pane)"],
    [new CycleError("a", "b"), "CycleError"],
    [new CrossWorkstreamEdgeError("a", "wsA", "b", "wsB"), "CrossWorkstreamEdgeError"],
    [new AgentExistsError("alice"), "AgentExistsError"],
    [new AgentNotFoundError("alice"), "AgentNotFoundError"],
    [new AgentNotInWorkstreamError("alice", "expected", "actual"), "AgentNotInWorkstreamError"],
    [new AgentDiedOnSpawnError("alice", "%15", "panic: died"), "AgentDiedOnSpawnError"],
    [new TmuxError(["list-panes"], "no server", "", 1), "TmuxError"],
    [new PaneNotFoundError("%999"), "PaneNotFoundError"],
    [new WorkspaceExistsError("alice"), "WorkspaceExistsError"],
    [new WorkspacePathNotEmptyError("alice", "auth", "/path/to/ws"), "WorkspacePathNotEmptyError"],
    [new WorkspacePreservedError("alice", "/path/to/ws"), "WorkspacePreservedError"],
    [new WorkspaceNotFoundError("alice"), "WorkspaceNotFoundError"],
    [new ApprovalNotFoundError("abc12345"), "ApprovalNotFoundError"],
    [new ApprovalAlreadyDecidedError("abc12345", "granted"), "ApprovalAlreadyDecidedError"],
    [new ApprovalNotInWorkstreamError("abc12345", "wsA", "wsB"), "ApprovalNotInWorkstreamError"],
    [
      new ApprovalNotInWorkstreamError("abc12345", "wsA", null),
      "ApprovalNotInWorkstreamError (global)",
    ],
    [new WorkstreamNameInvalidError("mu-foo"), "WorkstreamNameInvalidError"],
  ];

  for (const [err, label] of cases) {
    it(`${label}: implements HasNextSteps with non-empty, well-formed steps`, () => {
      expect(hasNextSteps(err)).toBe(true);
      // Re-cast since hasNextSteps narrows on the duck check.
      const steps = (err as unknown as { errorNextSteps: () => unknown[] }).errorNextSteps();
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps as Array<{ intent?: unknown; command?: unknown }>) {
        expect(typeof s.intent).toBe("string");
        expect(typeof s.command).toBe("string");
        expect((s.intent as string).length).toBeGreaterThan(0);
        expect((s.command as string).length).toBeGreaterThan(0);
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
