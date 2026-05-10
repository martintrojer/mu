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
import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";
import { sleep } from "./tmux.js";
import { ensureWorkstream } from "./workstream.js";

export type ApprovalStatus = "pending" | "granted" | "denied" | "timeout";

export interface ApprovalRow {
  /** Per-workstream-unique TEXT name for the approval gate. */
  name: string;
  workstreamName: string | null;
  reason: string;
  requestedBy: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface RawApprovalRow {
  slug: string;
  /** Joined from workstreams.name. v5 schema makes workstream_id
   *  NOT NULL; the LEFT JOIN keeps the column nullable in the row
   *  shape only for defence against a corrupt DB. */
  workstream: string | null;
  reason: string;
  requested_by: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const SELECT_APPROVAL_COLS = `
  ap.slug AS slug,
  ws.name AS workstream,
  ap.reason AS reason,
  ap.requested_by AS requested_by,
  ap.status AS status,
  ap.decided_by AS decided_by,
  ap.decided_at AS decided_at,
  ap.created_at AS created_at
`;

// LEFT JOIN: defensive against a corrupt DB where workstream_id is
// somehow NULL (schema enforces NOT NULL; this is belt-and-braces).
const APPROVAL_FROM_JOIN = "FROM approvals ap LEFT JOIN workstreams ws ON ws.id = ap.workstream_id";

function rowFromDb(row: RawApprovalRow): ApprovalRow {
  return {
    name: row.slug,
    workstreamName: row.workstream,
    reason: row.reason,
    requestedBy: row.requested_by,
    status: row.status as ApprovalStatus,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export class ApprovalNotFoundError extends Error implements HasNextSteps {
  override readonly name = "ApprovalNotFoundError";
  constructor(public readonly slug: string) {
    super(`no such approval: ${slug}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List approvals in current workstream", command: "mu approve list" },
      { intent: "List across ALL workstreams", command: "mu approve list --all" },
      {
        intent: "Filter by status (pending / granted / denied / timeout)",
        command: "mu approve list --all --status pending",
      },
    ];
  }
}

export class ApprovalAlreadyDecidedError extends Error implements HasNextSteps {
  override readonly name = "ApprovalAlreadyDecidedError";
  constructor(
    public readonly slug: string,
    public readonly status: ApprovalStatus,
  ) {
    super(`approval ${slug} already ${status}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Show the existing approval (look at decided_by / decided_at)",
        command: `mu sql "SELECT * FROM approvals WHERE slug='${this.slug}'"`,
      },
      {
        intent: "Create a new approval request (slugs are unique)",
        command: 'mu approve add --reason "..."',
      },
    ];
  }
}

/**
 * Thrown when a verb targeting an approval is invoked with
 * `-w/--workstream <name>` but the named approval lives in a different
 * workstream. Mirrors `TaskNotInWorkstreamError` /
 * `AgentNotInWorkstreamError`. Maps to exit code 4 (conflict / wrong
 * scope).
 */
export class ApprovalNotInWorkstreamError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    const steps: NextStep[] = [];
    if (this.actualWorkstream !== null) {
      steps.push({
        intent: "Use the approval's actual workstream",
        command: `mu approve grant ${this.slug} -w ${this.actualWorkstream}`,
      });
    } else {
      steps.push({
        intent: "Approval is workstream-less; omit -w",
        command: `mu approve grant ${this.slug}`,
      });
    }
    steps.push({ intent: "Or list across all workstreams", command: "mu approve list --all" });
    return steps;
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
  /** Workstream this approval is scoped to. v5: approvals.workstream_id
   *  is NOT NULL. */
  workstream: string;
  /** Free-form description of what the approver is being asked to OK. */
  reason: string;
  /** Who requested it (agent name, 'user', etc.). */
  requestedBy: string;
}

export function addApproval(db: Db, opts: AddApprovalOptions): ApprovalRow {
  const slug = opts.slug ?? generateApprovalSlug();
  const createdAt = new Date().toISOString();
  ensureWorkstream(db, opts.workstream);
  const wsId = resolveWorkstreamId(db, opts.workstream);
  db.prepare(
    `INSERT INTO approvals (slug, workstream_id, reason, requested_by, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(slug, wsId, opts.reason, opts.requestedBy, createdAt);
  emitEvent(
    db,
    opts.workstream,
    `approval add ${slug} (requested-by ${opts.requestedBy}): ${opts.reason}`,
    opts.requestedBy,
  );
  return {
    name: slug,
    workstreamName: opts.workstream,
    reason: opts.reason,
    requestedBy: opts.requestedBy,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt,
  };
}

export function getApproval(db: Db, slug: string, workstream: string): ApprovalRow | undefined {
  // v5: slug is per-workstream unique. Workstream is required so the
  // same slug in two workstreams resolves unambiguously.
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(
      `SELECT ${SELECT_APPROVAL_COLS} ${APPROVAL_FROM_JOIN}
        WHERE ap.slug = ? AND ap.workstream_id = ?`,
    )
    .get(slug, wsId) as RawApprovalRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export interface ListApprovalsOptions {
  workstream?: string;
  /** Filter to one or more statuses. Single value behaves identically
   *  to the legacy `status: ApprovalStatus`; an array becomes
   *  `WHERE status IN (?, ?, …)` (parameterised). Omitted = all. */
  status?: ApprovalStatus | readonly ApprovalStatus[];
}

export function listApprovals(db: Db, opts: ListApprovalsOptions = {}): ApprovalRow[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as ApprovalStatus[])
        : [opts.status as ApprovalStatus];
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.workstream !== undefined) {
    const wsId = tryResolveWorkstreamId(db, opts.workstream);
    if (wsId === null) return [];
    conditions.push("ap.workstream_id = ?");
    params.push(wsId);
  }
  if (statuses !== undefined && statuses.length > 0) {
    conditions.push(`ap.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${SELECT_APPROVAL_COLS} ${APPROVAL_FROM_JOIN} ${where} ORDER BY ap.created_at DESC`,
    )
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
  opts: DecideApprovalOptions & { workstream: string },
): ApprovalRow {
  const before = getApproval(db, slug, opts.workstream);
  if (!before) throw new ApprovalNotFoundError(slug);
  if (before.status !== "pending") {
    throw new ApprovalAlreadyDecidedError(slug, before.status);
  }
  // Pre-mutation snapshot. Approval decisions are terminal
  // (pending → granted/denied/timeout); without this an accidental
  // grant has no recovery path.
  captureSnapshot(db, `approval ${newStatus} ${slug}`, before.workstreamName);
  const decidedAt = new Date().toISOString();
  // Scope the UPDATE to the slug's workstream so v5's per-workstream
  // uniqueness can't be sidestepped by a same-slug row in another
  // workstream. before.workstreamName is non-null in v5 (schema NOT NULL).
  db.prepare(
    `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
      WHERE slug = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
  ).run(newStatus, opts.decidedBy, decidedAt, slug, before.workstreamName);
  emitEvent(
    db,
    before.workstreamName,
    `approval ${newStatus} ${slug} (by ${opts.decidedBy})`,
    opts.decidedBy,
  );
  const after = getApproval(db, slug, opts.workstream);
  if (!after) throw new Error(`approval vanished after update: ${slug}`);
  return after;
}

export function grantApproval(
  db: Db,
  slug: string,
  opts: DecideApprovalOptions & { workstream: string },
): ApprovalRow {
  return decide(db, slug, "granted", opts);
}

export function denyApproval(
  db: Db,
  slug: string,
  opts: DecideApprovalOptions & { workstream: string },
): ApprovalRow {
  return decide(db, slug, "denied", opts);
}

/**
 * Mark a pending approval as timed out. Used internally by `waitApproval`
 * when its deadline elapses; also exposed for `mu approve timeout` to
 * proactively clear an abandoned request.
 */
export function timeoutApproval(
  db: Db,
  slug: string,
  opts: DecideApprovalOptions & { workstream: string },
): ApprovalRow {
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
  opts: WaitApprovalOptions & { workstream: string },
): Promise<ApprovalRow> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  for (;;) {
    const row = getApproval(db, slug, opts.workstream);
    if (!row) throw new ApprovalNotFoundError(slug);
    if (row.status !== "pending") return row;
    if (Date.now() >= deadline) {
      // Race: another process might have granted/denied between our last
      // read and now. timeoutApproval will throw AlreadyDecided in that
      // case; treat that as success and re-read.
      try {
        return timeoutApproval(db, slug, { decidedBy: "system", workstream: opts.workstream });
      } catch (err) {
        if (err instanceof ApprovalAlreadyDecidedError) {
          const after = getApproval(db, slug, opts.workstream);
          if (!after) throw new ApprovalNotFoundError(slug);
          return after;
        }
        throw err;
      }
    }
    await sleep(pollMs);
  }
}
