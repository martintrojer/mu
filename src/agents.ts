// mu — agent registry CRUD primitives + the five high-level verbs
// (spawn, send, read, list, close) that the CLI in step 7 will wrap.
//
// Layering inside this file:
//
//   - Types & raw-row mapping (RawAgentRow / rowFromDb)
//   - CRUD primitives        (insertAgent, getAgent, listAgents,
//                              updateAgentStatus, deleteAgent)
//   - Verbs                  (spawnAgent, sendToAgent, readAgent,
//                              closeAgent, listLiveAgents)
//
// The verbs compose the CRUD primitives with src/tmux.ts and
// src/reconcile.ts. They are deliberately thin — each one is essentially
// "look up the agent, do the tmux thing, update the registry."

import type { Db } from "./db.js";
import type { AgentStatus } from "./detect.js";
import { emitEvent } from "./logs.js";
import { type ReconcileReport, reconcile } from "./reconcile.js";
import { addNote } from "./tasks.js";
import {
  type CaptureOptions,
  type SendOptions,
  type TmuxPane,
  capturePane,
  killPane,
  listWindows,
  newSessionWithPane,
  newWindow,
  paneExists,
  sendToPane,
  sessionExists,
  setPaneTitle,
  sleep,
  splitWindow,
} from "./tmux.js";
import type { VcsBackendName } from "./vcs.js";
import { createWorkspace, freeWorkspace, getWorkspaceForAgent } from "./workspace.js";
import { ensureWorkstream } from "./workstream.js";

export type { AgentStatus };

export interface AgentRow {
  name: string;
  workstream: string;
  cli: string;
  paneId: string;
  status: AgentStatus;
  role: string;
  /** Window name; null when the agent has its own window named after itself. */
  tab: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

export interface InsertAgentInput {
  name: string;
  workstream: string;
  paneId: string;
  status: AgentStatus;
  /** Defaults to "pi" via schema DEFAULT. */
  cli?: string;
  /** Defaults to "full-access" via schema DEFAULT. */
  role?: string;
  tab?: string | null;
}

interface RawAgentRow {
  name: string;
  workstream: string;
  cli: string;
  pane_id: string;
  status: string;
  role: string;
  tab: string | null;
  created_at: string;
  updated_at: string;
}

function rowFromDb(row: RawAgentRow): AgentRow {
  return {
    name: row.name,
    workstream: row.workstream,
    cli: row.cli,
    paneId: row.pane_id,
    status: row.status as AgentStatus,
    role: row.role,
    tab: row.tab,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertAgent(db: Db, input: InsertAgentInput): AgentRow {
  // Auto-create the workstreams row if missing so the FK on agents.workstream
  // is always satisfied. Preserves the ergonomics where you could spawn
  // without explicit `mu init`.
  ensureWorkstream(db, input.workstream);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (name, workstream, cli, pane_id, status, role, tab, created_at, updated_at)
     VALUES (@name, @workstream, COALESCE(@cli, 'pi'), @paneId, @status,
             COALESCE(@role, 'full-access'), @tab, @now, @now)`,
  ).run({
    name: input.name,
    workstream: input.workstream,
    cli: input.cli ?? null,
    paneId: input.paneId,
    status: input.status,
    role: input.role ?? null,
    tab: input.tab ?? null,
    now,
  });
  const row = getAgent(db, input.name);
  if (!row) throw new Error(`agents.insertAgent: row not found after insert: ${input.name}`);
  return row;
}

/**
 * Look up an agent by its tmux pane id (e.g. `%4`). Returns undefined if
 * no agent currently owns that pane. Used by `mu whoami` and friends to
 * answer "which agent am I?" from `$TMUX_PANE` without the LLM having to
 * remember its own name.
 *
 * Note: `pane_id` is not declared UNIQUE in the schema (a managed agent
 * could in theory be re-spawned into the same recycled pane id) but in
 * practice tmux pane ids are unique within a server's lifetime, and
 * reconcile prunes ghosts. We return the first match.
 */
export function getAgentByPane(db: Db, paneId: string): AgentRow | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE pane_id = ? LIMIT 1").get(paneId) as
    | RawAgentRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function getAgent(db: Db, name: string): AgentRow | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as
    | RawAgentRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function listAgents(db: Db, opts: { workstream?: string } = {}): AgentRow[] {
  const rows =
    opts.workstream === undefined
      ? (db.prepare("SELECT * FROM agents ORDER BY workstream, name").all() as RawAgentRow[])
      : (db
          .prepare("SELECT * FROM agents WHERE workstream = ? ORDER BY name")
          .all(opts.workstream) as RawAgentRow[]);
  return rows.map(rowFromDb);
}

/**
 * Update an agent's status. Returns true if a row was matched.
 * Also bumps updated_at.
 */
export function updateAgentStatus(db: Db, name: string, status: AgentStatus): boolean {
  const result = db
    .prepare("UPDATE agents SET status = ?, updated_at = ? WHERE name = ?")
    .run(status, new Date().toISOString(), name);
  return result.changes > 0;
}

/**
 * Delete an agent row. Returns true if a row was matched. Idempotent;
 * deleting an agent that doesn't exist returns false without throwing.
 *
 * Reaper side-effect: any task that was IN_PROGRESS owned by this
 * agent gets flipped back to OPEN with a `[reaper]` task_note and a
 * `task reap` event in `agent_logs`. The FK on `tasks.owner` is
 * `ON DELETE SET NULL` so the owner column resets automatically; the
 * extra step here is the status revert. Without this an agent that
 * crashed (or was explicitly closed mid-task) leaves the task graph
 * in a wrong state — IN_PROGRESS forever, with no owner to release.
 */
export function deleteAgent(db: Db, name: string): boolean {
  // Snapshot the stuck tasks BEFORE the DELETE; the FK CASCADE
  // (SET NULL on owner) makes the post-delete query indistinguishable
  // from "never owned by this agent."
  const stuck = db
    .prepare(
      "SELECT local_id AS id, workstream FROM tasks WHERE owner = ? AND status = 'IN_PROGRESS'",
    )
    .all(name) as Array<{ id: string; workstream: string }>;

  const result = db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  if (result.changes === 0) return false;

  for (const t of stuck) {
    db.prepare("UPDATE tasks SET status = 'OPEN', updated_at = ? WHERE local_id = ?").run(
      new Date().toISOString(),
      t.id,
    );
    addNote(
      db,
      t.id,
      `[reaper] previous owner ${name} gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared`,
      { author: "reaper" },
    );
    emitEvent(
      db,
      t.workstream,
      `task reap ${t.id} (previous owner ${name} gone, IN_PROGRESS → OPEN)`,
    );
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// High-level verbs (spawn, send, read, list, close)
// ────────────────────────────────────────────────────────────────────────

/** Allowed agent name shape: lowercase alpha first, then alnum/underscore/
 *  hyphen. Mirrors VOCABULARY.md §"Naming conventions". */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

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

export class AgentExistsError extends Error {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    super(`agent already exists: ${agentName}`);
  }
}

export class AgentNotFoundError extends Error {
  override readonly name = "AgentNotFoundError";
  constructor(public readonly agentName: string) {
    super(`no such agent: ${agentName}`);
  }
}

/**
 * Thrown when an entity-targeted verb is invoked with `-w/--workstream
 * <name>` but the named agent lives in a different workstream.
 * Mirrors `TaskNotInWorkstreamError`. Maps to exit code 4 (conflict /
 * wrong scope). Distinguishes "the user typo'd the workstream" from
 * "the agent doesn't exist anywhere" (which surfaces as
 * `AgentNotFoundError`).
 */
export class AgentNotInWorkstreamError extends Error {
  override readonly name = "AgentNotInWorkstreamError";
  constructor(
    public readonly agentName: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`agent ${agentName} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
}

/**
 * Thrown when an agent's pane is created and titled successfully but the
 * spawned process exits within the liveness window (default 1500ms;
 * configurable via `MU_SPAWN_LIVENESS_MS`). The most common cause is the
 * underlying CLI failing fast: a wrapper CLI blocking on a single-instance
 * lock, `claude` rejecting an invalid API key, etc. The agent's last
 * scrollback (when capturable) is attached to help diagnose.
 */
export class AgentDiedOnSpawnError extends Error {
  override readonly name = "AgentDiedOnSpawnError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    public readonly scrollback: string | undefined,
  ) {
    const tail = scrollback?.trim();
    const detail = tail ? `\n\n--- pane scrollback ---\n${tail}\n--- end scrollback ---` : "";
    super(
      `agent ${agentName} died within ${defaultSpawnLivenessMs()}ms of spawn (pane ${paneId}). Most common cause: the spawned CLI exited immediately (e.g. a wrapper CLI blocking on its instance lock; set MU_<UPPER_CLI>_COMMAND to a non-blocking variant to bypass).${detail}`,
    );
  }
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

  const paneId = await createOrReusePane({
    session,
    windowName,
    command,
    cwd: workspacePathStr ?? opts.cwd,
  });

  let agent: AgentRow;
  try {
    await setPaneTitle(paneId, opts.name);
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
}): Promise<string> {
  if (!(await sessionExists(opts.session))) {
    return newSessionWithPane(opts.session, {
      windowName: opts.windowName,
      command: opts.command,
      cwd: opts.cwd,
    });
  }

  const windows = await listWindows(opts.session);
  const matching = windows.find((w) => w.name === opts.windowName);

  if (matching) {
    return splitWindow({
      target: `${opts.session}:${opts.windowName}`,
      command: opts.command,
      cwd: opts.cwd,
    });
  }

  return newWindow({
    session: opts.session,
    name: opts.windowName,
    command: opts.command,
    cwd: opts.cwd,
  });
}

/**
 * Send a single line of text to an agent's pane and submit it. Uses the
 * canonical bracketed-paste protocol from src/tmux.ts.
 */
export async function sendToAgent(
  db: Db,
  name: string,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  const agent = getAgent(db, name);
  if (!agent) throw new AgentNotFoundError(name);
  await sendToPane(agent.paneId, text, opts);
}

/**
 * Read scrollback from an agent's pane. With no options, returns the full
 * scrollback (`-S - -E -`); with `lines: N`, returns only the last N lines.
 */
export async function readAgent(db: Db, name: string, opts: CaptureOptions = {}): Promise<string> {
  const agent = getAgent(db, name);
  if (!agent) throw new AgentNotFoundError(name);
  return capturePane(agent.paneId, opts);
}

// ─── freeAgent (verb) ─────────────────────────────────────────────────────

export interface FreeAgentResult {
  /** Status before the call. */
  previousStatus: AgentStatus;
  /** Status after the call (always 'free' on success). */
  status: AgentStatus;
  /** True iff the row actually changed. False on idempotent no-op. */
  changed: boolean;
}

/**
 * Mark an agent's status as `free` — the explicit "I'm done with you
 * for now; you're available" signal. The agent's pane and DB row are
 * untouched; reconcile treats `free` as sticky (only flips back to busy
 * on real activity, never on an idle prompt) so this verb composes
 * cleanly with the existing scrollback detector.
 *
 * Idempotent: setting an already-free agent to free is a no-op (returns
 * `changed: false`). Throws AgentNotFoundError on missing.
 */
export function freeAgent(db: Db, name: string): FreeAgentResult {
  const before = getAgent(db, name);
  if (!before) throw new AgentNotFoundError(name);
  if (before.status === "free") {
    return { previousStatus: before.status, status: "free", changed: false };
  }
  updateAgentStatus(db, name, "free");
  emitEvent(db, before.workstream, `agent free ${name} (was ${before.status})`);
  return { previousStatus: before.status, status: "free", changed: true };
}

export interface CloseAgentOptions {
  /** If the agent has a workspace, also tear it down on disk. Default
   *  true: workspaces are created with the agent (via spawn --workspace)
   *  so they should die with it; the FK CASCADE would orphan the dir
   *  otherwise. Pass `keepWorkspace: true` to preserve the working copy. */
  keepWorkspace?: boolean;
  /** When freeing the workspace, attempt to auto-commit pending changes
   *  first. Same semantics as `mu workspace free --commit`. Ignored
   *  when `keepWorkspace: true`. */
  commitWorkspace?: boolean;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** True iff a workspace existed and was freed (dir + row). */
  freedWorkspace: boolean;
  /** Commit captured by the workspace free, when commitWorkspace was true. */
  workspaceCommittedRef?: string;
}

/**
 * Close an agent: kill its tmux pane and remove its DB row. Idempotent:
 *   - if the agent doesn't exist in the DB, returns a no-op result
 *   - if the tmux pane is already gone, killPane swallows the error
 *
 * Workspace handling: if the agent has a workspace AND `keepWorkspace`
 * isn't set, free it BEFORE deleting the agent (the FK CASCADE on
 * agent delete would otherwise leave the on-disk dir orphaned). With
 * `keepWorkspace: true`, the row still cascades but the dir survives.
 */
export async function closeAgent(
  db: Db,
  name: string,
  opts: CloseAgentOptions = {},
): Promise<CloseAgentResult> {
  const agent = getAgent(db, name);
  if (!agent) {
    return { killedPane: false, deletedRow: false, freedWorkspace: false };
  }
  let freedWorkspace = false;
  let workspaceCommittedRef: string | undefined;
  if (!opts.keepWorkspace) {
    const ws = getWorkspaceForAgent(db, name);
    if (ws) {
      const r = await freeWorkspace(db, name, { commit: opts.commitWorkspace ?? false });
      freedWorkspace = r.removed || r.rowDeleted;
      if (r.committedRef !== undefined) workspaceCommittedRef = r.committedRef;
    }
  }
  await killPane(agent.paneId).catch(() => {
    /* idempotent — pane may already be gone */
  });
  const deletedRow = deleteAgent(db, name);
  emitEvent(db, agent.workstream, `agent close ${name} (pane=${agent.paneId})`);
  const result: CloseAgentResult = {
    killedPane: true,
    deletedRow,
    freedWorkspace,
  };
  if (workspaceCommittedRef !== undefined) result.workspaceCommittedRef = workspaceCommittedRef;
  return result;
}

export interface ListLiveAgentsOptions {
  workstream: string;
  tmuxSession?: string;
}

export interface LiveAgentsView {
  /** All registered agents in the workstream, post-reconcile. */
  agents: AgentRow[];
  /** Panes in the tmux session that look like agents but aren't registered. */
  orphans: TmuxPane[];
  /** Diagnostic numbers from the reconcile pass; useful for `mu doctor`. */
  report: ReconcileReport;
}

/**
 * Return the live, reality-reconciled view of agents in a workstream.
 * `mu list` calls this. Step 7 will pretty-print with cli-table3.
 */
export async function listLiveAgents(db: Db, opts: ListLiveAgentsOptions): Promise<LiveAgentsView> {
  const report = await reconcile(db, {
    workstream: opts.workstream,
    ...(opts.tmuxSession !== undefined ? { tmuxSession: opts.tmuxSession } : {}),
  });
  const agents = listAgents(db, { workstream: opts.workstream });
  return { agents, orphans: report.orphans, report };
}
