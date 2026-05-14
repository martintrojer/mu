---
id: "bug_workspace_orphaned_after_agent_close"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-08T07:52:30.419Z"
updated_at: "2026-05-08 08:59:00"
blocked_by: []
blocks: []
---

# BUG: mu agent close cascades vcs_workspaces row but leaves the on-disk dir orphaned

## Notes (4)

### #1 by null, 2026-05-08T07:52:30.531Z

```
SURFACED during the multi-agent dogfood teardown.

Reproduction:
  mu agent spawn worker-a -w X --workspace
  mu agent close worker-a -w X            # FK CASCADE drops vcs_workspaces row
  mu workspace free worker-a -w X         # now sees no row; reports {removed: false}
  ls ~/.local/state/mu/workspaces/X/      # worker-a/ is still there

mu agent close intentionally does NOT touch the workspace (commit be15fdf:
'agents: stop auto-freeing workspaces on mu agent close'). The CHANGELOG
for that change argues that workspaces are valuable artifacts an operator
might want to preserve / commit / inspect after the agent dies.

But that intent is silently broken because the FK ON DELETE CASCADE
on vcs_workspaces.agent (introduced when the FKs were added) drops
the registry row when the agent row is deleted. The on-disk dir survives
but is now invisible to mu workspace list / free / path.

Net result:
  - The dir occupies disk forever (never reaped).
  - mu workspace free can't help — it queries vcs_workspaces.
  - User has to rm -rf manually OR run mu workspace free BEFORE close.

Three possible fixes:

  (a) Drop the ON DELETE CASCADE on vcs_workspaces.agent so the row
      survives agent close. Workspace becomes a "ghost" pointing at a
      dead agent name. mu workspace list shows it. mu workspace free
      cleans it up.
      + Most consistent with the be15fdf intent.
      - The agent name FK becomes a soft reference (we just hardened
        all FKs on the migration to ON UPDATE CASCADE). Inconsistent.

  (b) When mu agent close runs, BEFORE the agent DELETE, rename the
      vcs_workspaces row's agent column to '<name>_orphan' (or NULL).
      Workspace stays in the registry but unattached. mu workspace
      list shows it as orphaned.
      - Requires schema change (agent column needs to be nullable, or
        a rename pattern).

  (c) Make mu agent close also rm -rf the workspace dir. Reverts
      be15fdf. Loses the artifact-preservation property.

  (d) Document the gotcha + add a guard to mu agent close: if the
      agent has a workspace, refuse close unless --discard-workspace
      is passed. Forces the user to run mu workspace free FIRST or to
      explicitly accept loss.
      + Surfaces the issue at the right moment.
      - Adds a flag.

I lean (a) — drop the cascade. The schema's preferred policy is
SET NULL where the relationship is optional; vcs_workspaces.agent
is a real entity reference but the workspace's lifetime is allowed
to outlast the agent (per be15fdf). SET NULL on agent would let
mu workspace list see {agent: NULL, path: '...', workstream: '...'};
mu workspace free could then take the workstream + the orphaned
path.

But that needs a v3 schema migration (rebuild vcs_workspaces with
ON DELETE SET NULL + agent column made nullable). Smallish migration
relative to v1->v2 but non-trivial.

Alternative cheap fix: option (d). One flag, one validation in the
SDK closeAgent path, no schema change. Documented behaviour:
  mu agent close worker-1
  -> error: agent has a workspace (/path/to/workspace).
     Either run 'mu workspace free worker-1' first, or pass
     --discard-workspace to lose it.

Promotion: hit on FIRST multi-agent dogfood teardown. Disk-leak
class of bug; promotion-by-occurrence applies but the cost-per-
occurrence is low (a few MB per orphaned workspace) so I lean
'file but defer' until snapshots/undo work is on the table (they'll
need to consider workspace lifetime anyway).
```

### #2 by null, 2026-05-08T08:50:55.661Z

```
FILES: mu CLI/runtime behavior observed after closing worker-1 in infer-rs.
COMMANDS: mu agent close worker-1 -w infer-rs; mu state -w infer-rs --json; ls -ld ~/.local/state/mu/workspaces/infer-rs/worker-1.
FINDINGS: Duplicate/extra evidence for this existing bug: agent close reported 'Workspace kept on disk. Run mu workspace free worker-1...' but mu state showed no registered workspaces, while the workspace directory still existed on disk. Normal cleanup was ambiguous and required manual rm -rf after verifying artifacts were preserved.
DECISION: Added evidence instead of creating a duplicate task.
NEXT: agent close should either leave a workspace registry row that workspace free can act on, or print an unregistered-directory cleanup command/status.
VERIFIED: Also logged in infer-rs event #250/process note.
ODDITIES: May relate to workspace registry migration or agent close dropping rows before workspace cleanup.
```

### #3 by null, 2026-05-08T08:59:00.654Z

```
FILES: mu task metadata.
COMMANDS: mu sql UPDATE tasks SET workstream='mufeedback' ...
FINDINGS: Moved from roadmap-v0-2 to mufeedback per user request. Note this overlaps with mufeedback/agent_close_orphans_workspace_dir_from.
DECISION: Preserve moved closed task as historical duplicate/evidence rather than deleting.
NEXT: Triage/merge duplicates if desired.
VERIFIED: task show/list in mufeedback after move.
ODDITIES: Moved via mu sql because mu has no typed task-move verb.
```

### #4 by "π - infer-rs", 2026-05-08T13:01:06.023Z

```
FILES: cross-reference from infer-rs incident on 2026-05-08.
FINDINGS: Related newer reports: bug_workspace_orphan_not_in_state captures that orphan workspace dirs are invisible in mu state/workspace list but block spawn; bug_agent_spawn_workspace_aborts_without_status captures a fresh spawn that created sil-1 workspace dir, no pane/DB row, and no stderr/stdout diagnostic. The practical effect is the same family as this older bug: workspace lifecycle can orphan dirs and make future spawns fail.
NEXT: When fixing this family, cover all three user-visible cases: agent close leaves workspace dirs; state/list does not show orphan dirs; failed spawn can create a new orphan and abort without diagnostics.
VERIFIED: See notes on bug_workspace_orphan_not_in_state and bug_agent_spawn_workspace_aborts_without_status for exact commands/artifacts.
```
