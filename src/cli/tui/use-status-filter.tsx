// Shared task-status toggle filter for TUI task-list surfaces.
//
// Used by the DAG popup today and by the all-tasks popup next wave.
// Default is all task statuses visible; state is deliberately local to
// the popup instance and resets on unmount (no persistence / no config).
//
// Per ROADMAP pledge: ink/react imports are confined to src/cli/tui/*.

import { Box, Text } from "ink";
import { useCallback, useState } from "react";
import { TASK_STATUSES, type TaskStatus } from "../../tasks/status.js";
import { colorStatus } from "../format.js";
import type { KeyFlags } from "./keys.js";

export const STATUS_BY_KEY: Readonly<Record<string, TaskStatus>> = {
  o: "OPEN",
  i: "IN_PROGRESS",
  c: "CLOSED",
  r: "REJECTED",
  d: "DEFERRED",
};

const STATUS_LABELS: Readonly<Record<TaskStatus, { key: string; rest: string }>> = {
  OPEN: { key: "O", rest: "pen" },
  IN_PROGRESS: { key: "I", rest: "n_progress" },
  CLOSED: { key: "C", rest: "losed" },
  REJECTED: { key: "R", rest: "ejected" },
  DEFERRED: { key: "D", rest: "eferred" },
};

export function toggleStatusSet(
  statuses: ReadonlySet<TaskStatus>,
  status: TaskStatus,
): Set<TaskStatus> {
  const next = new Set(statuses);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next;
}

export function statusForToggleKey(input: string, key: KeyFlags): TaskStatus | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  return STATUS_BY_KEY[input.toLowerCase()];
}

export interface StatusFilter {
  statuses: Set<TaskStatus>;
  toggle: (s: TaskStatus) => void;
  /** Returns true when the o/i/c/r/d toggle key was consumed. */
  onKey: (input: string, key: KeyFlags) => boolean;
}

export function useStatusFilter(): StatusFilter {
  const [statuses, setStatuses] = useState<Set<TaskStatus>>(() => new Set(TASK_STATUSES));

  const toggle = useCallback((status: TaskStatus) => {
    setStatuses((prev) => toggleStatusSet(prev, status));
  }, []);

  const onKey = useCallback(
    (input: string, key: KeyFlags): boolean => {
      const status = statusForToggleKey(input, key);
      if (status === undefined) return false;
      toggle(status);
      return true;
    },
    [toggle],
  );

  return { statuses, toggle, onKey };
}

export function StatusFilterStrip({ statuses }: { statuses: Set<TaskStatus> }): JSX.Element {
  return (
    <Box>
      <Text dimColor>filters: </Text>
      {TASK_STATUSES.map((status, i) => {
        const label = STATUS_LABELS[status];
        const enabled = statuses.has(status);
        return (
          <Text key={status}>
            {i > 0 ? "  " : ""}
            <Text>{"["}</Text>
            <Text>{colorStatus(status).replace(status, label.key)}</Text>
            <Text>{"]"}</Text>
            <Text>{label.rest}</Text>
            <Text> </Text>
            <Text color={enabled ? "green" : "gray"}>{enabled ? "●" : "○"}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
