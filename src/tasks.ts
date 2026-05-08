// mu — task graph: CRUD primitives, verbs (addTask, addNote, claimTask),
// view reads (ready / blocked / goals), and DAG traversal helpers.
//
// The schema (db.ts) does the heavy lifting: PRIMARY KEYs, CHECK
// constraints on impact/effort/status, FK cascades on edges and notes.
// This module adds:
//   - the cycle check on edge insertion (SQL CHECK can't express it)
//   - the claim protocol (atomic CAS on tasks.owner via single UPDATE)
//   - row-shape mapping (snake_case columns → camelCase TS)

import type { Db } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { currentAgentName } from "./tmux.js";
import { ensureWorkstream } from "./workstream.js";

// ─── Domain types ──────────────────────────────────────────────────────

export type TaskStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "REJECTED" | "DEFERRED";

/** Every legal task status, in canonical order (matches the schema
 *  CHECK clause). Exported so CLI surfaces (`--status` validators,
 *  --help text, error messages) name them all in one place; missing
 *  one used to silently lie about the supported set. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "CLOSED",
  "REJECTED",
  "DEFERRED",
];

/** Statuses that count as 'no longer scheduled work' — used by the
 *  goals view and by the dependent-check on reject/defer.
 *
 *  (The complement — 'statuses that satisfy a blocked-by edge' — is
 *  just `["CLOSED"]` and is hardcoded inline in the SQL views in
 *  src/db.ts + src/migrations.ts. A constant for it was tried and
 *  reverted: a one-element array doesn't earn its keep, and
 *  parameterising the SQL views from a TS const would be brittle.) */
export const STATUSES_TERMINAL_OR_PARKED: readonly TaskStatus[] = [
  "CLOSED",
  "REJECTED",
  "DEFERRED",
];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Pipe-separated list of every legal status, e.g.
 *  'OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED'. Single source
 *  of truth for --help text and error messages so adding a new status
 *  doesn't leave stale lists rotting in the CLI surface. */
export const TASK_STATUS_LIST = TASK_STATUSES.join(" | ");

export interface TaskRow {
  localId: string;
  workstream: string;
  title: string;
  status: TaskStatus;
  impact: number;
  effortDays: number;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNoteRow {
  id: number;
  taskId: string;
  author: string | null;
  content: string;
  createdAt: string;
}

interface RawTaskRow {
  local_id: string;
  workstream: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTaskNoteRow {
  id: number;
  task_id: string;
  author: string | null;
  content: string;
  created_at: string;
}

function rowFromDb(row: RawTaskRow): TaskRow {
  return {
    localId: row.local_id,
    workstream: row.workstream,
    title: row.title,
    status: row.status as TaskStatus,
    impact: row.impact,
    effortDays: row.effort_days,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteFromDb(row: RawTaskNoteRow): TaskNoteRow {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    content: row.content,
    createdAt: row.created_at,
  };
}

// ─── ID validation ─────────────────────────────────────────────────────

/** Lowercase alpha first, then alnum / underscore / hyphen, ≤64 chars. */
const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** The `mu_` prefix is reserved for system-generated IDs. Mirrors
 *  `tg`'s `T<digits>` reservation. */
const RESERVED_PREFIX = "mu_";

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id) && !id.startsWith(RESERVED_PREFIX);
}

/**
 * Derive a task id from a free-form title.
 *
 *   "Build the auth module"      → "build_the_auth_module"
 *   "FILES: foo.ts (refactor)"   → "files_foo_ts_refactor"
 *
/**
 * Soft cap for auto-generated slugs. The collision-suffix loop in
 * idFromTitle can push past this (`_2`, `_3`, ...) without going past
 * the hard ceiling. 40 chars hits the sweet spot of 'short enough to
 * type and to look reasonable in mu task tree' without losing too
 * much of the title's meaning.
 */
const SLUG_SOFT_CAP = 40;

/**
 * Hard ceiling for any generated id. Schema has no length limit, but
 * 64 keeps ids comfortable in tables, JSON, and tmux pane titles. The
 * collision-suffix loop also respects this.
 */
const SLUG_HARD_CAP = 64;

/**
 * Lowercase title; collapse non-alnum runs into single `_`; trim
 * leading/trailing `_`; prefix `t_` if the result starts with a digit
 * (schema requires first char letter); apply the soft cap with
 * word-boundary trim (cut at the last `_` at-or-before SLUG_SOFT_CAP
 * when one exists, else hard-truncate). Mirrors `tg`'s `id_from_title`
 * but adds the soft cap.
 *
 * Throws if `title` yields an empty slug after stripping.
 */
export function slugifyTitle(title: string): string {
  const stripped = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (stripped.length === 0) {
    throw new Error(`title yields empty slug: ${JSON.stringify(title)}`);
  }
  // Soft cap with word-boundary preference: if the slug exceeds the
  // soft cap, look for the last `_` at-or-before the cap and cut there
  // (so we never break a word). If no underscore is in the cap window
  // (ie the title is one giant word), fall back to a hard truncate at
  // the soft cap. The result is always <= SLUG_SOFT_CAP after this.
  let trimmed: string;
  if (stripped.length <= SLUG_SOFT_CAP) {
    trimmed = stripped;
  } else {
    const window = stripped.slice(0, SLUG_SOFT_CAP);
    const lastSep = window.lastIndexOf("_");
    trimmed = lastSep > 0 ? window.slice(0, lastSep) : window;
  }
  // Two prefix-corrections so derived slugs always pass the schema:
  //  - first char must be a letter → prefix `t_` if it isn't
  //  - the `mu_` prefix is reserved for system-generated IDs (see
  //    RESERVED_PREFIX above) → prefix `t_` so titles like
  //    "Mu smoke test" don't dead-end at addTask's reserved-prefix
  //    check. The explicit-id rejection still applies when a caller
  //    hand-writes `mu_foo`.
  const fixed = /^[a-z]/.test(trimmed) ? trimmed : `t_${trimmed}`;
  const safe = fixed.startsWith(RESERVED_PREFIX) ? `t_${fixed}` : fixed;
  return safe.slice(0, SLUG_HARD_CAP);
}

/**
 * Generate a unique task id from a title. On collision in `workstream`,
 * appends `_2`, `_3`, … until unique. Tasks are keyed on `local_id`
 * globally today, so collision check spans every workstream (a future
 * composite-PK migration would scope this).
 */
export function idFromTitle(db: Db, workstream: string, title: string): string {
  const base = slugifyTitle(title);
  if (getTask(db, base) === undefined) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`.slice(0, SLUG_HARD_CAP);
    if (getTask(db, candidate) === undefined) return candidate;
  }
  throw new Error(`could not derive a unique id from title in workstream ${workstream}: ${title}`);
}

// ─── Errors ────────────────────────────────────────────────────────────

export class TaskNotFoundError extends Error implements HasNextSteps {
  override readonly name = "TaskNotFoundError";
  constructor(public readonly taskId: string) {
    super(`no such task: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List tasks in workstream", command: "mu task list -w <workstream>" },
      {
        intent: "Search by substring (id + title)",
        command: `mu task search ${this.taskId} --all`,
      },
      { intent: "Find which workstream owns it", command: `mu task search ${this.taskId} --all` },
    ];
  }
}

export class TaskExistsError extends Error implements HasNextSteps {
  override readonly name = "TaskExistsError";
  constructor(public readonly taskId: string) {
    super(`task already exists: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show the existing task", command: `mu task show ${this.taskId}` },
      {
        intent: "Update fields on the existing task",
        command: `mu task update ${this.taskId} --title "..." --impact <n> --effort-days <n>`,
      },
      {
        intent: "Pick a different id",
        command: 'mu task add <new-id> --title "..." --impact <n> --effort-days <n>',
      },
    ];
  }
}

/**
 * Thrown when a verb is invoked with `-w/--workstream <name>` but the
 * named task lives in a different workstream. Distinguishes "the user
 * typo'd the workstream" from "the task doesn't exist anywhere"
 * (which surfaces as `TaskNotFoundError`). Maps to exit code 4
 * (conflict / wrong scope).
 */
export class TaskNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "TaskNotInWorkstreamError";
  constructor(
    public readonly taskId: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`task ${taskId} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the correct workstream",
        command: `mu task show ${this.taskId} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List tasks in the requested workstream",
        command: `mu task list -w ${this.expectedWorkstream}`,
      },
    ];
  }
}

export class TaskAlreadyOwnedError extends Error implements HasNextSteps {
  override readonly name = "TaskAlreadyOwnedError";
  constructor(
    public readonly taskId: string,
    public readonly currentOwner: string,
  ) {
    super(`task ${taskId} is already owned by ${currentOwner}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "See the current owner's task list",
        command: `mu task owned-by ${this.currentOwner}`,
      },
      {
        intent: "Release the current claim (if you ARE the owner)",
        command: `mu task release ${this.taskId}`,
      },
      { intent: "Show full task state", command: `mu task show ${this.taskId}` },
    ];
  }
}

/**
 * Thrown by `rejectTask` / `deferTask` when the target task has
 * dependents that are still OPEN or IN_PROGRESS. Rejecting or
 * deferring such a task would silently strand the dependents (they'd
 * remain blocked by a prereq that's never going to satisfy the edge),
 * so we refuse and force an explicit decision: pass `--cascade` to
 * apply the same status to every transitive dependent, drop the
 * blocking edge first with `mu task unblock`, or address the
 * dependents individually. Maps to exit code 4.
 */
export class TaskHasOpenDependentsError extends Error implements HasNextSteps {
  override readonly name = "TaskHasOpenDependentsError";
  constructor(
    public readonly taskId: string,
    public readonly verb: "reject" | "defer",
    public readonly dependents: readonly string[],
  ) {
    super(
      `cannot ${verb} ${taskId}: ${dependents.length} open dependent(s) would be stranded (${dependents.slice(0, 5).join(", ")}${dependents.length > 5 ? ", …" : ""}). Pick one resolution and re-run.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: `Preview the cascade (lists dependents that would be ${this.verb}ed; --cascade alone is dry-run)`,
        command: `mu task ${this.verb} ${this.taskId} --cascade`,
      },
      {
        intent: `${this.verb.charAt(0).toUpperCase() + this.verb.slice(1)} the whole sub-tree (commit; rerun with --yes after previewing)`,
        command: `mu task ${this.verb} ${this.taskId} --cascade --yes`,
      },
      {
        intent: "Drop the blocking edge from a dependent first",
        command: `mu task unblock <dep> --not-blocked-by ${this.taskId}`,
      },
      {
        intent: "Address dependents individually first",
        command: `mu task ${this.verb} <dep>`,
      },
    ];
  }
}

/**
 * Thrown when `mu task claim` resolves a claimer agent name (from the
 * pane title or --for) that has no matching row in the agents table.
 *
 * The FK on `tasks.owner` references `agents.name`; without this guard
 * the claim attempt would fail with the unhelpful 'FOREIGN KEY constraint
 * failed' from SQLite. This typed error gives the user actionable next
 * steps (run `mu adopt <pane-id>` to register, or use --for to pick a
 * different agent).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class ClaimerNotRegisteredError extends Error implements HasNextSteps {
  override readonly name = "ClaimerNotRegisteredError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string | null,
  ) {
    const paneHint = paneId !== null ? ` (pane ${paneId})` : "";
    super(
      `claimer '${agentName}'${paneHint} is not a registered mu agent (no row in agents table)`,
    );
  }

  /**
   * Three actionable resolutions in expected-frequency order:
   *   1. --self  : orchestrator pattern (working directly)
   *   2. --for   : dispatcher pattern (assigning to a worker)
   *   3. mu adopt: registration pattern (promote pane to worker)
   */
  errorNextSteps(): NextStep[] {
    const steps: NextStep[] = [
      { intent: "Work directly (anonymous)", command: "mu task claim <id> --self" },
      { intent: "Dispatch to a worker", command: "mu task claim <id> --for <worker>" },
    ];
    steps.push(
      this.paneId !== null
        ? { intent: "Register this pane", command: `mu adopt ${this.paneId}` }
        : {
            intent: "Register a pane",
            command: "mu adopt <pane-id>  (must be in mu-<workstream> tmux session)",
          },
    );
    return steps;
  }
}

export class CycleError extends Error implements HasNextSteps {
  override readonly name = "CycleError";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`adding edge ${from} -> ${to} would create a cycle`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Show the dependency tree",
        command: `mu task tree ${this.to} --down`,
      },
      {
        intent: "Show the prereq tree (what blocks the from-task)",
        command: `mu task tree ${this.from}`,
      },
      {
        intent: "Remove an edge in the path to break the cycle",
        command: "mu task unblock <blocked> --by <blocker>",
      },
    ];
  }
}

export class CrossWorkstreamEdgeError extends Error implements HasNextSteps {
  override readonly name = "CrossWorkstreamEdgeError";
  constructor(
    public readonly blocker: string,
    public readonly blockerWorkstream: string,
    public readonly dependent: string,
    public readonly dependentWorkstream: string,
  ) {
    super(
      `cross-workstream edge: blocker '${blocker}' is in workstream '${blockerWorkstream}', dependent '${dependent}' is in workstream '${dependentWorkstream}'`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Move the blocker into the dependent's workstream",
        command: `mu sql "UPDATE tasks SET workstream='${this.dependentWorkstream}' WHERE local_id='${this.blocker}'"`,
      },
      {
        intent: "Or merge the two workstreams (rename one to the other)",
        command: `mu sql "UPDATE workstreams SET name='${this.dependentWorkstream}' WHERE name='${this.blockerWorkstream}'"`,
      },
      {
        intent: "Or duplicate the blocker (typed verb deferred)",
        command: `mu task add <new-id> -w ${this.dependentWorkstream} --title "<copy of ${this.blocker}>" --impact <n> --effort-days <n>`,
      },
    ];
  }
}

// ─── Read primitives ───────────────────────────────────────────────────

export function getTask(db: Db, localId: string): TaskRow | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE local_id = ?").get(localId) as
    | RawTaskRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

/**
 * List tasks. With no `workstream` arg returns every row — used by `mu sql`
 * and by tests; CLI surfaces always pass a workstream so users only see
 * their own.
 */
export interface ListTasksOptions {
  /** Filter to one or more lifecycle statuses. Omitted = all statuses. */
  status?: TaskStatus | readonly TaskStatus[];
}

export function listTasks(db: Db, workstream?: string, opts: ListTasksOptions = {}): TaskRow[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as TaskStatus[])
        : [opts.status as TaskStatus];

  const where: string[] = [];
  const params: unknown[] = [];
  if (workstream !== undefined) {
    where.push("workstream = ?");
    params.push(workstream);
  }
  if (statuses !== undefined) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const sql =
    where.length === 0
      ? "SELECT * FROM tasks ORDER BY local_id"
      : `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY local_id`;
  const rows = db.prepare(sql).all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listReady(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM ready WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listBlocked(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM blocked WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listGoals(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM goals WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listNotes(db: Db, taskId: string): TaskNoteRow[] {
  const rows = db
    .prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY id")
    .all(taskId) as RawTaskNoteRow[];
  return rows.map(noteFromDb);
}

/**
 * All tasks currently owned by `agent`, across every workstream
 * (agent names are PRIMARY KEY — globally unique — so this is
 * unambiguous). Sorted by workstream, then local_id.
 *
 * Defaults to **excluding CLOSED** since the verb's purpose is "what
 * is X currently working on?" and a closed task is no longer being
 * worked on. closeTask intentionally preserves `owner` as a
 * historical record (so audit/notes can attribute decisions); pass
 * `{ includeClosed: true }` to surface that history.
 *
 * Real bug found in real use: `mu task owned-by worker-1` was
 * returning CLOSED tasks alongside live ones, making it impossible
 * to tell at a glance what the agent was actually doing.
 */
export function listTasksByOwner(
  db: Db,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  // 'Live work' = not in any terminal-or-parked state. CLOSED is the
  // obvious one; REJECTED and DEFERRED are also off the agent's plate
  // (the user has decided 'won't do' or 'not now'). includeClosed
  // re-includes ALL of those so historical attribution is recoverable.
  const sql = opts.includeClosed
    ? "SELECT * FROM tasks WHERE owner = ? ORDER BY workstream, local_id"
    : "SELECT * FROM tasks WHERE owner = ? AND status NOT IN ('CLOSED', 'REJECTED', 'DEFERRED') ORDER BY workstream, local_id";
  const rows = db.prepare(sql).all(owner) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export interface SearchTasksOptions {
  /** Restrict to one workstream; undefined = search across all. */
  workstream?: string;
  /** Also search `task_notes.content` (default false: titles + ids only). */
  includeNotes?: boolean;
}

/**
 * Substring search on task `title` and `local_id`, case-insensitive.
 * With `includeNotes: true` also searches `task_notes.content`. The
 * pattern is wrapped in `%...%` automatically so callers don't need
 * SQL LIKE knowledge — for explicit globs (or regex), use `mu sql`.
 */
export function searchTasks(db: Db, pattern: string, opts: SearchTasksOptions = {}): TaskRow[] {
  const like = `%${pattern.toLowerCase()}%`;
  const wsClause = opts.workstream === undefined ? "" : "t.workstream = ? AND";
  const wsParams = opts.workstream === undefined ? [] : [opts.workstream];
  const orderBy =
    opts.workstream === undefined ? "ORDER BY t.workstream, t.local_id" : "ORDER BY t.local_id";

  if (opts.includeNotes) {
    const sql = `SELECT DISTINCT t.* FROM tasks t
                 LEFT JOIN task_notes n ON n.task_id = t.local_id
                 WHERE ${wsClause} (
                   LOWER(t.title) LIKE ?
                   OR LOWER(t.local_id) LIKE ?
                   OR LOWER(n.content) LIKE ?
                 )
                 ${orderBy}`;
    return (db.prepare(sql).all(...wsParams, like, like, like) as RawTaskRow[]).map(rowFromDb);
  }

  const sql = `SELECT t.* FROM tasks t
               WHERE ${wsClause} (LOWER(t.title) LIKE ? OR LOWER(t.local_id) LIKE ?)
               ${orderBy}`;
  return (db.prepare(sql).all(...wsParams, like, like) as RawTaskRow[]).map(rowFromDb);
}

export interface TaskEdges {
  /** Tasks that must close before this one can start (blockers). */
  blockers: string[];
  /** Tasks that this one blocks (dependents). */
  dependents: string[];
}

/**
 * Direct (one-hop) edges for a task. For transitive prerequisites, use
 * `getPrerequisites()`; this helper is the immediate-neighbour view used
 * by `mu task show`.
 */
export function getTaskEdges(db: Db, taskId: string): TaskEdges {
  const blockers = (
    db
      .prepare("SELECT from_task FROM task_edges WHERE to_task = ? ORDER BY from_task")
      .all(taskId) as { from_task: string }[]
  ).map((r) => r.from_task);
  const dependents = (
    db
      .prepare("SELECT to_task FROM task_edges WHERE from_task = ? ORDER BY to_task")
      .all(taskId) as { to_task: string }[]
  ).map((r) => r.to_task);
  return { blockers, dependents };
}

/**
 * All tasks transitively reachable from `taskId` via reverse-edge
 * traversal (i.e. the set of tasks that block this one), including the
 * task itself.
 */
export function getPrerequisites(db: Db, taskId: string): Set<string> {
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(node) AS (
         SELECT ?
         UNION
         SELECT from_task FROM task_edges, reach WHERE to_task = reach.node
       )
       SELECT node FROM reach`,
    )
    .all(taskId) as { node: string }[];
  return new Set(rows.map((r) => r.node));
}

// ─── Internal: cycle check ─────────────────────────────────────────────

/**
 * Adding edge `from -> to` creates a cycle iff there's already a path
 * `to -> ... -> from`. SQL recursive CTE expresses this exactly.
 */
function wouldCreateCycle(db: Db, from: string, to: string): boolean {
  if (from === to) return true;
  const result = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT ?
         UNION
         SELECT to_task FROM task_edges, forward WHERE from_task = forward.node
       )
       SELECT 1 AS hit FROM forward WHERE node = ? LIMIT 1`,
    )
    .get(to, from) as { hit: number } | undefined;
  return result !== undefined;
}

// ─── addTask (verb) ────────────────────────────────────────────────────

export interface AddTaskOptions {
  localId: string;
  workstream: string;
  title: string;
  /** 1..100; enforced by schema CHECK. */
  impact: number;
  /** > 0; enforced by schema CHECK. */
  effortDays: number;
  /**
   * Tasks that block this one. Edges inserted as `blocker -> newTask`.
   * Each blocker must already exist AND share this task's workstream
   * (cross-workstream edges are forbidden); cycle check guards each
   * edge. The CLI surfaces this as `--blocked-by`; the SDK key matches.
   */
  blockedBy?: string[];
}

/**
 * Atomically create a task and (optionally) its incoming blocked-by
 * edges.
 *
 * The task insert + every edge insert + cycle check happen inside one
 * SQLite transaction. If any blocker is missing or any edge would
 * create a cycle, the entire add rolls back.
 *
 * Cycle check for `addTask` is structurally trivial (a fresh task has
 * no outgoing edges, so `to -> ... -> from` is impossible). It's still
 * called here so the same primitive is exercised by tests.
 */
export function addTask(db: Db, opts: AddTaskOptions): TaskRow {
  if (opts.localId.startsWith("mu_")) {
    throw new TypeError(
      `invalid task id: ${JSON.stringify(opts.localId)} (the "mu_" prefix is reserved for system-generated IDs)`,
    );
  }
  if (!isValidTaskId(opts.localId)) {
    throw new TypeError(
      `invalid task id: ${JSON.stringify(opts.localId)} (expected /^[a-z][a-z0-9_-]{0,63}$/)`,
    );
  }
  if (getTask(db, opts.localId) !== undefined) {
    throw new TaskExistsError(opts.localId);
  }

  return db.transaction(() => {
    // Auto-create the workstream row so tasks.workstream FK is satisfied
    // (preserves the spawn-without-init ergonomics; see ensureWorkstream's docstring).
    ensureWorkstream(db, opts.workstream);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, created_at, updated_at)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    ).run(opts.localId, opts.workstream, opts.title, opts.impact, opts.effortDays, now, now);

    if (opts.blockedBy && opts.blockedBy.length > 0) {
      const blockerLookup = db.prepare("SELECT workstream FROM tasks WHERE local_id = ?");
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)",
      );
      for (const blocker of opts.blockedBy) {
        const row = blockerLookup.get(blocker) as { workstream: string } | undefined;
        if (!row) {
          throw new TaskNotFoundError(blocker);
        }
        if (row.workstream !== opts.workstream) {
          throw new CrossWorkstreamEdgeError(
            blocker,
            row.workstream,
            opts.localId,
            opts.workstream,
          );
        }
        if (wouldCreateCycle(db, blocker, opts.localId)) {
          throw new CycleError(blocker, opts.localId);
        }
        insertEdge.run(blocker, opts.localId, now);
      }
    }

    const row = getTask(db, opts.localId);
    if (!row) throw new Error(`addTask: row missing after insert: ${opts.localId}`);
    const blockedBy =
      opts.blockedBy && opts.blockedBy.length > 0 ? `, blocked-by=${opts.blockedBy.join(",")}` : "";
    emitEvent(
      db,
      opts.workstream,
      `task add ${opts.localId} (impact=${opts.impact}, effort=${opts.effortDays}${blockedBy})`,
    );
    return row;
  })();
}

// ─── addNote (verb) ────────────────────────────────────────────────────

export interface AddNoteOptions {
  /** Free-form author label. Convention: agent name, "user", or "orchestrator". */
  author?: string;
}

export function addNote(
  db: Db,
  taskId: string,
  content: string,
  opts: AddNoteOptions = {},
): TaskNoteRow {
  const task = getTask(db, taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, opts.author ?? null, content, now);
  const noteId = Number(result.lastInsertRowid);
  emitEvent(
    db,
    task.workstream,
    `task note ${taskId} (note #${noteId} by ${opts.author ?? "orchestrator"})`,
    opts.author ?? "system",
  );
  return {
    id: noteId,
    taskId,
    author: opts.author ?? null,
    content,
    createdAt: now,
  };
}

// ─── setTaskStatus / closeTask / openTask (verbs) ────────────────────────

export interface SetStatusResult {
  /** Status before the call. */
  previousStatus: TaskStatus;
  /** Status after the call (== requested status). */
  status: TaskStatus;
  /** True iff the row actually changed. False on idempotent no-op. */
  changed: boolean;
}

/**
 * Optional evidence string carried on lifecycle verbs (close / open /
 * claim / release). Lands in the auto-emitted `kind='event'` payload
 * verbatim, prefixed with `evidence=`. The first inch of distinguishing
 * "observed" from "claimed" state per an internal critique: the
 * verb still trusts the caller (it's not a verifier), but the audit
 * trail records what the caller said it relied on.
 */
export interface EvidenceOption {
  evidence?: string;
}

/** Render `… evidence="<text>"` suffix when evidence is provided.
 *  Quoted so multi-word strings stay legible in the event payload. */
function evidenceSuffix(opts: EvidenceOption | undefined): string {
  if (!opts || opts.evidence === undefined) return "";
  return ` evidence=${JSON.stringify(opts.evidence)}`;
}

/**
 * Flip a task's status to any of OPEN / IN_PROGRESS / CLOSED.
 * Idempotent: setting a task to its current status is a no-op (returns
 * `changed: false`) rather than throwing. Owner is unchanged.
 */
export function setTaskStatus(
  db: Db,
  localId: string,
  status: TaskStatus,
  opts: EvidenceOption = {},
): SetStatusResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);
  if (before.status === status) {
    return { previousStatus: before.status, status, changed: false };
  }
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE local_id = ?").run(
    status,
    new Date().toISOString(),
    localId,
  );
  emitEvent(
    db,
    before.workstream,
    `task status ${localId} (${before.status} → ${status})${evidenceSuffix(opts)}`,
  );
  return { previousStatus: before.status, status, changed: true };
}

/** Convenience: setTaskStatus(db, id, "CLOSED"). Accepts evidence. */
export function closeTask(db: Db, localId: string, opts: EvidenceOption = {}): SetStatusResult {
  return setTaskStatus(db, localId, "CLOSED", opts);
}

/** Convenience: setTaskStatus(db, id, "OPEN"). Owner intentionally NOT
 *  cleared — use `releaseTask` for that. Accepts evidence. */
export function openTask(db: Db, localId: string, opts: EvidenceOption = {}): SetStatusResult {
  return setTaskStatus(db, localId, "OPEN", opts);
}

// ─── rejectTask / deferTask (terminal-but-blocking transitions) ────
//
// REJECTED and DEFERRED both leave the task off the active scheduler
// (gone from `ready`, `goals`, track count) but, unlike CLOSED, do NOT
// satisfy a `--blocked-by` edge. A REJECTED / DEFERRED task therefore
// silently strands every OPEN/IN_PROGRESS dependent. We refuse the
// transition unless either there are no open dependents OR the caller
// passes `--cascade` to apply the same status to every transitive
// dependent.

export interface RejectDeferOptions extends EvidenceOption {
  /** If true, walk the transitive dependent closure and (with `yes`)
   *  apply the same status to every dependent, atomically. Without
   *  `yes`, runs as a dry-run: returns the list of tasks that WOULD
   *  be swept (changedIds) with `dryRun: true` and changes nothing.
   *  Logs one event per task (via setTaskStatus) on commit. */
  cascade?: boolean;
  /** Required to actually commit a `cascade` operation. Without it,
   *  cascade is dry-run only — prints the affected dependents so the
   *  caller can verify before sweeping. Mirrors `mu workstream destroy
   *  --yes`. Surfaced in mufeedback bug_cascade_reject_too_aggressive
   *  when an accidentally-cascaded reject swept hud_dogfood (which had
   *  independent merit and needed reopening). */
  yes?: boolean;
}

export interface RejectDeferResult {
  /** Tasks that actually changed status, in cascade order (root first). */
  changedIds: string[];
  /** The status now stamped on every changedId. */
  status: TaskStatus;
  /** True iff anything changed. False on a clean idempotent no-op
   *  (root task already in target status, no dependents). */
  changed: boolean;
  /** True iff this was a `cascade` dry-run (cascade requested without
   *  `yes`). In that case `changedIds` lists tasks that WOULD be
   *  swept; the DB is unchanged. */
  dryRun: boolean;
  /** Tasks that would be touched by a cascade. Same as `changedIds`
   *  on a dry-run; populated even on a commit so the caller can
   *  report what was swept. */
  affectedIds: string[];
}

/** Reject a task: terminal 'won't do' (out of scope, duplicate, wontfix).
 *  Refuses if dependents are open unless `--cascade`. */
export function rejectTask(
  db: Db,
  localId: string,
  opts: RejectDeferOptions = {},
): RejectDeferResult {
  return setTerminalOrParked(db, localId, "REJECTED", opts);
}

/** Defer a task: parked, may revisit. Same dependent-stranding semantics
 *  as reject (DEFERRED also doesn't satisfy a `--blocked-by` edge). */
export function deferTask(
  db: Db,
  localId: string,
  opts: RejectDeferOptions = {},
): RejectDeferResult {
  return setTerminalOrParked(db, localId, "DEFERRED", opts);
}

function setTerminalOrParked(
  db: Db,
  localId: string,
  status: "REJECTED" | "DEFERRED",
  opts: RejectDeferOptions,
): RejectDeferResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);

  // Find all open (OPEN or IN_PROGRESS) tasks that transitively depend
  // on this one. Forward-edge recursive CTE from localId.
  const openDependents = findOpenDependents(db, localId);

  if (openDependents.length > 0 && !opts.cascade) {
    const verb = status === "REJECTED" ? "reject" : "defer";
    throw new TaskHasOpenDependentsError(localId, verb, openDependents);
  }

  const affectedIds =
    openDependents.length > 0 && opts.cascade ? [localId, ...openDependents] : [localId];

  // Cascade dry-run: cascade requested but --yes missing. Don't touch
  // the DB; return the would-be-affected list so the CLI can render
  // a 'about to sweep these N tasks; rerun with --yes' preview.
  // Mirrors `mu workstream destroy` semantics. Single-task case
  // (openDependents == 0, cascade flag irrelevant) skips the dry-run
  // since there's nothing to preview.
  if (opts.cascade && !opts.yes && openDependents.length > 0) {
    return {
      changedIds: affectedIds,
      status,
      changed: false,
      dryRun: true,
      affectedIds,
    };
  }

  // Apply to root first, then dependents in BFS order. setTaskStatus
  // emits one event per task and is idempotent (no-op if already in
  // target status).
  const changedIds: string[] = [];
  for (const id of affectedIds) {
    const r = setTaskStatus(db, id, status, opts);
    if (r.changed) changedIds.push(id);
  }

  return {
    changedIds,
    status,
    changed: changedIds.length > 0,
    dryRun: false,
    affectedIds,
  };
}

/** Open dependents that would be stranded if `taskId` were rejected /
 *  deferred. The walk PRUNES at CLOSED nodes: a CLOSED intermediate
 *  has already satisfied its blocked-by edge, so its downstream is
 *  independent of whatever happens to `taskId` and must NOT be swept.
 *  REJECTED / DEFERRED intermediates also stop the walk — their
 *  downstream is already stranded by them, not by `taskId`, and a
 *  cascade from here would (a) double-flip them or (b) overwrite a
 *  previous explicit decision.
 *
 *  Ordering: BFS-equivalent via DISTINCT + ORDER BY local_id; cascade
 *  applies one row at a time so each setTaskStatus is logged. */
function findOpenDependents(db: Db, taskId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT e.to_task
           FROM task_edges e
           JOIN tasks      t ON t.local_id = e.to_task
          WHERE e.from_task = ?
            AND t.status IN ('OPEN', 'IN_PROGRESS')
         UNION
         SELECT e.to_task
           FROM task_edges e
           JOIN forward    f ON f.node = e.from_task
           JOIN tasks      t ON t.local_id = e.to_task
          WHERE t.status IN ('OPEN', 'IN_PROGRESS')
       )
       SELECT DISTINCT node AS local_id FROM forward ORDER BY node`,
    )
    .all(taskId) as { local_id: string }[];
  return rows.map((r) => r.local_id);
}

// ─── releaseTask (verb) ──────────────────────────────────────────────────

export interface ReleaseResult {
  /** The previous owner (null if the task was already unowned). */
  previousOwner: string | null;
  /** Status before the release. */
  previousStatus: TaskStatus;
  /** Status after the release. */
  status: TaskStatus;
  /** True iff owner OR status actually changed. */
  changed: boolean;
}

export interface ReleaseTaskOptions extends EvidenceOption {
  /** If true, also flip status back to OPEN (so the task is ready for
   *  another claim). Default false: status preserved. */
  reopen?: boolean;
}

/**
 * Release a task: clear `tasks.owner`. Optionally also flip status back
 * to OPEN via `--reopen` for the common "agent gave up mid-flight, hand
 * it back to the pool" workflow.
 *
 * Idempotent: releasing an already-unowned task with no `--reopen` is a
 * no-op (returns `changed: false`). Throws TaskNotFoundError on missing.
 */
export function releaseTask(db: Db, localId: string, opts: ReleaseTaskOptions = {}): ReleaseResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);

  const newStatus: TaskStatus = opts.reopen ? "OPEN" : before.status;
  const ownerChanges = before.owner !== null;
  const statusChanges = newStatus !== before.status;

  if (!ownerChanges && !statusChanges) {
    return {
      previousOwner: before.owner,
      previousStatus: before.status,
      status: before.status,
      changed: false,
    };
  }

  db.prepare("UPDATE tasks SET owner = NULL, status = ?, updated_at = ? WHERE local_id = ?").run(
    newStatus,
    new Date().toISOString(),
    localId,
  );
  const statusBit = statusChanges ? `, ${before.status} → ${newStatus}` : "";
  emitEvent(
    db,
    before.workstream,
    `task release ${localId} (was owner=${before.owner ?? "none"}${statusBit})${evidenceSuffix(opts)}`,
  );
  return {
    previousOwner: before.owner,
    previousStatus: before.status,
    status: newStatus,
    changed: true,
  };
}

// ─── claimTask (verb) ──────────────────────────────────────────────────

export interface ClaimTaskOptions extends EvidenceOption {
  /**
   * Override the agent name. If omitted, derived from the current pane's
   * title via `tmux display-message -t $TMUX_PANE -p '#{pane_title}'`.
   *
   * Mutually exclusive with `self: true`.
   */
  agentName?: string;
  /**
   * Anonymous claim: write `owner = NULL` instead of resolving an agent
   * name and checking the FK. Use when the actor is the orchestrator
   * (or a script, or a human) doing direct work in a workstream they
   * aren't a registered worker in.
   *
   * The actor name is still recorded — it ends up in `agent_logs.source`
   * for the auto-emitted `task claim` event — so provenance is preserved.
   * Just not in the FK column.
   *
   * Resolution order for the actor name (used as the log source):
   *   1. `actor` if explicitly passed.
   *   2. Current pane title (when `$TMUX_PANE` is set).
   *   3. `$USER`.
   *   4. The literal string 'unknown'.
   *
   * Mutually exclusive with `agentName` (the two are alternative
   * answers to "who's the actor for this claim?"). Passing both is a
   * usage error.
   */
  self?: boolean;
  /**
   * Override the actor name used for the log source when `self: true`.
   * Ignored when `self: false`. Useful when the orchestrator wants to
   * attribute the work to a meaningful name rather than the pane
   * title (e.g. "deploy-bot" rather than "pi-mu").
   */
  actor?: string;
}

export interface ClaimResult {
  /** The agent now owning the task, or null when the claim was anonymous (--self). */
  owner: string | null;
  /** The actor recorded in the agent_logs event — the agent name for a
   *  registered-worker claim, or the resolved actor for --self. */
  actor: string;
  /** The previous owner (null if it was unowned). */
  previousOwner: string | null;
  /** The status BEFORE the claim; post-claim is IN_PROGRESS unless was CLOSED. */
  previousStatus: TaskStatus;
  /** The status AFTER the claim. */
  status: TaskStatus;
}

/**
 * Claim a task. Two modes:
 *
 *   Worker claim (default):
 *     Resolve an agent name from `opts.agentName` or from $TMUX_PANE's
 *     pane title. The name MUST exist in the agents table (FK on
 *     tasks.owner). Sets `owner = <name>`. This is what mu-spawned
 *     workers do, and what `mu task claim --for <worker>` does for
 *     orchestrator dispatch.
 *
 *   Anonymous claim (--self):
 *     Skip the name -> agents FK lookup entirely. Sets `owner = NULL`.
 *     Records the actor in `agent_logs.source` instead. This is the
 *     orchestrator-doing-direct-work path — the actor is logged but
 *     not registered as a worker pane.
 *
 * Status side-effect: OPEN -> IN_PROGRESS; IN_PROGRESS / CLOSED unchanged.
 *
 * Concurrency: the worker-claim path uses a single-statement CAS UPDATE
 * with `WHERE owner IS NULL OR owner = ?` so two workers racing to
 * claim the same task can't both win. The anonymous path uses
 * `WHERE owner IS NULL` (anonymous claims don't 'own' the task in any
 * exclusive sense; if it's already owned by anyone, the anonymous claim
 * is a TaskAlreadyOwnedError just like a worker claim would be).
 */
export async function claimTask(
  db: Db,
  localId: string,
  opts: ClaimTaskOptions = {},
): Promise<ClaimResult> {
  if (opts.self === true && opts.agentName !== undefined) {
    throw new Error("claimTask: --self and --for are mutually exclusive");
  }

  if (opts.self === true) {
    return claimSelf(db, localId, opts);
  }

  // ── Worker claim path (registered agent owns the task) ──
  // currentAgentName() parses 'name · status · task' titles back to
  // just the name token — the registry FK is keyed on agents.name,
  // so the parser is essential after composeAgentTitle decorates.
  const agentName = opts.agentName ?? (await currentAgentName());
  if (!agentName) {
    throw new Error(
      "claimTask: no agent name (pass opts.agentName, run inside an mu-spawned pane with $TMUX_PANE set, or pass --self for an anonymous claim)",
    );
  }

  // Pre-check: the FK on tasks.owner -> agents.name will reject any
  // claim from an unregistered agent with bare 'FOREIGN KEY constraint
  // failed'. Fail loud + actionable instead.
  const claimerExists = db.prepare("SELECT 1 FROM agents WHERE name = ? LIMIT 1").get(agentName) as
    | { 1: number }
    | undefined;
  if (!claimerExists) {
    // If we resolved the name from $TMUX_PANE, surface the pane id so
    // the error message can suggest 'mu adopt <pane>'. If --for was
    // used, we don't know which pane is intended.
    const paneIdFromEnv = opts.agentName === undefined ? (process.env.TMUX_PANE ?? null) : null;
    throw new ClaimerNotRegisteredError(agentName, paneIdFromEnv);
  }

  return db.transaction(() => {
    const before = getTask(db, localId);
    if (!before) throw new TaskNotFoundError(localId);

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE tasks
            SET owner = ?,
                status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                updated_at = ?
          WHERE local_id = ?
            AND (owner IS NULL OR owner = ?)`,
      )
      .run(agentName, now, localId, agentName);

    if (result.changes === 0) {
      throw new TaskAlreadyOwnedError(localId, before.owner ?? "<unknown>");
    }

    const after = getTask(db, localId);
    if (!after) throw new Error(`claimTask: row missing after update: ${localId}`);
    const statusBit = after.status !== before.status ? `, ${before.status} → ${after.status}` : "";
    emitEvent(
      db,
      before.workstream,
      `task claim ${localId} by ${agentName} (was owner=${before.owner ?? "none"}${statusBit})${evidenceSuffix(opts)}`,
      agentName,
    );
    return {
      owner: agentName,
      actor: agentName,
      previousOwner: before.owner,
      previousStatus: before.status,
      status: after.status,
    };
  })();
}

/**
 * Resolve the actor name for an anonymous (--self) claim:
 *   1. opts.actor if explicit.
 *   2. Current pane title (when $TMUX_PANE is set + tmux available).
 *   3. $USER.
 *   4. The literal 'unknown'.
 */
async function resolveSelfActor(opts: ClaimTaskOptions): Promise<string> {
  if (opts.actor !== undefined && opts.actor !== "") return opts.actor;
  return resolveActorIdentity();
}

/**
 * Resolve the current actor's identity for attribution in task notes,
 * --self claims, and any other write that wants 'who did this?'.
 *
 * Resolution order:
 *   1. $MU_AGENT_NAME env var (set by mu spawnAgent on every managed
 *      pane; surfaced from the f3d4bdd commit). Authoritative when
 *      present — you're inside a mu-spawned worker, no ambiguity.
 *   2. tmux pane title (the legacy claim-protocol identity step). Works
 *      when running inside any pane mu manages OR adopted.
 *   3. $USER (when running outside tmux entirely).
 *   4. The literal 'orchestrator' as a last-resort default.
 *
 * Why prefer env over pane title: pane titles are a tmux-server-wide
 * resource that anything can rewrite. The env var is set per-pane at
 * spawn time and is unforgeable from outside without explicit
 * `--actor` override. Pane title is still the legacy identity for
 * adopted panes that didn't go through mu's spawn path.
 */
export async function resolveActorIdentity(): Promise<string> {
  const muAgent = process.env.MU_AGENT_NAME;
  if (muAgent !== undefined && muAgent !== "") return muAgent;
  const paneTitle = await currentAgentName();
  if (paneTitle !== undefined && paneTitle !== "") return paneTitle;
  const user = process.env.USER;
  if (user !== undefined && user !== "") return user;
  return "orchestrator";
}

async function claimSelf(db: Db, localId: string, opts: ClaimTaskOptions): Promise<ClaimResult> {
  const actor = await resolveSelfActor(opts);
  return db.transaction(() => {
    const before = getTask(db, localId);
    if (!before) throw new TaskNotFoundError(localId);

    // Anonymous claim: owner stays NULL, status flips OPEN -> IN_PROGRESS.
    // We still gate on `owner IS NULL` so an in-flight worker claim
    // can't be silently overwritten.
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
                updated_at = ?
          WHERE local_id = ?
            AND owner IS NULL`,
      )
      .run(now, localId);

    if (result.changes === 0) {
      // Task exists but is already owned (by someone). Mirror the
      // worker-path error so callers can pattern-match consistently.
      throw new TaskAlreadyOwnedError(localId, before.owner ?? "<unknown>");
    }

    const after = getTask(db, localId);
    if (!after) throw new Error(`claimTask: row missing after update: ${localId}`);
    const statusBit = after.status !== before.status ? `, ${before.status} → ${after.status}` : "";
    emitEvent(
      db,
      before.workstream,
      `task claim ${localId} by ${actor} --self (anonymous, owner stays NULL${statusBit})${evidenceSuffix(opts)}`,
      actor,
    );
    return {
      owner: null,
      actor,
      previousOwner: before.owner,
      previousStatus: before.status,
      status: after.status,
    };
  })();
}

// ─── waitForTasks (verb) ──────────────────────────────────────────
//
// Block until a set of tasks reaches a target status. The orchestrator
// pattern: dispatch N workers via mu task claim --for, then wait until
// they're all done before reviewing/merging.
//
// Pre-existing alternatives + why this verb exists:
//
//   awk pipe over `mu log --tail`: works for ONE event but the
//     awk script becomes stateful (tracking 'which of N have closed?')
//     for multi-task waits. Bad shape for SKILL examples.
//   mu approve wait: same pattern but for approvals; this is the
//     symmetric verb for the task graph.
//
// Implementation mirrors waitApproval (in src/approvals.ts):
//
//   1. Initial check — if the wait condition is already satisfied,
//      exit immediately. No subscription needed.
//   2. Otherwise, poll the tasks table every pollMs. Same cadence as
//      mu log --tail (default 1000ms). We don't subscribe to
//      agent_logs because (a) we'd still need to re-query tasks to
//      learn the current status, (b) some status changes happen via
//      mu sql which doesn't emit events, and (c) the polling cost is
//      one indexed SELECT every second — cheaper than parsing the
//      log stream.
//   3. Exit on success (all/any reached) OR timeout. Caller maps
//      timeout to exit code 5 (mirrors mu approve wait).

export interface TaskWaitOptions {
  /** Target status. Default 'CLOSED'. */
  status?: TaskStatus;
  /** When true, succeed as soon as ONE listed task reaches the target.
   *  Default false: every listed task must reach the target. */
  any?: boolean;
  /** Maximum time to wait, in milliseconds. Default 600_000 (10 min).
   *  Pass 0 to wait forever. */
  timeoutMs?: number;
  /** Polling interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
}

export interface TaskWaitTaskState {
  /** The task's local_id. */
  localId: string;
  /** Current status (at the moment we exit). */
  status: TaskStatus;
  /** True when this task's status equals the target. */
  reachedTarget: boolean;
}

export interface TaskWaitResult {
  /** Per-task state at exit time. Same length and order as the input list. */
  tasks: TaskWaitTaskState[];
  /** True when EVERY task reached the target (the --all condition). */
  allReached: boolean;
  /** True when AT LEAST ONE task reached the target (the --any condition). */
  anyReached: boolean;
  /** Wall-clock time spent waiting, in ms (always >= 0). */
  elapsedMs: number;
  /** True when we exited because of the timeout, not because the wait
   *  condition was met. allReached / anyReached can still be true on
   *  partial progress when timedOut is true. */
  timedOut: boolean;
}

/**
 * Block until a set of tasks reaches `opts.status` (default CLOSED).
 * Returns a result describing the final state — the caller decides
 * whether to treat partial-progress timeouts as success or failure
 * (the CLI maps a clean exit to 0, a timeout to 5).
 *
 * Pre-flight: every task in `localIds` MUST exist; missing ones throw
 * TaskNotFoundError before any waiting begins. This is loud-fail by
 * design — a typo'd id silently waiting forever is the worst-case UX.
 */
export async function waitForTasks(
  db: Db,
  localIds: readonly string[],
  opts: TaskWaitOptions = {},
): Promise<TaskWaitResult> {
  if (localIds.length === 0) {
    throw new Error("waitForTasks: localIds must be non-empty");
  }
  const target: TaskStatus = opts.status ?? "CLOSED";
  const wantAny = opts.any === true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const startedAt = Date.now();

  // Pre-flight: every id must exist.
  for (const id of localIds) {
    if (getTask(db, id) === undefined) throw new TaskNotFoundError(id);
  }

  /** Read current state of all tasks; returns the result shape. */
  const snapshot = (): TaskWaitResult => {
    const tasks: TaskWaitTaskState[] = localIds.map((id) => {
      const row = getTask(db, id);
      // Defensive: if a task was deleted mid-wait, treat as 'never
      // reached'. (Not the same as TaskNotFoundError pre-flight —
      // deletion mid-wait shouldn't crash the wait; it's a legitimate
      // state change.)
      const status = (row?.status ?? "OPEN") as TaskStatus;
      return { localId: id, status, reachedTarget: status === target };
    });
    const reachedCount = tasks.filter((t) => t.reachedTarget).length;
    return {
      tasks,
      allReached: reachedCount === tasks.length,
      anyReached: reachedCount > 0,
      elapsedMs: Date.now() - startedAt,
      timedOut: false,
    };
  };

  /** Has the wait condition been met? */
  const isDone = (snap: TaskWaitResult): boolean => (wantAny ? snap.anyReached : snap.allReached);

  // Initial check: maybe we're already done.
  let snap = snapshot();
  if (isDone(snap)) return snap;

  // Poll loop.
  for (;;) {
    if (Date.now() >= deadline) {
      return { ...snap, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    snap = snapshot();
    if (isDone(snap)) return snap;
  }
}

// ─── addBlockEdge / removeBlockEdge ────────────────────────────────────────

export interface BlockEdgeResult {
  /** True iff a row was actually inserted (vs. already present). */
  added: boolean;
}

/**
 * Add the edge `blocker → blocked` ('blocker blocks blocked').
 * Idempotent (existing edge → `added: false`). Validates:
 *
 *   - both tasks exist
 *   - same workstream (cross-workstream edges forbidden)
 *   - no cycle (the new edge wouldn't form a path blocked → ... → blocker)
 *   - blocker ≠ blocked (no self-reference)
 */
export function addBlockEdge(db: Db, blocked: string, blocker: string): BlockEdgeResult {
  if (blocked === blocker) {
    // Surface as a typed CycleError so the CLI maps it to exit 4 (conflict)
    // rather than letting the schema CHECK fire as a generic SQL error.
    throw new CycleError(blocker, blocked);
  }
  const blockedRow = getTask(db, blocked);
  if (!blockedRow) throw new TaskNotFoundError(blocked);
  const blockerRow = getTask(db, blocker);
  if (!blockerRow) throw new TaskNotFoundError(blocker);
  if (blockedRow.workstream !== blockerRow.workstream) {
    throw new CrossWorkstreamEdgeError(
      blocker,
      blockerRow.workstream,
      blocked,
      blockedRow.workstream,
    );
  }
  if (wouldCreateCycle(db, blocker, blocked)) {
    throw new CycleError(blocker, blocked);
  }
  const result = db
    .prepare("INSERT OR IGNORE INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)")
    .run(blocker, blocked, new Date().toISOString());
  const added = result.changes > 0;
  if (added) emitEvent(db, blockedRow.workstream, `task block ${blocked} by ${blocker}`);
  return { added };
}

export interface RemoveBlockEdgeResult {
  /** True iff a row was actually deleted (vs. no such edge). */
  removed: boolean;
}

/**
 * Remove the edge `blocker → blocked`. Idempotent (no edge →
 * `removed: false`). Does NOT validate task existence — if the
 * edge is gone there's nothing to do, regardless of whether the
 * tasks are gone too.
 */
export function removeBlockEdge(db: Db, blocked: string, blocker: string): RemoveBlockEdgeResult {
  const result = db
    .prepare("DELETE FROM task_edges WHERE from_task = ? AND to_task = ?")
    .run(blocker, blocked);
  const removed = result.changes > 0;
  if (removed) {
    // Use the blocked task's workstream as the channel (both tasks must
    // be in the same workstream by the addBlockEdge invariant).
    const blockedRow = getTask(db, blocked);
    const ws = blockedRow?.workstream ?? null;
    emitEvent(db, ws, `task unblock ${blocked} by ${blocker}`);
  }
  return { removed };
}

// ─── deleteTask ───────────────────────────────────────────────────────────

export interface DeleteTaskResult {
  /** True iff the row existed and was deleted. */
  deleted: boolean;
  /** Number of `task_edges` rows cascaded out (informational). */
  deletedEdges: number;
  /** Number of `task_notes` rows cascaded out (informational). */
  deletedNotes: number;
}

/**
 * Delete a task. FK CASCADE on `task_edges` (from + to) and
 * `task_notes` cleans the joined rows automatically. Idempotent on
 * a missing task (returns `deleted: false`).
 *
 * Pre-counts the cascade victims for reporting because SQLite's
 * `changes()` only reports rows directly affected by the DELETE.
 */
export function deleteTask(db: Db, localId: string): DeleteTaskResult {
  const before = getTask(db, localId);
  const edgesBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_edges WHERE from_task = ? OR to_task = ?")
      .get(localId, localId) as { n: number }
  ).n;
  const notesBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(localId) as {
      n: number;
    }
  ).n;
  const result = db.prepare("DELETE FROM tasks WHERE local_id = ?").run(localId);
  const deleted = result.changes > 0;
  if (deleted && before) {
    emitEvent(
      db,
      before.workstream,
      `task delete ${localId} (cascade: ${edgesBefore} edges, ${notesBefore} notes)`,
    );
  }
  return { deleted, deletedEdges: edgesBefore, deletedNotes: notesBefore };
}

// ─── updateTask ───────────────────────────────────────────────────────────

export interface UpdateTaskOptions {
  title?: string;
  /** 1..100; enforced by schema CHECK. */
  impact?: number;
  /** > 0; enforced by schema CHECK. */
  effortDays?: number;
}

export interface UpdateTaskResult {
  /** True iff at least one field actually changed. */
  updated: boolean;
  /** The fields whose values differ post-update (in `UpdateTaskOptions`'s
   *  camelCase shape). Empty when `updated: false`. */
  changedFields: string[];
}

/**
 * Update scalar fields on a task. Each option is independently optional;
 * passing none is a typed no-op (returns `updated: false, changedFields: []`).
 * Fields whose new value equals the current value are skipped (no row change).
 *
 * NOT for status (use `closeTask` / `openTask` / `setTaskStatus`), owner
 * (use `claimTask` / `releaseTask`), local_id (rename is deferred), or
 * workstream (cross-workstream moves are deferred).
 */
export function updateTask(db: Db, localId: string, opts: UpdateTaskOptions): UpdateTaskResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);

  const setters: string[] = [];
  const params: unknown[] = [];
  const changedFields: string[] = [];

  if (opts.title !== undefined && opts.title !== before.title) {
    setters.push("title = ?");
    params.push(opts.title);
    changedFields.push("title");
  }
  if (opts.impact !== undefined && opts.impact !== before.impact) {
    setters.push("impact = ?");
    params.push(opts.impact);
    changedFields.push("impact");
  }
  if (opts.effortDays !== undefined && opts.effortDays !== before.effortDays) {
    setters.push("effort_days = ?");
    params.push(opts.effortDays);
    changedFields.push("effortDays");
  }

  if (setters.length === 0) {
    return { updated: false, changedFields: [] };
  }

  setters.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(localId);

  db.prepare(`UPDATE tasks SET ${setters.join(", ")} WHERE local_id = ?`).run(...params);
  emitEvent(db, before.workstream, `task update ${localId} (changed: ${changedFields.join(", ")})`);
  return { updated: true, changedFields };
}

// ─── reparentTask ─────────────────────────────────────────────────────────

export interface ReparentTaskResult {
  /** Edges removed (i.e. all incoming `to_task = taskId` edges). */
  removedEdges: number;
  /** Edges added (== blockers.length on success). */
  addedEdges: number;
}

/**
 * Atomically replace every incoming edge of `taskId` with new ones
 * `blocker[i] → taskId`. Pass an empty `blockers` array to clear all
 * incoming edges (the task becomes ready iff its status allows).
 *
 * Validates ALL new blockers up-front (existence + same workstream +
 * cycle check); if any fails, no DELETE happens — the call is fully
 * atomic via a single transaction.
 *
 * Cycle reasoning: removing the existing incoming edges to `taskId`
 * doesn't change `taskId`'s OUTGOING reachability, so
 * `wouldCreateCycle(db, blocker, taskId)` evaluated against the
 * pre-state gives the right answer for each new edge.
 */
export function reparentTask(
  db: Db,
  taskId: string,
  blockers: readonly string[],
): ReparentTaskResult {
  const task = getTask(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  for (const blockerId of blockers) {
    if (blockerId === taskId) {
      throw new CycleError(blockerId, taskId);
    }
    const blocker = getTask(db, blockerId);
    if (!blocker) throw new TaskNotFoundError(blockerId);
    if (blocker.workstream !== task.workstream) {
      throw new CrossWorkstreamEdgeError(blockerId, blocker.workstream, taskId, task.workstream);
    }
    if (wouldCreateCycle(db, blockerId, taskId)) {
      throw new CycleError(blockerId, taskId);
    }
  }

  return db.transaction(() => {
    const removed = db.prepare("DELETE FROM task_edges WHERE to_task = ?").run(taskId);
    const insertEdge = db.prepare(
      "INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const blockerId of blockers) {
      insertEdge.run(blockerId, taskId, now);
    }
    const blockersBit = blockers.length > 0 ? `, new=${[...blockers].join(",")}` : "";
    emitEvent(
      db,
      task.workstream,
      `task reparent ${taskId} (removed ${removed.changes} edges, added ${blockers.length}${blockersBit})`,
    );
    return { removedEdges: removed.changes, addedEdges: blockers.length };
  })();
}
