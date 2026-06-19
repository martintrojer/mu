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

import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "./db.js";
import type { AgentStatus } from "./detect.js";
import { emitEvent, listLogs } from "./logs.js";
import { type ReconcileMode, type ReconcileReport, reconcile } from "./reconcile.js";
import { captureSnapshot } from "./snapshots.js";
import { addNote, listTasksByOwner } from "./tasks.js";
// Re-export the cluster modules so external callers continue to
// `import { AgentNotFoundError, spawnAgent, ... } from "./agents.js"`.
export {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentBusyError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  WorkspacePreservedError,
} from "./agents/errors.js";
export {
  type CommandResolutionResult,
  type CommandResolver,
  type SpawnAgentOptions,
  type EnsureAgentOptions,
  type EnsureAgentResult,
  checkCommandResolvable,
  defaultSpawnLivenessMs,
  defaultSpawnReadinessMs,
  envVarNameForCli,
  resetCommandResolverForTests,
  resolveCliCommand,
  resolveCliCommandWithSource,
  setCommandResolverForTests,
  ensureAgent,
  spawnAgent,
} from "./agents/spawn.js";
export {
  type AdoptAgentOptions,
  type AdoptAgentResult,
  adoptAgent,
} from "./agents/adopt.js";
export {
  type KickAgentOptions,
  type KickAgentResult,
  type KickSignal,
  type KickProcessExecutor,
  NoForegroundProcessError,
  foregroundPgid,
  isKickSignal,
  kickAgent,
  parsePsTtyOutput,
  resetKickProcessExecutor,
  setKickProcessExecutor,
} from "./agents/kick.js";
export {
  type AgentWaitRef,
  type AgentWaitOptions,
  type AgentWaitResult,
  type AgentWaitAgentState,
  type AgentStatusSnapshot,
  setAgentWaitSleepForTests,
  waitForAgents,
} from "./agents/wait.js";
import { AgentNotFoundError, WorkspacePreservedError } from "./agents/errors.js";
import {
  type CaptureOptions,
  type SendOptions,
  type TmuxPane,
  capturePane,
  killPane,
  listPanesInSession,
  sendToPane,
  setPaneTitle,
} from "./tmux.js";
import {
  decorateWithStaleness,
  freeWorkspace,
  getWorkspaceForAgent,
  isWorkspaceClean,
  listWorkspaces,
} from "./workspace.js";
// (freeWorkspace is used by the spawn rollback paths below, not by closeAgent.
// Closing an agent is intentionally a separate concern from freeing its workspace;
// see the closeAgent docstring.)
import { ensureWorkstream } from "./workstream.js";

export type { AgentStatus };

export interface AgentRow {
  name: string;
  /** Foreign-name reference to the owning workstream. */
  workstreamName: string;
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
  /**
   * Derived 'idle but assigned' flag (idle_assigned_agent_detection).
   * Set ONLY by `listLiveAgents` (and the helper `computeAgentIdle`);
   * never stored in the DB. Predicate:
   *   status === 'needs_input'
   *   AND owns ≥1 IN_PROGRESS task in this workstream
   *   AND (now - updated_at) >= MU_IDLE_THRESHOLD_MS (default 300_000ms)
   *
   * Surfaces the third lifecycle state (alive but assigned, no recent
   * progress) to `mu state` renders + `mu state --json`. Omitted (i.e.
   * absent — NOT `false`) when the predicate doesn't fire, so JSON
   * consumers can do a simple `if (agent.idle)` check and the field
   * stays out of the way for callers that don't care.
   */
  idle?: boolean;
}

/** Default idle threshold. Matches today's `mu task wait --stuck-after`
 *  default so the two paths agree on what counts as 'stalled'. */
const DEFAULT_IDLE_THRESHOLD_MS = 300_000;

/**
 * Read the operator-tunable idle threshold (`MU_IDLE_THRESHOLD_MS`).
 * Returns the default on any unparsable / negative value rather than
 * throwing — env-var typos shouldn't crash `mu state`.
 */
export function idleThresholdMs(): number {
  const env = process.env.MU_IDLE_THRESHOLD_MS;
  if (env === undefined || env === "") return DEFAULT_IDLE_THRESHOLD_MS;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_THRESHOLD_MS;
  return n;
}

/**
 * Decide whether an agent is in the 'idle but assigned' state. Pure
 * read on (agents, tasks); no side effects. Exported so `listLiveAgents`,
 * the renderers, and tests can share one source of truth.
 */
export function computeAgentIdle(db: Db, agent: AgentRow, now: number = Date.now()): boolean {
  if (agent.status !== "needs_input") return false;
  const threshold = idleThresholdMs();
  if (threshold <= 0) return false;
  const updated = Date.parse(agent.updatedAt);
  if (!Number.isFinite(updated)) return false;
  if (now - updated < threshold) return false;
  const wsId = tryResolveWorkstreamId(db, agent.workstreamName);
  if (wsId === null) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tasks t
         JOIN agents a ON a.id = t.owner_id
        WHERE a.name = ? AND a.workstream_id = ? AND t.status = 'IN_PROGRESS'`,
    )
    .get(agent.name, wsId) as { n: number };
  return row.n > 0;
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
  /** Joined from workstreams.name. */
  workstream: string;
  cli: string;
  pane_id: string;
  status: string;
  role: string;
  tab: string | null;
  created_at: string;
  updated_at: string;
}

/** SELECT clause that joins agents to workstreams, exposing the
 *  operator-facing workstream name as `workstream`. Used by every
 *  read path. */
const SELECT_AGENT_COLS = `
  a.name AS name,
  ws.name AS workstream,
  a.cli AS cli,
  a.pane_id AS pane_id,
  a.status AS status,
  a.role AS role,
  a.tab AS tab,
  a.created_at AS created_at,
  a.updated_at AS updated_at
`;

const AGENT_FROM_JOIN = "FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id";

function rowFromDb(row: RawAgentRow): AgentRow {
  return {
    name: row.name,
    workstreamName: row.workstream,
    cli: row.cli,
    paneId: row.pane_id,
    status: row.status as AgentStatus,
    role: row.role,
    tab: row.tab,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve an agent's surrogate id by (workstream, name). Returns
 *  null on miss. */
function agentIdByName(db: Db, name: string, workstream: string): number | null {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return null;
  const row = db
    .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
    .get(name, wsId) as { id: number } | undefined;
  return row ? row.id : null;
}

export function insertAgent(db: Db, input: InsertAgentInput): AgentRow {
  // Auto-create the workstreams row if missing so the FK on
  // agents.workstream_id is always satisfied. Preserves the ergonomics
  // where you could spawn without explicit `mu init`.
  ensureWorkstream(db, input.workstream);
  const workstreamId = resolveWorkstreamId(db, input.workstream);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (name, workstream_id, cli, pane_id, status, role, tab, created_at, updated_at)
     VALUES (@name, @workstreamId, COALESCE(@cli, 'pi'), @paneId, @status,
             COALESCE(@role, 'full-access'), @tab, @now, @now)`,
  ).run({
    name: input.name,
    workstreamId,
    cli: input.cli ?? null,
    paneId: input.paneId,
    status: input.status,
    role: input.role ?? null,
    tab: input.tab ?? null,
    now,
  });
  const row = getAgent(db, input.name, input.workstream);
  if (!row) throw new Error(`agents.insertAgent: row not found after insert: ${input.name}`);
  return row;
}

/**
 * Look up an agent by its tmux pane id (e.g. `%4`). Returns undefined if
 * no agent currently owns that pane. Used by `mu me` and friends to
 * answer "which agent am I?" from `$TMUX_PANE` without the LLM having to
 * remember its own name.
 *
 * Note: `pane_id` is not declared UNIQUE in the schema (a managed agent
 * could in theory be re-spawned into the same recycled pane id) but in
 * practice tmux pane ids are unique within a server's lifetime, and
 * reconcile prunes ghosts. We return the first match.
 */
export function getAgentByPane(db: Db, paneId: string): AgentRow | undefined {
  const row = db
    .prepare(`SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.pane_id = ? LIMIT 1`)
    .get(paneId) as RawAgentRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function getAgent(db: Db, name: string, workstream: string): AgentRow | undefined {
  // v5: agents.name is per-workstream unique, not globally unique.
  // Workstream is required so the same name in two workstreams
  // resolves unambiguously.
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(
      `SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.name = ? AND a.workstream_id = ?`,
    )
    .get(name, wsId) as RawAgentRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function listAgents(db: Db, opts: { workstream?: string } = {}): AgentRow[] {
  if (opts.workstream === undefined) {
    const rows = db
      .prepare(`SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} ORDER BY ws.name, a.name`)
      .all() as RawAgentRow[];
    return rows.map(rowFromDb);
  }
  const wsId = tryResolveWorkstreamId(db, opts.workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.workstream_id = ? ORDER BY a.name`,
    )
    .all(wsId) as RawAgentRow[];
  return rows.map(rowFromDb);
}

/**
 * Update an agent's status. Returns true if a row was matched.
 * Also bumps updated_at. Workstream is required (v5: agents.name is
 * per-workstream unique).
 */
export function updateAgentStatus(
  db: Db,
  name: string,
  status: AgentStatus,
  workstream: string,
): boolean {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return false;
  const result = db
    .prepare("UPDATE agents SET status = ?, updated_at = ? WHERE name = ? AND workstream_id = ?")
    .run(status, new Date().toISOString(), name, wsId);
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
// Unicode emoji like a gear-with-variation-selector are TWO
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

/** Single rendering helper for agent status glyphs. Keep callers off
 *  STATUS_EMOJI indexing so glyph fallback policy stays centralised. */
export function agentStatusGlyph(status: AgentStatus): string {
  return STATUS_EMOJI[status] ?? "?";
}

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
 * Because no real tmux pane has this prefix, a naive mutating reconcile
 * pass would treat the placeholder row as a ghost and prune it
 * (→ FK-failure on the workspace insert mid-spawn). Reconcile now guards
 * against it explicitly via isPendingPaneId(), and refreshAgentTitle skips
 * placeholders for the same reason.
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
  // Scope by the agent's workstream so a same-named worker in another
  // workstream can't pollute this title's task list.
  const tasks = listTasksByOwner(db, agent.workstreamName, agent.name);
  let title = agent.name;
  if (showStatus) {
    title += ` · ${agentStatusGlyph(agent.status)}`;
  }
  if (tasks.length === 1) {
    title += ` · ${tasks[0]?.name}`;
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
export async function refreshAgentTitle(
  db: Db,
  agentName: string,
  workstream: string,
): Promise<void> {
  const agent = getAgent(db, agentName, workstream);
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
export function deleteAgent(db: Db, name: string, workstream: string): boolean {
  // Wrap the whole reaper sequence (snapshot stuck tasks → DELETE
  // agent → per-task UPDATE + addNote + emitEvent) in a single
  // synchronous better-sqlite3 transaction. Without this, a throw
  // mid-loop (FK race after workstream destroy, addNote/emitEvent
  // regression, OOM, …) would leave the agent row deleted (FK
  // CASCADE already SET NULL on tasks.owner_id) but only PART of
  // the reaper trail written: leftover IN_PROGRESS tasks with no
  // owner and no `[reaper]` note explaining how they got there.
  // Reconcile / `mu task wait --stuck-after` would then surface
  // them as ownerless zombies with no breadcrumb.
  return db.transaction(() => {
    // Snapshot the stuck tasks BEFORE the DELETE; the FK CASCADE
    // (SET NULL on owner_id) makes the post-delete query indistinguishable
    // from "never owned by this agent."
    const agentId = agentIdByName(db, name, workstream);
    if (agentId === null) {
      // Already gone — idempotent return. (Could happen if reconcile
      // pruned a ghost concurrently.) The DELETE is a no-op.
      return false;
    }
    const stuck = db
      .prepare(
        `SELECT t.id AS taskId, t.local_id AS localId, ws.name AS workstream
           FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS'`,
      )
      .all(agentId) as Array<{ taskId: number; localId: string; workstream: string }>;

    const result = db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    if (result.changes === 0) return false;

    for (const t of stuck) {
      db.prepare("UPDATE tasks SET status = 'OPEN', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        t.taskId,
      );
      addNote(
        db,
        t.localId,
        `[reaper] previous owner ${name} gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared`,
        { author: "reaper", workstream: t.workstream },
      );
      emitEvent(
        db,
        t.workstream,
        `task reap ${t.localId} (previous owner ${name} gone, IN_PROGRESS → OPEN)`,
      );
    }
    return true;
  })();
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
  opts: SendOptions & { workstream: string },
): Promise<void> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name);
  await sendToPane(agent.paneId, text, opts);
}

/**
 * Read scrollback from an agent's pane. With no options, returns the full
 * scrollback (`-S - -E -`); with `lines: N`, returns only the last N lines.
 */
export async function readAgent(
  db: Db,
  name: string,
  opts: CaptureOptions & { workstream: string },
): Promise<string> {
  const agent = getAgent(db, name, opts.workstream);
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
export function freeAgent(db: Db, name: string, workstream: string): FreeAgentResult {
  const before = getAgent(db, name, workstream);
  if (!before) throw new AgentNotFoundError(name);
  if (before.status === "free") {
    return { previousStatus: before.status, status: "free", changed: false };
  }
  updateAgentStatus(db, name, "free", before.workstreamName);
  emitEvent(db, before.workstreamName, `agent free ${name} (was ${before.status})`);
  return { previousStatus: before.status, status: "free", changed: true };
}

export interface CloseAgentOptions {
  /**
   * Lossy override: when true, free the agent's workspace BEFORE
   * deleting the agent regardless of whether it's clean. (We control
   * the order rather than relying on FK cascade, which leaves the
   * on-disk dir orphaned.) Any pending changes / commits since fork
   * are gone unless the caller frees with `--commit` separately first.
   *
   * When false (default), behaviour depends on workspace state:
   *   - clean (no uncommitted changes AND no commits since fork):
   *     silently auto-free. allow_mu_agent_close_without_discard.
   *   - dirty (uncommitted changes OR commits since fork): throw
   *     WorkspacePreservedError so the caller decides explicitly.
   * Surfaced as a real bug in the multi-agent dogfood teardown.
   */
  discardWorkspace?: boolean;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** True iff the agent had an associated workspace AND we proactively
   *  freed it — either because the caller passed `discardWorkspace:
   *  true` (lossy) or because the workspace was clean and we
   *  auto-freed (allow_mu_agent_close_without_discard). False on the
   *  no-workspace path (nothing to free) and on the refused path (we
   *  threw before doing anything). */
  workspaceFreed: boolean;
  /** True iff `workspaceFreed` was triggered by the clean-workspace
   *  auto-free path (no uncommitted changes AND no commits since
   *  fork) rather than the explicit `discardWorkspace: true` override.
   *  Lets the CLI render an accurate message ("auto-freed (clean)"
   *  vs "workspace discarded") and gives JSON consumers a stable
   *  signal. False on every other path. */
  workspaceAutoFreedClean: boolean;
}

/**
 * Close an agent: kill its tmux pane and remove its DB row. Idempotent:
 *   - if the agent doesn't exist in the DB, returns a no-op result
 *   - if the tmux pane is already gone, killPane swallows the error
 *
 * Workspace handling: closing an agent and freeing its workspace are
 * separate concerns (agent lifecycle vs disk artifacts). Three cases:
 *
 *   - No workspace: close proceeds normally.
 *   - Workspace exists AND is CLEAN (no uncommitted changes, no
 *     commits since fork): silently auto-free (so a workspace that
 *     contains nothing worth preserving doesn't make the operator
 *     type --discard-workspace just to clean it up). Surfaced by
 *     allow_mu_agent_close_without_discard — a misconfigured-spawn
 *     teardown was needlessly forced through the lossy flag.
 *   - Workspace exists AND has either uncommitted changes OR commits
 *     since fork: REFUSE with WorkspacePreservedError so the operator
 *     decides explicitly. Two resolutions:
 *       1. `freeWorkspace(db, name)` first, then `closeAgent(db, name)`.
 *          Preserves the option to `--commit` pending changes.
 *       2. `closeAgent(db, name, { discardWorkspace: true })`.
 *          One-shot; lossy.
 *
 * The CLI surfaces these as the two actionable nextSteps on the
 * `WorkspacePreservedError` thrown by the refuse path.
 */
export async function closeAgent(
  db: Db,
  name: string,
  opts: CloseAgentOptions & { workstream: string },
): Promise<CloseAgentResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) {
    return {
      killedPane: false,
      deletedRow: false,
      workspaceFreed: false,
      workspaceAutoFreedClean: false,
    };
  }
  const ws = getWorkspaceForAgent(db, name, agent.workstreamName);
  // allow_mu_agent_close_without_discard: silently auto-free a clean
  // workspace (no uncommitted changes AND no commits since fork) so
  // the user doesn't have to type --discard-workspace for a workspace
  // that contains nothing worth preserving. Only refuse when there's
  // actually something to lose. The flag stays as the lossy override
  // for non-clean workspaces.
  let autoFreeClean = false;
  if (ws !== undefined && opts.discardWorkspace !== true) {
    autoFreeClean = await isWorkspaceClean(ws);
    if (!autoFreeClean) {
      throw new WorkspacePreservedError(name, ws.path);
    }
  }
  // Pre-mutation snapshot (snap_design §CAPTURE STRATEGY > WHEN).
  // Captures the agent row + the FK SET NULL ripple onto tasks.owner +
  // (when --discard-workspace or auto-free) the vcs_workspaces row.
  // Workstream is recorded so this snapshot is filterable in `mu
  // snapshot list`.
  captureSnapshot(db, `agent close ${name}`, agent.workstreamName);
  // Free the workspace BEFORE the agent (so the on-disk dir is
  // removed cleanly, not orphaned by FK cascade). freeWorkspace is
  // idempotent on missing rows.
  let workspaceFreed = false;
  if (ws !== undefined && (opts.discardWorkspace === true || autoFreeClean)) {
    await freeWorkspace(db, name, { commit: false, workstream: agent.workstreamName });
    workspaceFreed = true;
  }
  await killPane(agent.paneId).catch(() => {
    /* idempotent — pane may already be gone */
  });
  const deletedRow = deleteAgent(db, name, agent.workstreamName);
  emitEvent(
    db,
    agent.workstreamName,
    `agent close ${name} (pane=${agent.paneId}${
      workspaceFreed
        ? autoFreeClean
          ? ", workspace auto-freed (clean)"
          : ", workspace discarded"
        : ""
    })`,
  );
  return {
    killedPane: true,
    deletedRow,
    workspaceFreed,
    workspaceAutoFreedClean: workspaceFreed && autoFreeClean,
  };
}

export interface ListLiveAgentsOptions {
  workstream: string;
  tmuxSession?: string;
  /**
   * Which kind of reconciliation pass to run. Forwarded to
   * `reconcile()`'s same-name option. Default `"full"` (the
   * documented mutating behaviour `mu agent list` has always had,
   * now also used by `mu state` and `mu agent attach`).
   *
   * `mu doctor` and `mu undo` pass `"report-only"`: count drift,
   * mutate nothing. `mu undo` MUST use this so a post-restore
   * reconcile doesn't delete the rows the snapshot just restored
   * (snap_undo_reconcile_destroys_recovered_agents).
   *
   * Mid-spawn placeholders (pane id `%pending-<name>`) are protected
   * directly in reconcile's prune loop, independent of mode
   * (bug_agent_spawn_workspace_fk_failure).
   *
   * BREAKING: this replaces the previous `dryRun?: boolean`
   * option. Migration: `dryRun: true` → `mode: "report-only"`;
   * default (`dryRun: false` / unset) → `mode: "full"`.
   */
  mode?: ReconcileMode;
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
 * `mu state`, `mu agent list`, and `mu agent attach` call this with the
 * default `mode: "full"` (mutating); read-only diagnostic / restore paths
 * (`mu doctor`, `mu undo`) call it with `mode: "report-only"` to mutate
 * nothing at all.
 */
export async function listLiveAgents(db: Db, opts: ListLiveAgentsOptions): Promise<LiveAgentsView> {
  const report = await reconcile(db, {
    workstream: opts.workstream,
    ...(opts.tmuxSession !== undefined ? { tmuxSession: opts.tmuxSession } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  const baseAgents = listAgents(db, { workstream: opts.workstream });
  // Enrich with the derived `idle` flag (idle_assigned_agent_detection).
  // One COUNT per agent — cheap; the agents table in any one workstream
  // is small (typical wave: <10 rows). We add the field only when
  // idle=true, so non-idle rows JSON-serialize without the noise.
  const now = Date.now();
  const agents: AgentRow[] = baseAgents.map((a) =>
    computeAgentIdle(db, a, now) ? { ...a, idle: true } : a,
  );
  return { agents, orphans: report.orphans, report };
}

/** One agent's snapshot in a `pollAgents` view. The non-blocking,
 *  read-only dual of `waitForAgents`'s per-agent state: instead of
 *  blocking until a status transition, it captures the current pool
 *  state once so a `/watch` loop or orchestrator tick can diff it
 *  against the previous tick. */
export interface AgentPollSnapshot {
  /** Agent name (per-workstream unique). */
  name: string;
  /** Persisted runtime status (as last reconciled). */
  status: AgentStatus;
  /** Milliseconds since the agent's row was last updated (its last
   *  observed activity). Floored at 0. */
  idleMs: number;
  /** Highest `agent_logs.seq` whose source is this agent, or 0 when the
   *  agent has emitted no activity. A monotonically-increasing cursor a
   *  watcher can diff tick-over-tick to detect progress. */
  lastActivitySeq: number;
  /** How many commits the agent's workspace parent_ref is behind main,
   *  or null when the agent has no workspace / it cannot be computed. */
  workspaceBehind: number | null;
  /** True when the agent's pane no longer exists in the tmux session
   *  (a dead/ghost pane the next reconcile would prune). */
  dead: boolean;
}

/** The whole-pool result of `pollAgents`. Mirrors the `{items,count}`
 *  collection-read JSON shape every `--json` collection verb uses. */
export interface AgentPollView {
  items: AgentPollSnapshot[];
  count: number;
}

export interface PollAgentsOptions {
  workstream: string;
  /** Override the tmux session name (defaults to `mu-<workstream>`). */
  tmuxSession?: string;
}

/**
 * Non-blocking, read-only snapshot of every agent in a workstream — the
 * dual of `waitForAgents` (`mu agent wait`). Where `wait` blocks until a
 * status transition fires, `poll` captures the current pool state exactly
 * once and returns. A `/watch` loop or orchestrator tick calls this each
 * tick and diffs against the prior result.
 *
 * MUST NOT block: it issues a single `list-panes` (to detect dead panes),
 * reads the persisted agent rows, the activity log, and the workspace
 * staleness cache. It does NOT reconcile (no DB mutation), does NOT
 * capture per-pane scrollback, and does NOT fetch from any VCS remote —
 * `workspaceBehind` is as fresh as the workspace's local refs cache.
 */
export async function pollAgents(db: Db, opts: PollAgentsOptions): Promise<AgentPollView> {
  const agents = listAgents(db, { workstream: opts.workstream });
  if (agents.length === 0) return { items: [], count: 0 };

  // Single non-blocking tmux read to find which panes are still alive.
  // listPanesInSession returns [] for a missing session, so a torn-down
  // workstream simply reports every agent dead.
  const sessionName = opts.tmuxSession ?? `mu-${opts.workstream}`;
  let livePaneIds: Set<string>;
  try {
    const panes = await listPanesInSession(sessionName);
    livePaneIds = new Set(panes.map((p) => p.paneId));
  } catch {
    // Treat a tmux failure as "can't confirm liveness" rather than
    // throwing — poll is a read-only observation, never a hard error.
    livePaneIds = new Set();
  }

  // Last-activity cursor: highest agent_logs.seq sourced by each agent.
  // One scoped read of the workstream's log, bucketed by source.
  const lastSeqByAgent = new Map<string, number>();
  for (const row of listLogs(db, { workstream: opts.workstream })) {
    const prev = lastSeqByAgent.get(row.source) ?? 0;
    if (row.seq > prev) lastSeqByAgent.set(row.source, row.seq);
  }

  // Workspace staleness: decorate only the workspaces in this workstream,
  // keyed by agent name. decorateWithStaleness reads local refs only — no
  // network fetch — so this stays non-blocking.
  const wsRows = listWorkspaces(db, opts.workstream);
  const behindByAgent = new Map<string, number | null>();
  if (wsRows.length > 0) {
    for (const decorated of await decorateWithStaleness(wsRows)) {
      behindByAgent.set(decorated.agentName, decorated.commitsBehindMain ?? null);
    }
  }

  const now = Date.now();
  const items: AgentPollSnapshot[] = agents.map((a) => {
    const updated = Date.parse(a.updatedAt);
    const idleMs = Number.isFinite(updated) ? Math.max(0, now - updated) : 0;
    // A mid-spawn placeholder pane id is not dead — it just hasn't landed
    // a real pane yet; treat it as alive so a freshly-spawning agent
    // isn't surfaced as a ghost.
    const dead = !isPendingPaneId(a.paneId) && !livePaneIds.has(a.paneId);
    return {
      name: a.name,
      status: a.status,
      idleMs,
      lastActivitySeq: lastSeqByAgent.get(a.name) ?? 0,
      workspaceBehind: behindByAgent.get(a.name) ?? null,
      dead,
    };
  });
  return { items, count: items.length };
}

/** Statuses that count as 'finished / awaiting input' — the candidates a
 *  sweep is allowed to consider. `busy` and `spawning` are excluded: an
 *  actively-working agent is never idle, regardless of clock time. */
const REAPABLE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "needs_input",
  "needs_permission",
  "free",
]);

/** Per-agent outcome of a `reapIdleAgents` sweep. `action: "closed"` rows
 *  were closed (pane killed + row removed; clean workspace auto-freed);
 *  `action: "skipped"` rows were left untouched with a human-readable
 *  `reason`. */
export interface ReapAgentResult {
  name: string;
  action: "closed" | "skipped";
  /** Pre-close status (so callers can log what was swept). */
  status: AgentStatus;
  /** Milliseconds the agent had been idle at sweep time. */
  idleMs: number;
  /** Why a candidate was skipped. Set only when action === "skipped". */
  reason?: string;
  /** True iff the close auto-freed a clean workspace. */
  workspaceFreed?: boolean;
}

/** The whole-pool result of `reapIdleAgents`. Mirrors the `{items,count}`
 *  collection-read JSON shape. `count` is the number of agents CLOSED
 *  (not the number considered), so a caller can branch on "did anything
 *  get swept". */
export interface ReapView {
  items: ReapAgentResult[];
  count: number;
}

export interface ReapIdleAgentsOptions {
  workstream: string;
  /** Minimum idle duration (ms) before an agent is eligible. Defaults to
   *  `idleThresholdMs()` (MU_IDLE_THRESHOLD_MS, 5m). */
  idleForMs?: number;
  /** When true, compute the plan but mutate nothing — every closeable
   *  candidate is reported `action: "closed"` but no pane is killed and
   *  no row removed. Lets the operator preview a graveyard sweep. */
  dryRun?: boolean;
  /** When true, also close agents whose workspace is dirty (uncommitted
   *  changes / commits since fork), discarding the workspace (LOSSY).
   *  Off by default: the whole point of the verb is to never lose work
   *  unexpectedly. */
  discardDirty?: boolean;
}

/**
 * Sweep a workstream and close finished, idle, SAFE helpers — the
 * one-line graveyard cleanup for the `fixer-N` scratch-watcher pattern
 * (spawn a helper per unit, let them pile up, reap the clean ones).
 *
 * An agent is a candidate when its status is one of `REAPABLE_STATUSES`
 * (needs_input / needs_permission / free — i.e. NOT busy/spawning) AND it
 * has been idle (no row update) for >= `idleForMs`. Each candidate is
 * then closed via `closeAgent`, which auto-frees a clean workspace and
 * REFUSES a dirty one (WorkspacePreservedError). By default that refusal
 * is caught and the agent is skipped with a reason — no work is lost
 * unexpectedly. Pass `discardDirty: true` to override and discard.
 *
 * Non-candidates are reported as skipped with a reason so the JSON is a
 * full audit of what the sweep saw, not just what it touched.
 */
export async function reapIdleAgents(db: Db, opts: ReapIdleAgentsOptions): Promise<ReapView> {
  // Defensive: a NaN/Infinity/negative idleForMs (e.g. a non-numeric CLI
  // arg that slipped past validation) would make the `idleMs < idleForMs`
  // guard below silently false, closing EVERY reapable agent regardless of
  // how recently it went idle. Fall back to the default threshold instead.
  const idleForMs =
    opts.idleForMs !== undefined && Number.isFinite(opts.idleForMs) && opts.idleForMs >= 0
      ? opts.idleForMs
      : idleThresholdMs();
  const agents = listAgents(db, { workstream: opts.workstream });
  const now = Date.now();
  const items: ReapAgentResult[] = [];

  for (const a of agents) {
    const updated = Date.parse(a.updatedAt);
    const idleMs = Number.isFinite(updated) ? Math.max(0, now - updated) : 0;
    const base = { name: a.name, status: a.status, idleMs } as const;

    if (!REAPABLE_STATUSES.has(a.status)) {
      items.push({ ...base, action: "skipped", reason: `status ${a.status} (working)` });
      continue;
    }
    if (idleMs < idleForMs) {
      items.push({
        ...base,
        action: "skipped",
        reason: `idle ${Math.round(idleMs / 1000)}s < ${Math.round(idleForMs / 1000)}s`,
      });
      continue;
    }

    // Dirty-workspace guard: peek BEFORE close so a dry run reports the
    // skip and a real run never throws into the loop. closeAgent would
    // refuse a dirty workspace anyway; we surface it as a clean skip.
    if (opts.discardDirty !== true) {
      const ws = getWorkspaceForAgent(db, a.name, a.workstreamName);
      if (ws !== undefined && !(await isWorkspaceClean(ws))) {
        items.push({
          ...base,
          action: "skipped",
          reason: "workspace dirty (uncommitted changes or commits since fork)",
        });
        continue;
      }
    }

    if (opts.dryRun === true) {
      items.push({ ...base, action: "closed" });
      continue;
    }

    try {
      const result = await closeAgent(db, a.name, {
        workstream: a.workstreamName,
        ...(opts.discardDirty === true ? { discardWorkspace: true } : {}),
      });
      items.push({ ...base, action: "closed", workspaceFreed: result.workspaceFreed });
    } catch (err) {
      // Defensive: a dirty workspace can appear between the peek above
      // and the close (or discardDirty=false races a fresh edit). Treat
      // any close failure as a skip rather than aborting the whole sweep.
      if (err instanceof WorkspacePreservedError) {
        items.push({ ...base, action: "skipped", reason: "workspace preserved (dirty)" });
        continue;
      }
      throw err;
    }
  }

  const count = items.filter((i) => i.action === "closed").length;
  return { items, count };
}
