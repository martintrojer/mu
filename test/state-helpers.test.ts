// Tests for the SDK seam helpers in src/state.ts and src/logs.ts that
// the new ink-based TUI consumes alongside the static `mu state` renderer.
// See design_sdk_seam in workstream `tui` (`mu task notes design_sdk_seam -w tui`).

import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import { classifyEventVerb } from "../src/logs.js";
import {
  type WorkstreamSnapshot,
  agentStatusHistogram,
  loadWorkstreamSnapshot,
  roiBucket,
  summarizeOwnedTasks,
} from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";

// Minimal TaskRow factory for the pure-function tests.
function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: "t1",
    title: "test task",
    status: "OPEN",
    impact: 50,
    effortDays: 1,
    owner: null,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    closeKind: null,
    ...over,
  } as TaskRow;
}

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 1,
    name: "worker-1",
    workstream: "ws",
    status: "alive",
    title: "worker-1",
    role: "full-access",
    createdAt: 0,
    updatedAt: 0,
    paneId: "%1",
    windowId: "@1",
    sessionName: "mu-ws",
    cli: "pi",
    ...over,
  } as AgentRow;
}

describe("summarizeOwnedTasks", () => {
  it("returns em-dash for empty list", () => {
    expect(summarizeOwnedTasks([])).toEqual({ bit: "—", count: 0 });
  });

  it("returns task name for single", () => {
    const t = task({ name: "build_x" });
    expect(summarizeOwnedTasks([t])).toEqual({
      bit: "build_x",
      count: 1,
      onlyTaskId: "build_x",
    });
  });

  it("returns ⊕N for many", () => {
    const r = summarizeOwnedTasks([task({ name: "a" }), task({ name: "b" })]);
    expect(r.bit).toBe("⊕2");
    expect(r.count).toBe(2);
    expect(r.onlyTaskId).toBeUndefined();
  });
});

describe("roiBucket", () => {
  it("classifies high (>=100)", () => {
    expect(roiBucket(100, 1)).toBe("high");
    expect(roiBucket(500, 1)).toBe("high");
  });
  it("classifies mid (>=50)", () => {
    expect(roiBucket(60, 1)).toBe("mid");
    expect(roiBucket(50, 1)).toBe("mid");
  });
  it("classifies low (<50)", () => {
    expect(roiBucket(20, 1)).toBe("low");
    expect(roiBucket(0, 1)).toBe("low");
  });
  it("classifies infinite when effortDays is 0", () => {
    expect(roiBucket(50, 0)).toBe("infinite");
  });
});

describe("agentStatusHistogram", () => {
  it("returns empty map for no agents", () => {
    const h = agentStatusHistogram([]);
    expect(h.size).toBe(0);
  });

  it("counts per status", () => {
    const agents: AgentRow[] = [
      agent({ name: "a", status: "alive" }),
      agent({ name: "b", status: "alive" }),
      agent({ name: "c", status: "needs_input" }),
    ];
    const h = agentStatusHistogram(agents);
    expect(h.get("alive")).toBe(2);
    expect(h.get("needs_input")).toBe(1);
    expect(h.size).toBe(2);
  });
});

describe("classifyEventVerb", () => {
  it("matches a known verb followed by space", () => {
    expect(classifyEventVerb("task add foo")).toEqual({
      verb: "task add",
      rest: " foo",
    });
  });

  it("matches a verb at end-of-string", () => {
    expect(classifyEventVerb("task add")).toEqual({
      verb: "task add",
      rest: "",
    });
  });

  it("matches the longest prefix when verbs share start (e.g. task vs task add)", () => {
    // EVENT_VERB_PREFIXES is iterated in declaration order so 'task add'
    // (the entry, not 'task') wins for inputs starting with 'task add '.
    const r = classifyEventVerb("task add ws-foo");
    expect(r?.verb).toBe("task add");
  });

  it("rejects substring match without word boundary", () => {
    // 'task add' is a verb; 'task addnote' must NOT match it (the next
    // char 'n' is not space/tab/eos).
    expect(classifyEventVerb("task addnote x")).toBeNull();
  });

  it("returns null for unknown payloads", () => {
    expect(classifyEventVerb("hello world")).toBeNull();
    expect(classifyEventVerb("")).toBeNull();
  });
});

describe("loadWorkstreamSnapshot", () => {
  it("is exported and callable (smoke)", () => {
    // Behaviour is exercised end-to-end by the existing state-render
    // tests; this just guards against accidental removal of the
    // export. A full SDK test would require a mu DB fixture (covered
    // by test/state-render.test.ts).
    expect(typeof loadWorkstreamSnapshot).toBe("function");
  });

  it("WorkstreamSnapshot type is structurally what consumers expect", () => {
    // Compile-time structural check: this assignment must compile.
    const _example: WorkstreamSnapshot = {
      workstreamName: "demo",
      view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
      tracks: [],
      ready: [],
      inProgress: [],
      blocked: [],
      recentClosed: [],
      workspaces: [],
      workspaceOrphans: [],
      recent: [],
    };
    expect(_example.workstreamName).toBe("demo");
  });
});
