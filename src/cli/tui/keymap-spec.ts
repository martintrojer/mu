// Canonical TUI keymap specification for the status-bar hint
// clusters and the `?` help overlay.
//
// Contract: status-bar hints are the per-mode ALWAYS-SHOWN subset
// (keys with no better mnemonic elsewhere, and only keys that work in
// that mode). The help overlay is the SUPERSET: every key shown in a
// status-bar cluster must appear here too. Keep new key hints in this
// pure data file so src/cli/tui/status-bar.tsx and help.tsx cannot
// drift independently.

type KeyId = string;

export interface StatusHintEntry {
  kind: "hint" | "label" | "text";
  /** Key glyph/range rendered in yellow for kind="hint". */
  key?: string;
  /** Effect label (kind="hint") or literal text (label/text). */
  label: string;
  keyIds: readonly KeyId[];
  color?: "cyan" | "magenta" | "yellow";
}

export interface StatusHintContext {
  mode: "dashboard" | "popup-list" | "popup-drill" | "popup-filter" | "dag" | "all-tasks";
  /** Dashboard-only: Tab hint appears only when N≥2 workstreams. */
  hasWorkstreamTabs?: boolean;
}

export interface HelpRowSpec {
  keys: string;
  effect: string;
  keyIds: readonly KeyId[];
}

export interface HelpPaneSpec {
  title: string;
  rows: readonly HelpRowSpec[];
}

const DASHBOARD_BASE_HINTS: readonly StatusHintEntry[] = [
  hint("0-9", "cards", ["0-9"]),
  hint("Shift 0-9", "popups", ["Shift 0-9"]),
  hint("g", "DAG", ["g"]),
  hint("t", "tasks", ["t"]),
];

const DASHBOARD_TRAILING_HINTS: readonly StatusHintEntry[] = [
  hint("?", "help", ["?"]),
  hint("q", "quit", ["q"]),
];

const POPUP_LIST_HINTS: readonly StatusHintEntry[] = [
  hint("j/k", "nav", ["j", "k"]),
  hint("/", "filter", ["/"]),
  hint("Enter", "drill", ["Enter"]),
  hint("y", "yank", ["y"]),
  hint("Shift 0-9", "switch", ["Shift 0-9"]),
  hint("?", "help", ["?"]),
  hint("Esc", "back", ["Esc"]),
];

const POPUP_DRILL_HINTS: readonly StatusHintEntry[] = [
  label("drill", "magenta"),
  hint("j/k", "scroll", ["j", "k"]),
  hint("Ctrl-D/U", "page", ["Ctrl-D", "Ctrl-U"]),
  hint("y", "yank", ["y"]),
  hint("?", "help", ["?"]),
  hint("Esc", "back", ["Esc"]),
];

const POPUP_FILTER_HINTS: readonly StatusHintEntry[] = [
  label("filter", "yellow"),
  text("type to match"),
  hint("Enter", "commit", ["Enter"]),
  hint("Esc", "cancel", ["Esc"]),
];

const DAG_HINTS: readonly StatusHintEntry[] = [
  label("drill", "magenta"),
  hint("j/k", "scroll", ["j", "k"]),
  hint("o/i/c/r/d", "filter", ["o", "i", "c", "r", "d"]),
  hint("y", "yank", ["y"]),
  hint("?", "help", ["?"]),
  hint("Esc", "back", ["Esc"]),
];

const ALL_TASKS_HINTS: readonly StatusHintEntry[] = [
  label("drill", "magenta"),
  hint("j/k", "nav", ["j", "k"]),
  hint("o/i/c/r/d", "filter", ["o", "i", "c", "r", "d"]),
  hint("s", "sort", ["s"]),
  hint("/", "search", ["/"]),
  hint("Enter", "drill", ["Enter"]),
  hint("y", "yank", ["y"]),
  hint("Esc", "back", ["Esc"]),
];

export function statusHintEntries(context: StatusHintContext): readonly StatusHintEntry[] {
  switch (context.mode) {
    case "dashboard":
      return [
        ...DASHBOARD_BASE_HINTS,
        ...(context.hasWorkstreamTabs ? [hint("Tab", "ws", ["Tab"])] : []),
        ...DASHBOARD_TRAILING_HINTS,
      ];
    case "popup-list":
      return POPUP_LIST_HINTS;
    case "popup-drill":
      return POPUP_DRILL_HINTS;
    case "popup-filter":
      return POPUP_FILTER_HINTS;
    case "dag":
      return DAG_HINTS;
    case "all-tasks":
      return ALL_TASKS_HINTS;
  }
}

export const HELP_PANES: readonly HelpPaneSpec[] = [
  {
    title: "keys · dashboard",
    rows: [
      row(
        "0-9",
        "toggle Commits/Agents/Tracks/Ready/Log/Workspaces/In-progress/Blocked/Recent/Doctor cards",
        ["0-9"],
      ),
      row("Shift 0-9", "open numbered popups (Shift+0 = Commits; Shift+8 = Recent)", ["Shift 0-9"]),
      row("g", "DAG popup", ["g"]),
      row("t", "all-tasks popup", ["t"]),
      row("Tab / Shift-Tab", "next / previous workstream tab (multi-ws)", ["Tab", "Shift-Tab"]),
      row("c", "clear footer (last yank)", ["c"]),
      row("0", "Commits card (tick reset is not bound; slot 0 is a card)", ["0"]),
      row("+/=", "tick faster (floor 100ms)", ["+", "="]),
      row("-", "tick slower (ceiling 10s)", ["-"]),
      row("r/F5", "refresh now", ["r", "F5"]),
      row("?", "toggle this overlay", ["?"]),
      row("q/Q", "quit (Ctrl-C also)", ["q", "Q", "Ctrl-C"]),
    ],
  },
  {
    title: "keys · popup list",
    rows: [
      row("j/k or ↑/↓", "move selection", ["j", "k", "ArrowUp", "ArrowDown"]),
      row("g/G", "first / last row", ["g", "G"]),
      row("Ctrl-D/U", "half-page down / up", ["Ctrl-D", "Ctrl-U"]),
      row("PgDn/PgUp", "full-page down / up", ["PgDn", "PgUp"]),
      row("/", "filter/search rows", ["/"]),
      row("Enter", "drill into focused row", ["Enter"]),
      row("y", "yank action for focused row", ["y"]),
      row("Shift 0-9", "switch numbered popup", ["Shift 0-9"]),
      row("Esc/q", "back to dashboard", ["Esc", "q"]),
      row("?", "toggle this overlay", ["?"]),
    ],
  },
  {
    title: "keys · popup drill",
    rows: [
      row("j/k or ↑/↓", "scroll one line", ["j", "k", "ArrowUp", "ArrowDown"]),
      row("Ctrl-D/U", "half-page down / up", ["Ctrl-D", "Ctrl-U"]),
      row("PgDn/PgUp", "full-page down / up", ["PgDn", "PgUp"]),
      row("g/G", "top / bottom", ["g", "G"]),
      row("/", "filter/search when the drill is a list", ["/"]),
      row("y", "yank drill-specific command", ["y"]),
      row("Esc/q", "back one drill level", ["Esc", "q"]),
      row("?", "toggle this overlay", ["?"]),
    ],
  },
  {
    title: "keys · popup filter",
    rows: [
      row("type", "append printable characters to the filter", ["type"]),
      row("Backspace", "edit query", ["Bksp"]),
      row("Enter", "commit filter", ["Enter"]),
      row("Esc", "cancel filter", ["Esc"]),
    ],
  },
  {
    title: "keys · DAG / all-tasks",
    rows: [
      row("o/i/c/r/d", "toggle OPEN / IN_PROGRESS / CLOSED / REJECTED / DEFERRED status filters", [
        "o",
        "i",
        "c",
        "r",
        "d",
      ]),
      row("s", "all-tasks sort cycle (roi → recency → age → id)", ["s"]),
      row("/", "all-tasks row search", ["/"]),
    ],
  },
  {
    title: "mouse",
    rows: [
      row("double-click card", "drill into popup", ["mouse:doubleclick-card"]),
      row("double-click row", "drill into row detail", ["mouse:doubleclick-row"]),
      row("scroll wheel", "scroll list / drill body", ["mouse:scroll"]),
      row("back", "no mouse back; use Esc/q", ["mouse:no-back"]),
    ],
  },
];

export function statusHintKeyIds(context: StatusHintContext): Set<KeyId> {
  return new Set(statusHintEntries(context).flatMap((entry) => entry.keyIds));
}

export function helpOverlayKeyIds(): Set<KeyId> {
  return new Set(HELP_PANES.flatMap((pane) => pane.rows.flatMap((row) => row.keyIds)));
}

function hint(key: string, labelText: string, keyIds: readonly KeyId[]): StatusHintEntry {
  return { kind: "hint", key, label: labelText, keyIds };
}

function label(textValue: string, color: "cyan" | "magenta" | "yellow"): StatusHintEntry {
  return { kind: "label", label: textValue, keyIds: [], color };
}

function text(textValue: string): StatusHintEntry {
  return { kind: "text", label: textValue, keyIds: [] };
}

function row(keys: string, effect: string, keyIds: readonly KeyId[]): HelpRowSpec {
  return { keys, effect, keyIds };
}
