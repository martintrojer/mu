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
// Per feat_workspaces_drill_git_show: a third, deeper level. Pressing
// Enter on a focused commit in the commits-since-fork list drills
// ONE MORE LEVEL into a read-only inline view of the actual
// `git show <sha> --stat -p` output, rendered via the shared
// <DrillScrollView> primitive (same one log.tsx uses for full
// payload view). The popup's `mode` prop from <App> stays "drill"
// while in the show view — the show level is a popup-local sub-mode
// (showSha state below) so we don't have to widen <App>'s PopupMode
// union for one popup. j/k Ctrl-D/U scroll the diff; Esc/q back to
// the commits list; y yanks the bare `git show <sha>` (the operator
// gets the command, not the captured output).
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
import { runGitShow } from "../git-show.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { TitledBox } from "../titled-box.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { usePopupViewport } from "./viewport.js";

// SHOW_MAX_CHARS + the actual `git show` invocation live in
// ../git-show.ts so they're testable against a real tiny git repo
// fixture without spinning up an ink renderer (per
// review_tests_workspaces_show_loadshow_unmocked).

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

const COMMIT_COLORS = [
  { color: "yellow" }, // sha
  undefined, // subject
] as const;

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
  // Workspaces popup uses the viewport in the DRILL view (centring
  // + page nav for the commits-since-fork list); list view
  // paginates by single-row cursor moves under j/k AND also consumes
  // the viewport for the centralised Ctrl-D/U / PgUp/PgDn page-step
  // bindings (per feat_centralize_scroll_navigation). Drill subtracts
  // an extra row for its in-body title indicator
  // (see WORKSPACES_DRILL_CHROME above).
  const viewport = usePopupViewport();
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
  // Show-mode (commit-diff drill) state. Owned here (popup-local)
  // because <App>'s PopupMode union is only "list" | "drill" — we
  // don't widen it for one popup. While `showSha !== null` AND
  // mode === "drill" we render the show view; Esc/q clears showSha
  // back to the commits list. Reset by:
  //   - mode change away from "drill" (useEffect below)
  //   - focused workspace change in list mode (useEffect below)
  //   - Esc/q in show mode (handler below)
  const [showSha, setShowSha] = useState<string | null>(null);
  const [showText, setShowText] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const [showErr, setShowErr] = useState<string | null>(null);

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
  // popup-filter when editing. Show-mode never edits a filter
  // (it's a read-only diff view) so it never bubbles "true".
  const inShow = mode === "drill" && showSha !== null;
  const activeFilterEditing = inShow ? false : mode === "drill" ? drillFlt.editing : flt.editing;
  useEffect(() => {
    onFilterEditingChange?.(activeFilterEditing);
  }, [activeFilterEditing, onFilterEditingChange]);

  /** Thin React glue around runGitShow (the real git invocation +
   *  truncation logic lives in ../git-show.ts so it's testable
   *  against a real fixture). The body here is just state-setter
   *  bookkeeping. */
  const loadShow = useCallback(async (path: string, sha: string) => {
    setShowLoading(true);
    setShowErr(null);
    setShowText("");
    const r = await runGitShow(path, sha);
    if (r.error !== null) setShowErr(r.error);
    else setShowText(r.text);
    setShowLoading(false);
  }, []);

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

  // Reset show-mode state when the popup leaves drill (back to
  // workspace list) or when the focused workspace changes. Mirrors
  // the spec STATE LIFECYCLE: "Reset captured-show state on mode
  // change away from 'show', focused commit change in drill,
  // workspace change in list mode". The first two collapse to
  // "mode !== drill" (Esc from show → drill, Esc from drill → list);
  // the third is the focused.agentName effect below. Note: we do
  // NOT reset on focused commit change inside drill — the user
  // hasn't entered show mode yet there; the show fetch is wired to
  // the Enter handler instead.
  useEffect(() => {
    if (mode !== "drill") {
      setShowSha(null);
      setShowText("");
      setShowErr(null);
      setShowLoading(false);
    }
  }, [mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focused?.agentName is the trigger; the effect body is intentionally pure setters, so biome can't infer the dependency from a body reference.
  useEffect(() => {
    setShowSha(null);
    setShowText("");
    setShowErr(null);
    setShowLoading(false);
  }, [focused?.agentName]);

  const showBody = showErr !== null ? `error: ${showErr}` : showText;
  const showDrill = useDrillKeymap({
    body: showBody,
    viewport: drillViewport,
    onClose: () => setShowSha(null),
    onYank: () => {
      if (showSha !== null) return yank(`git show ${showSha}`);
    },
  });

  useInput((input, key) => {
    // Filter-mode keystrokes consume printable + Esc/Enter/Bksp.
    // The active filter depends on which view we're rendering.
    // Show-mode is read-only — no filter prompt — so we skip the
    // consume check entirely (lets Esc fire as close, not
    // filter-cancel).
    const activeFlt = mode === "drill" ? drillFlt : flt;
    if (!inShow && activeFlt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (inShow) {
      showDrill.dispatch(action);
      return;
    }
    if (mode === "drill") {
      // Drill-mode commits list: nav funnels through applyCursor.
      // '/' filters the commits list, Enter drills ONE MORE LEVEL
      // into the focused commit's `git show` diff
      // (feat_workspaces_drill_git_show), Esc/q backs out to the
      // workspace list. Yank in drill mode yanks `git show <sha>`
      // for the focused commit (cherry-pick target inspection).
      if (isNavAction(action)) {
        setDrillCursor((c) => applyCursor(c, action, filteredCommits.length, drillViewport));
        return;
      }
      switch (action.kind) {
        case "close":
          onModeChange("list");
          return;
        case "filter":
          drillFlt.startEdit();
          return;
        case "drill": {
          const c = filteredCommits[safeDrillCursor];
          if (!c || !focused) return;
          setShowSha(c.sha);
          void loadShow(focused.path, c.sha);
          return;
        }
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
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, workspaces.length, viewport));
      return;
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
    return <PopupShell title="Workspaces · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (inShow && showSha !== null && focused) {
    const shortSha = showSha.slice(0, 12);
    return (
      <PopupShell title={`Workspaces · git show ${shortSha}`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`git show ${shortSha} (${focused.agentName})`}
            body={showBody}
            viewport={drillViewport}
            scrollTop={showDrill.scrollTop}
            hint={`y yanks \`git show ${shortSha}\``}
            emptyText={showLoading ? "loading…" : "(empty diff)"}
          />
        </Box>
      </PopupShell>
    );
  }
  if (sourceWorkspaces.length === 0) {
    return (
      <PopupShell title="Workspaces · popup">
        <Text dimColor>
          (no workspaces) try `mu agent spawn worker-1 -w {snapshot.workstreamName} --workspace`
        </Text>
      </PopupShell>
    );
  }
  if (mode !== "drill" && workspaces.length === 0) {
    return (
      <PopupShell title="Workspaces · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Workspaces · ${focused.agentName} (commits since fork)`}>
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
      </PopupShell>
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
    <PopupShell
      title={`Workspaces · popup (${safeCursor + 1}/${workspaces.length})`}
      hint="y yanks `cd $(mu workspace path <agent>)`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {workspaces.map((w, i) => {
          const sel = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { color: colorForGlyph(w) }, // glyph
            { bold: true }, // name
            { dimColor: true }, // backend
            { color: colorForBehind(w.commitsBehindMain) }, // behind
            { color: colorForDirty(w.dirty) }, // dirty
            { dimColor: true }, // parent
            { dimColor: true }, // path
          ];
          return (
            <ListRow
              key={w.agentName}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={sel}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
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
  const title = `commits for ${focused.agentName}`;
  const hint = "y yanks `git show <sha>`";
  if (loading) {
    return (
      <DrillScrollView
        title={title}
        body="loading…"
        viewport={viewport}
        scrollTop={0}
        hint={hint}
      />
    );
  }
  if (err !== null) {
    return (
      <DrillScrollView
        title={title}
        body={`error: ${err}`}
        viewport={viewport}
        scrollTop={0}
        hint={hint}
      />
    );
  }
  if (source.length === 0) {
    const parent = focused.parentRef ? focused.parentRef.slice(0, 12) : "(none)";
    return (
      <DrillScrollView
        title={title}
        body={`(no commits since fork — workspace is at parent_ref ${parent})`}
        viewport={viewport}
        scrollTop={0}
        hint={hint}
      />
    );
  }
  if (filtered.length === 0) {
    return <DrillScrollView title={title} body="(no matches)" viewport={viewport} scrollTop={0} />;
  }

  const { visible } = centredVisibleSlice(filtered, cursor, viewport);
  const rows = visible.map((c) => [c.sha.slice(0, 12), c.subject]);
  const widths = layoutColumns(rows, DRILL_COLUMN_SPECS, contentWidth);
  return (
    <TitledBox
      title={`${title} · ${cursor + 1}/${filtered.length}`}
      borderColor="magenta"
      titleColor="magenta"
      bottomLabel={hint}
      flexGrow={1}
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((c, i) => {
          const sel = filtered.indexOf(c) === cursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, DRILL_COLUMN_SPECS);
          return (
            <ListRow
              key={c.sha}
              cells={padded}
              contentWidth={contentWidth}
              colors={COMMIT_COLORS}
              selected={sel}
            />
          );
        })}
      </Box>
    </TitledBox>
  );
}
