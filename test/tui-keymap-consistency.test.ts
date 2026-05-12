import { describe, expect, it } from "vitest";
import {
  type StatusHintContext,
  helpOverlayKeyIds,
  statusHintEntries,
  statusHintKeyIds,
} from "../src/cli/tui/keymap-spec.js";

const MODES: StatusHintContext[] = [
  { mode: "dashboard", hasWorkstreamTabs: false },
  { mode: "dashboard", hasWorkstreamTabs: true },
  { mode: "popup-list" },
  { mode: "popup-drill" },
  { mode: "popup-filter" },
  { mode: "dag" },
  { mode: "all-tasks" },
];

describe("TUI status-bar/help keymap consistency", () => {
  it.each(MODES)("status-bar keys are listed in the help overlay: %o", (context) => {
    const barKeys = statusHintKeyIds(context);
    const helpKeys = helpOverlayKeyIds();
    const missing = [...barKeys].filter((key) => !helpKeys.has(key));
    expect(missing).toEqual([]);
  });

  it.each(MODES)("status hint specs have no duplicate key ids: %o", (context) => {
    const ids = statusHintEntries(context).flatMap((entry) => entry.keyIds);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
