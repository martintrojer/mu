// mu — workstream-level operations.
//
// One workstream = one mux session + N agents + M tasks (and their
// edges/notes) all sharing the workstream column. 0.1.0 ships `mu init`
// (create the mux session) and `mu destroy` (this module: nuke the
// mux session and every DB row tagged with the workstream name).
//
// `destroyWorkstream` is idempotent on every leg:
//   - mux session already gone         → killSession swallows the error
//   - no agents/tasks for this name    → DELETE returns zero changes
//   - workstream never existed at all  → returns all-zero counts
//
// Both summarize and destroy take an optional `muxSession` override so
// tests (and the rare workstream whose mux session was created with a
// non-default name) work without env-var gymnastics.

import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, defaultStateDir } from "./db.js";
import { activeMux } from "./mux.js";
import { withOpContext } from "./op-context.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { parkedStatus } from "./parked.js";
import { backendByName, type VcsBackend, type VcsBackendName } from "./vcs.js";
import { listWorkspaces } from "./workspace.js";

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
export const RESERVED_WORKSTREAM_PREFIX = "mu-";

/** Reserved workstream names that may only be auto-created on spawn,
 *  never via `mu workstream init`. `scratch` is the off-the-cuff bucket
 *  for ad-hoc agents you'll keep talking to without crew/DAG ceremony;
 *  it auto-creates on first `mu agent spawn <name> -w scratch` (via
 *  `ensureWorkstream`, which stays permissive) but `init` is rejected
 *  loud so the operator doesn't treat it as a durable crew workstream.
 *  See docs/VOCABULARY.md "scratch workstream". */
export const RESERVED_WORKSTREAM_NAMES = new Set(["scratch"]);

/** The canonical off-the-cuff workstream name. */
export const SCRATCH_WORKSTREAM = "scratch";

// ─── Best-effort mux reads ─────────────────────────────────────────
//
// Every workstream READ decorates DB truth with mux liveness. The DB
// half always works, so an unreachable mux must degrade the decoration
// ("no sessions", "not alive") rather than fail `mu workstream list`
// on a box where nobody is running a multiplexer right now.

async function listMuxSessions(): Promise<readonly { name: string }[]> {
  try {
    return await (await activeMux()).listSessions();
  } catch {
    return [];
  }
}

async function sessionAlive(session: string): Promise<boolean> {
  try {
    return await (await activeMux()).sessionExists(session);
  } catch {
    return false;
  }
}

/** True iff `name` is a scratch/ephemeral workstream (special-cased by
 *  the staleness nudge and the TUI ephemeral marker). */
export function isScratchWorkstream(name: string): boolean {
  return RESERVED_WORKSTREAM_NAMES.has(name);
}

/**
 * The workstream implied by the mux session the caller sits in, or
 * null. Best-effort: this is one rung of the -w resolution ladder, so
 * an unreachable mux means "no ambient answer", never a thrown verb.
 */
export async function resolveMuxSessionWorkstreamName(): Promise<string | null> {
  try {
    const name = await (await activeMux()).currentSessionName();
    if (name?.startsWith(RESERVED_WORKSTREAM_PREFIX)) {
      return name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    }
  } catch {
    // fall through: mux context is best-effort for workstream resolution
  }
  return null;
}

export function isValidWorkstreamName(name: string): boolean {
  if (!WORKSTREAM_NAME_RE.test(name)) return false;
  if (name.startsWith(RESERVED_WORKSTREAM_PREFIX)) return false;
  return true;
}

/** Thrown by `ensureWorkstream` and `mu workstream init` when the name
 *  doesn't match the rules. */
export class WorkstreamExistsError extends Error implements HasNextSteps {
  override readonly name: string = "WorkstreamExistsError";
  constructor(public readonly workstream: string) {
    super(`workstream already exists: ${workstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List existing workstreams", command: "mu workstream list" },
      {
        intent: "Destroy the existing workstream first",
        command: `mu workstream destroy -w ${this.workstream} --yes`,
      },
    ];
  }
}

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
    // Branch the intent label on the failure class. For the mu-prefix
    // case the correction is unambiguous (drop the prefix), so phrase
    // the next-step as a direct action — "Try a … (best guess)" reads
    // as a hedge and dogfooding showed agents skip past the rationale
    // line entirely (workstream_init_name_rejected_mu in feedback ws).
    // For the regex/mangle branch the sanitiser really is guessing
    // (`.`/`:`/case all collapse), so the hedge stays honest there.
    const isPrefixCase = this.attempted.toLowerCase().startsWith(RESERVED_WORKSTREAM_PREFIX);
    const intent = isPrefixCase
      ? "Retry without the 'mu-' prefix"
      : "Try a sanitized name (best guess)";
    return [
      { intent, command: `mu workstream init ${sanitized || "<name>"}` },
      { intent: "List existing workstreams", command: "mu workstream list" },
    ];
  }
}

function assertValidWorkstreamName(name: string): void {
  if (!isValidWorkstreamName(name)) throw new WorkstreamNameInvalidError(name);
}

/** Thrown by `mu workstream init` when the operator tries to create a
 *  reserved workstream (e.g. `scratch`) explicitly. The name is not
 *  invalid — it auto-creates on spawn — it just can't be `init`ed. */
export class WorkstreamNameReservedError extends Error implements HasNextSteps {
  override readonly name = "WorkstreamNameReservedError";
  constructor(public readonly attempted: string) {
    super(
      `workstream name ${JSON.stringify(attempted)} is reserved: it is the off-the-cuff bucket and auto-creates on first spawn. Don't 'init' it.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Just spawn into it (auto-creates)",
        command: `mu agent spawn <name> -w ${this.attempted}`,
      },
      { intent: "Use a durable workstream instead", command: "mu workstream init <name>" },
    ];
  }
}

/** Reject reserved names for the explicit `mu workstream init` path.
 *  `ensureWorkstream` (the auto-create-on-spawn path) deliberately does
 *  NOT call this — spawning into `scratch` must Just Work. */
export function assertWorkstreamInitable(name: string): void {
  if (RESERVED_WORKSTREAM_NAMES.has(name)) throw new WorkstreamNameReservedError(name);
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
  return withOpContext(db, { intent: "workstream.init", group: "new" }, () =>
    ensureWorkstreamImpl(db, name),
  );
}

function ensureWorkstreamImpl(db: Db, name: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO workstreams (name, created_at) VALUES (?, ?)")
    .run(name, new Date().toISOString());
  const created = result.changes > 0;
  // No emitEvent: the workstreams INSERT fired the capture trigger
  // (intent='workstream.init', key=<name>).
  return created;
}

export interface WorkstreamSummary {
  /** The workstream's own name. */
  name: string;
  /** Mux session name, defaults to `mu-<name>`. */
  muxSession: string;
  /** True iff the mux session `<muxSession>` is alive right now. */
  muxAlive: boolean;
  /** Rows in `agents` for this workstream. */
  agentCount: number;
  /** Rows in `tasks` for this workstream. */
  taskCount: number;
  /** Rows in `task_notes` whose task is in this workstream. */
  noteCount: number;
  /** Rows in `task_edges` whose `from_task` is in this workstream. */
  edgeCount: number;
  /** Rows in `vcs_workspaces` for this workstream. Surfaced so the
   *  destroy dry-run can warn about per-agent worktrees that need
   *  cleanup before the FK cascade silently nukes their rows. */
  workspaceCount: number;
  /** True iff a row exists in the `workstreams` table itself. False
   *  for tmux-only `mu-*` sessions that mu never observed via
   *  `mu workstream init`. Surfaced so destroy can clean up bare
   *  registry rows (workstream row exists, no agents/tasks/etc.) —
   *  otherwise such rows are orphaned forever (the previous
   *  `nothingToDo` heuristic short-circuited on them). */
  registered: boolean;
  /** "Presumed parked on another machine" derived signal. Present
   *  iff `parkedStatus(db, name)` reports `parked: true` (most recent
   *  op is an export marker, no alive agents, no
   *  IN_PROGRESS tasks, threshold elapsed). Dormant in practice — see
   *  src/parked.ts for why nothing emits that marker. Consumed by
   *  `mu workstream list` and the TUI tab strip / workstreams card.
   *  See src/parked.ts. */
  parked?: { sinceDays: number };
}

export interface DestroyResult {
  /** True iff killing the mux session actually killed something. */
  killedMux: boolean;
  /** Number of `agents` rows deleted. */
  deletedAgents: number;
  /** Number of `tasks` rows deleted (edges/notes cascade via FK). */
  deletedTasks: number;
  /** Number of `task_notes` deleted by the cascade — informational. */
  deletedNotes: number;
  /** Number of `task_edges` deleted by the cascade — informational. */
  deletedEdges: number;
  /** Number of vcs_workspaces whose on-disk path was actually
   *  removed by the backend on this destroy. Excludes
   *  `alreadyGoneWorkspaces` (those were no-ops on disk). */
  freedWorkspaces: number;
  /** Number of vcs_workspaces whose registry row existed but
   *  whose on-disk path was already gone (manual rm -rf or a prior
   *  interrupted destroy). The DB row was cascade-deleted; the
   *  backend did no filesystem work. Tracked separately so the
   *  destroy report doesn't lie about how much cleanup it actually
   *  performed. */
  alreadyGoneWorkspaces: number;
  /** Workspaces whose backend cleanup failed (e.g. `git worktree
   *  remove` refused because of uncommitted changes). The DB row
   *  was still cascade-deleted; the on-disk path remains and needs
   *  manual cleanup. */
  failedWorkspaces: WorkspaceFailure[];
}

export interface WorkspaceFailure {
  agent: string;
  backend: string;
  path: string;
  error: string;
}

export interface WorkstreamOptions {
  workstream: string;
  /** Override the mux session name. Defaults to `mu-<workstream>`. */
  muxSession?: string;
  /** Override the per-name VcsBackend resolver. Defaults to
   *  `backendByName`. Lets tests inject a fake backend (e.g. one whose
   *  `freeWorkspace` throws) without mutating the exported singletons —
   *  same pattern as `createWorkspace`'s `opts.backend` accepting a
   *  pre-built `VcsBackend` object. Production callers leave this
   *  unset. */
  resolveBackend?: (name: VcsBackendName) => VcsBackend;
}

export interface DestroyWorkstreamOptions extends WorkstreamOptions {}

/**
 * Discover every workstream visible on this machine. The union of:
 *   - rows in the `workstreams` table (canonical DB source; populated by
 *     `mu init` and auto-created by insertAgent / addTask)
 *   - mux sessions named `mu-*` (with the prefix stripped) — catches
 *     externally-created sessions (e.g. `tmux new-session -s mu-foo`)
 *     that mu hasn't observed yet
 *
 * Returns one `WorkstreamSummary` per workstream, sorted by name.
 * Useful as a pre-flight before `mu init` ("is this name taken?") and
 * for `mu doctor`-style diagnostics.
 */
export async function listWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const dbNames = new Set<string>(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );

  // Best-effort: the DB half of the union is always answerable, so a
  // missing mux degrades to "registered workstreams only" rather than
  // failing a read-only listing.
  const muxNames = new Set<string>();
  for (const session of await listMuxSessions()) {
    if (session.name.startsWith(RESERVED_WORKSTREAM_PREFIX))
      muxNames.add(session.name.slice(RESERVED_WORKSTREAM_PREFIX.length));
  }

  const allNames = Array.from(new Set([...dbNames, ...muxNames])).sort();
  return Promise.all(allNames.map((name) => summarizeWorkstream(db, { workstream: name })));
}

/**
 * Discover every workstream that has no user-meaningful state
 * attached. Two flavours unioned:
 *
 *   1. REGISTERED-empty: a row in `workstreams` with zero tasks,
 *      zero agents, zero vcs_workspaces. Mux
 *      session presence and agent_logs entries do NOT disqualify
 *      — the session itself was created at init time and contains
 *      no agent panes; the events are audit, not state.
 *
 *   2. MUX-only: a mux session named `mu-*` with no row in the
 *      `workstreams` table. Catches test litter and remnants of a
 *      partial destroy where the DB row was wiped but the mux
 *      session survived (or sessions created out-of-band via
 *      `tmux new-session -s mu-foo`). The synthetic summary has
 *      `registered=false`, all counts 0, and `muxAlive=true` (it
 *      wouldn't have been surfaced otherwise).
 *
 * The predicate is intentionally narrow on the prefix: only
 * `mu-*` sessions are eligible. Arbitrary mux sessions the
 * operator created for unrelated work are NEVER matched — mu only
 * owns its own namespace.
 *
 * Used by `mu workstream destroy --empty` to sweep test-litter
 * workstreams in one command (instead of the per-name jq incantation
 * over `mu workstream list --json`).
 *
 * Returns one `WorkstreamSummary` per match, sorted by name (with
 * defensive dedup — a registered-empty and a mux-only of the same
 * name can't both arise from the same call by construction, but
 * belt-and-braces).
 */
export async function listEmptyWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const registeredRows = db
    .prepare(
      `SELECT ws.name AS name
         FROM workstreams ws
         LEFT JOIN tasks          t  ON t.workstream_id  = ws.id
         LEFT JOIN agents         a  ON a.workstream_id  = ws.id
         LEFT JOIN vcs_workspaces v  ON v.workstream_id  = ws.id
        GROUP BY ws.id, ws.name
       HAVING COUNT(DISTINCT t.id)  = 0
          AND COUNT(DISTINCT a.id)  = 0
          AND COUNT(DISTINCT v.id)  = 0
        ORDER BY ws.name`,
    )
    .all() as { name: string }[];
  const registeredEmpty = await Promise.all(
    registeredRows.map((r) => summarizeWorkstream(db, { workstream: r.name })),
  );

  // Mux-only mu-* sessions: enumerate every running mux session,
  // keep the ones with the `mu-` prefix (strip it to get the
  // would-be workstream name), then subtract names already in the
  // `workstreams` table. The mirror of listWorkstreams above; see
  // its comment for the prefix rationale.
  const dbNames = new Set<string>(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );
  const muxOnlyNames: string[] = [];
  for (const session of await listMuxSessions()) {
    if (!session.name.startsWith("mu-")) continue;
    const name = session.name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    if (dbNames.has(name)) continue;
    muxOnlyNames.push(name);
  }
  const muxOnly = await Promise.all(
    muxOnlyNames.map((name) => summarizeWorkstream(db, { workstream: name })),
  );

  // Compose + sort + dedup-by-name (defensive; no overlap is possible
  // by construction since muxOnlyNames excludes every dbName).
  const seen = new Set<string>();
  const all: WorkstreamSummary[] = [];
  for (const ws of [...registeredEmpty, ...muxOnly]) {
    if (seen.has(ws.name)) continue;
    seen.add(ws.name);
    all.push(ws);
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

export async function summarizeWorkstream(
  db: Db,
  opts: WorkstreamOptions,
): Promise<WorkstreamSummary> {
  const muxSession = opts.muxSession ?? `mu-${opts.workstream}`;
  const parked = parkedStatus(db, opts.workstream);
  return {
    name: opts.workstream,
    muxSession,
    muxAlive: await sessionAlive(muxSession),
    agentCount: countAgents(db, opts.workstream),
    taskCount: countTasks(db, opts.workstream),
    noteCount: countNotes(db, opts.workstream),
    edgeCount: countEdges(db, opts.workstream),
    workspaceCount: listWorkspaces(db, opts.workstream).length,
    registered: isRegistered(db, opts.workstream),
    ...(parked.parked ? { parked: { sinceDays: parked.sinceDays ?? 0 } } : {}),
  };
}

function isRegistered(db: Db, workstream: string): boolean {
  const row = db.prepare("SELECT 1 AS x FROM workstreams WHERE name = ?").get(workstream) as
    | { x: number }
    | undefined;
  return row !== undefined;
}

/**
 * Tear down a workstream: kill its mux session and delete every DB row
 * tagged with its name. Cascades on `tasks` clean up `task_edges` and
 * `task_notes` automatically (FK ON DELETE CASCADE in the schema).
 *
 * Idempotent: safe to call against a workstream that never existed; safe
 * to call repeatedly. Returns counts so the caller can print a useful
 * summary.
 */
export async function destroyWorkstream(
  db: Db,
  opts: DestroyWorkstreamOptions,
): Promise<DestroyResult> {
  const muxSession = opts.muxSession ?? `mu-${opts.workstream}`;

  // Destroy does not snapshot. v9 dropped the `snapshots` table; the
  // destroy writes tombstone ops instead and `mu undo` replays the
  // inverses (VISION.md § 2b).

  // Pre-count the cascade victims so we can report them — SQLite's
  // changes() only reports rows directly affected by the last statement,
  // not cascade victims.
  const agentsBefore = countAgents(db, opts.workstream);
  const tasksBefore = countTasks(db, opts.workstream);
  const notesBefore = countNotes(db, opts.workstream);
  const edgesBefore = countEdges(db, opts.workstream);
  const workspacesBefore = listWorkspaces(db, opts.workstream);

  // Mux session first: if killSession throws we don't want the DB rows
  // already gone with no way to recover. (killSession is itself
  // idempotent on missing sessions — a real throw here is an
  // unexpected mux error.) Load-bearing: destroy must actually kill
  // the session, not silently report success while leaving panes
  // running.
  const mux = await activeMux();
  const muxAliveBefore = await mux.sessionExists(muxSession);
  if (muxAliveBefore) {
    await mux.killSession(muxSession);
  }

  // Workspaces SECOND, before the FK cascade. The cascade silently
  // deletes vcs_workspaces rows but leaves the on-disk worktrees
  // (and the git worktree registry entries) behind — the bug from
  // mufeedback note #195. Per backend, the right cleanup is
  // 'git worktree remove --force' / 'jj workspace forget' / etc.,
  // not 'rm -rf'. We surface failures so the user can recover; we
  // do NOT abort the destroy on workspace failure (the workstream
  // semantics are 'tear it all down', not 'partial cleanup').
  let freedWorkspaces = 0;
  let alreadyGoneWorkspaces = 0;
  const failedWorkspaces: WorkspaceFailure[] = [];
  const resolveBackend = opts.resolveBackend ?? backendByName;
  for (const ws of workspacesBefore) {
    try {
      const backend = resolveBackend(ws.backend);
      const result = await backend.freeWorkspace({
        workspacePath: ws.path,
        commit: false,
      });
      if (result.removed) {
        // Backend actually removed the on-disk path. This is the
        // only case that counts as 'work done by destroy'.
        freedWorkspaces += 1;
      } else {
        // Path was already gone (manual rm -rf or interrupted prior
        // destroy). The DB row is cascade-deleted below either way,
        // but we don't claim to have freed anything on disk — it was
        // already in the desired state. Tracked separately so the
        // user can spot stale registry rows from past mishaps.
        alreadyGoneWorkspaces += 1;
      }
    } catch (err) {
      failedWorkspaces.push({
        agent: ws.agentName,
        backend: ws.backend,
        path: ws.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After every per-agent worktree is freed, the parent
  // <state>/workspaces/<workstream>/ directory is empty — reap it
  // too. Best-effort: rmdir refuses if non-empty (e.g. backend
  // removal failed and left files behind), which is the right
  // outcome (don't silently rm -rf user data). Skipped if the
  // parent doesn't exist (workstream never had any workspaces).
  const parentDir = join(defaultStateDir(), "workspaces", opts.workstream);
  if (existsSync(parentDir)) {
    try {
      if (readdirSync(parentDir).length === 0) rmdirSync(parentDir);
    } catch {
      // Non-empty or otherwise unreapable. The failed-workspaces
      // list above already tells the user what to clean.
    }
  }

  // One DELETE: the FK CASCADE chain (workstreams → agents,
  // workstreams → tasks → task_edges + task_notes, workstreams →
  // agent_logs, workstreams → vcs_workspaces) cleans every row in
  // one shot, atomically. If the workstream was never registered
  // (e.g. an orphan mux session that mu never observed),
  // changes() = 0 and we still report the killed mux session
  // honestly.
  // One group for the entire destroy: the DELETE cascades to tasks,
  // edges and notes, and each cascaded row gets its own tombstone op
  // (SQLite FK CASCADE DOES fire triggers — verified empirically, see
  // src/capture.ts). They all share this group so the whole teardown is
  // one unit for `mu undo`.
  withOpContext(db, { intent: "workstream.destroy", group: "new" }, () =>
    db.prepare("DELETE FROM workstreams WHERE name = ?").run(opts.workstream),
  );
  // No emitEvent: the DELETE cascade fired the capture triggers, which
  // wrote tombstone ops (op='del', intent='workstream.destroy') for the
  // workstream AND for every task/edge/note that cascaded with it —
  // strictly more information than the prose counts, and it survives the
  // cascade because ops is FK-free.

  return {
    killedMux: muxAliveBefore,
    deletedAgents: agentsBefore,
    deletedTasks: tasksBefore,
    deletedNotes: notesBefore,
    deletedEdges: edgesBefore,
    freedWorkspaces,
    alreadyGoneWorkspaces,
    failedWorkspaces,
  };
}

// ─── Counts ────────────────────────────────────────────────────────────

function countAgents(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agents a
         JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countTasks(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countNotes(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_notes n
         JOIN tasks      t  ON t.id = n.task_id
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
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
         JOIN tasks      t  ON t.id = e.from_task_id
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}
