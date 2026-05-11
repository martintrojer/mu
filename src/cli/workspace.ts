// mu — `mu workspace` verbs (create / list / free / path / orphans).
//
// Per-agent VCS workspaces (registry layer on top of vcs.ts).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  assertAgentInWorkstream,
  emitJson,
  emitJsonCollection,
  formatWorkspacesTable,
  resolveEntityRef,
  resolveWorkstream,
} from "../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import type { VcsBackendName } from "../vcs.js";
import {
  type StrandedWorkspaceOrphan,
  WorkspaceNotFoundError,
  createWorkspace,
  decorateWithStaleness,
  freeWorkspace,
  getWorkspaceForAgent,
  listAllOrphanWorkspaces,
  listCommitsForWorkspace,
  listWorkspaceOrphans,
  listWorkspaces,
  refreshWorkspace,
} from "../workspace.js";

export async function cmdWorkspaceCreate(
  db: Db,
  rawAgent: string,
  opts: {
    workstream?: string;
    backend?: VcsBackendName;
    from?: string;
    projectRoot?: string;
    json?: boolean;
  },
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
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
    `Created workspace ${pc.bold(ws.path)} ${pc.dim(`(backend=${ws.backend}, agent=${ws.agentName}, parent=${ws.parentRef ?? "—"})`)}`,
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
    emitJsonCollection(decorated);
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
  rawAgent: string,
  opts: { commit?: boolean; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false, workstream: ws });
  if (opts.json) {
    emitJson({ agentName: agent, ...r });
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

export async function cmdWorkspaceRefresh(
  db: Db,
  rawAgent: string,
  opts: { workstream?: string; from?: string; json?: boolean } = {},
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const workstream = await resolveWorkstream(opts.workstream);
  const refreshOpts: Parameters<typeof refreshWorkspace>[1] = { agent, workstream };
  if (opts.from !== undefined) refreshOpts.fromRef = opts.from;
  const r = await refreshWorkspace(db, refreshOpts);
  const nextSteps: NextStep[] = [
    {
      intent: "cd into the refreshed workspace",
      command: `cd $(mu workspace path ${agent} -w ${workstream})`,
    },
    {
      intent: "List commits replayed on top of the new base",
      command: `mu workspace commits ${agent} -w ${workstream}`,
    },
  ];
  if (opts.json) {
    emitJson({ agent, ...r, nextSteps });
    return;
  }
  if (r.replayed.length === 0) {
    console.log(`Workspace ${pc.bold(agent)} already at ${pc.dim(r.fromRef)} — nothing to replay.`);
  } else {
    console.log(
      `Refreshed workspace ${pc.bold(agent)} onto ${pc.dim(r.fromRef)} ${pc.dim(`(backend=${r.vcs}, ${r.replayed.length} commit${r.replayed.length === 1 ? "" : "s"} replayed)`)}`,
    );
    for (const subject of r.replayed) {
      console.log(`  ${pc.dim("•")} ${subject}`);
    }
  }
  printNextSteps(nextSteps);
}

export async function cmdWorkspaceCommits(
  db: Db,
  rawAgent: string,
  opts: { workstream?: string; since?: string; json?: boolean } = {},
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const workstream = await resolveWorkstream(opts.workstream);
  const listOpts: Parameters<typeof listCommitsForWorkspace>[2] = { workstream };
  if (opts.since !== undefined) listOpts.since = opts.since;
  const r = await listCommitsForWorkspace(db, agent, listOpts);
  if (opts.json) {
    emitJsonCollection(r.commits);
    return;
  }
  if (r.commits.length === 0) {
    console.log(pc.dim(`(no commits in ${agent} since ${r.baseRef.slice(0, 12)})`));
    return;
  }
  // Plain `<sha> <subject>` per line, oldest-first — the format the
  // dogfood incantation produced via `git log --oneline base..HEAD`.
  // Stays grep/awk/jq-friendly without --json.
  for (const c of r.commits) {
    console.log(`${c.sha} ${c.subject}`);
  }
}

export async function cmdWorkspacePath(
  db: Db,
  rawAgent: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const wsName = await resolveWorkstream(opts.workstream);
  const ws = getWorkspaceForAgent(db, agent, wsName);
  if (!ws) throw new WorkspaceNotFoundError(agent);
  if (opts.json) {
    emitJson({ agentName: agent, path: ws.path, backend: ws.backend });
    return;
  }
  // Print just the path, no decoration: usable for `cd $(mu workspace path X)`.
  console.log(ws.path);
}

export async function cmdWorkspaceOrphans(
  db: Db,
  opts: { workstream?: string; all?: boolean; json?: boolean } = {},
): Promise<void> {
  // --all overrides scope: ignore -w and scan every workstream subdir
  // under <state-dir>/workspaces/, INCLUDING workstreams whose row is
  // gone (those orphans get `stranded: true`). See
  // workspace_orphans_misses_destroyed_workstreams.
  if (opts.all === true) {
    const orphans = listAllOrphanWorkspaces(db);
    const sample = orphans[0];
    const nextSteps: NextStep[] =
      sample === undefined
        ? []
        : [
            {
              intent: "Remove a specific orphan dir (git: also prunes worktree registry)",
              command: `(cd <project-root> && git worktree remove --force ${sample.path}) || rm -rf ${sample.path}`,
            },
          ];
    if (opts.json) {
      // audit_json_envelope_uniformity: collection envelope plus the
      // sibling nextSteps field. workstreamName is omitted because
      // --all spans the whole state dir.
      emitJson({ items: orphans, count: orphans.length, nextSteps });
      return;
    }
    if (orphans.length === 0) {
      console.log(pc.dim("(no orphan workspace dirs across all workstreams)"));
      return;
    }
    console.log(pc.yellow(`${orphans.length} orphan workspace dir(s) across all workstreams:`));
    const grouped = new Map<string, StrandedWorkspaceOrphan[]>();
    for (const o of orphans) {
      const list = grouped.get(o.workstreamName) ?? [];
      list.push(o);
      grouped.set(o.workstreamName, list);
    }
    for (const [wsName, list] of grouped) {
      const sampleEntry = list[0];
      const strandedTag =
        sampleEntry?.stranded === true ? pc.red(" (stranded: workstream destroyed)") : "";
      console.log(`  ${pc.bold(wsName)}${strandedTag}`);
      for (const o of list) {
        console.log(`    ${pc.bold(o.agentName)}  ${pc.dim(o.path)}`);
      }
    }
    printNextSteps(nextSteps);
    return;
  }

  const workstream = await resolveWorkstream(opts.workstream);
  // Tighten resolution: a typo'd or destroyed workstream name used to
  // happy-path to "no orphans" because listWorkspaceOrphans returns []
  // when the dir doesn't exist. Match the mutating verbs and surface
  // WorkstreamNotFoundError (exit 3) instead. See
  // workspace_orphans_misses_destroyed_workstreams option C.
  if (tryResolveWorkstreamId(db, workstream) === null) {
    throw new WorkstreamNotFoundError(workstream);
  }
  const orphans = listWorkspaceOrphans(db, workstream);
  const nextSteps: NextStep[] =
    orphans.length === 0
      ? []
      : [
          {
            intent: "Remove a specific orphan dir (git: also prunes worktree registry)",
            command: `(cd <project-root> && git worktree remove --force ${orphans[0]?.path}) || rm -rf ${orphans[0]?.path}`,
          },
        ];
  if (opts.json) {
    // audit_json_envelope_uniformity: items + count for the
    // collection envelope; workstreamName + nextSteps as siblings.
    emitJson({
      workstreamName: workstream,
      items: orphans,
      count: orphans.length,
      nextSteps,
    });
    return;
  }
  if (orphans.length === 0) {
    console.log(pc.dim(`(no orphan workspace dirs in ${workstream})`));
    return;
  }
  console.log(pc.yellow(`${orphans.length} orphan workspace dir(s) in ${pc.bold(workstream)}:`));
  for (const o of orphans) {
    console.log(`  ${pc.bold(o.agentName)}  ${pc.dim(o.path)}`);
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
      return handle((db) => cmdWorkspaceCreate(db, agent, opts), this as Command)();
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
      return handle((db) => cmdWorkspaceList(db, opts), this as Command)();
    });

  workspace
    .command("refresh <agent>")
    .description(
      "Rebase an agent's workspace onto a fresh base WITHOUT touching the agent or pane. Default base = the backend's tracked main (origin/HEAD for git, trunk() for jj/sl); override with --from <ref>. Refuses on dirty WC (git/sl) with the file list and a Next: hint to commit/stash. On rebase conflict, leaves the workspace in a resolvable state and exits 5 with a `cd` hint. The `none` backend errors (refresh requires a real VCS).",
    )
    .option("--from <ref>", "override the rebase target (default: backend's tracked main)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        from?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceRefresh(db, agent, opts), this as Command)();
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
      return handle((db) => cmdWorkspaceFree(db, agent, opts), this as Command)();
    });

  workspace
    .command("commits <agent>")
    .description(
      "Print commits the agent's workspace has on top of its recorded parent_ref (the fork point), oldest-first. Default text output is `<sha> <subject>` per line; --json emits the full array `[{sha, subject, body, authorDate}]` for piping. --since <ref> overrides the base. The `none` backend errors (no fork point to compare against).",
    )
    .option("--since <ref>", "override the base ref (default: workspace's recorded parent_ref)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        since?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceCommits(db, agent, opts), this as Command)();
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
      return handle((db) => cmdWorkspacePath(db, agent, opts), this as Command)();
    });

  workspace
    .command("orphans")
    .description(
      "List on-disk workspace dirs in <state-dir>/workspaces/<workstream>/ that have no DB row. These block subsequent `--workspace` spawns; surfaced by bug_workspace_orphan_not_in_state. With --all, scans every workstream subdir under <state-dir>/workspaces/ INCLUDING workstreams whose row is gone (those rows are tagged `stranded: workstream destroyed`); --all overrides -w. With -w <unknown>, errors via WorkstreamNotFoundError (exit 3) instead of silently printing 'no orphans'. Cleanup recipe shown in Next: hints.",
    )
    .option(
      "--all",
      "scan every workstream subdir on disk (overrides -w; surfaces dirs whose workstream row is gone as `stranded`)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        all?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceOrphans(db, opts), this as Command)();
    });
}
