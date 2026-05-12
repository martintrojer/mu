import { describe, expect, it } from "vitest";
import { yankCommandForTask } from "../src/cli/tui/popups/ready.js";

describe("Tasks popup yank matrix", () => {
  const workstream = "tui-impl";

  it.each([
    {
      label: "OPEN no owner → claim",
      task: { name: "task_open_unowned", status: "OPEN", ownerName: null },
      expected: "mu task claim task_open_unowned -w tui-impl",
    },
    {
      label: "OPEN owned → release",
      task: { name: "task_open_owned", status: "OPEN", ownerName: "worker-1" },
      expected: "mu task release task_open_owned -w tui-impl",
    },
    {
      label: "IN_PROGRESS owned → close --evidence",
      task: { name: "task_in_progress", status: "IN_PROGRESS", ownerName: "worker-1" },
      expected: 'mu task close task_in_progress -w tui-impl --evidence "..."',
    },
    {
      label: "CLOSED → open",
      task: { name: "task_closed", status: "CLOSED", ownerName: "worker-1" },
      expected: "mu task open task_closed -w tui-impl",
    },
    {
      label: "REJECTED → open",
      task: { name: "task_rejected", status: "REJECTED", ownerName: "worker-1" },
      expected: "mu task open task_rejected -w tui-impl",
    },
    {
      label: "DEFERRED → open",
      task: { name: "task_deferred", status: "DEFERRED", ownerName: null },
      expected: "mu task open task_deferred -w tui-impl",
    },
    {
      label: "unknown → null",
      task: { name: "task_unknown", status: "SOMETHING_ELSE", ownerName: null },
      expected: null,
    },
  ])("$label", ({ task, expected }) => {
    expect(yankCommandForTask(task, workstream)).toBe(expected);
  });
});
