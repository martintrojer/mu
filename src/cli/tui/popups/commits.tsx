// Commits popup (Shift+0 → `)`). Fullscreen lazygit-style project
// commit log with '/' filtering and Enter → VCS show drill.
//
// Uses the project-root backend (detectBackend(projectRoot)) so git,
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
import { runTuicrInteractive } from "../tuicr.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { loadShowPreservingBody } from "./show-loader.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  slowTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  onFooter?: (command: string, copied: boolean, tone?: "normal" | "info" | "error") => void;
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
  slowTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  onFooter,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  const viewport = usePopupViewport();
  const drillViewport = usePopupViewport(DRILL_CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [showText, setShowText] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const [showErr, setShowErr] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<VcsBackendName | null>(
    snapshot?.commitsBackend ?? null,
  );
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
  const projectRoot = process.cwd();
  const showBody = showErr !== null ? `error: ${showErr}` : showText;

  const loadShow = useCallback(
    async (sha: string) => {
      await loadShowPreservingBody(
        projectRoot,
        sha,
        async (path) => {
          const backend = await detectBackend(path);
          setBackendName(backend.name);
          return backend;
        },
        {
          setText: setShowText,
          setError: setShowErr,
          setLoading: setShowLoading,
        },
      );
    },
    [projectRoot],
  );

  useEffect(() => {
    if (snapshot?.commitsBackend !== undefined) setBackendName(snapshot.commitsBackend);
  }, [snapshot?.commitsBackend]);

  useEffect(() => {
    if (mode !== "drill") {
      setShowText("");
      setShowErr(null);
      setShowLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void slowTickNonce;
    if (mode === "drill" && focused !== undefined) {
      void loadShow(focused.sha);
    }
  }, [mode, focused, loadShow, slowTickNonce]);

  const drill = useDrillKeymap({
    body: showBody,
    viewport: drillViewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (showCommand !== null) return yank(showCommand);
    },
    onTuicr: () => {
      if (!focused) return;
      const r = runTuicrInteractive({ rev: focused.sha, cwd: projectRoot });
      if (!r.ok) onFooter?.(r.error ?? "tuicr failed", false, "error");
      else onFooter?.(`tuicr -r ${focused.sha}`, true, "info");
    },
    resetKey: focused?.sha ?? "",
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
    return <PopupShell title="Commits · loading">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (mode === "drill" && focused !== undefined) {
    const short = shortSha(focused.sha);
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)} · ${short}`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`${showCommand ?? "show"} · ${focused.subject}`}
            body={showBody}
            viewport={drillViewport}
            scrollTop={drill.scrollTop}
            hint={
              showCommand === null
                ? "y yanks show command · t tuicr"
                : `y yanks \`${showCommand}\` · t tuicr`
            }
            emptyText={showLoading ? "loading…" : "(empty show output)"}
          />
        </Box>
      </PopupShell>
    );
  }
  if (sourceCommits.length === 0) {
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)}`}>
        <Text dimColor>(no commits)</Text>
      </PopupShell>
    );
  }
  if (commits.length === 0) {
    return (
      <PopupShell title={`Commits · ${formatBackend(backendName)}`}>
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
      title={`Commits · ${formatBackend(backendName)} (${safeCursor + 1}/${commits.length})`}
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

export function formatBackend(backend: VcsBackendName | null): string {
  return backend ?? "(no vcs)";
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
