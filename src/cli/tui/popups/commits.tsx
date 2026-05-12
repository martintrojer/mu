// Commits popup (`l` or Shift+8 → `*`). Fullscreen lazygit-style
// project commit log with '/' filtering and Enter → VCS show drill.
//
// Uses the project-root backend (detectBackend(process.cwd())) so git,
// jj, and sl all work through the shared VcsBackend.showCommit seam.
// The popup never mutates: `y` yanks the backend-specific show command
// for the focused commit.

import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type CommitSummary, type VcsBackendName, detectBackend } from "../../../vcs.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
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

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // sha short
  { kind: "protect", align: "right" }, // relative time
  { kind: "protect", max: 18 }, // author
  { kind: "clip", min: 1 }, // subject
];

const DRILL_CHROME_ROWS = 7;

export function CommitsPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  onFilterEditingChange,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  const viewport = usePopupViewport();
  const drillViewport = usePopupViewport(DRILL_CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [showText, setShowText] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const [showErr, setShowErr] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<VcsBackendName | null>(null);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });

  const sourceCommits = snapshot?.recentCommits ?? [];
  const commits = applyFilter(
    sourceCommits,
    flt.query,
    (c) => `${c.sha} ${c.subject} ${c.author} ${c.relTime}`,
  );
  const safeCursor = commits.length === 0 ? 0 : Math.min(cursor, commits.length - 1);
  const focused = commits[safeCursor];
  const showCommand =
    focused && backendName !== null ? showCommandForBackend(backendName, focused.sha) : null;
  const showBody = showErr !== null ? `error: ${showErr}` : showText;

  const loadShow = useCallback(async (sha: string) => {
    setShowLoading(true);
    setShowErr(null);
    setShowText("");
    const projectRoot = process.cwd();
    const backend = await detectBackend(projectRoot);
    setBackendName(backend.name);
    const r = await backend.showCommit(projectRoot, sha);
    if (r.error !== undefined) setShowErr(r.error);
    else setShowText(r.text);
    setShowLoading(false);
  }, []);

  useEffect(() => {
    if (backendName !== null) return;
    void detectBackend(process.cwd()).then((backend) => setBackendName(backend.name));
  }, [backendName]);

  useEffect(() => {
    if (mode !== "drill") {
      setShowText("");
      setShowErr(null);
      setShowLoading(false);
    }
  }, [mode]);

  const drill = useDrillKeymap({
    body: showBody,
    viewport: drillViewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (showCommand !== null) return yank(showCommand);
    },
  });

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, commits.length, viewport));
      return;
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "filter":
        flt.startEdit();
        return;
      case "drill": {
        const c = commits[safeCursor];
        if (!c) return;
        onModeChange("drill");
        void loadShow(c.sha);
        return;
      }
      case "yank": {
        const c = commits[safeCursor];
        if (!c || backendName === null) return;
        void yank(showCommandForBackend(backendName, c.sha));
        return;
      }
    }
  });

  if (snapshot === null) {
    return <PopupShell title="Commits · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (mode === "drill" && focused !== undefined) {
    const short = shortSha(focused.sha);
    return (
      <PopupShell title={`Commits · ${short}`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`${showCommand ?? "show"} · ${focused.subject}`}
            body={showBody}
            viewport={drillViewport}
            scrollTop={drill.scrollTop}
            hint={showCommand === null ? "y yanks show command" : `y yanks \`${showCommand}\``}
            emptyText={showLoading ? "loading…" : "(empty show output)"}
          />
        </Box>
      </PopupShell>
    );
  }
  if (sourceCommits.length === 0) {
    return (
      <PopupShell title="Commits · popup">
        <Text dimColor>(no commits)</Text>
      </PopupShell>
    );
  }
  if (commits.length === 0) {
    return (
      <PopupShell title="Commits · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  const { visible } = centredVisibleSlice(commits, safeCursor, viewport);
  const rows = visible.map((c) => [shortSha(c.sha), c.relTime, c.author, c.subject]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Commits · popup (${safeCursor + 1}/${commits.length})`}
      hint="y yanks VCS show command"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((c, i) => {
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { color: "yellow" }, // sha
            { dimColor: true }, // relTime
            { dimColor: true }, // author
            undefined, // subject
          ];
          return (
            <ListRow
              key={c.sha}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={commits.indexOf(c) === safeCursor}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function showCommandForBackend(backend: VcsBackendName, sha: string): string {
  switch (backend) {
    case "git":
      return `git show ${sha}`;
    case "jj":
      return `jj show ${sha}`;
    case "sl":
      return `sl show ${sha}`;
    case "none":
      return `# no VCS backend for commit ${sha}`;
  }
}

// Test-only helper: keeps the WorkstreamSnapshot import live under
// noUnusedLocals even when source-level tests import the prop type.
export function commitFilterBlob(c: CommitSummary): string {
  return `${c.sha} ${c.subject} ${c.author} ${c.relTime}`;
}
