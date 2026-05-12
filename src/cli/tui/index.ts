// Public entrypoint for the interactive TUI. Lazy-imported by
// src/cli/state.ts cmdState so the ink/react dependency tree only
// loads when the user actually enters the TUI (not on `mu task list`,
// `mu state --json`, `mu agent show`, etc.).

import { render } from "ink";
import { createElement } from "react";
import type { Db } from "../../db.js";
import { App } from "./app.js";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

export interface RunTuiOptions {
  /** Resolved workstream set (≥1). Per feat_tui_multi_workstream
   *  (workstream `tui-impl`): N=1 renders the TUI exactly as the
   *  pre-multi-ws build did; N≥2 renders a tab strip above the
   *  cards and Tab/Shift-Tab switch the active tab. cmdState is
   *  responsible for the resolution + validation; runTui just
   *  forwards the array. */
  workstreams: string[];
  /** Initial active tab index. Bare `mu` and `mu state --tui` share
   *  the launch-focus ladder: $MU_SESSION, then tmux session name,
   *  then cwd inside a workspace, then cwd equal to a workspace's
   *  VCS-derived project root (latest activity breaks ties), then 0.
   *  <App> clamps defensively. */
  initialActive?: number;
}

export async function runTui(db: Db, opts: RunTuiOptions): Promise<void> {
  process.stdout.write(ALT_SCREEN_ENTER);
  try {
    const { waitUntilExit } = render(
      createElement(App, { db, workstreams: opts.workstreams, initialActive: opts.initialActive }),
      { exitOnCtrlC: true },
    );
    await waitUntilExit();
  } finally {
    process.stdout.write(ALT_SCREEN_EXIT);
  }
}
