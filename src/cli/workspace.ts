// mu — `mu workspace` verbs (create / list / free / path / orphans).
//
// Per-agent VCS workspaces (registry layer on top of vcs.ts).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  assertAgentInWorkstream,
  emitJson,
  formatWorkspacesTable,
  resolveWorkstream,
} from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import type { VcsBackendName } from "../vcs.js";
import {
  WorkspaceNotFoundError,
  createWorkspace,
  decorateWithStaleness,
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
  // decorateWithStaleness is the staleness signal from
  // bug_workspace_stale_parent_silent_drift: ask each row's backend how
  // many commits its parent_ref is behind main. Pure observation; no
  // automatic fetch.
  const decorated = await decorateWithStaleness(rows);
  if (opts.json) {
    emitJson(decorated);
    return;
  }
  if (decorated.length === 0) {
    console.log(pc.dim(workstream ? `(no workspaces in ${workstream})` : "(no workspaces)"));
    return;
  }
  console.log(formatWorkspacesTable(decorated));
}

export async function cmdWorkspaceFree(
  db: Db,
  agent: string,
  opts: { commit?: boolean; workstream?: string; json?: boolean },
): Promise<void> {
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false, workstream: ws });
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
  const wsName = await resolveWorkstream(opts.workstream);
  const ws = getWorkspaceForAgent(db, agent, wsName);
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

// ─── commander wiring ────────────────────────────────────────────────
//
// wireWorkspaceCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, WORKSTREAM_OPT, handle } from "../cli.js";

export function wireWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("VCS workspace commands (per-agent isolated working copies)");

  workspace
    .command("create <agent>")
    .description(
      "Create a fresh isolated working copy for an agent. Backend auto-detected (jj > sl > git > none) unless --backend overrides.",
    )
    .option("--backend <name>", "force a backend instead of auto-detecting (jj | sl | git | none)")
    .option("--from <ref>", "base the workspace on a specific commit / branch / changeset")
    .option("--project-root <path>", "override the project root to branch from (default: cwd)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        backend?: VcsBackendName;
        from?: string;
        projectRoot?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceCreate(db, agent, opts))();
    });

  workspace
    .command("list")
    .description("List workspaces in the current workstream (--all spans every workstream)")
    .option("--all", "list workspaces across every workstream")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceList(db, opts))();
    });

  workspace
    .command("free <agent>")
    .description(
      "Tear down an agent's workspace. With --commit, attempt to auto-commit pending changes first; without it, pending changes are lost.",
    )
    .option("--commit", "auto-commit pending changes before removing the workspace")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        commit?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceFree(db, agent, opts))();
    });

  workspace
    .command("path <agent>")
    .description(
      "Print the on-disk path of an agent's workspace. Usable as `cd $(mu workspace path foo)`.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdWorkspacePath(db, agent, opts))();
    });

  workspace
    .command("orphans")
    .description(
      "List on-disk workspace dirs in <state-dir>/workspaces/<workstream>/ that have no DB row. These block subsequent `--workspace` spawns; surfaced by bug_workspace_orphan_not_in_state. Cleanup recipe shown in Next: hints.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdWorkspaceOrphans(db, opts))();
    });
}
