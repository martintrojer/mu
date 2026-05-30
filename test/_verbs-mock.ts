// Shared mock-tmux harness for verbs-* test files. Split out of
// test/verbs.test.ts under testreview_test_files_past_800loc to keep
// each split file focused on its verb without reproducing 180 LOC of
// scaffolding. The freshMockState() factory + mockTmux() executor pair
// model just enough of tmux's send/list/capture surface to drive the
// agent verbs through their happy + edge paths without a real tmux
// server (see test/tmux.integration.test.ts for the real-tmux suite).

import type { TmuxExecResult, TmuxExecutor } from "../src/tmux.js";

// ─── Mock tmux harness ─────────────────────────────────────────────────

export interface FakePane {
  windowId: string;
  paneId: string;
  title: string;
  command: string;
  scrollback?: string;
}

export interface MockState {
  /** Sessions that exist. */
  sessions: Set<string>;
  /** windows[session] -> [{id, name}] */
  windows: Map<string, { id: string; name: string }[]>;
  /** All panes by paneId. */
  panes: Map<string, FakePane>;
  /** Auto-incrementing ids. */
  nextWindowId: number;
  nextPaneId: number;
}

export function freshMockState(): MockState {
  return {
    sessions: new Set(),
    windows: new Map(),
    panes: new Map(),
    nextWindowId: 1,
    nextPaneId: 1,
  };
}

export function mockTmux(state: MockState): { calls: string[][]; executor: TmuxExecutor } {
  const calls: string[][] = [];

  const executor: TmuxExecutor = async (args) => {
    calls.push([...args]);
    const verb = args[0];

    if (verb === "has-session") {
      const target = args[2];
      return state.sessions.has(target ?? "") ? ok() : fail(`can't find session: ${target}`);
    }

    if (verb === "new-session") {
      const sessionFlag = args.indexOf("-s");
      const sessionName = sessionFlag >= 0 ? args[sessionFlag + 1] : undefined;
      const nameFlag = args.indexOf("-n");
      const windowName = nameFlag >= 0 ? args[nameFlag + 1] : "main";
      if (!sessionName) return fail("session name required");
      if (state.sessions.has(sessionName)) return fail("duplicate session");
      state.sessions.add(sessionName);
      const windowId = `@${state.nextWindowId++}`;
      const paneId = `%${state.nextPaneId++}`;
      state.windows.set(sessionName, [{ id: windowId, name: windowName ?? "main" }]);
      state.panes.set(paneId, {
        windowId,
        paneId,
        title: "",
        command: args[args.length - 1] ?? "bash",
      });
      // -P -F captures pane id
      if (args.includes("-P")) return ok(`${paneId}\n`);
      return ok();
    }

    if (verb === "list-windows") {
      const targetFlag = args.indexOf("-t");
      const target = targetFlag >= 0 ? args[targetFlag + 1] : undefined;
      const wins = state.windows.get(target ?? "") ?? [];
      return ok(wins.map((w) => `${w.id}\t${w.name}`).join("\n") + (wins.length ? "\n" : ""));
    }

    if (verb === "new-window") {
      const tFlag = args.indexOf("-t");
      const sessionName = tFlag >= 0 ? args[tFlag + 1] : "";
      const nFlag = args.indexOf("-n");
      const windowName = nFlag >= 0 ? args[nFlag + 1] : "window";
      if (!sessionName || !state.sessions.has(sessionName)) {
        return fail(`can't find session: ${sessionName}`);
      }
      const windowId = `@${state.nextWindowId++}`;
      const paneId = `%${state.nextPaneId++}`;
      state.windows.get(sessionName)?.push({ id: windowId, name: windowName ?? "window" });
      state.panes.set(paneId, {
        windowId,
        paneId,
        title: "",
        command: args[args.length - 1] ?? "bash",
      });
      return ok(`${paneId}\n`);
    }

    if (verb === "split-window") {
      // Find which session/window we're targeting via -t <session>:<window>.
      const tFlag = args.indexOf("-t");
      const target = tFlag >= 0 ? args[tFlag + 1] : "";
      if (!target?.includes(":")) return fail(`bad split target: ${target}`);
      const [session, windowName] = target.split(":");
      const win = state.windows.get(session ?? "")?.find((w) => w.name === windowName);
      if (!win) return fail(`can't find window: ${target}`);
      const paneId = `%${state.nextPaneId++}`;
      state.panes.set(paneId, {
        windowId: win.id,
        paneId,
        title: "",
        command: args[args.length - 1] ?? "bash",
      });
      return ok(`${paneId}\n`);
    }

    if (verb === "select-pane") {
      const tFlag = args.indexOf("-t");
      const TFlag = args.indexOf("-T");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : undefined;
      const title = TFlag >= 0 ? args[TFlag + 1] : undefined;
      if (!paneId || title === undefined) return fail("bad select-pane");
      const pane = state.panes.get(paneId);
      if (!pane) return fail(`can't find pane: ${paneId}`);
      pane.title = title;
      return ok();
    }

    if (verb === "kill-pane") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : undefined;
      if (!paneId) return fail("bad kill-pane");
      if (!state.panes.has(paneId)) return fail(`can't find pane: ${paneId}`);
      state.panes.delete(paneId);
      return ok();
    }

    if (verb === "list-panes" && args[1] === "-s") {
      const tFlag = args.indexOf("-t");
      const session = tFlag >= 0 ? args[tFlag + 1] : "";
      const sessionWindowIds = new Set(state.windows.get(session ?? "")?.map((w) => w.id) ?? []);
      const lines: string[] = [];
      for (const pane of state.panes.values()) {
        if (sessionWindowIds.has(pane.windowId)) {
          lines.push(`${pane.windowId}\t${pane.paneId}\t${pane.title}\t${pane.command}`);
        }
      }
      return ok(lines.join("\n"));
    }

    if (verb === "capture-pane") {
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const pane = state.panes.get(paneId ?? "");
      if (!pane) return fail(`can't find pane: ${paneId}`);
      return ok(pane.scrollback ?? "");
    }

    if (verb === "display-message") {
      // Used by paneExists() during the spawn liveness check.
      // `display-message -t <pane> -p '#{pane_id}'` echoes back the pane id
      // iff the pane exists; otherwise tmux exits non-zero.
      const tFlag = args.indexOf("-t");
      const paneId = tFlag >= 0 ? args[tFlag + 1] : "";
      const pane = state.panes.get(paneId ?? "");
      if (!pane) return fail(`can't find pane: ${paneId}`);
      return ok(`${paneId}\n`);
    }

    if (verb === "copy-mode") return ok();
    if (verb === "set-buffer") return ok();
    if (verb === "paste-buffer") return ok();
    if (verb === "send-keys") return ok();

    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };

  return { calls, executor };
}

export const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
export const fail = (stderr: string, exitCode = 1): TmuxExecResult => ({
  stdout: "",
  stderr,
  exitCode,
});

// Mutate $MU_PI_COMMAND for the duration of `fn` and restore it after.
// `delete process.env[<runtime key>]` is the project-wide pattern (see
// test/tmux.test.ts) — Biome flags the literal-key forms but accepts the
// computed form via a const variable, and assigning `undefined` would
// silently coerce to the string "undefined".
export async function withMuPiCommand(value: string | undefined, fn: () => unknown): Promise<void> {
  const key = "MU_PI_COMMAND";
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

export async function withMuSpawnLivenessMs(
  value: string | undefined,
  fn: () => unknown,
): Promise<void> {
  const key = "MU_SPAWN_LIVENESS_MS";
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

export async function withMuSpawnReadinessMs(
  value: string | undefined,
  fn: () => unknown,
): Promise<void> {
  const key = "MU_SPAWN_READINESS_MS";
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}
