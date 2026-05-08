// mu — workstream-level operations.
//
// One workstream = one tmux session + N agents + M tasks (and their
// edges/notes) all sharing the workstream column. 0.1.0 ships `mu init`
// (create the tmux session) and `mu destroy` (this module: nuke the
// tmux session and every DB row tagged with the workstream name).
//
// `destroyWorkstream` is idempotent on every leg:
//   - tmux session already gone        → killSession swallows the error
//   - no agents/tasks for this name    → DELETE returns zero changes
//   - workstream never existed at all  → returns all-zero counts
//
// Both summarize and destroy take an optional `tmuxSession` override so
// tests (and the rare workstream whose tmux session was created with a
// non-default name) work without env-var gymnastics.

import type { Db } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { killSession, listSessions, sessionExists } from "./tmux.js";

/**
 * Allowed workstream-name shape: lowercase alpha first, then alnum,
 * underscore, or hyphen, up to 32 chars total. Mirrors the agent-name
 * rule in VOCABULARY.md §"Naming conventions".
 *
 * Critically, this rule excludes `.` and `:` — tmux silently rewrites
 * `.` to `_` in session names (because `.` is the window/pane separator
 * in tmux's `session:window.pane` target syntax) and `:` is reserved
 * outright. A workstream name with `.` would create a session that mu
 * couldn't subsequently look up, breaking every downstream verb. We
 * fail loud at init time instead.
 */
const WORKSTREAM_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Reserved prefix — mu auto-prepends `mu-` to derive the tmux session
 *  name (so workstream `auth` lives in tmux session `mu-auth`). A
 *  workstream named `mu-auth` would produce session `mu-mu-auth`,
 *  which the user almost certainly didn't intend. Fail loud rather
 *  than silently double-prefix. */
const RESERVED_WORKSTREAM_PREFIX = "mu-";

export function isValidWorkstreamName(name: string): boolean {
  if (!WORKSTREAM_NAME_RE.test(name)) return false;
  if (name.startsWith(RESERVED_WORKSTREAM_PREFIX)) return false;
  return true;
}

/** Thrown by `ensureWorkstream` and `mu workstream init` when the name
 *  doesn't match the rules. */
export class WorkstreamNameInvalidError extends Error implements HasNextSteps {
  override readonly name = "WorkstreamNameInvalidError";
  constructor(public readonly attempted: string) {
    const reason = attempted.startsWith(RESERVED_WORKSTREAM_PREFIX)
      ? `the 'mu-' prefix is reserved (mu auto-prepends 'mu-' to derive the tmux session name; '${attempted}' would produce session 'mu-${attempted}', which is double-prefixed and almost never what you want). Drop the 'mu-' from the workstream name.`
      : `must match /^[a-z][a-z0-9_-]{0,31}$/. tmux silently rewrites '.' to '_' and reserves ':' as a target separator, so workstream names containing those characters would create tmux sessions mu couldn't look up afterwards. Use letters, digits, '_', and '-' only.`;
    super(`invalid workstream name ${JSON.stringify(attempted)}: ${reason}`);
  }
  errorNextSteps(): NextStep[] {
    // Suggest a sanitized form: strip the mu- prefix; replace dots and
    // colons with underscores; lowercase.
    const sanitized = this.attempted
      .toLowerCase()
      .replace(/^mu-/, "")
      .replace(/[.:]/g, "_")
      .slice(0, 32);
    return [
      {
        intent: "Try a sanitized name (best guess)",
        command: `mu workstream init ${sanitized || "<name>"}`,
      },
      { intent: "List existing workstreams", command: "mu workstream list" },
    ];
  }
}

function assertValidWorkstreamName(name: string): void {
  if (!isValidWorkstreamName(name)) throw new WorkstreamNameInvalidError(name);
}

/**
 * Ensure a row exists in the `workstreams` table for `name`. Idempotent;
 * INSERT OR IGNORE so concurrent callers race safely. Called by
 * `insertAgent` and `addTask` so callers don't need to remember to call
 * `mu init` before adding a task / spawning an agent (preserves the
 * spawn-without-init ergonomics now that agents.workstream and
 * tasks.workstream are real FKs into this table).
 *
 * Validates the name before inserting; throws `WorkstreamNameInvalidError`
 * for names tmux would silently mangle (containing '.' or ':') or that
 * exceed 32 chars / start with a non-letter.
 *
 * Returns true iff a row was actually inserted (vs. already present).
 */
export function ensureWorkstream(db: Db, name: string): boolean {
  assertValidWorkstreamName(name);
  const result = db
    .prepare("INSERT OR IGNORE INTO workstreams (name, created_at) VALUES (?, ?)")
    .run(name, new Date().toISOString());
  const created = result.changes > 0;
  if (created) emitEvent(db, name, `workstream init ${name}`);
  return created;
}

export interface WorkstreamSummary {
  workstream: string;
  /** Tmux session name, defaults to `mu-<workstream>`. */
  tmuxSession: string;
  /** True iff `tmux has-session -t <tmuxSession>` succeeds right now. */
  tmuxAlive: boolean;
  /** Rows in `agents` for this workstream. */
  agents: number;
  /** Rows in `tasks` for this workstream. */
  tasks: number;
  /** Rows in `task_notes` whose task is in this workstream. */
  notes: number;
  /** Rows in `task_edges` whose `from_task` is in this workstream. */
  edges: number;
}

export interface DestroyResult {
  /** True iff `tmux kill-session` actually killed something. */
  killedTmux: boolean;
  /** Number of `agents` rows deleted. */
  deletedAgents: number;
  /** Number of `tasks` rows deleted (edges/notes cascade via FK). */
  deletedTasks: number;
  /** Number of `task_notes` deleted by the cascade — informational. */
  deletedNotes: number;
  /** Number of `task_edges` deleted by the cascade — informational. */
  deletedEdges: number;
}

export interface WorkstreamOptions {
  workstream: string;
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
}

/**
 * Discover every workstream visible on this machine. The union of:
 *   - rows in the `workstreams` table (canonical DB source; populated by
 *     `mu init` and auto-created by insertAgent / addTask)
 *   - tmux sessions named `mu-*` (with the prefix stripped) — catches
 *     externally-created `tmux new-session -s mu-foo` that mu hasn't
 *     observed yet
 *
 * Returns one `WorkstreamSummary` per workstream, sorted by name.
 * Useful as a pre-flight before `mu init` ("is this name taken?") and
 * for `mu doctor`-style diagnostics.
 */
export async function listWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const dbNames = new Set<string>(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );

  const tmuxNames = new Set<string>();
  for (const session of await listSessions()) {
    if (session.name.startsWith("mu-")) tmuxNames.add(session.name.slice(3));
  }

  const allNames = Array.from(new Set([...dbNames, ...tmuxNames])).sort();
  return Promise.all(allNames.map((name) => summarizeWorkstream(db, { workstream: name })));
}

export async function summarizeWorkstream(
  db: Db,
  opts: WorkstreamOptions,
): Promise<WorkstreamSummary> {
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;
  return {
    workstream: opts.workstream,
    tmuxSession,
    tmuxAlive: await sessionExists(tmuxSession),
    agents: countAgents(db, opts.workstream),
    tasks: countTasks(db, opts.workstream),
    notes: countNotes(db, opts.workstream),
    edges: countEdges(db, opts.workstream),
  };
}

/**
 * Tear down a workstream: kill its tmux session and delete every DB row
 * tagged with its name. Cascades on `tasks` clean up `task_edges` and
 * `task_notes` automatically (FK ON DELETE CASCADE in the schema).
 *
 * Idempotent: safe to call against a workstream that never existed; safe
 * to call repeatedly. Returns counts so the caller can print a useful
 * summary.
 */
export async function destroyWorkstream(db: Db, opts: WorkstreamOptions): Promise<DestroyResult> {
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;

  // Pre-count the cascade victims so we can report them — SQLite's
  // changes() only reports rows directly affected by the last statement,
  // not cascade victims.
  const agentsBefore = countAgents(db, opts.workstream);
  const tasksBefore = countTasks(db, opts.workstream);
  const notesBefore = countNotes(db, opts.workstream);
  const edgesBefore = countEdges(db, opts.workstream);

  // Tmux first: if killSession throws we don't want the DB rows already
  // gone with no way to recover. (killSession is itself idempotent on
  // missing sessions — a real throw here is an unexpected tmux error.)
  const tmuxAliveBefore = await sessionExists(tmuxSession);
  if (tmuxAliveBefore) {
    await killSession(tmuxSession);
  }

  // One DELETE: the FK CASCADE chain (workstreams → agents,
  // workstreams → tasks → task_edges + task_notes, workstreams →
  // agent_logs) cleans every row in one shot, atomically. If the
  // workstream was never registered (e.g. an orphan tmux session
  // that mu never observed), changes() = 0 and we still report
  // the killed tmux session honestly.
  const result = db.prepare("DELETE FROM workstreams WHERE name = ?").run(opts.workstream);
  // The destroy event itself goes to workstream=null (machine-wide)
  // because the FK CASCADE we just triggered would otherwise wipe
  // it on the same statement. Visible via `mu log --all`.
  if (result.changes > 0 || tmuxAliveBefore) {
    emitEvent(
      db,
      null,
      `workstream destroy ${opts.workstream} (agents=${agentsBefore}, tasks=${tasksBefore}, edges=${edgesBefore}, notes=${notesBefore}, tmux=${tmuxAliveBefore})`,
    );
  }

  return {
    killedTmux: tmuxAliveBefore,
    deletedAgents: agentsBefore,
    deletedTasks: tasksBefore,
    deletedNotes: notesBefore,
    deletedEdges: edgesBefore,
  };
}

// ─── Counts ────────────────────────────────────────────────────────────

function countAgents(db: Db, workstream: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE workstream = ?")
    .get(workstream) as { n: number };
  return row.n;
}

function countTasks(db: Db, workstream: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE workstream = ?")
    .get(workstream) as { n: number };
  return row.n;
}

function countNotes(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_notes n
         JOIN tasks      t ON t.local_id = n.task_id
        WHERE t.workstream = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countEdges(db: Db, workstream: string): number {
  // Count edges whose blocker (from_task) is in the workstream. Since
  // cross-workstream edges are forbidden by addTask, this equals the
  // edge count for the workstream subgraph.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_edges e
         JOIN tasks      t ON t.local_id = e.from_task
        WHERE t.workstream = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}
