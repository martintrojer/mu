// mu — claim/release/resolveActorIdentity verbs.
//
// claimTask is the heart of mu's coordination protocol: an atomic
// CAS via a single SQL UPDATE, with two flavours:
//
//   "worker claim"  : --for <name> sets owner=<name> (FK to agents.name)
//   "anonymous claim": --self      keeps owner=NULL but flips status to
//                                  IN_PROGRESS and records the actor
//                                  in agent_logs
//
// resolveActorIdentity is the env-aware identity helper: pane title
// > MU_AGENT_NAME > USER > 'orchestrator'. Used by --self.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { captureSnapshot } from "../snapshots.js";
import { getTask } from "../tasks.js";
import { currentAgentName } from "../tmux.js";
import { ClaimerNotRegisteredError, TaskAlreadyOwnedError, TaskNotFoundError } from "./errors.js";
import { type EvidenceOption, evidenceSuffix } from "./lifecycle.js";
import type { TaskStatus } from "./status.js";

export interface ReleaseResult {
  /** The previous owner (null if the task was already unowned). */
  previousOwner: string | null;
  /** Status before the release. */
  previousStatus: TaskStatus;
  /** Status after the release. */
  status: TaskStatus;
  /** True iff owner OR status actually changed. */
  changed: boolean;
}

export interface ReleaseTaskOptions extends EvidenceOption {
  /** If true, also flip status back to OPEN (so the task is ready for
   *  another claim). Default false: status preserved. */
  reopen?: boolean;
}

/**
 * Release a task: clear `tasks.owner`. Optionally also flip status back
 * to OPEN via `--reopen` for the common "agent gave up mid-flight, hand
 * it back to the pool" workflow.
 *
 * Idempotent: releasing an already-unowned task with no `--reopen` is a
 * no-op (returns `changed: false`). Throws TaskNotFoundError on missing.
 */
export function releaseTask(db: Db, localId: string, opts: ReleaseTaskOptions = {}): ReleaseResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);

  const newStatus: TaskStatus = opts.reopen ? "OPEN" : before.status;
  const ownerChanges = before.owner !== null;
  const statusChanges = newStatus !== before.status;

  if (!ownerChanges && !statusChanges) {
    return {
      previousOwner: before.owner,
      previousStatus: before.status,
      status: before.status,
      changed: false,
    };
  }

  // Pre-mutation snapshot — release wipes ownership which is
  // irrecoverable from history (we'd lose 'who was working on this').
  captureSnapshot(db, `task release ${localId}`, before.workstream);

  db.prepare("UPDATE tasks SET owner = NULL, status = ?, updated_at = ? WHERE local_id = ?").run(
    newStatus,
    new Date().toISOString(),
    localId,
  );
  const statusBit = statusChanges ? `, ${before.status} → ${newStatus}` : "";
  emitEvent(
    db,
    before.workstream,
    `task release ${localId} (was owner=${before.owner ?? "none"}${statusBit})${evidenceSuffix(opts)}`,
  );
  return {
    previousOwner: before.owner,
    previousStatus: before.status,
    status: newStatus,
    changed: true,
  };
}

// ─── claimTask (verb) ──────────────────────────────────────────────────

export interface ClaimTaskOptions extends EvidenceOption {
  /**
   * Override the agent name. If omitted, derived from the current pane's
   * title via `tmux display-message -t $TMUX_PANE -p '#{pane_title}'`.
   *
   * Mutually exclusive with `self: true`.
   */
  agentName?: string;
  /**
   * Anonymous claim: write `owner = NULL` instead of resolving an agent
   * name and checking the FK. Use when the actor is the orchestrator
   * (or a script, or a human) doing direct work in a workstream they
   * aren't a registered worker in.
   *
   * The actor name is still recorded — it ends up in `agent_logs.source`
   * for the auto-emitted `task claim` event — so provenance is preserved.
   * Just not in the FK column.
   *
   * Resolution order for the actor name (used as the log source):
   *   1. `actor` if explicitly passed.
   *   2. Current pane title (when `$TMUX_PANE` is set).
   *   3. `$USER`.
   *   4. The literal string 'unknown'.
   *
   * Mutually exclusive with `agentName` (the two are alternative
   * answers to "who's the actor for this claim?"). Passing both is a
   * usage error.
   */
  self?: boolean;
  /**
   * Override the actor name used for the log source when `self: true`.
   * Ignored when `self: false`. Useful when the orchestrator wants to
   * attribute the work to a meaningful name rather than the pane
   * title (e.g. "deploy-bot" rather than "pi-mu").
   */
  actor?: string;
}

export interface ClaimResult {
  /** The agent now owning the task, or null when the claim was anonymous (--self). */
  owner: string | null;
  /** The actor recorded in the agent_logs event — the agent name for a
   *  registered-worker claim, or the resolved actor for --self. */
  actor: string;
  /** The previous owner (null if it was unowned). */
  previousOwner: string | null;
  /** The status BEFORE the claim; post-claim is IN_PROGRESS unless was CLOSED. */
  previousStatus: TaskStatus;
  /** The status AFTER the claim. */
  status: TaskStatus;
}

/**
 * Claim a task. Two modes:
 *
 *   Worker claim (default):
 *     Resolve an agent name from `opts.agentName` or from $TMUX_PANE's
 *     pane title. The name MUST exist in the agents table (FK on
 *     tasks.owner). Sets `owner = <name>`. This is what mu-spawned
 *     workers do, and what `mu task claim --for <worker>` does for
 *     orchestrator dispatch.
 *
 *   Anonymous claim (--self):
 *     Skip the name -> agents FK lookup entirely. Sets `owner = NULL`.
 *     Records the actor in `agent_logs.source` instead. This is the
 *     orchestrator-doing-direct-work path — the actor is logged but
 *     not registered as a worker pane.
 *
 * Status side-effect: OPEN -> IN_PROGRESS; IN_PROGRESS / CLOSED unchanged.
 *
 * Concurrency: the worker-claim path uses a single-statement CAS UPDATE
 * with `WHERE owner IS NULL OR owner = ?` so two workers racing to
 * claim the same task can't both win. The anonymous path uses
 * `WHERE owner IS NULL` (anonymous claims don't 'own' the task in any
 * exclusive sense; if it's already owned by anyone, the anonymous claim
 * is a TaskAlreadyOwnedError just like a worker claim would be).
 */
export async function claimTask(
  db: Db,
  localId: string,
  opts: ClaimTaskOptions = {},
): Promise<ClaimResult> {
  if (opts.self === true && opts.agentName !== undefined) {
    throw new Error("claimTask: --self and --for are mutually exclusive");
  }

  if (opts.self === true) {
    return claimSelf(db, localId, opts);
  }

  // ── Worker claim path (registered agent owns the task) ──
  // currentAgentName() parses 'name · status · task' titles back to
  // just the name token — the registry FK is keyed on agents.name,
  // so the parser is essential after composeAgentTitle decorates.
  const agentName = opts.agentName ?? (await currentAgentName());
  if (!agentName) {
    throw new Error(
      "claimTask: no agent name (pass opts.agentName, run inside an mu-spawned pane with $TMUX_PANE set, or pass --self for an anonymous claim)",
    );
  }

  // Pre-check: the FK on tasks.owner -> agents.name will reject any
  // claim from an unregistered agent with bare 'FOREIGN KEY constraint
  // failed'. Fail loud + actionable instead.
  const claimerExists = db.prepare("SELECT 1 FROM agents WHERE name = ? LIMIT 1").get(agentName) as
    | { 1: number }
    | undefined;
  if (!claimerExists) {
    // If we resolved the name from $TMUX_PANE, surface the pane id so
    // the error message can suggest 'mu adopt <pane>'. If --for was
    // used, we don't know which pane is intended.
    const paneIdFromEnv = opts.agentName === undefined ? (process.env.TMUX_PANE ?? null) : null;
    throw new ClaimerNotRegisteredError(agentName, paneIdFromEnv);
  }

  return db.transaction(() => {
    const before = getTask(db, localId);
    if (!before) throw new TaskNotFoundError(localId);

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE tasks
            SET owner = ?,
                status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                updated_at = ?
          WHERE local_id = ?
            AND (owner IS NULL OR owner = ?)`,
      )
      .run(agentName, now, localId, agentName);

    if (result.changes === 0) {
      throw new TaskAlreadyOwnedError(localId, before.owner ?? "<unknown>");
    }

    const after = getTask(db, localId);
    if (!after) throw new Error(`claimTask: row missing after update: ${localId}`);
    const statusBit = after.status !== before.status ? `, ${before.status} → ${after.status}` : "";
    emitEvent(
      db,
      before.workstream,
      `task claim ${localId} by ${agentName} (was owner=${before.owner ?? "none"}${statusBit})${evidenceSuffix(opts)}`,
      agentName,
    );
    return {
      owner: agentName,
      actor: agentName,
      previousOwner: before.owner,
      previousStatus: before.status,
      status: after.status,
    };
  })();
}

/**
 * Resolve the actor name for an anonymous (--self) claim:
 *   1. opts.actor if explicit.
 *   2. Current pane title (when $TMUX_PANE is set + tmux available).
 *   3. $USER.
 *   4. The literal 'unknown'.
 */
async function resolveSelfActor(opts: ClaimTaskOptions): Promise<string> {
  if (opts.actor !== undefined && opts.actor !== "") return opts.actor;
  return resolveActorIdentity();
}

/**
 * Resolve the current actor's identity for attribution in task notes,
 * --self claims, and any other write that wants 'who did this?'.
 *
 * Resolution order:
 *   1. $MU_AGENT_NAME env var (set by mu spawnAgent on every managed
 *      pane; surfaced from the f3d4bdd commit). Authoritative when
 *      present — you're inside a mu-spawned worker, no ambiguity.
 *   2. tmux pane title (the legacy claim-protocol identity step). Works
 *      when running inside any pane mu manages OR adopted.
 *   3. $USER (when running outside tmux entirely).
 *   4. The literal 'orchestrator' as a last-resort default.
 *
 * Why prefer env over pane title: pane titles are a tmux-server-wide
 * resource that anything can rewrite. The env var is set per-pane at
 * spawn time and is unforgeable from outside without explicit
 * `--actor` override. Pane title is still the legacy identity for
 * adopted panes that didn't go through mu's spawn path.
 */
export async function resolveActorIdentity(): Promise<string> {
  const muAgent = process.env.MU_AGENT_NAME;
  if (muAgent !== undefined && muAgent !== "") return muAgent;
  const paneTitle = await currentAgentName();
  if (paneTitle !== undefined && paneTitle !== "") return paneTitle;
  const user = process.env.USER;
  if (user !== undefined && user !== "") return user;
  return "orchestrator";
}

async function claimSelf(db: Db, localId: string, opts: ClaimTaskOptions): Promise<ClaimResult> {
  const actor = await resolveSelfActor(opts);
  return db.transaction(() => {
    const before = getTask(db, localId);
    if (!before) throw new TaskNotFoundError(localId);

    // Anonymous claim: owner stays NULL, status flips OPEN -> IN_PROGRESS.
    // We still gate on `owner IS NULL` so an in-flight worker claim
    // can't be silently overwritten.
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                updated_at = ?
          WHERE local_id = ?
            AND owner IS NULL`,
      )
      .run(now, localId);

    if (result.changes === 0) {
      // Task exists but is already owned (by someone). Mirror the
      // worker-path error so callers can pattern-match consistently.
      throw new TaskAlreadyOwnedError(localId, before.owner ?? "<unknown>");
    }

    const after = getTask(db, localId);
    if (!after) throw new Error(`claimTask: row missing after update: ${localId}`);
    const statusBit = after.status !== before.status ? `, ${before.status} → ${after.status}` : "";
    emitEvent(
      db,
      before.workstream,
      `task claim ${localId} by ${actor} --self (anonymous, owner stays NULL${statusBit})${evidenceSuffix(opts)}`,
      actor,
    );
    return {
      owner: null,
      actor,
      previousOwner: before.owner,
      previousStatus: before.status,
      status: after.status,
    };
  })();
}
