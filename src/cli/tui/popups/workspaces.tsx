// Workspaces popup (Shift+5 → `%`). Drill-down for the Workspaces card.
//
// Per feat_popup_5_workspaces (workstream `tui-impl`): list of every
// per-agent workspace in the workstream, with j/k navigation, '/'
// filter (via use-popup-filter), and Enter to drill into the
// commits-since-fork list (same data `mu workspace commits <agent>`
// surfaces). The drill is the actionable lookup for the cherry-pick
// loop: orient on which workspace has unmerged commits, then yank a
// `cd` to that workspace's path.
//
// Mirrors the data exposed by Card 5 (cards/workspaces.tsx) — the
// same WorkstreamSnapshot.workspaces[] rows decorated by
// withDirty: true (already wired by state.ts) — and adds two columns
// useful in the fullscreen view: dirty? and the workspace's on-disk
// path. The card omits both (too narrow); the popup has the room.
//
// Read-only: the only act-intent is `y` which yanks
//   cd $(mu workspace path <agent> -w <ws>)
// — the canonical entry to a workspace per skills/mu (cherry-pick /
// inspection workflow). No mutating verbs surface here. The drill
// view is also read-only: it RUNS `listCommitsForWorkspace` (a
// backend `git log` / `jj log` / `sl log` SELECT-equivalent), never
// a mutation.
//
// Drill is NOT TaskDetailDrill — workspaces aren't tasks. We render
// commits as a column-aligned `<sha-short> <subject>` list with an
// independent usePopupFilter applied so '/' substring search across
// (sha+subject) works in 30+-commit workspaces too.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: glyph + agent name +
// backend + behind + dirty? + parent_ref are PROTECTED (operators
// yank them verbatim into shell commands); only the path column is
// CLIPPABLE.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { CommitSummary } from "../../../vcs.js";
import { type WorkspaceRow, listCommitsForWorkspace } from "../../../workspace.js";
import { colorForBehind, colorForGlyph, formatBehind, glyphFor } from "../cards/workspaces.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { TitledBox } from "../titled-box.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { CursorRow } from "./cursor-row.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  /** Bubbles the filter-prompt edit state up to <App> for StatusBar mode. */
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // status glyph
  { kind: "protect" }, // agent name
  { kind: "protect" }, // backend
  { kind: "protect", align: "right" }, // commits-behind
  { kind: "protect" }, // dirty? (yes / no / —)
  { kind: "protect" }, // parent_ref short
  { kind: "clip", min: 1 }, // path
];

const DRILL_COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // sha short
  { kind: "clip", min: 1 }, // subject
];

// Drill view renders an EXTRA in-body title + dim "(L-T/T)" indicator
// pair on top of the default popup chrome — subtract 7 (default 6 + 1)
// for that branch. List view uses the default 6.
const WORKSPACES_DRILL_CHROME = 7;

export function WorkspacesPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  onFilterEditingChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20.
  // Workspaces popup only uses the viewport in the DRILL view
  // (centring + page nav for the commits-since-fork list); the list
  // view paginates by single-row cursor moves and never consults the
  // viewport size. Drill subtracts an extra row for its in-body title
  // indicator (see WORKSPACES_DRILL_CHROME above).
  const drillViewport = usePopupViewport(WORKSPACES_DRILL_CHROME);
  const [cursor, setCursor] = useState(0);
  // Drill-mode state. Owned here (not in <App>) because it's
  // popup-local: <App> only tracks the list/drill mode flag for
  // StatusBar purposes. Cursor + commit list + load state die with
  // the popup.
  const [drillCursor, setDrillCursor] = useState(0);
  const [commits, setCommits] = useState<readonly CommitSummary[]>([]);
  const [drillErr, setDrillErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Two independent filter instances: one for the workspace list,
  // one for the commits drill view. Each '/' edit applies to the
  // currently-rendered list only.
  const flt = usePopupFilter();
  const drillFlt = usePopupFilter();

  const sourceWorkspaces = snapshot?.workspaces ?? [];
  const workspaces =
    mode === "drill"
      ? sourceWorkspaces
      : applyFilter(
          sourceWorkspaces,
          flt.query,
          (w) =>
            `${w.agentName} ${w.backend} ${w.parentRef ?? ""} ${w.dirty === true ? "dirty" : ""}`,
        );
  const safeCursor = workspaces.length === 0 ? 0 : Math.min(cursor, workspaces.length - 1);
  const focused = workspaces[safeCursor];

  // The active filter pushed up to <App>: list-mode → flt;
  // drill-mode → drillFlt. Either way the StatusBar flips to
  // popup-filter when editing.
  const activeFilterEditing = mode === "drill" ? drillFlt.editing : flt.editing;
  useEffect(() => {
    onFilterEditingChange?.(activeFilterEditing);
  }, [activeFilterEditing, onFilterEditingChange]);

  // Filtered commits view (drill-mode equivalent of `workspaces`).
  const filteredCommits = applyFilter(commits, drillFlt.query, (c) => `${c.sha} ${c.subject}`);
  const safeDrillCursor =
    filteredCommits.length === 0 ? 0 : Math.min(drillCursor, filteredCommits.length - 1);

  // Load commits when entering drill mode (or when the focused row
  // changes while in drill mode — same-shape lazy fetch as
  // AgentsPopup's loadScrollback). listCommitsForWorkspace is a
  // backend `git log`-equivalent; never a mutation.
  const loadCommits = useCallback(
    async (agentName: string) => {
      setLoading(true);
      setDrillErr(null);
      try {
        const r = await listCommitsForWorkspace(db, agentName, { workstream });
        // Newest-first reads better in a "what's stacked on top of
        // fork?" view; the backend returns oldest-first. Reverse a
        // copy (don't mutate the source).
        setCommits([...r.commits].reverse());
        setDrillCursor(0);
        drillFlt.reset();
      } catch (e) {
        setDrillErr(e instanceof Error ? e.message : String(e));
        setCommits([]);
      } finally {
        setLoading(false);
      }
    },
    // drillFlt.reset is stable (useCallback in the hook); listing it
    // here keeps biome's exhaustive-deps lint happy.
    [db, workstream, drillFlt.reset],
  );

  useEffect(() => {
    if (mode === "drill" && focused) {
      void loadCommits(focused.agentName);
    }
  }, [mode, focused, loadCommits]);

  useInput((input, key) => {
    // Filter-mode keystrokes consume printable + Esc/Enter/Bksp.
    // The active filter depends on which view we're rendering.
    const activeFlt = mode === "drill" ? drillFlt : flt;
    if (activeFlt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKey(input, {
      ctrl: key.ctrl,
      shift: key.shift,
      meta: key.meta,
      escape: key.escape,
      return: key.return,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      tab: key.tab,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
    });
    if (mode === "drill") {
      // Drill-mode keymap: j/k scroll the commits list, '/' filters
      // the commits list, Esc/q backs out to the workspace list.
      // Yank in drill mode yanks `git show <sha>` for the focused
      // commit (most useful when scanning for cherry-pick targets).
      switch (action.kind) {
        case "close":
          onModeChange("list");
          return;
        case "filter":
          drillFlt.startEdit();
          return;
        case "moveDown":
          setDrillCursor((c) => Math.min(filteredCommits.length - 1, c + 1));
          return;
        case "moveUp":
          setDrillCursor((c) => Math.max(0, c - 1));
          return;
        case "jumpTop":
          setDrillCursor(0);
          return;
        case "jumpBottom":
          setDrillCursor(Math.max(0, filteredCommits.length - 1));
          return;
        case "pageDown":
          setDrillCursor((c) =>
            Math.min(
              filteredCommits.length - 1,
              c + Math.floor(drillViewport / (action.half ? 2 : 1)),
            ),
          );
          return;
        case "pageUp":
          setDrillCursor((c) => Math.max(0, c - Math.floor(drillViewport / (action.half ? 2 : 1))));
          return;
        case "yank": {
          const c = filteredCommits[safeDrillCursor];
          if (!c) return;
          // Cherry-pick recipe per skills/mu: `git cherry-pick <sha>`
          // is the canonical follow-on. Yank the bare `git show` for
          // the focused commit so the operator can inspect first.
          void yank(`git show ${c.sha}`);
          return;
        }
        default:
          return;
      }
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "filter":
        flt.startEdit();
        return;
      case "drill":
        if (focused) onModeChange("drill");
        return;
      case "moveDown":
        setCursor((c) => Math.min(workspaces.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, workspaces.length - 1));
        return;
      case "yank": {
        const w = workspaces[safeCursor];
        if (!w || !snapshot) return;
        const ws = snapshot.workstreamName;
        // Default yank: `cd $(mu workspace path <agent> -w <ws>)` —
        // the canonical entry to a workspace per skills/mu's
        // cherry-pick / inspection-workflow recipe.
        void yank(`cd $(mu workspace path ${w.agentName} -w ${ws})`);
        return;
      }
    }
  });

  if (snapshot === null) {
    return <Shell title="Workspaces · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (sourceWorkspaces.length === 0) {
    return (
      <Shell title="Workspaces · popup">
        <Text dimColor>
          (no workspaces) try `mu agent spawn worker-1 -w {snapshot.workstreamName} --workspace`
        </Text>
      </Shell>
    );
  }
  if (mode !== "drill" && workspaces.length === 0) {
    return (
      <Shell title="Workspaces · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </Shell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <Shell title={`Workspaces · ${focused.agentName} (commits since fork)`}>
        <Box flexDirection="column" flexGrow={1}>
          {renderDrillBody(
            commits,
            filteredCommits,
            safeDrillCursor,
            loading,
            drillErr,
            focused,
            contentWidth,
            drillViewport,
          )}
        </Box>
        <FilterPrompt state={drillFlt} />
      </Shell>
    );
  }

  const rows = workspaces.map((w) => [
    glyphFor(w),
    w.agentName,
    w.backend,
    formatBehind(w.commitsBehindMain),
    formatDirty(w.dirty),
    w.parentRef ? w.parentRef.slice(0, 12) : "—",
    w.path,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <Shell
      title={`Workspaces · popup (${safeCursor + 1}/${workspaces.length})`}
      hint="y yanks `cd $(mu workspace path <agent>)`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {workspaces.map((w, i) => {
          const sel = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          if (sel)
            return <CursorRow key={w.agentName} cells={padded} contentWidth={contentWidth} />;
          const [
            glyph = "",
            name = "",
            backend = "",
            behind = "",
            dirty = "",
            parent = "",
            path = "",
          ] = padded;
          return (
            <Box key={w.agentName}>
              <Text wrap="truncate">
                <Text color={colorForGlyph(w)}>{glyph}</Text>
                {"  "}
                <Text bold>{name}</Text>
                {"  "}
                <Text dimColor>{backend}</Text>
                {"  "}
                <Text color={colorForBehind(w.commitsBehindMain)}>{behind}</Text>
                {"  "}
                <Text color={colorForDirty(w.dirty)}>{dirty}</Text>
                {"  "}
                <Text dimColor>{parent}</Text>
                {"  "}
                <Text dimColor>{path}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </Shell>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Render the dirty? cell. "yes" when dirty, "no" when clean,
 *  "—" when unknown (workspace decoration failed or backend has no
 *  dirty concept). Mirrors the card's three-glyph state space. */
export function formatDirty(d: boolean | null | undefined): string {
  if (d === undefined || d === null) return "—";
  return d ? "yes" : "no";
}

/** Picocolors-compatible colour name for the dirty? cell. Red for
 *  dirty (load-bearing — uncommitted work to deal with); dim for
 *  clean / unknown so the eye snaps to the actionable rows. */
export function colorForDirty(d: boolean | null | undefined): string | undefined {
  if (d === true) return "red";
  return undefined;
}

// ─── drill body renderer ───────────────────────────────────────────

function renderDrillBody(
  source: readonly CommitSummary[],
  filtered: readonly CommitSummary[],
  cursor: number,
  loading: boolean,
  err: string | null,
  focused: WorkspaceRow,
  contentWidth: number,
  viewport: number,
): JSX.Element {
  if (loading) {
    return <Text dimColor>▸ loading commits for {focused.agentName} …</Text>;
  }
  if (err !== null) {
    return (
      <Box flexDirection="column">
        <Text bold color="magenta">
          ▸ commits for {focused.agentName}
        </Text>
        <Text color="red">error: {err}</Text>
      </Box>
    );
  }
  if (source.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="magenta">
          ▸ commits for {focused.agentName}
        </Text>
        <Text dimColor>
          (no commits since fork — workspace is at parent_ref{" "}
          {focused.parentRef ? focused.parentRef.slice(0, 12) : "(none)"})
        </Text>
      </Box>
    );
  }
  if (filtered.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="magenta">
          ▸ commits for {focused.agentName}
        </Text>
        <Text dimColor>(no matches)</Text>
      </Box>
    );
  }

  const start = Math.max(
    0,
    Math.min(filtered.length - viewport, cursor - Math.floor(viewport / 2)),
  );
  const visible = filtered.slice(start, start + viewport);
  const rows = visible.map((c) => [c.sha.slice(0, 12), c.subject]);
  const widths = layoutColumns(rows, DRILL_COLUMN_SPECS, contentWidth);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">
          ▸ commits for {focused.agentName}
        </Text>
        <Text dimColor>
          {" "}
          ({cursor + 1}/{filtered.length})
        </Text>
      </Box>
      {visible.map((c, i) => {
        const sel = filtered.indexOf(c) === cursor;
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, DRILL_COLUMN_SPECS);
        if (sel) return <CursorRow key={c.sha} cells={padded} contentWidth={contentWidth} />;
        const [sha = "", subject = ""] = padded;
        return (
          <Box key={c.sha}>
            <Text wrap="truncate">
              <Text color="yellow">{sha}</Text>
              {"  "}
              <Text>{subject}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Shell({
  title,
  hint,
  children,
}: {
  title: string;
  /** Per-popup hint inset into the bottom border (Layer 1 of
   *  nit_tui_drill_inset_title_and_hints). List-mode only;
   *  drill-mode callers omit and let Layer 2's DrillScrollView
   *  carry its own bottomLabel (workspaces drill uses an ad-hoc
   *  list renderer rather than DrillScrollView, so its drill hint
   *  remains in-body for now). */
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <TitledBox title={title} borderColor="cyan" titleColor="cyan" bottomLabel={hint} flexGrow={1}>
      {children}
    </TitledBox>
  );
}
