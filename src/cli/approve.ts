// mu — `mu approve` verbs (add / list / grant / deny / wait).
//
// Human-in-the-loop gate. An agent script that's about to do
// something irreversible:
//
//   slug=$(mu approve add --reason "delete the design task" --json | jq -r .slug)
//   if mu approve wait "$slug" --timeout 600; then
//     mu task delete design
//   else
//     echo "approval denied or timed out"; exit 1
//   fi
//
// The human grants/denies in another shell:
//   mu approve list                    # see pending
//   mu approve grant app_a1b2c3d4      # green-light it
//   mu approve deny  app_a1b2c3d4      # block it
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import Table from "cli-table3";
import pc from "picocolors";
import { getAgentByPane } from "../agents.js";
import {
  type AddApprovalOptions,
  ApprovalNotInWorkstreamError,
  type ApprovalRow,
  type ApprovalStatus,
  addApproval,
  denyApproval,
  getApproval,
  grantApproval,
  listApprovals,
  waitApproval,
} from "../approvals.js";
import { UsageError, emitJson, resolveOptionalWorkstream } from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, printNextSteps } from "../output.js";

export async function cmdApprovalAdd(
  db: Db,
  opts: {
    slug?: string;
    reason: string;
    requestedBy?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const ws = opts.workstream ?? (await resolveOptionalWorkstream());
  const requestedBy = opts.requestedBy ?? (await resolveSelfNameOrUser(db));
  const addOpts: AddApprovalOptions = {
    workstream: ws,
    reason: opts.reason,
    requestedBy,
  };
  if (opts.slug !== undefined) addOpts.slug = opts.slug;
  const row = addApproval(db, addOpts);
  const wsArg = row.workstream ? ` -w ${row.workstream}` : "";
  const nextSteps: NextStep[] = [
    {
      intent: "Block until decided (orchestrator)",
      command: `mu approve wait ${row.slug}${wsArg} --timeout 600`,
    },
    { intent: "Grant", command: `mu approve grant ${row.slug}${wsArg}` },
    { intent: "Deny", command: `mu approve deny ${row.slug}${wsArg}` },
  ];
  if (opts.json) {
    emitJson({ ...row, nextSteps });
    return;
  }
  console.log(
    `Requested approval ${pc.bold(row.slug)} ${pc.dim(`(workstream=${row.workstream ?? "—"}, by ${row.requestedBy})`)}`,
  );
  console.log(pc.dim(`  reason: ${row.reason}`));
  printNextSteps(nextSteps);
}

export async function cmdApprovalList(
  db: Db,
  opts: { workstream?: string; status?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const listOpts: { workstream?: string; status?: ApprovalStatus } = {};
  if (!opts.all) {
    const ws = opts.workstream ?? (await resolveOptionalWorkstream());
    if (ws) listOpts.workstream = ws;
  }
  if (opts.status !== undefined) {
    if (!isApprovalStatus(opts.status)) {
      throw new UsageError(
        `--status must be one of pending|granted|denied|timeout (got ${JSON.stringify(opts.status)})`,
      );
    }
    listOpts.status = opts.status;
  }
  const rows = listApprovals(db, listOpts);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim("(no approvals)"));
    return;
  }
  console.log(formatApprovalsTable(rows));
}

export async function cmdApprovalGrant(
  db: Db,
  slug: string,
  opts: { by?: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  const decidedBy = opts.by ?? (await resolveSelfNameOrUser(db));
  const row = grantApproval(db, slug, { decidedBy });
  if (opts.json) {
    emitJson(row);
    return;
  }
  console.log(`Granted ${pc.bold(slug)} ${pc.dim(`(by ${row.decidedBy})`)}`);
}

export async function cmdApprovalDeny(
  db: Db,
  slug: string,
  opts: { by?: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  const decidedBy = opts.by ?? (await resolveSelfNameOrUser(db));
  const row = denyApproval(db, slug, { decidedBy });
  if (opts.json) {
    emitJson(row);
    return;
  }
  console.log(`Denied ${pc.bold(slug)} ${pc.dim(`(by ${row.decidedBy})`)}`);
}

export async function cmdApprovalWait(
  db: Db,
  slug: string,
  opts: { timeout?: number; json?: boolean; workstream?: string },
): Promise<void> {
  assertApprovalInWorkstream(db, slug, opts.workstream);
  // --timeout in seconds for shell ergonomics; SDK takes ms.
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : 600_000;
  const row = await waitApproval(db, slug, { timeoutMs });
  if (opts.json) {
    emitJson(row);
  } else {
    console.log(
      `${pc.bold(slug)}: ${approvalStatusColor(row.status)} ${pc.dim(`(by ${row.decidedBy ?? "—"})`)}`,
    );
  }
  // Exit codes wire approval outcomes into shell control flow without
  // forcing the caller to parse output:
  //   0 = granted, 4 = denied (conflict semantically), 5 = timeout.
  if (row.status === "granted") return;
  if (row.status === "denied") process.exit(4);
  process.exit(5);
}

function isApprovalStatus(s: string): s is ApprovalStatus {
  return s === "pending" || s === "granted" || s === "denied" || s === "timeout";
}

function approvalStatusColor(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return pc.yellow(status);
    case "granted":
      return pc.green(status);
    case "denied":
      return pc.red(status);
    case "timeout":
      return pc.dim(status);
  }
}

function formatApprovalsTable(rows: readonly ApprovalRow[]): string {
  const table = new Table({
    head: ["slug", "workstream", "status", "requested_by", "decided_by", "reason", "created"].map(
      (h) => pc.bold(h),
    ),
    style: { head: [], border: [] },
  });
  for (const r of rows) {
    table.push([
      r.slug,
      r.workstream ?? pc.dim("—"),
      approvalStatusColor(r.status),
      r.requestedBy,
      r.decidedBy ?? pc.dim("—"),
      r.reason,
      pc.dim(r.createdAt),
    ]);
  }
  return table.toString();
}

/**
 * Sister helper for verbs targeting an approval by slug. Slugs are
 * globally unique (PK on approvals.slug); `-w` lets operators assert
 * the workstream the approval was opened against. Mismatch raises
 * `ApprovalNotInWorkstreamError` (exit 4).
 */
function assertApprovalInWorkstream(db: Db, slug: string, workstream: string | undefined): void {
  if (!workstream) return;
  const approval = getApproval(db, slug);
  if (approval && approval.workstream !== workstream) {
    throw new ApprovalNotInWorkstreamError(slug, workstream, approval.workstream);
  }
}

/** Like resolveSelf but falls back to 'user' (no throw) when not in
 *  a managed pane. Used by approve add / grant / deny so an external
 *  shell caller doesn't have to pass --by/--requested-by every time. */
async function resolveSelfNameOrUser(db: Db): Promise<string> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return "user";
  const agent = getAgentByPane(db, paneId);
  return agent ? agent.name : "user";
}
