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
import type { HasNextSteps, NextStep } from "./output.js";
import { type ReconcileReport, reconcile } from "./reconcile.js";
import { captureSnapshot } from "./snapshots.js";
import { addNote, listTasksByOwner } from "./tasks.js";
import {
  type CaptureOptions,
  PaneNotFoundError,
  type SendOptions,
  type TmuxPane,
  capturePane,
  enableMuPaneBorders,
  getWindowIdForPane,
  killPane,
  listPanesInSession,
  listWindows,
  newSessionWithPane,
  newWindow,
  paneExists,
  parseAgentNameFromTitle,
  sendToPane,
  sessionExists,
  setPaneTitle,
  sleep,
  splitWindow,
} from "./tmux.js";
import type { VcsBackendName } from "./vcs.js";
import { createWorkspace, freeWorkspace, getWorkspaceForAgent } from "./workspace.js";
// (freeWorkspace is used by the spawn rollback paths below, not by closeAgent.
// Closing an agent is intentionally a separate concern from freeing its workspace;
// see the closeAgent docstring.)
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

// ─── Pane title composition (mu's interpreted state on the border) ───
//
// The pane border (set by enableMuPaneBorders) renders
// `[mu] #{pane_title}` as tmux chrome. mu owns the pane title and uses
// it to carry interpreted state at a glance:
//
//   worker-a                            (no claim, status not
//                                        worth surfacing yet)
//   worker-a · ⚙️                         (busy, no claim)
//   worker-a · ⚙️ · build_x               (busy, owns one task)
//   worker-a · 💤 · build_x               (needs_input, owns one task)
//   worker-a · 🛂 · build_x               (needs_permission)
//   worker-a · ✅                         (free, no claim)
//   worker-a · ⚙️ · ⊕2 tasks             (multi-claim case)
//
// The agent name MUST remain the first ' · '-separated token so the
// claim protocol's pane-title-as-identity fallback (currentPaneTitle
// in src/tmux.ts) keeps working. Adopted panes that haven't been
// re-titled by mu just have the name (one token) — still parses.

/** Plain-text emoji map for the agent status. Mirrors statusIcon in
 *  cli.ts but without picocolors (tmux pane titles don't render ANSI
 *  colour). 'spawning' is omitted on purpose — the title gets the
 *  initial render before status detection runs, and 'spawning' is a
 *  transient state. */
// Single-codepoint, single-cell-width Nerd Font glyphs (nf-fa family).
// Picked over Unicode emoji so cli-table3's column widths line up:
// emoji like '⚙️' (gear + variation selector) are TWO codepoints,
// which cli-table3 counts as length-2 and uses to size columns; but
// terminals render them as ONE cell wide, so adjacent rows that mix
// 1-codepoint emoji ('✅') and 2-codepoint emoji ('⚙️') misalign.
// Nerd Font glyphs are private-use codepoints, all length-1 and all
// 1-cell-wide.
//
// Requires a Nerd Font on the operator's terminal (mu's substrate is
// pi, which assumes Nerd Fonts; the rest of mu's TUI uses Nerd Font
// glyphs already in cli-table3 box-drawing). Without one, every
// glyph below renders as a placeholder box — the columns still align
// (which was the bug we were fixing).
export const STATUS_EMOJI: Record<AgentStatus, string> = {
  spawning: "\uf251", // nf-fa-hourglass_start
  busy: "\uf013", // nf-fa-cog
  needs_input: "\uf186", // nf-fa-moon_o
  needs_permission: "\uf023", // nf-fa-lock
  free: "\uf058", // nf-fa-check_circle
  unreachable: "\uf059", // nf-fa-question_circle
  terminated: "\uf057", // nf-fa-times_circle
};

/** Maximum total length for a composed pane title. tmux truncates
 *  silently in some chrome positions; we truncate the task id
 *  ourselves so the suffix is predictable. */
const MAX_TITLE_LEN = 64;

/** Build the pane title for `agent` based on current DB state.
 *  Pure (no tmux side effect; no DB write). Read-only on the DB. */
export function composeAgentTitle(db: Db, agent: AgentRow): string {
  // 'spawning' is the initial state at row insert. Don't decorate —
  // surfaces as just the agent name until detection runs.
  const showStatus = agent.status !== "spawning";
  const tasks = listTasksByOwner(db, agent.name); // already filters CLOSED/REJECTED/DEFERRED
  let title = agent.name;
  if (showStatus) {
    title += ` · ${STATUS_EMOJI[agent.status]}`;
  }
  if (tasks.length === 1) {
    title += ` · ${tasks[0]?.localId}`;
  } else if (tasks.length > 1) {
    title += ` · ⊕${tasks.length} tasks`;
  }
  if (title.length > MAX_TITLE_LEN) {
    // Truncate from the END (preserves agent name + status prefix).
    title = `${title.slice(0, MAX_TITLE_LEN - 1)}…`;
  }
  return title;
}

/** Push a fresh pane title for `agentName`. Best-effort — a missing
 *  agent, a placeholder pane id, or a tmux failure are all swallowed
 *  silently (titles are decorative; never block the calling verb). */
export async function refreshAgentTitle(db: Db, agentName: string): Promise<void> {
  const agent = getAgent(db, agentName);
  if (!agent) return;
  if (agent.paneId.startsWith("%pending-")) return; // workspace pre-stage placeholder
  const title = composeAgentTitle(db, agent);
  await setPaneTitle(agent.paneId, title).catch(() => {});
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

export class AgentExistsError extends Error implements HasNextSteps {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    super(
      `agent already exists: ${agentName} (agent names are globally unique across workstreams)`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Find which workstream the existing agent is in",
        command: `mu sql "SELECT name, workstream FROM agents WHERE name='${this.agentName}'"`,
      },
      {
        intent: "Close the existing agent and re-spawn",
        command: `mu agent close ${this.agentName}  &&  mu agent spawn ${this.agentName} -w <workstream>`,
      },
      { intent: "Pick a different name", command: "mu agent spawn <new-name> -w <workstream>" },
    ];
  }
}

export class AgentNotFoundError extends Error implements HasNextSteps {
  override readonly name = "AgentNotFoundError";
  constructor(public readonly agentName: string) {
    super(`no such agent: ${agentName}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List agents in current workstream", command: "mu agent list" },
      { intent: "List agents across ALL workstreams", command: "mu agent list -w *" },
      {
        intent: "Spawn it now",
        command: `mu agent spawn ${this.agentName} -w <workstream>`,
      },
    ];
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
export class AgentNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "AgentNotInWorkstreamError";
  constructor(
    public readonly agentName: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`agent ${agentName} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the agent's actual workstream",
        command: `mu agent show ${this.agentName} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List agents in the requested workstream",
        command: `mu agent list -w ${this.expectedWorkstream}`,
      },
    ];
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
export class AgentDiedOnSpawnError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect the dead pane's scrollback for the underlying error",
        command: `mu agent read ${this.agentName} -n 100`,
      },
      {
        intent: "Override the spawn command to a non-blocking variant",
        command: 'export MU_PI_COMMAND="pi-alt --some-flag"   (or pass --command "..." to spawn)',
      },
      {
        intent: "Disable the liveness check (CI / known long-lived sh subprocess)",
        command: "export MU_SPAWN_LIVENESS_MS=0",
      },
      { intent: "Run health check", command: "mu doctor" },
    ];
  }
}

/**
 * Thrown when `closeAgent` is called on an agent that has an associated
 * workspace AND the caller didn't explicitly opt into discarding it.
 *
 * Background: the FK on `vcs_workspaces.agent` cascades on agent
 * delete, so a naive `closeAgent` drops the workspace registry row
 * but leaves the on-disk dir orphaned (mu can't see it via
 * `mu workspace list / free / path` afterwards). Surfaced during
 * the multi-agent dogfood teardown when three workspaces went
 * orphaned silently.
 *
 * The fix: refuse close if a workspace exists; force the caller to
 * decide. Two actionable resolutions:
 *   - `mu workspace free <agent>` first, then close cleanly.
 *   - `mu agent close <agent> --discard-workspace` to free the
 *     workspace AND close the agent in one shot (lossy: pending
 *     changes in the workspace are gone).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class WorkspacePreservedError extends Error implements HasNextSteps {
  override readonly name = "WorkspacePreservedError";
  constructor(
    public readonly agentName: string,
    public readonly workspacePath: string,
  ) {
    super(
      `agent ${agentName} has a workspace at ${workspacePath}; refusing to close (would orphan the on-disk dir)`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Free the workspace first (preserves agent for next step)",
        command: `mu workspace free ${this.agentName}  (--commit to commit pending changes first)`,
      },
      {
        intent: "Or close + discard the workspace in one shot (lossy)",
        command: `mu agent close ${this.agentName} --discard-workspace`,
      },
      {
        intent: "Or just inspect what's in the workspace",
        command: `cd ${this.workspacePath}`,
      },
    ];
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

// ─── Adopt: register an existing tmux pane as a managed agent ─────

export interface AdoptAgentOptions {
  /** tmux pane id (e.g. '%15'). Must already exist on the tmux server. */
  paneId: string;
  /** Workstream to adopt the pane into. The pane MUST be in the
   *  matching tmux session (`mu-<workstream>`); cross-session adopt is
   *  rejected. */
  workstream: string;
  /** Override the pane's title with this name. When omitted, the pane's
   *  current title becomes the agent name (zero-config adoption). */
  name?: string;
  /** Defaults to 'pi' via the schema DEFAULT. */
  cli?: string;
  /** 'full-access' (default) or 'read-only'. */
  role?: string;
  /** Override the tmux session lookup. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
}

export interface AdoptAgentResult {
  agent: AgentRow;
  /** True when the pane already had a matching agents row — the call
   *  was a no-op (idempotent). */
  alreadyAdopted: boolean;
  /** The pane title before adopt, or null if the pane had no title. */
  previousTitle: string | null;
  /** The title the pane was set to (== agent.name post-adopt). Equal to
   *  previousTitle when no retitle happened. */
  paneTitleSetTo: string;
}

/**
 * Register an existing tmux pane as a managed mu agent. Inverse of the
 * 'orphan' state surfaced by `mu agent list`: a pane that looks like an
 * agent (running pi/claude/codex) but has no DB row.
 *
 * Identity contract (matches the claim protocol invariant):
 *   - Post-adopt, the pane's title equals the agent's name.
 *   - When `name` is omitted, the pane's existing title becomes the
 *     agent name verbatim. Adopting a pane titled 'pi' would fail name
 *     validation — caller must supply --name in that case.
 *
 * Idempotent: adopting the same pane twice with the same name is a
 * no-op (returns alreadyAdopted=true). Adopting a different pane under
 * an existing agent name throws AgentExistsError.
 *
 * Validation order (matches the design in note #100):
 *   1. Pane id format     -> assertValidPaneId via paneExists / setPaneTitle
 *   2. Pane exists        -> PaneNotFoundError
 *   3. Pane is in session -> AgentNotInWorkstreamError (cross-session)
 *   4. Resolved name OK   -> isValidAgentName / Error('agent name invalid')
 *   5. Idempotent check   -> if pane already owned by an agent of this
 *                            name, return alreadyAdopted=true
 *   6. Name not taken     -> AgentExistsError (else)
 *   7. Insert + retitle.
 *
 * Status starts at 'free' — reconcile/detect will update it on the next
 * `mu agent list` based on actual pane content (the pi prompt yields
 * 'free'; an agent mid-thought yields 'busy'; etc.). We don't run
 * detection inline here because the caller may not have $TMUX, and
 * adoption shouldn't depend on a captured-pane probe succeeding.
 */
export async function adoptAgent(db: Db, opts: AdoptAgentOptions): Promise<AdoptAgentResult> {
  // Step 1+2: pane format + existence.
  if (!(await paneExists(opts.paneId))) {
    throw new PaneNotFoundError(opts.paneId);
  }

  // Step 3: pane must be in the workstream's tmux session.
  const expectedSession = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const panesInSession: TmuxPane[] = await listPanesInSession(expectedSession);
  const matchingPane = panesInSession.find((p) => p.paneId === opts.paneId);
  if (!matchingPane) {
    // Pane exists (passed step 2) but isn't in the expected session.
    // Synthesise the cross-session error using the same shape as the
    // existing AgentNotInWorkstreamError path so the CLI's exit-code
    // mapping handles it identically. We don't know the actual session
    // name without another tmux query; the message just says 'a
    // different session' — actionable enough.
    throw new AgentNotInWorkstreamError(
      `pane ${opts.paneId}`,
      opts.workstream,
      "a different tmux session",
    );
  }

  // Step 4: resolved name. Default to the pane's current title —
  // unwrapping a possibly-composed mu title ('name · 💤 · task') back
  // to just the name token. Re-adoption of a pane that mu previously
  // owned must work; without parseAgentNameFromTitle the ' · 💤'
  // suffix would fail isValidAgentName.
  const previousTitle = matchingPane.title.length > 0 ? matchingPane.title : null;
  const candidate =
    opts.name ?? (previousTitle !== null ? parseAgentNameFromTitle(previousTitle) : "");
  const resolvedName = candidate;
  if (!isValidAgentName(resolvedName)) {
    if (opts.name === undefined) {
      throw new Error(
        `pane ${opts.paneId} title '${previousTitle ?? "(empty)"}' is not a valid agent name; pass --name <name>`,
      );
    }
    throw new Error(`agent name invalid: '${resolvedName}'`);
  }

  // Step 5: idempotency. If an agent already owns this pane id, check
  // whether it's the same name; same name == no-op, different name ==
  // conflict (we don't move agents between pane ids silently).
  const existingByPane = getAgentByPane(db, opts.paneId);
  if (existingByPane) {
    if (existingByPane.name === resolvedName) {
      return {
        agent: existingByPane,
        alreadyAdopted: true,
        previousTitle,
        paneTitleSetTo: resolvedName,
      };
    }
    throw new AgentExistsError(existingByPane.name);
  }

  // Step 6: name not taken (in any workstream — agents.name is the PK).
  const existingByName = getAgent(db, resolvedName);
  if (existingByName) {
    throw new AgentExistsError(resolvedName);
  }

  // Step 7: insert + (conditional) retitle.
  const inserted = insertAgent(db, {
    name: resolvedName,
    workstream: opts.workstream,
    paneId: opts.paneId,
    status: "free",
    cli: opts.cli,
    role: opts.role,
  });
  if (resolvedName !== previousTitle) {
    await setPaneTitle(opts.paneId, resolvedName);
  }
  emitEvent(
    db,
    opts.workstream,
    `agent adopt ${resolvedName} (pane ${opts.paneId}, was title='${previousTitle ?? ""}')`,
  );
  return {
    agent: inserted,
    alreadyAdopted: false,
    previousTitle,
    paneTitleSetTo: resolvedName,
  };
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
  /**
   * When true, free the agent's workspace BEFORE deleting the agent
   * (so we control the order rather than relying on FK cascade, which
   * leaves the on-disk dir orphaned). Lossy: any pending changes in
   * the workspace are gone unless the caller frees with `--commit`
   * separately first.
   *
   * When false (default) and a workspace exists, throws
   * WorkspacePreservedError so the caller has to decide explicitly.
   * Surfaced as a real bug in the multi-agent dogfood teardown.
   */
  discardWorkspace?: boolean;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** True iff the agent had an associated workspace AND the caller
   *  passed `discardWorkspace: true` so we proactively freed it.
   *  False on the no-workspace path (nothing to free) and on the
   *  refused path (we threw before doing anything). */
  workspaceFreed: boolean;
}

/**
 * Close an agent: kill its tmux pane and remove its DB row. Idempotent:
 *   - if the agent doesn't exist in the DB, returns a no-op result
 *   - if the tmux pane is already gone, killPane swallows the error
 *
 * Workspace handling: closing an agent and freeing its workspace are
 * separate concerns (agent lifecycle vs disk artifacts), so by default
 * `closeAgent` REFUSES if the agent has a workspace — you'd otherwise
 * orphan the on-disk dir (the FK cascade drops the registry row but
 * not the directory). Two ways to proceed:
 *
 *   1. `freeWorkspace(db, name)` first, then `closeAgent(db, name)`.
 *      Preserves the option to `--commit` pending changes.
 *   2. `closeAgent(db, name, { discardWorkspace: true })`. One-shot;
 *      lossy.
 *
 * The CLI surfaces these as the two actionable nextSteps on the
 * `WorkspacePreservedError` thrown by the refuse path.
 */
export async function closeAgent(
  db: Db,
  name: string,
  opts: CloseAgentOptions = {},
): Promise<CloseAgentResult> {
  const agent = getAgent(db, name);
  if (!agent) {
    return { killedPane: false, deletedRow: false, workspaceFreed: false };
  }
  const ws = getWorkspaceForAgent(db, name);
  if (ws !== undefined && opts.discardWorkspace !== true) {
    throw new WorkspacePreservedError(name, ws.path);
  }
  // Pre-mutation snapshot (snap_design §CAPTURE STRATEGY > WHEN).
  // Captures the agent row + the FK SET NULL ripple onto tasks.owner +
  // (when --discard-workspace) the vcs_workspaces row. Workstream is
  // recorded so this snapshot is filterable in `mu snapshot list`.
  captureSnapshot(db, `agent close ${name}`, agent.workstream);
  // Free the workspace BEFORE the agent (so the on-disk dir is
  // removed cleanly, not orphaned by FK cascade). freeWorkspace is
  // idempotent on missing rows.
  let workspaceFreed = false;
  if (ws !== undefined && opts.discardWorkspace === true) {
    await freeWorkspace(db, name, { commit: false });
    workspaceFreed = true;
  }
  await killPane(agent.paneId).catch(() => {
    /* idempotent — pane may already be gone */
  });
  const deletedRow = deleteAgent(db, name);
  emitEvent(
    db,
    agent.workstream,
    `agent close ${name} (pane=${agent.paneId}${workspaceFreed ? ", workspace discarded" : ""})`,
  );
  return {
    killedPane: true,
    deletedRow,
    workspaceFreed,
  };
}

export interface ListLiveAgentsOptions {
  workstream: string;
  tmuxSession?: string;
  /**
   * Read-only: report drift WITHOUT mutating any row. Forwarded to
   * `reconcile()`'s same-name option. Read-only callers (`mu hud`,
   * `mu state`, bare `mu`, `mu agent attach`, `mu doctor`) MUST set
   * this so the periodic `watch -n 5 mu hud -w X` invocation doesn't
   * race a long-running spawn (`git worktree add` of a 13k-file repo
   * takes seconds; the placeholder agent row's `pane_id` =
   * `%pending-<name>` looks like a ghost to reconcile, which then
   * deletes the row mid-spawn — the FK on `vcs_workspaces.agent` then
   * fires when `createWorkspace` tries to insert the row, surfacing
   * as a confusing FOREIGN KEY constraint failure). Surfaced live by
   * bug_agent_spawn_workspace_fk_failure.
   *
   * Default: false. Only `mu agent list` keeps the mutating behaviour
   * (it's the documented escape hatch for forcing a real prune).
   */
  dryRun?: boolean;
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
 * `mu agent list` calls this with `dryRun: false` (mutating); every
 * read-only verb (`mu hud`, `mu state`, bare `mu`, `mu agent attach`,
 * `mu doctor`) calls it with `dryRun: true` to avoid racing in-flight
 * spawns / status changes.
 */
export async function listLiveAgents(db: Db, opts: ListLiveAgentsOptions): Promise<LiveAgentsView> {
  const report = await reconcile(db, {
    workstream: opts.workstream,
    ...(opts.tmuxSession !== undefined ? { tmuxSession: opts.tmuxSession } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  });
  const agents = listAgents(db, { workstream: opts.workstream });
  return { agents, orphans: report.orphans, report };
}
