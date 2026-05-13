import { describe, expect, it } from "vitest";
import {
  HELP_PANES,
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

  it("keeps `t tuicr` in the help overlay but NOT in the global popup-drill hint cluster", () => {
    // `t` only does something in git-show drills (Commits popup +
    // Workspaces popup commits drill). Each consumer inserts the
    // `· t tuicr` text into its own drill's bottom-border hint via
    // the per-drill `hint` prop. Putting it in the GLOBAL status-bar
    // cluster would falsely advertise it in TaskDetailDrill / agent
    // scrollback / etc where pressing `t` is a no-op. Help overlay is
    // the global reference and SHOULD list it.
    const drillHints = statusHintEntries({ mode: "popup-drill" });
    expect(drillHints).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "t", label: "tuicr" })]),
    );
    const drillPane = HELP_PANES.find((pane) => pane.title === "keys · popup drill");
    expect(drillPane?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: "t", effect: expect.stringContaining("tuicr") }),
      ]),
    );
  });
});
