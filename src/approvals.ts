// mu — approvals: human-in-the-loop gate for risky agent actions.
//
// An agent script that's about to do something irreversible requests
// an approval, then blocks on the wait verb until a human grants /
// denies (or it times out). Without this primitive, the only safety
// story is "the human runs the destructive verb themselves" — which
// defeats the autonomous-agent contract.
//
// Slug-keyed (TEXT PK, human-typeable) so the human can grant/deny by
// reading the slug off the requester's pane and typing it back. Auto-
// generated when the requester doesn't supply one. Every transition
// emits a kind='event' row to agent_logs.

import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { emitEvent } from "./logs.js";
import { sleep } from "./tmux.js";

export type ApprovalStatus = "pending" | "granted" | "denied" | "timeout";

export interface ApprovalRow {
  slug: string;
  workstream: string | null;
  reason: string;
  requestedBy: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface RawApprovalRow {
  slug: string;
  workstream: string | null;
  reason: string;
  requested_by: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

function rowFromDb(row: RawApprovalRow): ApprovalRow {
  return {
    slug: row.slug,
    workstream: row.workstream,
    reason: row.reason,
    requestedBy: row.requested_by,
    status: row.status as ApprovalStatus,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export class ApprovalNotFoundError extends Error {
  override readonly name = "ApprovalNotFoundError";
  constructor(public readonly slug: string) {
    super(`no such approval: ${slug}`);
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  override readonly name = "ApprovalAlreadyDecidedError";
  constructor(
    public readonly slug: string,
    public readonly status: ApprovalStatus,
  ) {
    super(`approval ${slug} already ${status}`);
  }
}

/**
 * Thrown when a verb targeting an approval is invoked with
 * `-w/--workstream <name>` but the named approval lives in a different
 * workstream. Mirrors `TaskNotInWorkstreamError` /
 * `AgentNotInWorkstreamError`. Maps to exit code 4 (conflict / wrong
 * scope).
 */
export class ApprovalNotInWorkstreamError extends Error {
  override readonly name = "ApprovalNotInWorkstreamError";
  constructor(
    public readonly slug: string,
    public readonly expectedWorkstream: string,
    /** May be null when the approval is workstream-less (global scope). */
    public readonly actualWorkstream: string | null,
  ) {
    const actual = actualWorkstream ?? "<global, workstream-less>";
    super(`approval ${slug} is in workstream ${actual}, not ${expectedWorkstream}`);
  }
}

/**
 * Generate a short, human-typeable slug. Format: 8 lowercase
 * alphanumeric chars. Mirrors `mu_<hex>`-style avoidance: prefix is
 * `app_` so it's clearly an approval id and won't collide with
 * task ids (which start with a letter and avoid `mu_`).
 */
export function generateApprovalSlug(): string {
  const random = randomBytes(4).toString("hex"); // 8 chars
  return `app_${random}`;
}

export interface AddApprovalOptions {
  /** Override the slug; auto-generated when omitted. */
  slug?: string;
  /** Workstream this approval is scoped to; can be null. */
  workstream: string | null;
  /** Free-form description of what the approver is being asked to OK. */
  reason: string;
  /** Who requested it (agent name, 'user', etc.). */
  requestedBy: string;
}

export function addApproval(db: Db, opts: AddApprovalOptions): ApprovalRow {
  const slug = opts.slug ?? generateApprovalSlug();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO approvals (slug, workstream, reason, requested_by, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(slug, opts.workstream, opts.reason, opts.requestedBy, createdAt);
  emitEvent(
    db,
    opts.workstream,
    `approval add ${slug} (requested-by ${opts.requestedBy}): ${opts.reason}`,
    opts.requestedBy,
  );
  return {
    slug,
    workstream: opts.workstream,
    reason: opts.reason,
    requestedBy: opts.requestedBy,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt,
  };
}

export function getApproval(db: Db, slug: string): ApprovalRow | undefined {
  const row = db.prepare("SELECT * FROM approvals WHERE slug = ?").get(slug) as
    | RawApprovalRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

export interface ListApprovalsOptions {
  workstream?: string;
  status?: ApprovalStatus;
}

export function listApprovals(db: Db, opts: ListApprovalsOptions = {}): ApprovalRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.workstream !== undefined) {
    conditions.push("workstream = ?");
    params.push(opts.workstream);
  }
  if (opts.status !== undefined) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC`)
    .all(...params) as RawApprovalRow[];
  return rows.map(rowFromDb);
}

export interface DecideApprovalOptions {
  decidedBy: string;
}

/**
 * Internal helper: transition a pending approval to a final state.
 * Throws ApprovalNotFoundError on missing slug, ApprovalAlreadyDecidedError
 * on a slug that's already in a final state.
 */
function decide(
  db: Db,
  slug: string,
  newStatus: Exclude<ApprovalStatus, "pending">,
  opts: DecideApprovalOptions,
): ApprovalRow {
  const before = getApproval(db, slug);
  if (!before) throw new ApprovalNotFoundError(slug);
  if (before.status !== "pending") {
    throw new ApprovalAlreadyDecidedError(slug, before.status);
  }
  const decidedAt = new Date().toISOString();
  db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE slug = ?").run(
    newStatus,
    opts.decidedBy,
    decidedAt,
    slug,
  );
  emitEvent(
    db,
    before.workstream,
    `approval ${newStatus} ${slug} (by ${opts.decidedBy})`,
    opts.decidedBy,
  );
  const after = getApproval(db, slug);
  if (!after) throw new Error(`approval vanished after update: ${slug}`);
  return after;
}

export function grantApproval(db: Db, slug: string, opts: DecideApprovalOptions): ApprovalRow {
  return decide(db, slug, "granted", opts);
}

export function denyApproval(db: Db, slug: string, opts: DecideApprovalOptions): ApprovalRow {
  return decide(db, slug, "denied", opts);
}

/**
 * Mark a pending approval as timed out. Used internally by `waitApproval`
 * when its deadline elapses; also exposed for `mu approve timeout` to
 * proactively clear an abandoned request.
 */
export function timeoutApproval(db: Db, slug: string, opts: DecideApprovalOptions): ApprovalRow {
  return decide(db, slug, "timeout", opts);
}

export interface WaitApprovalOptions {
  /** Maximum time to wait, in milliseconds. Default 600_000 (10 min).
   *  Pass 0 to wait forever. */
  timeoutMs?: number;
  /** Polling interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
}

/**
 * Block until the approval reaches a final state (granted / denied /
 * timeout). Returns the final row. If the deadline elapses while still
 * pending, the row is transitioned to 'timeout' (decided_by='system')
 * before being returned.
 *
 * Polling-based, like `mu log --tail`. SQLite handles concurrent
 * writers; the caller's poll picks up the granter's update on the next
 * tick.
 */
export async function waitApproval(
  db: Db,
  slug: string,
  opts: WaitApprovalOptions = {},
): Promise<ApprovalRow> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  for (;;) {
    const row = getApproval(db, slug);
    if (!row) throw new ApprovalNotFoundError(slug);
    if (row.status !== "pending") return row;
    if (Date.now() >= deadline) {
      // Race: another process might have granted/denied between our last
      // read and now. timeoutApproval will throw AlreadyDecided in that
      // case; treat that as success and re-read.
      try {
        return timeoutApproval(db, slug, { decidedBy: "system" });
      } catch (err) {
        if (err instanceof ApprovalAlreadyDecidedError) {
          const after = getApproval(db, slug);
          if (!after) throw new ApprovalNotFoundError(slug);
          return after;
        }
        throw err;
      }
    }
    await sleep(pollMs);
  }
}
