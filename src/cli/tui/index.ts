// Public entrypoint for the interactive TUI. Lazy-imported by
// src/cli/state.ts cmdState so the ink/react dependency tree only
// loads when the user actually enters the TUI (not on `mu task list`,
// `mu state --json`, `mu agent show`, etc.).

import { render } from "ink";
import { createElement } from "react";
import type { Db } from "../../db.js";
import { App } from "./app.js";

export interface RunTuiOptions {
  workstream: string;
}

// Alt-screen escape sequences (lazygit/htop/btop convention).
// `\x1b[?1049h` swaps to the alternate screen buffer; `\x1b[?1049l`
// restores the prior buffer (and therefore the user's shell scrollback)
// on exit. Without these, ink renders inline at the cursor position
// and the dashboard is not flush with the top of the pane.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

export async function runTui(db: Db, opts: RunTuiOptions): Promise<void> {
  process.stdout.write(ALT_SCREEN_ENTER);
  try {
    const { waitUntilExit } = render(createElement(App, { db, workstream: opts.workstream }), {
      exitOnCtrlC: true,
    });
    await waitUntilExit();
  } finally {
    process.stdout.write(ALT_SCREEN_EXIT);
  }
}
