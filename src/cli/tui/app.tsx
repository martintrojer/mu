// <App> — the TUI's root component.
//
// Owns:
//   - The dashboard snapshot poll (via useDashboardSnapshot)
//   - Card visibility flags (1-4 toggle)
//   - Tick rate (+/-/=/0 adjust)
//   - Single-popup invariant + state-restore on close
//   - Help overlay (?)
//   - Footer line (last yanked command + [copied]/[no clipboard])
//   - Yank backend probe (memoised once per session)
//   - Quit / Ctrl-C
//
// Per design_card_iface + design_popup_lifecycle: when a popup is
// open, the dashboard pauses its tick (popups can fetch their own
// data if needed). On popup close, the dashboard tick resumes; card
// visibility + tick rate + footer are preserved as a side effect of
// living in <App> state, not the popup.

import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Db } from "../../db.js";
import { AgentsCard } from "./cards/agents.js";
import { BlockedCard } from "./cards/blocked.js";
import { DoctorCard } from "./cards/doctor.js";
import { InProgressCard } from "./cards/inprogress.js";
import { LogCard } from "./cards/log.js";
import { ReadyCard } from "./cards/ready.js";
import { RecentCard } from "./cards/recent.js";
import { TracksCard } from "./cards/tracks.js";
import { WorkspacesCard } from "./cards/workspaces.js";
import { Help } from "./help.js";
import { dispatchGlobalKey } from "./keys.js";
import { AgentsPopup } from "./popups/agents.js";
import { BlockedPopup } from "./popups/blocked.js";
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
}

export interface FooterState {
  command: string;
  copied: boolean;
}

type PopupId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | null;
export type PopupMode = "list" | "drill";

export function App({ db, workstreams }: AppProps): JSX.Element {
  const { exit } = useApp();

  const [visibility, setVisibility] = useState<CardVisibility>(DEFAULT_CARD_VISIBILITY);
  const [tickMs, setTickMs] = useState<number>(TICK_DEFAULT_MS);
  // Index of the active workstream tab. Tab / Shift-Tab cycles
  // through `workstreams`. Always in [0, workstreams.length).
  const [activeWs, setActiveWs] = useState<number>(0);
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

  const snap = useDashboardSnapshot(db, workstream, tickMs, popup === null);

  // Terminal-resize handling per design_resize. ink's stdout exposes
  // columns/rows; we only use them to render a 'too small' guard.
  // Cards self-shrink within the dashboard's flex layout; the
  // explicit guard catches the pathological 10x5 case.
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  if (cols < 40 || rows < 10) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text>
          terminal too small ({cols}x{rows}) — need at least 40x10 for the TUI. Resize or run `mu
          state` for the static card.
        </Text>
      </Box>
    );
  }

  // Yank callback handed down to popups (and used by the dashboard
  // for any direct yank in the future). The popup passes the command
  // text; we update the footer regardless of whether the clipboard
  // write succeeded so the user can mouse-select if needed.
  const yankFn = useCallback(async (command: string) => {
    const { yank } = await import("./yank.js");
    const r = await yank(command, clipboardRef.current ?? null);
    setFooter({ command, copied: r.copied });
  }, []);

  // Global keymap. Rendered before popup rendering so popups can
  // override Esc / q / y handling locally via their own useInput
  // (later popups will register handlers; for v0 placeholder
  // popups, Esc closes via this dispatcher).
  useInput(
    (input, key) => {
      // Esc / q always closes the help overlay (highest priority).
      if (helpOpen && (key.escape || input === "q" || input === "Q")) {
        setHelpOpen(false);
        return;
      }
      // While a popup is open, the popup owns navigation/yank/close.
      // App MUST NOT also handle q/Q (would quit the whole app —
      // confusing footgun) or Esc (would race with the popup's own
      // Esc handler). The popup's onClose callback flips popup back
      // to null; App resumes ownership on the next render.
      // Tick keys (+/-/=/0), refresh (r), and help (?) still bubble
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
          (input >= "1" && input <= "9") ||
          "!@#$%^&*()".includes(input) ||
          input === "c" ||
          input === "w"
        ) {
          return;
        }
        // Ctrl-C still quits (universal escape).
        if (key.ctrl && input === "c") {
          exit();
          return;
        }
      }
      const action = dispatchGlobalKey(input, {
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
        case "tickReset":
          setTickMs(TICK_DEFAULT_MS);
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
        // (slot 6/7/8 have no popup yet — see feat_more_cards_umbrella)
        case "openPopup":
          if (popup !== null) return; // single-popup invariant
          setPopupMode("list");
          setPopup(action.cardId);
          return;
        case "workstreamPicker":
          setFooter({
            command: "workstream picker: v0.next",
            copied: false,
          });
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

  // Force a refresh-now on nonce change (cheap; the snapshot hook
  // re-runs because `tickMs` is unchanged so React just schedules
  // the next interval — but we want one immediate fetch. Bumping
  // tickMs by a no-op cycle is the simplest pattern that works
  // without restructuring the hook.)
  useEffect(() => {
    // Touch refreshNonce so React tracks the dep; the actual
    // re-fetch happens on the next setInterval tick. v0 accepts
    // this latency; v0.next can wire a refresh-now signal into
    // the hook.
    void refreshNonce;
  }, [refreshNonce]);

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
  // overflow="hidden" instructs ink to CLIP children to the box's
  // computed bounds rather than letting them overrun and emit
  // escape sequences past row N (which scrolls the terminal up and
  // chops the topmost row — see bug_tui_tab_switch_stale_render
  // layer 2: the multi-ws TabStrip pushed total content to rows+1,
  // and without clipping the terminal scrolled, eating the topmost
  // card's top border).
  if (helpOpen) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <Help />
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
      <TabStrip workstreams={workstreams} active={safeActive} />
      {snap.error !== null && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">snapshot error: {snap.error}</Text>
        </Box>
      )}
      {visibility.agents && <AgentsCard snapshot={snap.data} />}
      {visibility.tracks && <TracksCard snapshot={snap.data} />}
      {visibility.ready && <ReadyCard snapshot={snap.data} />}
      {visibility.log && <LogCard snapshot={snap.data} />}
      {visibility.workspaces && <WorkspacesCard snapshot={snap.data} />}
      {visibility.inProgress && <InProgressCard snapshot={snap.data} />}
      {visibility.blocked && <BlockedCard snapshot={snap.data} db={db} workstream={workstream} />}
      {visibility.recent && <RecentCard snapshot={snap.data} />}
      {visibility.doctor && <DoctorCard snapshot={snap.data} />}
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

  function renderPopup(id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): JSX.Element {
    const props = {
      yank: yankFn,
      onClose: () => {
        setPopup(null);
        setPopupMode("list");
        setPopupFilterEditing(false);
      },
      snapshot: snap.data,
      mode: popupMode,
      onModeChange: setPopupMode,
      onFilterEditingChange: setPopupFilterEditing,
      db,
      workstream,
    };
    switch (id) {
      case 1:
        return <AgentsPopup {...props} />;
      case 2:
        return <TracksPopup {...props} />;
      case 3:
        return <ReadyPopup {...props} />;
      case 4:
        return <LogPopup {...props} />;
      case 5:
        return <WorkspacesPopup {...props} />;
      case 6:
        return <InProgressPopup {...props} />;
      case 7:
        return <BlockedPopup {...props} />;
      case 8:
        return <RecentPopup {...props} />;
      case 9:
        return <DoctorPopup {...props} />;
    }
  }
}

function cardKeyFromId(id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): keyof CardVisibility {
  switch (id) {
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

function popupNameForId(id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): string {
  switch (id) {
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
  }
}
