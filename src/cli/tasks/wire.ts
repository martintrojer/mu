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
import {
  cmdTaskBlocked,
  cmdTaskGoals,
  cmdTaskList,
  cmdTaskNext,
  cmdTaskOwnedBy,
  cmdTaskReady,
  cmdTaskSearch,
} from "./queries.js";
import { cmdTaskTree } from "./tree.js";

export function wireTaskCommands(program: Command): void {
  const task = program.command("task").description("Task graph commands");

  task
    .command("add [id]")
    .description(
      "Add a task to the graph. The id positional is optional — if omitted, derived from --title via slugify (collisions get _2, _3, … suffixes).",
    )
    .requiredOption("-t, --title <title>", "task title")
    .requiredOption("-i, --impact <n>", "impact 1..100", parseImpact)
    .requiredOption("-e, --effort-days <days>", "effort in days (>0)", parsePositiveNumber)
    .option(
      "-b, --blocked-by <ids>",
      "comma-separated task ids that block this one (this task is blocked by them)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string | undefined) {
      const opts = (this as Command).opts() as {
        title: string;
        impact: number;
        effortDays: number;
        blockedBy?: string;
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
      "--status <status>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive)`,
    )
    .option("--sort <key>", `${SORT_OPT_DESC} (default id)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string;
        sort?: string;
      };
      return handle((db) => cmdTaskList(db, opts))();
    });

  task
    .command("next")
    .description(
      "Show the next ready task(s) by ROI (impact / effort_days). The 'what should I do?' verb.",
    )
    .option("-n, --lines <k>", "how many top-K tasks to return (default 1)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
        sort?: string;
      };
      return handle((db) => cmdTaskNext(db, opts))();
    });

  task
    .command("ready")
    .description("List ready tasks (OPEN with all blockers CLOSED), sorted by ROI")
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        sort?: string;
      };
      return handle((db) => cmdTaskReady(db, opts))();
    });

  task
    .command("blocked")
    .description("List blocked tasks (OPEN with at least one non-CLOSED blocker)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlocked(db, opts))();
    });

  task
    .command("goals")
    .description("List tasks with no dependents (graph endpoints; excludes CLOSED)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskGoals(db, opts))();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks currently owned by an agent (cross-workstream; agent names are global). Excludes CLOSED by default — pass --include-closed for the full historical owner list.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdTaskOwnedBy(db, agent, opts))();
    });

  task
    .command("search <pattern>")
    .description(
      "Substring search on task title and id (case-insensitive). Use --in-notes to also search note content; --all to span all workstreams.",
    )
    .option("--in-notes", "also search task_notes.content")
    .option("--all", "search across all workstreams (default: current)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (pattern: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        all?: boolean;
        inNotes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdTaskSearch(db, pattern, opts))();
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
    .description("Mark a task CLOSED (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
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
      "Clear a task's owner; pass --reopen to also flip status back to OPEN (idempotent)",
    )
    .option("--reopen", "also flip status back to OPEN")
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
    .option("-f, --for <agent>", "claim on behalf of a registered worker (dispatch)")
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
      "Delete a task. Cascades to task_edges and task_notes via FK. Idempotent on missing.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
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
      "-b, --blocked-by <ids>",
      "comma-separated tasks that block <id> (empty string clears all)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReparent(db, id, opts))();
    });

  task
    .command("wait <ids...>")
    .description(
      "Block until the listed tasks reach --status (default CLOSED). Default: every task must reach the target (--all). Pass --any to exit on the first one that does. Exit 0 = condition met; 5 = timeout.",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option("--any", "succeed as soon as ONE listed task reaches the target (default: all must)")
    .option("--timeout <seconds>", "max seconds to wait (0 = forever, default 600)", parseLines)
    .option(
      "--stuck-after <seconds>",
      "emit a yellow STUCK warning to stderr when an IN_PROGRESS task's owner has been in needs_input for >= N seconds since their last status change (0 = disable, default 300). Surfaces the agent_close_discipline_gap pattern: worker finished + committed but skipped `mu task close <id>`. Wait keeps polling — the warning is observation-only.",
      parseLines,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        timeout?: number;
        stuckAfter?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskWait(db, ids, opts))();
    });
}
