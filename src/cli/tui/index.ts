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
  workstream: string;
}

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
