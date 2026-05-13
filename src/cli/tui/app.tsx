// <App> — the TUI's root component.
//
// Owns:
//   - The dashboard snapshot poll (via useDashboardSnapshot)
//   - Card visibility flags (0-9 toggle)
//   - Tick rate (+/-/= adjust)
//   - Single-popup invariant + state-restore on close
//   - Help overlay (?)
//   - Footer line (last yanked command + [copied]/[no clipboard])
//   - Yank backend probe (memoised once per session)
//   - Quit / Ctrl-C
//
// Per design_card_iface + design_popup_lifecycle: card visibility +
// tick rate + footer are preserved as a side effect of living in
// <App> state, not the popup. The snapshot tick keeps running while
// popups are open; drill-down bodies consume explicit fast/slow tick
// nonces so visible details refresh without closing/reopening.

import type { EventEmitter } from "node:events";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import type { Db } from "../../db.js";
import { AgentsCard } from "./cards/agents.js";
import { BlockedCard } from "./cards/blocked.js";
import { CommitsCard } from "./cards/commits.js";
import { DoctorCard } from "./cards/doctor.js";
import { InProgressCard } from "./cards/inprogress.js";
import { LogCard } from "./cards/log.js";
import { ReadyCard } from "./cards/ready.js";
import { RecentCard } from "./cards/recent.js";
import { TracksCard } from "./cards/tracks.js";
import { WorkspacesCard } from "./cards/workspaces.js";
import { Help } from "./help.js";
import { dispatchGlobalKeyFromInk } from "./keys.js";
import {
  CARD_CONFIGS,
  type CardId,
  type ColumnAssignment,
  type ColumnWidth,
  type RowBudgetMap,
  allocateRowBudgets,
  columnWidths,
  cullCardsForRows,
  dashboardCardHitRegions,
  dataCountForCard,
  hitTestDashboardCard,
  layoutColumns as layoutDashboardColumns,
} from "./layout.js";
import { type MouseEvent, useMouse } from "./mouse.js";
import { AgentsPopup } from "./popups/agents.js";
import { AllTasksPopup } from "./popups/all-tasks.js";
import { BlockedPopup } from "./popups/blocked.js";
import { CommitsPopup } from "./popups/commits.js";
import { DagPopup } from "./popups/dag.js";
import { DoctorPopup } from "./popups/doctor.js";
import { InProgressPopup } from "./popups/inprogress.js";
import { LogPopup } from "./popups/log.js";
import { ReadyPopup } from "./popups/ready.js";
import { RecentPopup } from "./popups/recent.js";
import { TracksPopup } from "./popups/tracks.js";
import { WorkspacesPopup } from "./popups/workspaces.js";
import {
  type CardVisibility,
  DEFAULT_CARD_VISIBILITY,
  TICK_DEFAULT_MS,
  fasterTick,
  slowerTick,
  useDashboardSnapshot,
} from "./state.js";
import { StatusBar } from "./status-bar.js";
import { TabStrip } from "./tab-strip.js";
import { type ClipboardBackend, probeClipboardBackend } from "./yank.js";

export interface AppProps {
  db: Db;
  /** Resolved workstream set (≥1). Per feat_tui_multi_workstream
   *  (workstream `tui-impl`): the TUI shows one ws at a time;
   *  Tab/Shift-Tab cycles. Length 1 is the original single-ws TUI
   *  with no tab strip rendered. */
  workstreams: string[];
  /** Initial active tab index. Clamped at render time so stale env
   *  values or shrinking workstream arrays fall back safely. */
  initialActive?: number;
}

export interface FooterState {
  command: string;
  copied: boolean;
  tone?: "normal" | "info" | "error";
}

type PopupId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | "dag" | "allTasks" | null;
type PopupRegistryId = NonNullable<PopupId>;
export type PopupMode = "list" | "drill";
type DashboardSnapshot = ReturnType<typeof useDashboardSnapshot>["data"];

interface CommonCardProps {
  snapshot: DashboardSnapshot;
  db: Db;
  workstream: string;
  rowBudget?: number;
  cols?: number;
}

interface CommonPopupProps {
  yank: (command: string) => Promise<void>;
  onFooter: (command: string, copied: boolean, tone?: FooterState["tone"]) => void;
  onClose: () => void;
  snapshot: DashboardSnapshot;
  fastTickNonce: number;
  slowTickNonce: number;
  mode: PopupMode;
  onModeChange: (mode: PopupMode) => void;
  onFilterEditingChange: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

const CARD_REGISTRY: Record<CardId, ComponentType<CommonCardProps>> = {
  0: CommitsCard,
  1: AgentsCard,
  2: TracksCard,
  3: ReadyCard,
  4: LogCard,
  5: WorkspacesCard,
  6: InProgressCard,
  7: BlockedCard,
  8: RecentCard,
  9: DoctorCard,
};

const POPUP_REGISTRY: Record<PopupRegistryId, ComponentType<CommonPopupProps>> = {
  0: CommitsPopup,
  1: AgentsPopup,
  2: TracksPopup,
  3: ReadyPopup,
  4: LogPopup,
  5: WorkspacesPopup,
  6: InProgressPopup,
  7: BlockedPopup,
  8: RecentPopup,
  9: DoctorPopup,
  dag: DagPopup,
  allTasks: AllTasksPopup,
};

export const DASHBOARD_MIN_ROWS = 5;

export function dashboardAvailableRows(
  rows: number,
  opts: { hasTabStrip: boolean; hasSnapshotError: boolean },
): number {
  const tabRows = opts.hasTabStrip ? 1 : 0;
  const snapshotErrorRows = opts.hasSnapshotError ? 3 : 0;
  const statusRows = 1;
  return Math.max(1, rows - tabRows - snapshotErrorRows - statusRows);
}

interface PendingMouseEventRef {
  current: MouseEvent | null;
}

// Ink's `useStdin` does not advertise `internal_eventEmitter` in its
// public TypeScript types, but the field IS what backs ink's own
// public `useInput` hook (see ink/build/components/StdinContext.d.ts —
// the field is exported from the Props type but flagged `internal_*`
// per ink convention, meaning ink reserves the right to rename or
// remove it without a breaking-change bump). We need it to replay
// synthetic key bytes from mouse events so popups' existing keymaps
// keep handling scroll/drill without each one re-subscribing to
// useMouse(). Define a typed seam + runtime probe so:
//   1. The cast site is explicit, not a silent any-shaped access.
//   2. If a future ink upgrade drops the field, we degrade gracefully
//      (mouse stops emitting synthetic keys; keyboard nav unaffected)
//      AND the test in test/tui-app-emitter-shape.test.ts fails CI.
interface InkStdinWithEmitter extends ReturnType<typeof useStdin> {
  internal_eventEmitter: EventEmitter;
}

export function getInkInternalEmitter(stdin: ReturnType<typeof useStdin>): EventEmitter | null {
  if ("internal_eventEmitter" in stdin) {
    return (stdin as InkStdinWithEmitter).internal_eventEmitter;
  }
  return null;
}

export function replayPendingMouseEvent(
  pendingMouseEvent: PendingMouseEventRef,
  opts: {
    popupOpen: boolean;
    filterEditing: boolean;
    emitKey: (key: string, delayMs: number) => void;
  },
): boolean {
  if (!opts.popupOpen || opts.filterEditing) return false;
  const event = pendingMouseEvent.current;
  pendingMouseEvent.current = null;
  if (event === null) return false;
  if (event.kind === "scroll") {
    opts.emitKey(event.direction === "up" ? "k" : "j", 0);
    return true;
  }
  if (event.kind === "doubleclick") {
    const rowIndex = Math.max(0, event.y - 2);
    const keys = `g${"j".repeat(rowIndex)}\r`;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key !== undefined) opts.emitKey(key, i * 8);
    }
    return true;
  }
  return false;
}

export function App({ db, workstreams, initialActive = 0 }: AppProps): JSX.Element {
  const { exit } = useApp();
  const stdin = useStdin();

  const [visibility, setVisibility] = useState<CardVisibility>(DEFAULT_CARD_VISIBILITY);
  const [tickMs, setTickMs] = useState<number>(TICK_DEFAULT_MS);
  // Index of the active workstream tab. Tab / Shift-Tab cycles
  // through `workstreams`. Always in [0, workstreams.length).
  const [activeWs, setActiveWs] = useState<number>(initialActive);
  const [popup, setPopup] = useState<PopupId>(null);
  // Per-popup-instance mode ("list" → list of rows; "drill" →
  // inline detail view inside the popup body). Owned by <App>
  // because the StatusBar's hint cluster needs to know which mode
  // we're in. Reset to "list" every time a new popup opens.
  const [popupMode, setPopupMode] = useState<PopupMode>("list");
  // True while ANY open popup has its '/' filter prompt in edit
  // mode. The popup pushes the flag up via onFilterEditingChange
  // (per feat_popup_search_filter); we use it solely to flip the
  // StatusBar hint cluster to the filter-mode hint.
  const [popupFilterEditing, setPopupFilterEditing] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [footer, setFooter] = useState<FooterState | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const pendingMouseEvent = useRef<MouseEvent | null>(null);
  const [popupMouseTick, setPopupMouseTick] = useState<number>(0);

  // Probe clipboard backend once per session and memoise.
  const clipboardRef = useRef<ClipboardBackend | undefined>(undefined);
  useEffect(() => {
    void probeClipboardBackend().then((b) => {
      clipboardRef.current = b;
    });
  }, []);

  // Bounds-clamp activeWs in case workstreams[] shrinks (defensive;
  // the TUI is launched with a fixed list today). Falls back to 0.
  const safeActive = Math.max(0, Math.min(activeWs, workstreams.length - 1));
  const workstream = workstreams[safeActive] ?? "";

  const snap = useDashboardSnapshot(db, workstream, tickMs, true, refreshNonce);

  // Terminal-resize handling per design_resize. ink's stdout exposes
  // columns/rows; we only use them to render a 'too small' guard.
  // Cards self-shrink within the dashboard's flex layout; the
  // explicit guard catches the pathological 10x5 case.
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const terminalTooSmall = cols < 40 || rows < DASHBOARD_MIN_ROWS;
  const hasTabStrip = workstreams.length > 1;
  const hasSnapshotError = snap.error !== null;
  const availableForCards = dashboardAvailableRows(rows, { hasTabStrip, hasSnapshotError });
  const dashboardModel = buildDashboardLayoutModel(cols, availableForCards, visibility, snap.data);
  const dashboardTop = 1 + (hasTabStrip ? 1 : 0) + (hasSnapshotError ? 3 : 0);
  const cardHitRegions = dashboardCardHitRegions(
    dashboardModel.assignments,
    dashboardModel.widths,
    dashboardModel.budgetsByColumn,
    { top: dashboardTop },
  );

  // Yank callback handed down to popups (and used by the dashboard
  // for any direct yank in the future). The popup passes the command
  // text; we update the footer regardless of whether the clipboard
  // write succeeded so the user can mouse-select if needed.
  const yankFn = useCallback(async (command: string) => {
    const { yank } = await import("./yank.js");
    const r = await yank(command, clipboardRef.current ?? null);
    setFooter({ command, copied: r.copied });
  }, []);

  const footerFn = useCallback((command: string, copied: boolean, tone?: FooterState["tone"]) => {
    setFooter({ command, copied, tone });
  }, []);

  useMouse((event) => {
    if (helpOpen || terminalTooSmall) return;
    if (popup === null) {
      if (event.kind !== "doubleclick") return;
      const hit = hitTestDashboardCard(cardHitRegions, event);
      if (process.env.MU_TUI_DEBUG_MOUSE === "1") {
        process.stderr.write(`mouse @ (${event.x},${event.y}) → card ${hit ?? "MISS"}\n`);
        for (const region of cardHitRegions) {
          process.stderr.write(
            `  region ${region.id}: top=${region.top} bottom=${region.bottom} left=${region.left} right=${region.right}\n`,
          );
        }
      }
      if (hit === null) return;
      setPopupMode("list");
      setPopup(hit);
      return;
    }
    if (popupFilterEditing) return;
    if (event.kind === "scroll" || event.kind === "doubleclick") {
      pendingMouseEvent.current = event;
      setPopupMouseTick((n) => n + 1);
    }
  });
  useEffect(() => {
    void popupMouseTick;
    // Ink's public useInput hook is backed by this internal emitter;
    // replay the same bytes keyboard users type so mouse scroll/drill
    // stays routed through each popup's existing keymap switch. The
    // runtime probe + typed seam (getInkInternalEmitter) makes the
    // private-API dependency explicit and degrades gracefully if a
    // future ink upgrade drops the field — mouse stops emitting
    // synthetic keys, keyboard nav is unaffected.
    const emitter = getInkInternalEmitter(stdin);
    if (emitter === null) {
      if (process.env.MU_TUI_DEBUG_MOUSE === "1") {
        process.stderr.write(
          "mu: ink stdin missing internal_eventEmitter; mouse replay disabled\n",
        );
      }
      return;
    }
    const emitKey = (key: string, delayMs: number) => {
      setTimeout(() => emitter.emit("input", Buffer.from(key)), delayMs);
    };
    replayPendingMouseEvent(pendingMouseEvent, {
      popupOpen: popup !== null,
      filterEditing: popupFilterEditing,
      emitKey,
    });
  }, [popupMouseTick, popup, popupFilterEditing, stdin]);
  useEffect(() => {
    if (popup === null) pendingMouseEvent.current = null;
  }, [popup]);

  // Global keymap. Rendered before popup rendering so popups can
  // override Esc / q / y handling locally via their own useInput
  // (later popups will register handlers; for v0 placeholder
  // popups, Esc closes via this dispatcher).
  useInput(
    (input, key) => {
      // Help overlay owns its local scroll keys. App only handles
      // close/toggle here, then swallows every other key so `j` / `k`
      // / Ctrl-D / Ctrl-U cannot leak into the global dashboard
      // keymap while the overlay is open.
      if (helpOpen) {
        if (key.escape || input === "q" || input === "Q" || input === "?") {
          setHelpOpen(false);
        }
        return;
      }
      // While a popup is open, the popup owns navigation/yank/close.
      // App MUST NOT also handle q/Q (would quit the whole app —
      // confusing footgun) or Esc (would race with the popup's own
      // Esc handler). The popup's onClose callback flips popup back
      // to null; App resumes ownership on the next render.
      // Tick keys (+/-/=), refresh (r), and help (?) still bubble
      // up so they remain global even inside a popup.
      if (popup !== null) {
        // Popups now own their own close (Esc/q routed through
        // dispatchPopupKey → case "close"). Per
        // feat_popup_search_filter spec step 6, the App-level
        // q/Esc safety net was removed because it would race with
        // the filter prompt's own Esc-cancel handler. If a popup
        // regresses and stops handling close, the user can still
        // exit via Ctrl-C (handled below).
        if (key.escape || input === "q" || input === "Q") {
          // Let the popup handle it; do nothing here.
          return;
        }
        // Suppress card toggles / popup openers inside a popup; let
        // tick/help/refresh fall through. While the filter prompt
        // is editing, ALSO suppress every other globally-reactive
        // key (+/-/r/?/c/w) so they don't compete with the user's
        // filter typing.
        if (popupFilterEditing) return;
        if (
          (input >= "0" && input <= "9") ||
          "!@#$%^&*()".includes(input) ||
          input === "g" ||
          input === "t" ||
          input === "c"
        ) {
          return;
        }
        // Ctrl-C still quits (universal escape).
        if (key.ctrl && input === "c") {
          exit();
          return;
        }
      }
      const action = dispatchGlobalKeyFromInk(input, key);

      switch (action.kind) {
        case "quit":
          exit();
          return;
        case "toggleHelp":
          setHelpOpen((o) => !o);
          return;
        case "refreshNow":
          setRefreshNonce((n) => n + 1);
          return;
        case "tickFaster":
          setTickMs((t) => fasterTick(t));
          return;
        case "tickSlower":
          setTickMs((t) => slowerTick(t));
          return;
        case "clearFooter":
          setFooter(null);
          return;
        case "toggleCard":
          if (popup !== null) return; // suppress while popup is open
          setVisibility((v) => ({
            ...v,
            [cardKeyFromId(action.cardId)]: !v[cardKeyFromId(action.cardId)],
          }));
          return;
        case "openPopup":
          if (popup !== null) return; // single-popup invariant
          setPopupMode("list");
          setPopup(action.cardId);
          return;
        case "nextTab":
          if (popup !== null) return; // suppress while popup is open
          if (workstreams.length <= 1) return;
          setActiveWs((i) => (i + 1) % workstreams.length);
          return;
        case "prevTab":
          if (popup !== null) return;
          if (workstreams.length <= 1) return;
          setActiveWs((i) => (i - 1 + workstreams.length) % workstreams.length);
          return;
        case "noop":
          return;
      }
    },
    { isActive: true },
  );

  if (terminalTooSmall) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text>
          terminal too small ({cols}x{rows}) — need at least 40x{DASHBOARD_MIN_ROWS} for the TUI.
          Resize or run `mu state` for the static card.
        </Text>
      </Box>
    );
  }

  // Help overlay covers everything else (still gets the global
  // status bar at the bottom for consistent navigation hints).
  //
  // height={rows} + a flexGrow={1} spacer above the StatusBar pins
  // every frame to the full terminal height. Without this, ink's
  // diff-based renderer leaves "ghost" lines below a shrinking
  // frame on card-toggle / branch-swap (see
  // bug_tui_render_ghosting_v2). The spacer also bottom-sticks the
  // status bar so it doesn't float up against a shorter body.
  //
  // overflow="hidden" pinned at the root (all three branches): when
  // total content exceeds rows ink would otherwise emit the
  // overflowing rows past the terminal bottom, scrolling the top
  // off-screen and silently dropping the topmost row's bytes (see
  // bug_tui_tab_switch_stale_render layer 2 + the single-ws sibling
  // bug_tui_dashboard_top_card_scrolls_off where the nine cards'
  // summed natural height beats `rows`). Belt-and-braces with the
  // per-card flexShrink=1 in TitledBox: that one tells Yoga it MAY
  // shrink cards, this one tells ink to clip if Yoga still didn't
  // (e.g. a card with a hardcoded `height` prop).
  if (helpOpen) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <Help rows={rows} />
        <Box flexGrow={1} />
        <StatusBar
          mode="help"
          tickMs={tickMs}
          footer={footer}
          cols={cols}
          activeWorkstream={workstreams.length > 1 ? workstream : undefined}
        />
      </Box>
    );
  }

  // Popup mounted: render full-screen instead of dashboard, with
  // the popup-mode status bar pinned at the bottom.
  //
  // NOTE: no flexGrow={1} spacer here — popup bodies own their
  // bottom-fill (see sibling task bug_tui_popups_fill_pane). Adding
  // a sibling spacer would steal the space the popup wants. The
  // height={rows} pin is still required to prevent ghost lines
  // when swapping between popup ↔ dashboard ↔ help.
  if (popup !== null) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        {renderPopup(popup)}
        <StatusBar
          mode={popupFilterEditing ? "popup-filter" : "popup"}
          tickMs={tickMs}
          footer={footer}
          cols={cols}
          popupName={popupNameForId(popup)}
          popupMode={popupMode}
          activeWorkstream={workstreams.length > 1 ? workstream : undefined}
        />
      </Box>
    );
  }

  // Dashboard.
  //
  // overflow="hidden" pinned at the root: when total content
  // exceeds `rows` (e.g. the multi-ws TabStrip adds a row that
  // pushes the sum to rows+1), ink would otherwise emit the
  // overflowing rows past the terminal bottom, scrolling the top
  // off-screen — the user sees the topmost card lose its top
  // border. Clipping inside the height-pinned box keeps the frame
  // bounded to the terminal viewport so nothing is lost above row 1.
  // (bug_tui_tab_switch_stale_render layer 2.)
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {/* Tab strip — null when workstreams.length === 1, so the
          single-ws layout is byte-identical to the pre-multi-ws
          frame. The strip lives INSIDE the height-pinned + clipping
          parent so flexbox accounts for its 1-row height when
          allocating space to the cards below it. */}
      <TabStrip workstreams={workstreams} active={safeActive} terminalColumns={cols} />
      {hasSnapshotError && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">snapshot error: {snap.error}</Text>
        </Box>
      )}
      <Box height={availableForCards} overflow="hidden" flexDirection="column">
        <DashboardColumns
          rows={availableForCards}
          model={dashboardModel}
          snapshot={snap.data}
          db={db}
          workstream={workstream}
        />
      </Box>
      <Box flexGrow={1} />
      <StatusBar
        mode="dashboard"
        tickMs={tickMs}
        footer={footer}
        cols={cols}
        activeWorkstream={workstreams.length > 1 ? workstream : undefined}
      />
    </Box>
  );

  function renderPopup(id: PopupRegistryId): JSX.Element {
    const props: CommonPopupProps = {
      yank: yankFn,
      onFooter: footerFn,
      onClose: () => {
        setPopup(null);
        setPopupMode("list");
        setPopupFilterEditing(false);
      },
      snapshot: snap.data,
      fastTickNonce: snap.fastTickNonce,
      slowTickNonce: snap.slowTickNonce,
      mode: popupMode,
      onModeChange: setPopupMode,
      onFilterEditingChange: setPopupFilterEditing,
      db,
      workstream,
    };
    const Popup = POPUP_REGISTRY[id];
    return <Popup {...props} />;
  }
}

interface DashboardLayoutModel {
  cardsRows: number;
  assignments: ColumnAssignment[];
  widths: ColumnWidth[];
  budgetsByColumn: RowBudgetMap[];
  hiddenCount: number;
}

interface DashboardColumnsProps {
  rows: number;
  model: DashboardLayoutModel;
  snapshot: ReturnType<typeof useDashboardSnapshot>["data"];
  db: Db;
  workstream: string;
}

function buildDashboardLayoutModel(
  cols: number,
  rows: number,
  visibility: CardVisibility,
  snapshot: ReturnType<typeof useDashboardSnapshot>["data"],
): DashboardLayoutModel {
  const visible = visibleCardIds(visibility);
  const firstCull = cullCardsForRows(visible, rows);
  const cullBudget = firstCull.hidden.length > 0 ? Math.max(1, rows - 1) : rows;
  const culled = cullBudget === rows ? firstCull : cullCardsForRows(visible, cullBudget);
  const cardsRows = culled.hidden.length > 0 ? Math.max(1, rows - 1) : rows;
  const assignments = layoutDashboardColumns(cols, culled.cards);
  const widths = columnWidths(cols, assignments.length);
  const budgetsByColumn = assignments.map((assignment) =>
    capRowBudgetsForColumn(
      cardsRows,
      assignment.cards,
      allocateRowBudgets(
        cardsRows,
        assignment.cards.map((id) => ({ id, dataCount: dataCountForCard(id, snapshot) })),
      ),
    ),
  );
  return { cardsRows, assignments, widths, budgetsByColumn, hiddenCount: culled.hidden.length };
}

function DashboardColumns({
  rows,
  model,
  snapshot,
  db,
  workstream,
}: DashboardColumnsProps): JSX.Element {
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Box flexDirection="row" gap={1} height={model.cardsRows} overflow="hidden">
        {model.assignments.map((assignment, i) => {
          const width = model.widths[i]?.width ?? 80;
          const budgets = model.budgetsByColumn[i];
          if (budgets === undefined) return null;
          return (
            <Box key={assignment.cards.join("-")} flexDirection="column" width={width}>
              {assignment.cards.map((id) =>
                renderCard(id, { snapshot, db, workstream, width, budgets }),
              )}
            </Box>
          );
        })}
      </Box>
      {model.hiddenCount > 0 ? (
        <Text dimColor>+{model.hiddenCount} cards hidden · resize taller</Text>
      ) : null}
    </Box>
  );
}

function capRowBudgetsForColumn(
  availableRows: number,
  cards: ReadonlyArray<CardId>,
  budgets: ReturnType<typeof allocateRowBudgets>,
): ReturnType<typeof allocateRowBudgets> {
  const out: Record<CardId, number> = { ...budgets };
  let remaining = Math.max(0, Math.floor(availableRows));
  for (const id of cards) {
    const chrome = CARD_CONFIGS[id].chrome;
    const maxBody = Math.max(0, remaining - chrome);
    out[id] = Math.min(out[id], maxBody);
    remaining = Math.max(0, remaining - chrome - out[id]);
  }
  return out;
}

interface RenderCardContext {
  snapshot: DashboardSnapshot;
  db: Db;
  workstream: string;
  width: number;
  budgets: ReturnType<typeof allocateRowBudgets>;
}

function renderCard(id: CardId, { snapshot, db, workstream, width, budgets }: RenderCardContext) {
  const Card = CARD_REGISTRY[id];
  return (
    <Card
      key={id}
      snapshot={snapshot}
      db={db}
      workstream={workstream}
      rowBudget={budgets[id]}
      cols={width}
    />
  );
}

function visibleCardIds(visibility: CardVisibility): CardId[] {
  const ids: CardId[] = [];
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
    if (visibility[cardKeyFromId(id)]) ids.push(id);
  }
  return ids;
}

function cardKeyFromId(id: CardId): keyof CardVisibility {
  switch (id) {
    case 0:
      return "commits";
    case 1:
      return "agents";
    case 2:
      return "tracks";
    case 3:
      return "ready";
    case 4:
      return "log";
    case 5:
      return "workspaces";
    case 6:
      return "inProgress";
    case 7:
      return "blocked";
    case 8:
      return "recent";
    case 9:
      return "doctor";
  }
}

function popupNameForId(id: NonNullable<PopupId>): string {
  switch (id) {
    case 0:
      return "Commits";
    case 1:
      return "Agents";
    case 2:
      return "Tracks";
    case 3:
      return "Tasks";
    case 4:
      return "Log";
    case 5:
      return "Workspaces";
    case 6:
      return "In-progress";
    case 7:
      return "Blocked";
    case 8:
      return "Recent";
    case 9:
      return "Doctor";
    case "dag":
      return "DAG";
    case "allTasks":
      return "All tasks";
  }
}
