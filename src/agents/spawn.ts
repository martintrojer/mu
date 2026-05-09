// mu — spawnAgent + supporting helpers (resolveCliCommand,
// awaitSpawnLiveness, createOrReusePane, defaultSpawnLivenessMs,
// prestageWorkspace, finalizeAgentRow, rollbackSpawn).
//
// spawnAgent's flow is documented inline. The interesting bit is the
// `--workspace` cycle (workspace row FKs agent.name; agent row needs
// pane_id which needs workspace path as cwd) — see prestageWorkspace.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import {
  type AgentRow,
  deleteAgent,
  getAgent,
  insertAgent,
  isValidAgentName,
  pendingPaneIdFor,
  refreshAgentTitle,
} from "../agents.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import {
  capturePane,
  enableMuPaneBordersForPane,
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
 * Phases:
 *   1. Validate name + uniqueness.
 *   2. If --workspace: prestageWorkspace() (placeholder agent row +
 *      workspace dir + workspace row).
 *   3. createOrReusePane() in the workspace path (or opts.cwd).
 *   4. setPaneTitle + enableMuPaneBordersForPane.
 *   5. finalizeAgentRow() — patch placeholder pane_id to real (workspace
 *      path), or insert a fresh agent row (no-workspace path).
 *   6. awaitSpawnLiveness().
 *
 * Failure between any of (3)–(6) calls rollbackSpawn() to undo the
 * pane + row + workspace. The caller-visible error is preserved.
 */
export async function spawnAgent(db: Db, opts: SpawnAgentOptions): Promise<AgentRow> {
  if (!isValidAgentName(opts.name)) {
    throw new TypeError(
      `invalid agent name: ${JSON.stringify(opts.name)} (expected /^[a-z][a-z0-9_-]{0,31}$/)`,
    );
  }
  // Per-workstream uniqueness check: v5 allows the same agent name in
  // different workstreams. Scope the existence check to the spawn's
  // workstream so two operators spawning 'worker-1' in wsA and wsB
  // both succeed (bug_v5_name_clash_silent_misroute).
  if (getAgent(db, opts.name, opts.workstream) !== undefined) {
    throw new AgentExistsError(opts.name);
  }

  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const windowName = opts.tab ?? opts.name;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? resolveCliCommand(cli);

  // Workspace pre-stage. See `prestageWorkspace` for the FK-ordering
  // rationale. Returns the workspace path (used as the pane's cwd) or
  // undefined when --workspace wasn't requested.
  const workspacePathStr = opts.workspace ? await prestageWorkspace(db, opts, cli) : undefined;

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

  const hasWorkspace = workspacePathStr !== undefined;

  let agent: AgentRow;
  try {
    await setPaneTitle(paneId, opts.name);
    // Apply the mu pane border to the new window. Window-scoped option;
    // see enableMuPaneBorders docstring for why this is required per
    // window (and not just per session). Self-checks MU_BANNER_QUIET
    // and is best-effort — the border is decorative.
    await enableMuPaneBordersForPane(paneId);
    agent = finalizeAgentRow(db, { opts, cli, paneId, hasWorkspace });
  } catch (err) {
    await rollbackSpawn(db, opts.name, paneId, hasWorkspace, opts.workstream);
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
    await rollbackSpawn(db, opts.name, paneId, hasWorkspace, opts.workstream);
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
  await refreshAgentTitle(db, opts.name, opts.workstream);
  return agent;
}

/**
 * Stage 1 of `--workspace` spawn: insert the agent row with a placeholder
 * pane id, then create the VCS workspace (whose row FKs the agent name).
 *
 * Why placeholder-first? `vcs_workspaces.agent` FK + ON DELETE CASCADE
 * means the workspace row needs an agents row to exist before we insert
 * it; but we can't insert agents without a pane_id (NOT NULL), and we
 * can't create the pane until we know the workspace's on-disk path
 * (used as cwd). The placeholder unblocks the cycle.
 *
 * The placeholder is a publicly-visible quirk — see `PENDING_PANE_PREFIX`
 * and the consumers it documents (refreshAgentTitle, the
 * mode: "status-only"/"report-only" rationale in `listLiveAgents`).
 * The deeper fix (eliminate the placeholder
 * by reordering ws-dir → pane → atomic dual-insert) is filed as a
 * separate refactor; this shape is the established equilibrium.
 *
 * Throws after best-effort rollback (deleteAgent) if workspace creation
 * fails. Returns the workspace's on-disk path.
 */
async function prestageWorkspace(db: Db, opts: SpawnAgentOptions, cli: string): Promise<string> {
  insertAgent(db, {
    name: opts.name,
    workstream: opts.workstream,
    cli,
    paneId: pendingPaneIdFor(opts.name),
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
    return ws.path;
  } catch (err) {
    deleteAgent(db, opts.name, opts.workstream);
    throw err;
  }
}

/**
 * Stage 2 of spawn (after the real pane exists): either patch the
 * placeholder row to the real pane id (workspace path), or insert a
 * fresh agent row (no-workspace path). Throws if the patch UPDATE
 * silently affects no row (the placeholder row vanished mid-spawn —
 * historically the bug_agent_spawn_workspace_fk_failure class, now
 * patched via mode: "status-only"/"report-only" on read verbs).
 */
function finalizeAgentRow(
  db: Db,
  args: { opts: SpawnAgentOptions; cli: string; paneId: string; hasWorkspace: boolean },
): AgentRow {
  const { opts, cli, paneId, hasWorkspace } = args;
  if (!hasWorkspace) {
    return insertAgent(db, {
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId,
      status: "spawning",
      role: opts.role,
      tab: opts.tab ?? null,
    });
  }
  // Scope the patch to the spawn's workstream so a same-named worker
  // in another workstream isn't repointed at this pane
  // (bug_v5_name_clash_silent_misroute).
  db.prepare(
    `UPDATE agents SET pane_id = ?, updated_at = ?
      WHERE name = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
  ).run(paneId, new Date().toISOString(), opts.name, opts.workstream);
  const row = getAgent(db, opts.name, opts.workstream);
  if (!row) throw new Error(`spawnAgent: agent vanished after workspace stage: ${opts.name}`);
  return row;
}

/**
 * Roll back a failed spawn. Idempotent and best-effort: every step
 * swallows its own errors so a partial-cleanup substrate (already-killed
 * pane, no agent row) never masks the original failure.
 */
async function rollbackSpawn(
  db: Db,
  name: string,
  paneId: string,
  hasWorkspace: boolean,
  workstream: string,
): Promise<void> {
  await killPane(paneId).catch(() => {});
  if (hasWorkspace) {
    // Scope cleanup to the spawn's workstream so a same-named worker
    // elsewhere isn't torn down by accident
    // (bug_v5_name_clash_silent_misroute).
    await freeWorkspace(db, name, { workstream }).catch(() => {});
  }
  deleteAgent(db, name, workstream);
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
