// mu — `mu workspace` verbs (create / list / free / path / orphans).
//
// Per-agent VCS workspaces (registry layer on top of vcs.ts).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import pc from "picocolors";
import {
  assertAgentInWorkstream,
  emitJson,
  formatWorkspacesTable,
  resolveWorkstream,
} from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, printNextSteps } from "../output.js";
import type { VcsBackendName } from "../vcs.js";
import {
  WorkspaceNotFoundError,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaceOrphans,
  listWorkspaces,
} from "../workspace.js";

export async function cmdWorkspaceCreate(
  db: Db,
  agent: string,
  opts: {
    workstream?: string;
    backend?: VcsBackendName;
    from?: string;
    projectRoot?: string;
    json?: boolean;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const createOpts: Parameters<typeof createWorkspace>[1] = { agent, workstream };
  if (opts.backend !== undefined) createOpts.backend = opts.backend;
  if (opts.from !== undefined) createOpts.parentRef = opts.from;
  if (opts.projectRoot !== undefined) createOpts.projectRoot = opts.projectRoot;
  const ws = await createWorkspace(db, createOpts);
  const nextSteps: NextStep[] = [
    { intent: "cd into the workspace", command: `cd $(mu workspace path ${agent})` },
    {
      intent: "Free it later (with optional --commit)",
      command: `mu workspace free ${agent}  (--commit to commit pending changes first)`,
    },
    {
      intent: "Spawn an agent that uses this workspace as cwd",
      command: `mu agent spawn <name> -w ${workstream} --workspace`,
    },
  ];
  if (opts.json) {
    emitJson({ workspace: ws, nextSteps });
    return;
  }
  console.log(
    `Created workspace ${pc.bold(ws.path)} ${pc.dim(`(backend=${ws.backend}, agent=${ws.agent}, parent=${ws.parentRef ?? "—"})`)}`,
  );
  printNextSteps(nextSteps);
}

export async function cmdWorkspaceList(
  db: Db,
  opts: { workstream?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const workstream = opts.all ? undefined : await resolveWorkstream(opts.workstream);
  const rows = listWorkspaces(db, workstream);
  if (opts.json) {
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim(workstream ? `(no workspaces in ${workstream})` : "(no workspaces)"));
    return;
  }
  console.log(formatWorkspacesTable(rows));
}

export async function cmdWorkspaceFree(
  db: Db,
  agent: string,
  opts: { commit?: boolean; workstream?: string; json?: boolean },
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false });
  if (opts.json) {
    emitJson({ agent, ...r });
    return;
  }
  if (!r.removed && !r.rowDeleted) {
    console.log(pc.dim(`no workspace for ${agent} (already gone?)`));
    return;
  }
  const committed = r.committedRef
    ? pc.dim(` (auto-committed: ${r.committedRef.slice(0, 12)})`)
    : "";
  console.log(`Freed workspace for ${pc.bold(agent)}${committed}`);
}

export async function cmdWorkspacePath(
  db: Db,
  agent: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = getWorkspaceForAgent(db, agent);
  if (!ws) throw new WorkspaceNotFoundError(agent);
  if (opts.json) {
    emitJson({ agent, path: ws.path, backend: ws.backend });
    return;
  }
  // Print just the path, no decoration: usable for `cd $(mu workspace path X)`.
  console.log(ws.path);
}

export async function cmdWorkspaceOrphans(
  db: Db,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const orphans = listWorkspaceOrphans(db, workstream);
  const nextSteps: NextStep[] =
    orphans.length === 0
      ? []
      : [
          {
            intent: "Remove a specific orphan dir (git: also prunes worktree registry)",
            command: `(cd <project-root> && git worktree remove --force ${orphans[0]?.path}) || rm -rf ${orphans[0]?.path}`,
          },
          {
            intent: "Adopt the dir as a managed workspace",
            command: "mu workspace adopt  (deferred; see roadmap)",
          },
        ];
  if (opts.json) {
    emitJson({ workstream, orphans, nextSteps });
    return;
  }
  if (orphans.length === 0) {
    console.log(pc.dim(`(no orphan workspace dirs in ${workstream})`));
    return;
  }
  console.log(pc.yellow(`${orphans.length} orphan workspace dir(s) in ${pc.bold(workstream)}:`));
  for (const o of orphans) {
    console.log(`  ${pc.bold(o.agent)}  ${pc.dim(o.path)}`);
  }
  printNextSteps(nextSteps);
}
