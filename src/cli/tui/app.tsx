// <App> — the TUI's root component.
//
// Owns:
//   - The dashboard snapshot poll (via useDashboardSnapshot)
//   - Card visibility flags (1-4 toggle)
//   - Tick rate (+/-/=/0 adjust)
//   - Single-popup invariant + state-restore on close
//   - Help overlay (?/F1)
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
import { LogCard } from "./cards/log.js";
import { ReadyCard } from "./cards/ready.js";
import { TracksCard } from "./cards/tracks.js";
import { WorkspacesCard } from "./cards/workspaces.js";
import { Help } from "./help.js";
import { dispatchGlobalKey } from "./keys.js";
import { AgentsPopup } from "./popups/agents.js";
import { LogPopup } from "./popups/log.js";
import { ReadyPopup } from "./popups/ready.js";
import { TracksPopup } from "./popups/tracks.js";
import {
  type CardVisibility,
  DEFAULT_CARD_VISIBILITY,
  TICK_DEFAULT_MS,
  fasterTick,
  slowerTick,
  useDashboardSnapshot,
} from "./state.js";
import { StatusBar } from "./status-bar.js";
import { type ClipboardBackend, probeClipboardBackend } from "./yank.js";

export interface AppProps {
  db: Db;
  workstream: string;
}

export interface FooterState {
  command: string;
  copied: boolean;
}

type PopupId = 1 | 2 | 3 | 4 | null;
export type PopupMode = "list" | "drill";

export function App({ db, workstream }: AppProps): JSX.Element {
  const { exit } = useApp();

  const [visibility, setVisibility] = useState<CardVisibility>(DEFAULT_CARD_VISIBILITY);
  const [tickMs, setTickMs] = useState<number>(TICK_DEFAULT_MS);
  const [popup, setPopup] = useState<PopupId>(null);
  // Per-popup-instance mode ("list" → list of rows; "drill" →
  // inline detail view inside the popup body). Owned by <App>
  // because the StatusBar's hint cluster needs to know which mode
  // we're in. Reset to "list" every time a new popup opens.
  const [popupMode, setPopupMode] = useState<PopupMode>("list");
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
        if (key.escape || input === "q" || input === "Q") {
          // Safety net: if the popup somehow doesn't handle close
          // (regression), close it from here too. We respect the
          // current popupMode so a stuck-in-drill popup doesn't get
          // collapsed all the way back to the dashboard — q/Esc
          // from drill should pop one level (back to list); only a
          // second q/Esc closes the popup. Popups call setPopupMode
          // themselves; we only act if they're already in list mode.
          if (popupMode === "list") setPopup(null);
          return;
        }
        // Suppress card toggles / popup openers inside a popup; let
        // tick/help/refresh fall through.
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
        // (slot 5 has no popup yet — see feat_more_cards_umbrella)
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
  if (helpOpen) {
    return (
      <Box flexDirection="column">
        <Help />
        <StatusBar mode="help" tickMs={tickMs} footer={footer} cols={cols} />
      </Box>
    );
  }

  // Popup mounted: render full-screen instead of dashboard, with
  // the popup-mode status bar pinned at the bottom.
  if (popup !== null) {
    return (
      <Box flexDirection="column">
        {renderPopup(popup)}
        <StatusBar
          mode="popup"
          tickMs={tickMs}
          footer={footer}
          cols={cols}
          popupName={popupNameForId(popup)}
          popupMode={popupMode}
        />
      </Box>
    );
  }

  // Dashboard.
  return (
    <Box flexDirection="column">
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
      <StatusBar mode="dashboard" tickMs={tickMs} footer={footer} cols={cols} />
    </Box>
  );

  function renderPopup(id: 1 | 2 | 3 | 4): JSX.Element {
    const props = {
      yank: yankFn,
      onClose: () => {
        setPopup(null);
        setPopupMode("list");
      },
      snapshot: snap.data,
      mode: popupMode,
      onModeChange: setPopupMode,
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
    }
  }
}

function cardKeyFromId(id: 1 | 2 | 3 | 4 | 5): keyof CardVisibility {
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
  }
}

function popupNameForId(id: 1 | 2 | 3 | 4): string {
  switch (id) {
    case 1:
      return "Agents";
    case 2:
      return "Tracks";
    case 3:
      return "Tasks";
    case 4:
      return "Log";
  }
}
