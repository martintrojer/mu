// Full task-DAG popup (`g` / Shift+0 → `)`).
//
// Read-only forest of the current workstream: every root task (no
// incoming blocks edge) is rendered with the same ASCII tree machinery
// as `mu task tree --down`, separated by blank lines. No card owns this
// popup; it is a dashboard-level graph affordance for large workstreams.

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { colorStatus } from "../../../cli.js";
import { loadFullDag, renderForest } from "../../../dag.js";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { PopupShell } from "../popup-shell.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyScroll, isNavAction } from "./scroll.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

interface DagBody {
  body: string;
  roots: string[];
}

export function DagPopup({ yank, onClose, db, workstream }: PopupProps): JSX.Element {
  const viewport = usePopupViewport();
  const [{ body, roots }] = useState<DagBody>(() => buildDagBody(db, workstream));
  const [focusedRoot, setFocusedRoot] = useState<string | null>(() => roots[0] ?? null);

  const focusedTask = focusedRoot ?? roots[0];
  const drill = useDrillKeymap({
    body,
    viewport,
    onClose: () => {},
    onYank: () => {
      if (focusedTask === undefined) return;
      return yank(dagYankCommand(focusedTask, workstream));
    },
  });

  const lineToRoot = useMemo(() => rootForBodyLines(body, roots), [body, roots]);
  const totalLines = body === "" ? 0 : body.split("\n").length;

  useInput((input, key) => {
    const action = dispatchPopupKeyFromInk(input, key);
    const before = drill.scrollTop;
    drill.dispatch(action);
    switch (action.kind) {
      case "close":
        onClose();
        return;
      default:
        break;
    }

    // Simplified yank focus: track the root whose header is at or
    // before the current top line (or first root). This keeps the
    // command useful without cursor-row plumbing in the text drill.
    if (isNavAction(action)) {
      const nextTop = applyScroll(before, action, totalLines, viewport);
      setFocusedRoot(lineToRoot[nextTop] ?? roots[0] ?? null);
    }
  });

  if (roots.length === 0) {
    return (
      <PopupShell title={`DAG · ${workstream}`}>
        <Text dimColor>(no tasks)</Text>
      </PopupShell>
    );
  }

  return (
    <PopupShell title={`DAG · ${workstream}`} hint="y yanks `mu task tree <root-id>`">
      <Box flexDirection="column" flexGrow={1}>
        <DrillScrollView
          title="task DAG forest"
          body={body}
          viewport={viewport}
          scrollTop={drill.scrollTop}
          emptyText="(no tasks)"
          hint="y yanks `mu task tree <root-id>`"
        />
      </Box>
    </PopupShell>
  );
}

export function dagYankCommand(taskId: string, workstream: string): string {
  return `mu task tree ${taskId} -w ${workstream}`;
}

function buildDagBody(db: Db, workstream: string): DagBody {
  const dag = loadFullDag(db, workstream);
  return {
    body: renderForest(dag.roots, dag.edges, (task) => colorStatus(task.status), dag.tasks),
    roots: dag.roots.map((t) => t.name),
  };
}

function rootForBodyLines(body: string, roots: readonly string[]): string[] {
  const rootSet = new Set(roots);
  const out: string[] = [];
  let current = roots[0] ?? "";
  const lines = body === "" ? [] : body.split("\n");
  for (const line of lines) {
    const maybeRoot = line.split(/\s+/)[0];
    if (maybeRoot !== undefined && rootSet.has(maybeRoot)) current = maybeRoot;
    out.push(current);
  }
  return out;
}
