// mu — spawnAgent + supporting helpers (resolveCliCommand,
// awaitSpawnLiveness, createOrReusePane, defaultSpawnLivenessMs).
//
// spawnAgent is the from-control / attach-runtime split:
//
//   1. Validate the name and that it's not already taken.
//   2. Ensure the workstream's tmux session exists (creating it WITH
//      the agent's first window in one shot if not, so a failed spawn
//      never leaves an empty mu-<workstream> session behind).
//   3. Decide whether the agent's window should be a fresh window or a
//      split of an existing one (multiple agents sharing a `tab`).
//   4. Set the pane title to the agent name (the claim protocol identity).
//   5. Insert the DB row with status="spawning".
//
// On any failure between (3) and (5), kill the freshly created pane to
// avoid leaking. The caller-visible error is preserved.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import {
  type AgentRow,
  deleteAgent,
  getAgent,
  insertAgent,
  isValidAgentName,
  refreshAgentTitle,
} from "../agents.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import {
  capturePane,
  enableMuPaneBorders,
  getWindowIdForPane,
  killPane,
  listWindows,
  newSessionWithPane,
  newWindow,
  paneExists,
  sessionExists,
  setPaneTitle,
  sleep,
  splitWindow,
} from "../tmux.js";
import type { VcsBackendName } from "../vcs.js";
import { createWorkspace, freeWorkspace } from "../workspace.js";
import { AgentDiedOnSpawnError, AgentExistsError } from "./errors.js";

/**
 * Resolve the actual executable to launch in an agent's pane for a given
 * `cli`. Honours the env var `MU_<UPPER_CLI>_COMMAND` (e.g. `MU_PI_COMMAND=
 * pi-alt` makes `--cli pi` actually exec `pi-alt`). Falls back to the cli
 * name itself, which is what users expect when their `pi` binary is on
 * `$PATH` under that exact name.
 *
 * Used by `spawnAgent` to pick the spawned command, and by reconcile's
 * orphan detector so externally-spawned panes running the resolved binary
 * are still recognised as agents.
 */
export function resolveCliCommand(cli: string): string {
  const envName = `MU_${cli.toUpperCase()}_COMMAND`;
  const override = process.env[envName];
  return override && override.trim() !== "" ? override : cli;
}

export interface SpawnAgentOptions {
  name: string;
  workstream: string;
  /** Defaults to "pi". 0.1.0 only really supports "pi" but the column
   *  accepts any string for forward-compat with future multi-CLI support
   *  (claude/codex). */
  cli?: string;
  /** The actual command to run in the pane. Defaults to the cli value. */
  command?: string;
  /** Window name to group this agent under. Defaults to the agent's name
   *  (so each agent gets its own window). Multiple agents sharing a `tab`
   *  share a window with multiple panes. */
  tab?: string;
  /** "full-access" (default) or "read-only". The schema stores it; today
   *  the role isn't enforced (deferred to a future capabilities pass). */
  role?: string;
  /** Initial working directory for the spawned pane (`tmux -c <path>`).
   *  When `workspace: true` is passed, this is ignored — the workspace
   *  path is used instead. */
  cwd?: string;
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
  /** Auto-create a VCS workspace for this agent before spawning the
   *  pane and use the workspace path as cwd. Backend defaults to
   *  detection (jj > sl > git > none). */
  workspace?: boolean;
  /** Force a specific VCS backend (only meaningful with `workspace: true`). */
  workspaceBackend?: VcsBackendName;
  /** Optional ref to base the workspace on (only meaningful with
   *  `workspace: true`). Backend-specific. */
  workspaceFrom?: string;
  /** Project root the workspace branches from (only meaningful with
   *  `workspace: true`). Defaults to `process.cwd()`. */
  workspaceProjectRoot?: string;
}

/**
 * Spawn a new agent in its tmux pane and register it in the DB.
 *
 * Order of operations (the "from_control / attach_runtime" split):
 *
 *   1. Validate the name and that it's not already taken.
 *   2. Ensure the workstream's tmux session exists (creating it WITH the
 *      agent's first window in one shot if not, so a failed spawn never
 *      leaves an empty mu-<workstream> session behind).
 *   3. Decide whether the agent's window should be a fresh window or a
 *      split of an existing one (multiple agents sharing a `tab`).
 *   4. Set the pane title to the agent name (the claim protocol identity).
 *   5. Insert the DB row with status="spawning".
 *
 *   On any failure between (3) and (5), kill the freshly created pane to
 *   avoid leaking. The caller-visible error is preserved.
 */
export async function spawnAgent(db: Db, opts: SpawnAgentOptions): Promise<AgentRow> {
  if (!isValidAgentName(opts.name)) {
    throw new TypeError(
      `invalid agent name: ${JSON.stringify(opts.name)} (expected /^[a-z][a-z0-9_-]{0,31}$/)`,
    );
  }
  if (getAgent(db, opts.name) !== undefined) {
    throw new AgentExistsError(opts.name);
  }

  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const windowName = opts.tab ?? opts.name;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? resolveCliCommand(cli);

  // Workspace integration: when --workspace is set, allocate the
  // VCS workspace BEFORE the pane so we can use the workspace path
  // as cwd. The workspace row is keyed on agent name, so we need
  // to insert the agent FIRST — but we don't have a pane yet, and
  // FK ON DELETE CASCADE makes the row depend on agent existence.
  // Solution: stage the workspace creation in two phases:
  //   1. Insert agent (after pane exists, as today)
  //   2. Create workspace BEFORE that, with a deferred row insert
  // Actually simpler: just create the workspace dir first, then
  // insert the workspace row AFTER the agent row exists. Splitting
  // dir vs row creation isn't worth the complexity though, so we
  // create the agent first WITHOUT a pane, then the workspace row,
  // then create the pane with workspace path as cwd, then update
  // the agent's pane_id. Too many moving parts; instead simplify:
  // create the agent with a placeholder pane id ("%pending"), make
  // the workspace, create the real pane in the workspace dir, then
  // update the agent row to point at the real pane id.
  let workspacePathStr: string | undefined;
  if (opts.workspace) {
    // Insert agent with placeholder pane id so the workspace FK is
    // satisfied. We'll patch pane_id after the real pane exists.
    insertAgent(db, {
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId: `%pending-${opts.name}`,
      status: "spawning",
      role: opts.role,
      tab: opts.tab ?? null,
    });
    try {
      const wsOpts: Parameters<typeof createWorkspace>[1] = {
        agent: opts.name,
        workstream: opts.workstream,
      };
      if (opts.workspaceBackend !== undefined) wsOpts.backend = opts.workspaceBackend;
      if (opts.workspaceFrom !== undefined) wsOpts.parentRef = opts.workspaceFrom;
      if (opts.workspaceProjectRoot !== undefined) wsOpts.projectRoot = opts.workspaceProjectRoot;
      const ws = await createWorkspace(db, wsOpts);
      workspacePathStr = ws.path;
    } catch (err) {
      // Roll back the agent row we just inserted.
      deleteAgent(db, opts.name);
      throw err;
    }
  }

  // Inject identity env vars into the pane so anything running inside
  // (pi extensions, claim-protocol scripts, status segments) can branch
  // on 'I am a mu-managed worker' without scraping pane titles or DB
  // lookups. Set via tmux `-e KEY=VALUE` (per-pane; doesn't pollute the
  // tmux server's global env).
  //
  // These are NOT exposed via SpawnAgentOptions — mu identity is not
  // user-tunable. Adding more keys here means every spawned pane sees
  // them automatically.
  const paneEnv: Record<string, string> = {
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: opts.name,
    MU_WORKSTREAM: opts.workstream,
  };

  const paneId = await createOrReusePane({
    session,
    windowName,
    command,
    cwd: workspacePathStr ?? opts.cwd,
    env: paneEnv,
  });

  let agent: AgentRow;
  try {
    await setPaneTitle(paneId, opts.name);
    // Apply the mu pane border to the new window. Window-scoped option;
    // see enableMuPaneBorders docstring for why this is required per
    // window (and not just per session). Best-effort — older tmux or
    // tmux server hiccups are non-fatal; the border is decorative.
    if (process.env.MU_BANNER_QUIET !== "1") {
      const wid = await getWindowIdForPane(paneId).catch(() => undefined);
      if (wid) await enableMuPaneBorders(wid).catch(() => {});
    }
    if (workspacePathStr !== undefined) {
      // Agent row already exists from the workspace pre-stage; just
      // patch the pane id (and bump updated_at to reflect the change).
      db.prepare("UPDATE agents SET pane_id = ?, updated_at = ? WHERE name = ?").run(
        paneId,
        new Date().toISOString(),
        opts.name,
      );
      const row = getAgent(db, opts.name);
      if (!row) throw new Error(`spawnAgent: agent vanished after workspace stage: ${opts.name}`);
      agent = row;
    } else {
      agent = insertAgent(db, {
        name: opts.name,
        workstream: opts.workstream,
        cli,
        paneId,
        status: "spawning",
        role: opts.role,
        tab: opts.tab ?? null,
      });
    }
  } catch (err) {
    // Rollback: kill the pane, drop the agent row, and free the
    // workspace if we made one.
    await killPane(paneId).catch(() => {});
    if (workspacePathStr !== undefined) {
      await freeWorkspace(db, opts.name).catch(() => {});
    }
    deleteAgent(db, opts.name);
    throw err;
  }

  // Liveness check: wait briefly, then verify the pane is still alive.
  // Catches the silent-spawn-failure class of bugs where the CLI dies
  // immediately (lock conflict, bad credentials, etc.). On failure, roll
  // back the DB row and surface a typed error with whatever scrollback
  // tmux still has.
  try {
    await awaitSpawnLiveness(paneId, opts.name);
  } catch (err) {
    if (workspacePathStr !== undefined) {
      await freeWorkspace(db, opts.name).catch(() => {});
    }
    deleteAgent(db, opts.name);
    await killPane(paneId).catch(() => {});
    throw err;
  }
  emitEvent(
    db,
    opts.workstream,
    `agent spawn ${opts.name} (cli=${cli}, role=${opts.role ?? "full-access"}, pane=${paneId})`,
  );
  // Initial title push: the agent row is in 'spawning' state at this
  // point, which composeAgentTitle renders as bare name (no decoration
  // until the first detect cycle). Reconcile will re-push as soon as
  // the operator runs any status-reading verb.
  await refreshAgentTitle(db, opts.name);
  return agent;
}

/**
 * Default liveness window in milliseconds. 0 disables the check (useful
 * for fast tests that don't want to wait). Override via env var
 * `MU_SPAWN_LIVENESS_MS`.
 */
export function defaultSpawnLivenessMs(): number {
  const raw = process.env.MU_SPAWN_LIVENESS_MS;
  if (raw === undefined) return 1500;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 1500;
  return parsed;
}

async function awaitSpawnLiveness(paneId: string, agentName: string): Promise<void> {
  const ms = defaultSpawnLivenessMs();
  if (ms === 0) return;
  await sleep(ms);
  // Capture-pane first so we have something to attach to the error if the
  // pane is in the process of being torn down (the buffer survives a beat
  // longer than the pane's existence in some tmux builds).
  const scrollback = await capturePane(paneId, { lines: 50 }).catch(() => undefined);
  if (await paneExists(paneId)) return;
  throw new AgentDiedOnSpawnError(agentName, paneId, scrollback);
}

/**
 * Three cases, all returning a stable pane id:
 *   - session doesn't exist          → create session+window+pane in one shot
 *   - session exists, no such window → create a new window for this agent
 *   - session and window both exist  → split the window to add a pane
 */
async function createOrReusePane(opts: {
  session: string;
  windowName: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<string> {
  if (!(await sessionExists(opts.session))) {
    return newSessionWithPane(opts.session, {
      windowName: opts.windowName,
      command: opts.command,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  const windows = await listWindows(opts.session);
  const matching = windows.find((w) => w.name === opts.windowName);

  if (matching) {
    return splitWindow({
      target: `${opts.session}:${opts.windowName}`,
      command: opts.command,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  return newWindow({
    session: opts.session,
    name: opts.windowName,
    command: opts.command,
    cwd: opts.cwd,
    env: opts.env,
  });
}
