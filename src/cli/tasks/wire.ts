// mu — `mu task` commander wiring.
//
// Pure glue: every `task.command(...)` definition lives here, so the
// per-verb modules in this cluster stay focused on behaviour. Imported
// by buildProgram() in src/cli.ts via the re-export hub at
// src/cli/tasks.ts.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import type { Command } from "commander";
import {
  JSON_OPT,
  TASK_SORT_KEYS,
  WORKSTREAM_OPT,
  handle,
  parseImpact,
  parseLines,
  parsePositiveNumber,
} from "../../cli.js";
import { TASK_STATUS_LIST } from "../../tasks.js";
import { cmdClaim, cmdTaskRelease, cmdTaskWait } from "./claim.js";
import { cmdTaskBlock, cmdTaskDelete, cmdTaskReparent, cmdTaskUnblock } from "./edges.js";
import { cmdTaskAdd, cmdTaskNote, cmdTaskNotes, cmdTaskShow, cmdTaskUpdate } from "./edit.js";
import { cmdTaskClose, cmdTaskDefer, cmdTaskOpen, cmdTaskReject } from "./lifecycle.js";
import { cmdTaskList, cmdTaskNext, cmdTaskOwnedBy } from "./queries.js";
import { cmdTaskTree } from "./tree.js";

export function wireTaskCommands(program: Command): void {
  const task = program.command("task").description("Task graph commands");

  task
    .command("add [id]")
    .description(
      "Add a task to the graph. The id positional is optional — if omitted, derived from --title via slugify (collisions get _2, _3, … suffixes). Auto-derived ids are capped at ~40 chars with a word-boundary cut, so long titles drop trailing clauses; pass the <id> positional explicitly to override.",
    )
    .requiredOption("-t, --title <title>", "task title")
    .requiredOption("-i, --impact <n>", "impact 1..100", parseImpact)
    .requiredOption("-e, --effort-days <days>", "effort in days (>0)", parsePositiveNumber)
    .option(
      "-b, --blocked-by <ids...>",
      "task ids that block this one (repeat or comma-separate; or both)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string | undefined) {
      const opts = (this as Command).opts() as {
        title: string;
        impact: number;
        effortDays: number;
        blockedBy?: string[];
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAdd(db, id, opts))();
    });

  // --sort key list shared across list/next/ready. `id` is the
  // historical default for `mu task list`; `roi` is the default for
  // `next`/`ready` (the "what should I do" verbs). The two time-based
  // keys (`recency` = updated_at DESC, `age` = created_at ASC) trigger
  // an extra `updated`/`created` column with relative timestamps so
  // the user sees the dimension they sorted by.
  const SORT_OPT_DESC = `sort key (${TASK_SORT_KEYS.join(" | ")})`;

  task
    .command("list")
    .description("List every task in the current workstream (id, status, ROI, owner)")
    .option(...WORKSTREAM_OPT)
    .option(
      "--status <status...>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive; repeat or comma-separate; or both)`,
    )
    .option("--sort <key>", `${SORT_OPT_DESC} (default id)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string[];
        sort?: string;
      };
      return handle((db) => cmdTaskList(db, opts))();
    });

  task
    .command("next")
    .description(
      "Show the next ready task(s) by ROI (impact / effort_days). The 'what should I do?' verb. Pass -n 0 for the unlimited 'what is doable?' shape (merged-in `task ready`).",
    )
    .option(
      "-n, --lines <k>",
      "how many top-K tasks to return (default 1; 0 = all ready)",
      parseLines,
    )
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(
      "--status <status...>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive; repeat or comma-separate; or both)`,
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
        sort?: string;
        status?: string[];
      };
      return handle((db) => cmdTaskNext(db, opts))();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks owned by an agent. Defaults to the current workstream (v5: agent names are per-workstream unique). Pass --all to surface every workstream's same-named worker. Excludes CLOSED by default — pass --include-closed for the full historical owner list.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(
      "--all",
      "surface every workstream's same-named agent (cross-workstream view; default scopes to current workstream)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).optsWithGlobals() as {
        json?: boolean;
        includeClosed?: boolean;
        all?: boolean;
        workstream?: string;
      };
      return handle((db) => cmdTaskOwnedBy(db, agent, opts))();
    });

  task
    .command("note <id> <text>")
    .description(
      "Append a note to a task. Author defaults to $MU_AGENT_NAME (env injected at spawn) > pane title > $USER > 'orchestrator'; pass --author to override. Single-quote the text (or use a quoted heredoc) to defer shell expansion of $VAR / $(...) / `cmd`; double quotes expand them in your shell before mu sees the note.",
    )
    .option("--author <name>", "override the auto-detected author label")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string, text: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        author?: string;
      };
      return handle((db) => cmdTaskNote(db, id, text, opts))();
    });

  task
    .command("show <id>")
    .description("Show a task: row + edges (blockers/dependents) + notes")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskShow(db, id, opts))();
    });

  task
    .command("tree <id>")
    .description(
      "ASCII tree of a task's blockers (default) or dependents (--down). Diamonds collapse to one render with an arrow marker.",
    )
    .option("--down", "render dependents (what this task blocks) instead of blockers")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        down?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskTree(db, id, opts))();
    });

  task
    .command("notes <id>")
    .description("List the notes attached to a task (oldest first)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskNotes(db, id, opts))();
    });

  // --evidence <text> on the four lifecycle verbs records what the
  // caller relied on (test output, command exit, observed file change)
  // in the auto-emitted event payload. The verb still trusts the
  // caller; the audit trail records what they said. First inch of
  // the "observed vs claimed state" distinction.
  const EVIDENCE_OPT = [
    "--evidence <text>",
    "record what the caller observed (e.g. 'tests pass: npm test exit 0'); appears verbatim in the event log",
  ] as const;

  task
    .command("close <id>")
    .description(
      "Mark a task CLOSED (idempotent). --if-ready no-ops unless every blocker is in a terminal status (CLOSED / REJECTED / DEFERRED) — the umbrella-on-wave-done pattern.",
    )
    .option(
      "--if-ready",
      "only close when every blocker is terminal (CLOSED / REJECTED / DEFERRED); otherwise no-op + list the still-blocking ids",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        ifReady?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskClose(db, id, opts))();
    });

  task
    .command("open <id>")
    .description("Mark a task OPEN — e.g. to reopen something closed by mistake (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskOpen(db, id, opts))();
    });

  task
    .command("reject <id>")
    .description(
      "Mark a task REJECTED — terminal 'won't do' (out of scope, duplicate, wontfix). Refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReject(db, id, opts))();
    });

  task
    .command("defer <id>")
    .description(
      "Mark a task DEFERRED — parked, may revisit. Like reject, doesn't satisfy a blocked-by edge; refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskDefer(db, id, opts))();
    });

  task
    .command("release <id>")
    .description(
      "Clear a task's owner. IN_PROGRESS auto-flips to OPEN so the task re-enters the ready set; other statuses preserved. Use --reopen to force OPEN from CLOSED/REJECTED/DEFERRED. Idempotent.",
    )
    .option(
      "--reopen",
      "force status to OPEN regardless of current status (escape hatch for un-closing a CLOSED owned task in one verb)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        reopen?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskRelease(db, id, opts))();
    });

  task
    .command("claim <id>")
    .description(
      "Claim a task. Default: derive agent from $TMUX_PANE's title (must be a registered worker). " +
        "Use --for <worker> to dispatch. Use --self for orchestrator-direct work (anonymous claim, owner=NULL, actor recorded in agent_logs).",
    )
    .option(
      "-f, --for <agent>",
      "claim on behalf of a registered worker (dispatch); accepts bare 'name' (resolves in the task's workstream) or qualified '<workstream>/<name>' for cross-workstream dispatch (e.g. 'roadmap-v0-3/worker-1')",
    )
    .option(
      "--self",
      "anonymous claim (orchestrator pattern): owner stays NULL; actor recorded in agent_logs.source. Mutually exclusive with --for.",
    )
    .option(
      "--actor <name>",
      "override the actor name used for the log (only valid with --self; defaults to pane title or $USER)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (taskId: string) {
      const opts = (this as Command).opts() as {
        for?: string;
        self?: boolean;
        actor?: string;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdClaim(db, taskId, opts))();
    });

  task
    .command("block <blocked>")
    .description(
      "Add a blocking edge: <blocker> --by <id> blocks <blocked>. Validates same-workstream + cycle.",
    )
    .requiredOption("-b, --by <blocker>", "the task that should block <blocked>")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlock(db, blocked, opts))();
    });

  task
    .command("unblock <blocked>")
    .description("Remove a single blocking edge (idempotent)")
    .requiredOption("-b, --by <blocker>", "the task whose blocker edge to remove")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskUnblock(db, blocked, opts))();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task (cascades edges + notes via FK). Two-phase: bare = dry-run preview; --yes commits. Idempotent on missing. Auto-snapshots before the commit; `mu undo --yes` reverts (DB only).",
    )
    .option("-y, --yes", "actually delete (without --yes prints a dry-run preview)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        yes?: boolean;
      };
      return handle((db) => cmdTaskDelete(db, id, opts))();
    });

  task
    .command("update <id>")
    .description(
      "Update scalar fields on a task. Pass at least one of --title, --impact, --effort-days. Use close/open/release for status/owner changes.",
    )
    .option("-t, --title <title>", "new title")
    .option("-i, --impact <n>", "new impact 1..100", parseImpact)
    .option("-e, --effort-days <days>", "new effort in days (>0)", parsePositiveNumber)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        title?: string;
        impact?: number;
        effortDays?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUpdate(db, id, opts))();
    });

  task
    .command("reparent <id>")
    .description(
      "Atomically replace every incoming edge of <id> with the new --blocked-by list. Pass --blocked-by '' to clear all blockers.",
    )
    .requiredOption(
      "-b, --blocked-by <ids...>",
      "tasks that block <id> (repeat or comma-separate; or both; pass an empty string to clear)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string[];
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReparent(db, id, opts))();
    });

  task
    .command("wait <ids...>")
    .description(
      "Block until the listed tasks reach --status (default CLOSED). Each <id> may be bare (resolves via -w / $MU_SESSION / tmux) or qualified `<workstream>/<name>` (cross-workstream waits don't need -w). Default: every task must reach the target (--all). --any / --first exit on the first one that does; --first additionally prints the firing ref's qualified id to stdout. Exit 0 = condition met; 5 = timeout; 6 = a watched task was reaper-flipped IN_PROGRESS→OPEN (target=CLOSED only).",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option("--any", "succeed as soon as ONE listed task reaches the target (default: all must)")
    .option(
      "--first",
      "alias for --any that ALSO prints the firing ref's qualified id to stdout (--json adds a `firing` field). Use to drive a single-shot dispatch loop: `closed=$(mu task wait a b --first --json | jq -r .firing.qualifiedId)`.",
    )
    .option("--timeout <seconds>", "max seconds to wait (0 = forever, default 600)", parseLines)
    .option(
      "--stuck-after <seconds>",
      "emit a yellow STUCK warning to stderr when an IN_PROGRESS task's owner has been in needs_input for >= N seconds since their last status change (0 = disable, default 300). Surfaces the agent_close_discipline_gap pattern: worker finished + committed but skipped `mu task close <id>`. Wait keeps polling — the warning is observation-only.",
      parseLines,
    )
    .option(
      "--on-stall <action>",
      "what to do when --stuck-after fires: 'warn' (default; today's behaviour: yellow STUCK warning + corroborating agent_logs event; wait keeps polling) or 'exit' (same emit + persist, then exit 7 = STALL_DETECTED so an unattended orchestrator can branch on the idle-vs-dead distinction). Suppressed when --status is anything other than CLOSED (mirrors exit-6's carve-out). If exit-6 (dead pane) and exit-7 (stall) would fire in the same poll, exit 6 wins (dead pane is unambiguous; stall is ambiguous).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        first?: boolean;
        timeout?: number;
        stuckAfter?: number;
        onStall?: "warn" | "exit";
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskWait(db, ids, opts))();
    });
}
