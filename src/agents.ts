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
import { captureSnapshot } from "./snapshots.js";
import { addNote, listTasksByOwner } from "./tasks.js";
// Re-export the cluster modules so external callers continue to
// `import { AgentNotFoundError, spawnAgent, ... } from "./agents.js"`.
export {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  WorkspacePreservedError,
} from "./agents/errors.js";
export {
  type SpawnAgentOptions,
  defaultSpawnLivenessMs,
  resolveCliCommand,
  spawnAgent,
} from "./agents/spawn.js";
export {
  type AdoptAgentOptions,
  type AdoptAgentResult,
  adoptAgent,
} from "./agents/adopt.js";
import { AgentNotFoundError, WorkspacePreservedError } from "./agents/errors.js";
import {
  type CaptureOptions,
  type SendOptions,
  type TmuxPane,
  capturePane,
  killPane,
  sendToPane,
  setPaneTitle,
} from "./tmux.js";
import { freeWorkspace, getWorkspaceForAgent } from "./workspace.js";
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

/**
 * Decide whether a scrollback-detected status should overwrite the
 * persisted one.
 *
 * `free` is sticky until the agent shows real activity:
 *   - free + needs_input  → stay free   (user explicitly marked it free;
 *                                        idle prompt isn't activity)
 *   - free + busy         → flip to busy
 *   - free + needs_permission → flip   (a permission prompt IS activity)
 *
 * Every other persisted status is auto-derived; overwrite freely. This
 * lets `spawning → busy/needs_input/needs_permission` happen on the
 * first reconcile after spawn.
 *
 * Lives on the agent (not on reconcile) because it's a property of the
 * agent's status field — both the periodic-reconcile loop and the
 * inline single-agent reconcile in `mu agent show` share this policy.
 */
export function shouldOverwriteAgentStatus(current: AgentStatus, detected: AgentStatus): boolean {
  if (current === "free") {
    return detected === "busy" || detected === "needs_permission";
  }
  return true;
}

// ─── Pane title composition (mu's interpreted state on the border) ───
//
// The pane border (set by enableMuPaneBorders) renders
// `[mu] #{pane_title}` as tmux chrome. mu owns the pane title and uses
// it to carry interpreted state at a glance. The status glyph in each
// example below is whatever STATUS_EMOJI resolves to today (see the
// table 30 lines down) — do NOT duplicate the codepoints in this
// comment, they have drifted from production once already.
//
//   worker-a                                    (no claim, status not
//                                                 worth surfacing yet)
//   worker-a · <STATUS_EMOJI.busy>              (busy, no claim)
//   worker-a · <STATUS_EMOJI.busy> · build_x     (busy, owns one task)
//   worker-a · <STATUS_EMOJI.needs_input> · build_x
//   worker-a · <STATUS_EMOJI.needs_permission> · build_x
//   worker-a · <STATUS_EMOJI.free>              (free, no claim)
//   worker-a · <STATUS_EMOJI.busy> · ⊕2 tasks    (multi-claim case)
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
// (legacy) Unicode emoji like a gear-with-variation-selector are TWO
// codepoints, which cli-table3 counts as length-2 and uses to size
// columns; but terminals render them as ONE cell wide, so adjacent
// rows that mix 1-codepoint and 2-codepoint emoji misalign. Nerd Font
// glyphs are private-use codepoints, all length-1 and all 1-cell-wide.
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

/**
 * Placeholder pane-id prefix used during the `--workspace` pre-stage in
 * spawnAgent (src/agents/spawn.ts).
 *
 * The placeholder unblocks the FK-ordering cycle:
 *   - vcs_workspaces.agent FK requires an agents row
 *   - agents.pane_id is NOT NULL
 *   - pane creation needs the workspace path as cwd
 * So we insert the agent with a placeholder pane_id, then create the
 * workspace, then the real pane, then patch pane_id.
 *
 * Because no real tmux pane has this prefix, ANY mutating reconcile
 * pass would treat the placeholder row as a ghost and prune it
 * (→ FK-failure on the workspace insert mid-spawn). Callers MUST:
 *   - either guard against it explicitly (refreshAgentTitle), OR
 *   - run reconcile in dryRun mode (read-only verbs; see
 *     `listLiveAgents.dryRun` rationale below).
 *
 * Bug surfaced as bug_agent_spawn_workspace_fk_failure.
 */
export const PENDING_PANE_PREFIX = "%pending-";

/** Build the placeholder pane id for an agent during workspace pre-stage. */
export function pendingPaneIdFor(agentName: string): string {
  return `${PENDING_PANE_PREFIX}${agentName}`;
}

/** True iff `paneId` is a `--workspace` pre-stage placeholder (not yet patched
 *  to the real tmux pane id). */
export function isPendingPaneId(paneId: string): boolean {
  return paneId.startsWith(PENDING_PANE_PREFIX);
}

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
  if (isPendingPaneId(agent.paneId)) return; // workspace pre-stage placeholder; see PENDING_PANE_PREFIX
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
   * `pendingPaneIdFor(name)` looks like a ghost to reconcile, which then
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
