// Shared '/' incremental substring filter for list popups
// (Agents/Tracks/Tasks/Log + every future card popup under
// feat_more_cards_umbrella). Per feat_popup_search_filter
// (workstream `tui-impl`).
//
// Design intent: every list popup wires this hook in ~5 LOC and
// gets the full UX (incremental edit, Enter commit, Esc cancel,
// status-bar mode flip, no-matches fallback) for free. New card
// popups (Workspaces / In-progress / Blocked / Recent / Doctor)
// MUST consume `usePopupFilter` rather than re-implement the state
// machine — keep the substrate cheap to reuse.
//
// The reducer is split out as a pure function (`popupFilterReducer`)
// so it's testable without React. The hook is a thin wrapper.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text } from "ink";
import { useCallback, useEffect, useReducer } from "react";
import type { KeyFlags } from "./keys.js";

/** Filter state owned by each popup. Resets on popup unmount. */
export interface FilterState {
  /** Current query string (case preserved for display; lower-cased for matching). */
  query: string;
  /** True while the user is typing the query; false after Enter (committed) and on cancel. */
  editing: boolean;
}

export const INITIAL_FILTER_STATE: FilterState = { query: "", editing: false };

/**
 * Reducer events emitted by `popupFilterOnKey`. The hook dispatches
 * these internally; tests can drive the reducer directly without
 * synthesising ink keystrokes.
 */
export type FilterAction =
  | { kind: "startEdit" }
  | { kind: "appendChar"; char: string }
  | { kind: "backspace" }
  | { kind: "commit" }
  | { kind: "cancel" }
  | { kind: "reset" };

/** Pure reducer. */
export function popupFilterReducer(state: FilterState, action: FilterAction): FilterState {
  switch (action.kind) {
    case "startEdit":
      // Re-entering edit mode keeps the existing query (so '/' after
      // Enter pre-fills for refinement). Only flips `editing`.
      return { ...state, editing: true };
    case "appendChar":
      // Per spec: ASCII 32..126 only. Caller should pre-filter, but
      // double-check defensively.
      if (!isPrintable(action.char)) return state;
      return { ...state, query: state.query + action.char };
    case "backspace":
      if (state.query === "") return state;
      return { ...state, query: state.query.slice(0, -1) };
    case "commit":
      // Keep query, exit edit mode. Cursor-snap is the popup's job
      // (it owns the cursor state; the filter just narrows the rows).
      return { ...state, editing: false };
    case "cancel":
      // Esc clears the query AND exits edit mode (full reset).
      return INITIAL_FILTER_STATE;
    case "reset":
      return INITIAL_FILTER_STATE;
  }
}

function isPrintable(s: string): boolean {
  if (s.length !== 1) return false;
  const code = s.charCodeAt(0);
  return code >= 32 && code <= 126;
}

/**
 * Classify a keystroke for filter mode. Returns the action that the
 * reducer should consume, or `null` when the key is NOT a
 * filter-mode keystroke (and the popup should run its normal
 * dispatchPopupKey logic).
 *
 * Pure function; no React. The hook calls this then dispatches the
 * returned action.
 */
export function classifyFilterKey(
  state: FilterState,
  input: string,
  key: KeyFlags,
): FilterAction | null {
  if (!state.editing) return null;
  // Esc cancels (full reset).
  if (key.escape) return { kind: "cancel" };
  // Enter commits.
  if (key.return) return { kind: "commit" };
  // Backspace pops one char (no-op if empty — reducer handles it).
  // ink reports backspace via key.backspace OR delete; many terminals
  // also send DEL (0x7f) as a literal character. Cover both.
  if (
    (key as KeyFlags & { backspace?: boolean; delete?: boolean }).backspace === true ||
    (key as KeyFlags & { backspace?: boolean; delete?: boolean }).delete === true ||
    input === "\x7f" ||
    input === "\b"
  ) {
    return { kind: "backspace" };
  }
  // Skip control / navigation keys (tab, arrows, page, function keys).
  if (
    key.tab === true ||
    key.upArrow === true ||
    key.downArrow === true ||
    key.leftArrow === true ||
    key.rightArrow === true ||
    key.pageUp === true ||
    key.pageDown === true ||
    key.f5 === true
  ) {
    // Consume (silently ignore) so they don't navigate the underlying
    // list while the user is typing. Returning null here would let
    // the popup run dispatchPopupKey and treat them as nav keys.
    // We model this by appending nothing — but the reducer ignores
    // empty strings, so we use a sentinel "no-op" via cancel? No —
    // we just return null is wrong. The cleanest fix is to return
    // an appendChar with empty content, which the reducer drops.
    // Even cleaner: return a "consumed-noop" by re-asserting state.
    // We piggy-back on appendChar with "" (reducer rejects via
    // isPrintable) → state unchanged → caller treats as consumed.
    return { kind: "appendChar", char: "" };
  }
  // Ctrl-* combos: also consume-and-ignore. Ctrl-C is handled by ink
  // itself (exitOnCtrlC) so we don't see it here.
  if (key.ctrl === true) {
    return { kind: "appendChar", char: "" };
  }
  // Printable single character (ASCII 32..126). Multi-codepoint
  // input (paste) is dropped char-by-char by ink's useInput; we just
  // append whatever single char arrived.
  if (isPrintable(input)) return { kind: "appendChar", char: input };
  // Unknown — consume-and-ignore so the underlying popup doesn't
  // see e.g. raw escape sequences mid-edit.
  return { kind: "appendChar", char: "" };
}

/**
 * Filter hook for list popups. Returns the current state plus a
 * keystroke handler the popup wires into its `useInput` callback.
 *
 *   const flt = usePopupFilter();
 *   useInput((input, key) => {
 *     if (flt.onKey(input, key) === "consumed") return;
 *     // ...existing dispatchPopupKey switch...
 *     if (action.kind === "filter") { flt.startEdit(); return; }
 *   });
 */
export interface PopupFilter {
  /** Current query (case preserved; empty = "no filter"). */
  query: string;
  /** True while editing (caret rendered; Enter to commit). */
  editing: boolean;
  /**
   * Handle a keystroke. Returns "consumed" when the key was a
   * filter-mode keystroke (caller should NOT run its own
   * dispatchPopupKey logic). Returns "passthrough" otherwise.
   */
  onKey(input: string, key: KeyFlags): "consumed" | "passthrough";
  /** Enter edit mode (call from the dispatchPopupKey "filter" branch). */
  startEdit(): void;
  /** Clear query + exit edit mode. */
  reset(): void;
}

/**
 * Optional hook options. Per review_dedup_filter_editing_effect:
 * eight list popups had the IDENTICAL `useEffect(() =>
 * onFilterEditingChange?.(flt.editing), [flt.editing,
 * onFilterEditingChange])` block immediately after `const flt =
 * usePopupFilter()`. Baking the bubble-up into the hook itself
 * collapses each call site by 3 lines and means the next popup
 * author can't forget to wire the StatusBar mode flip.
 *
 * `onEditingChange` is a callback the popup wires to its parent
 * `<App>`'s `setPopupFilterEditing`. Called WHENEVER the editing
 * flag changes (and once on mount when the initial value differs
 * from undefined-default). When omitted, the hook is silent.
 *
 * `enabled` (default true) lets popups with MULTIPLE filter
 * instances (e.g. workspaces.tsx — list view + commits drill view)
 * mark which instance is currently active. A disabled instance
 * always bubbles `false` regardless of its own `state.editing`, so
 * the StatusBar mode flip stays consistent across sub-modes
 * without hand-rolling a conditional useEffect at the call site.
 * Per review_tui_workspaces_two_filter_instances.
 */
export interface UsePopupFilterOpts {
  onEditingChange?: (editing: boolean) => void;
  enabled?: boolean;
}

export function usePopupFilter(opts: UsePopupFilterOpts = {}): PopupFilter {
  const [state, dispatch] = useReducer(popupFilterReducer, INITIAL_FILTER_STATE);
  const { onEditingChange, enabled } = opts;
  const onKey = useCallback(
    (input: string, key: KeyFlags): "consumed" | "passthrough" => {
      const action = classifyFilterKey(state, input, key);
      if (action === null) return "passthrough";
      dispatch(action);
      return "consumed";
    },
    [state],
  );
  const startEdit = useCallback(() => dispatch({ kind: "startEdit" }), []);
  const reset = useCallback(() => dispatch({ kind: "reset" }), []);
  // Bubble the editing flag up to the parent (StatusBar uses it to
  // flip its hint cluster into popup-filter mode). No-op when the
  // caller doesn't pass a callback. When `enabled === false`, bubble
  // `false` regardless of state.editing so popups with multiple
  // filter instances can declaratively mark which one is active
  // (per review_tui_workspaces_two_filter_instances).
  const bubbledEditing = enabled === false ? false : state.editing;
  useEffect(() => {
    onEditingChange?.(bubbledEditing);
  }, [bubbledEditing, onEditingChange]);
  return { query: state.query, editing: state.editing, onKey, startEdit, reset };
}

/**
 * Apply a filter query to a list of items. Case-insensitive
 * substring on the per-item "search blob" string returned by
 * `blobOf`. Empty query → original list (identity).
 *
 * Pure; no React. New card popups call this directly:
 *
 *   const filtered = applyFilter(source, flt.query, (e) => `${e.name} ${e.label}`);
 */
export function applyFilter<T>(
  items: readonly T[],
  query: string,
  blobOf: (item: T) => string,
): T[] {
  if (query === "") return [...items];
  const q = query.toLowerCase();
  const out: T[] = [];
  for (const item of items) {
    if (blobOf(item).toLowerCase().includes(q)) out.push(item);
  }
  return out;
}

/**
 * Bottom-of-popup prompt. Renders nothing while idle (no query AND
 * not editing); renders `/<query>_` while editing; renders
 * `[filter] <query>` after Enter (committed). The trailing `_` is a
 * literal character used as a "cursor" — ink doesn't expose a real
 * text-input cursor without ink-text-input which we are NOT adding
 * (anti-feature pledge).
 */
export function FilterPrompt({ state }: { state: PopupFilter }): JSX.Element | null {
  if (state.query === "" && !state.editing) return null;
  return (
    <Box marginTop={1}>
      <Text color={state.editing ? "yellow" : "gray"}>
        {state.editing ? "/" : "[filter] "}
        {state.query}
        {state.editing ? "_" : ""}
      </Text>
    </Box>
  );
}
