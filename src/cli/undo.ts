// mu — `mu undo [group]`: revert one action by emitting inverse ops.
//
// The verb disappeared in v9 along with src/cli/snapshot.ts (it lived
// there, not in its own module), so this re-wires it on the new
// substrate. Semantics are entirely different: the old undo swapped the whole DB
// file back to a snapshot, reverting unrelated workstreams too. This
// emits inverse ops for ONE group.
//
// Shaped to the repo's established conventions:
//   * DRY RUN BY DEFAULT, `--yes` to apply — same as `workstream teardown`.
//   * No argument means "tell me what you WOULD undo", never "guess and
//     do it". It lists recent groups so the ids are discoverable without
//     needing `mu log` (whose group surface is v2-log-verb's).
//   * `--json` shape + a `Next:` block on every path.

import { emitJson, handle, JSON_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import {
  type GroupSummary,
  listRecentGroups,
  NothingToUndoError,
  planUndo,
  resolveGroupId,
  type UndoPlan,
  undoGroup,
} from "../undo.js";

export interface UndoCmdOptions {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
  /** How many groups to list when no group is named. */
  limit?: number;
}

const short = (id: string): string => id.slice(0, 8);

function describeGroup(group: GroupSummary): string {
  const what = group.intents.length > 0 ? group.intents.join(", ") : "(no intent)";
  const actor = group.actor !== null && group.actor !== "" ? ` by ${group.actor}` : "";
  return `${what}${actor} — ${group.ops} op${group.ops === 1 ? "" : "s"}`;
}

/** Steps that make the next move obvious from wherever the operator is. */
function nextStepsForPlan(plan: UndoPlan, applied: boolean, undoGroupId?: string): NextStep[] {
  if (!applied) {
    return [
      { intent: "Apply this undo", command: `mu undo ${short(plan.groupId)} --yes` },
      { intent: "Inspect the group's ops", command: `mu log --group ${short(plan.groupId)}` },
    ];
  }
  return [
    {
      intent: "Redo (undo the undo)",
      command: `mu undo ${undoGroupId === undefined ? "<group>" : short(undoGroupId)} --yes`,
    },
    { intent: "Verify the log and tables still agree", command: "mu doctor --deep" },
  ];
}

/** No group named: show what undo WOULD target, plus recent groups so the
 *  ids are discoverable. */
function listGroups(db: Db, opts: UndoCmdOptions): void {
  const groups = listRecentGroups(db, opts.limit ?? 10);
  if (groups.length === 0) throw new NothingToUndoError();

  const target = groups[0];
  if (target === undefined) throw new NothingToUndoError();

  if (opts.json === true) {
    emitJson({
      target: {
        groupId: target.groupId,
        intents: target.intents,
        ops: target.ops,
        when: target.when,
      },
      groups: groups.map((g) => ({
        groupId: g.groupId,
        intents: g.intents,
        actor: g.actor,
        ops: g.ops,
        when: g.when,
      })),
      nextSteps: [
        {
          intent: "Preview undoing the most recent action",
          command: `mu undo ${short(target.groupId)}`,
        },
      ],
    });
    return;
  }

  console.log(`${pc.bold("mu undo")} — most recent undoable action:`);
  console.log(`  ${pc.bold(short(target.groupId))}  ${describeGroup(target)}`);
  console.log("");
  console.log(pc.dim("recent groups (newest first):"));
  for (const group of groups) {
    const marker = group.groupId === target.groupId ? pc.green("*") : " ";
    console.log(`  ${marker} ${pc.bold(short(group.groupId))}  ${pc.dim(describeGroup(group))}`);
  }
  printNextSteps([
    {
      intent: "Preview undoing the most recent action",
      command: `mu undo ${short(target.groupId)}`,
    },
    { intent: "Preview a specific group", command: "mu undo <group>" },
  ]);
}

function printPlan(plan: UndoPlan): void {
  const what = plan.intents.length > 0 ? plan.intents.join(", ") : "(no intent)";
  console.log(`${pc.bold("mu undo")} ${short(plan.groupId)} — would revert ${pc.bold(what)}`);
  if (plan.inverses.length === 0) {
    console.log(pc.yellow("  nothing to revert (already undone, or the group changed nothing)"));
    return;
  }
  for (const inverse of plan.inverses) {
    const verb = inverse.op === "del" ? pc.red("delete ") : pc.green("restore");
    console.log(`  ${verb} ${inverse.summary}`);
  }
  if (plan.skipped > 0) {
    console.log(pc.dim(`  (${plan.skipped} op(s) need no inverse)`));
  }
  if (plan.superseded) {
    console.log("");
    console.log(pc.yellow("  WARNING: this group has been SUPERSEDED by later work."));
    for (const inverse of plan.inverses) {
      for (const conflict of inverse.supersededBy) {
        const field = conflict.field === "<row>" ? "the row" : conflict.field;
        console.log(
          pc.yellow(
            `    ${inverse.key}: ${field} was changed since by ${short(conflict.groupId)}` +
              `${conflict.intent === null ? "" : ` (${conflict.intent})`}`,
          ),
        );
      }
    }
    console.log(
      pc.dim("  Undoing would DISCARD that newer work. Pass --force with --yes to do it anyway."),
    );
  }
}

export async function cmdUndo(
  db: Db,
  groupRef: string | undefined,
  opts: UndoCmdOptions = {},
): Promise<void> {
  // No argument: report, never guess. Listing the groups is also how the
  // ids become discoverable.
  if (groupRef === undefined) {
    listGroups(db, opts);
    return;
  }

  const groupId = resolveGroupId(db, groupRef);

  // Dry run by default (the `workstream teardown` / `db import` pattern).
  if (opts.yes !== true) {
    const plan = planUndo(db, groupId);
    if (opts.json === true) {
      emitJson({
        dryRun: true,
        groupId: plan.groupId,
        intents: plan.intents,
        when: plan.when,
        superseded: plan.superseded,
        inverses: plan.inverses,
        skipped: plan.skipped,
        nextSteps: nextStepsForPlan(plan, false),
      });
      return;
    }
    printPlan(plan);
    console.log(pc.dim("\n(dry-run; rerun with --yes to apply)"));
    printNextSteps(nextStepsForPlan(plan, false));
    return;
  }

  const result = undoGroup(db, groupId, {
    ...(opts.force === true ? { force: true } : {}),
  });

  if (opts.json === true) {
    emitJson({
      dryRun: false,
      groupId: result.plan.groupId,
      intents: result.plan.intents,
      undoGroupId: result.undoGroupId,
      applied: result.applied,
      inverses: result.plan.inverses,
      forced: opts.force === true,
      nextSteps: nextStepsForPlan(result.plan, true, result.undoGroupId),
    });
    return;
  }

  const what = result.plan.intents.length > 0 ? result.plan.intents.join(", ") : "(no intent)";
  console.log(`Undid ${pc.bold(short(result.plan.groupId))} (${what})`);
  for (const inverse of result.plan.inverses) {
    console.log(pc.dim(`  ${inverse.summary}`));
  }
  console.log(
    pc.dim(
      `  ${result.applied} row change(s), recorded as group ${pc.bold(short(result.undoGroupId))}`,
    ),
  );
  if (opts.force === true && result.plan.superseded) {
    console.log(pc.yellow("  --force: newer edits to those fields were discarded."));
  }
  // The undo is itself an op in its own group, so redo is just undo.
  console.log(pc.dim(`  This undo is itself undoable: mu undo ${short(result.undoGroupId)} --yes`));
  printNextSteps(nextStepsForPlan(result.plan, true, result.undoGroupId));
}

// ─── commander wiring ────────────────────────────────────────────────

import type { Command } from "commander";

export function wireUndoCommand(program: Command): void {
  program
    .command("undo [group]")
    .description(
      "Revert one action by emitting inverse ops (dry-run by default; --yes applies). " +
        "With no group, lists recent undoable actions.",
    )
    .option(...JSON_OPT)
    .option("--yes", "actually apply the inverse (default is a dry run)")
    .option("--force", "apply even when the group was superseded by later work (discards it)")
    .option("-n, --limit <n>", "how many recent groups to list", (v) => Number.parseInt(v, 10))
    .action(function (group: string | undefined) {
      const opts = (this as Command).opts() as UndoCmdOptions;
      return handle((db) => cmdUndo(db, group, opts), this as Command)();
    });
}
