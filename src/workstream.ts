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

import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Db, defaultStateDir } from "./db.js";
import {
  type ExportManifest,
  type ExportSourceManifest,
  exportSourceForWorkstream,
  renderToBucket,
} from "./exporting.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { parkedStatus } from "./parked.js";
import { captureSnapshot } from "./snapshots.js";
import { killSession, listSessions, sessionExists, tmux } from "./tmux.js";
import { type VcsBackend, type VcsBackendName, backendByName } from "./vcs.js";
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

export async function resolveTmuxSessionWorkstreamName(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const name = (await tmux(["display-message", "-p", "#S"])).trim();
    if (name.startsWith(RESERVED_WORKSTREAM_PREFIX)) {
      return name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    }
  } catch {
    // fall through: tmux context is best-effort for workstream resolution
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
      {
        intent: "Pick a different workstream name",
        command: "mu archive restore <label> --as <new-name>",
      },
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
  /** The workstream's own name. */
  name: string;
  /** Tmux session name, defaults to `mu-<name>`. */
  tmuxSession: string;
  /** True iff `tmux has-session -t <tmuxSession>` succeeds right now. */
  tmuxAlive: boolean;
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
   *  agent_logs row is a `db export` event, no alive agents, no
   *  IN_PROGRESS tasks, threshold elapsed). Consumed by
   *  `mu workstream list` and the TUI tab strip / workstreams card.
   *  See src/parked.ts. */
  parked?: { sinceDays: number };
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
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
  /** Override the per-name VcsBackend resolver. Defaults to
   *  `backendByName`. Lets tests inject a fake backend (e.g. one whose
   *  `freeWorkspace` throws) without mutating the exported singletons —
   *  same pattern as `createWorkspace`'s `opts.backend` accepting a
   *  pre-built `VcsBackend` object. Production callers leave this
   *  unset. */
  resolveBackend?: (name: VcsBackendName) => VcsBackend;
}

export interface DestroyWorkstreamOptions extends WorkstreamOptions {
  /** Skip the per-workstream pre-mutation snapshot because the caller
   *  already captured a broader snapshot for the whole destructive
   *  operation. Used by `mu workstream destroy --empty` after its
   *  sweep-level safety snapshot; direct destroy callers leave this
   *  false so the default safety net is unchanged. */
  suppressSnapshot?: boolean;
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
    if (session.name.startsWith(RESERVED_WORKSTREAM_PREFIX))
      tmuxNames.add(session.name.slice(RESERVED_WORKSTREAM_PREFIX.length));
  }

  const allNames = Array.from(new Set([...dbNames, ...tmuxNames])).sort();
  return Promise.all(allNames.map((name) => summarizeWorkstream(db, { workstream: name })));
}

/**
 * Discover every workstream that has no user-meaningful state
 * attached. Two flavours unioned:
 *
 *   1. REGISTERED-empty: a row in `workstreams` with zero tasks,
 *      zero agents, zero vcs_workspaces. Tmux
 *      session presence and agent_logs entries do NOT disqualify
 *      — the session itself was created at init time and contains
 *      no agent panes; the events are audit, not state.
 *
 *   2. TMUX-only: a tmux session named `mu-*` with no row in the
 *      `workstreams` table. Catches test litter and remnants of a
 *      partial destroy where the DB row was wiped but the tmux
 *      session survived (or sessions created out-of-band via
 *      `tmux new-session -s mu-foo`). The synthetic summary has
 *      `registered=false`, all counts 0, and `tmuxAlive=true` (it
 *      wouldn't have been surfaced otherwise).
 *
 * The predicate is intentionally narrow on the prefix: only
 * `mu-*` sessions are eligible. Arbitrary tmux sessions the
 * operator created for unrelated work are NEVER matched — mu only
 * owns its own namespace.
 *
 * Used by `mu workstream destroy --empty` to sweep test-litter
 * workstreams in one command (instead of the per-name jq incantation
 * over `mu workstream list --json`).
 *
 * Returns one `WorkstreamSummary` per match, sorted by name (with
 * defensive dedup — a registered-empty and a tmux-only of the same
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

  // Tmux-only mu-* sessions: enumerate every running tmux session,
  // keep the ones with the `mu-` prefix (strip it to get the
  // would-be workstream name), then subtract names already in the
  // `workstreams` table. The mirror of listWorkstreams above; see
  // its comment for the prefix rationale.
  const dbNames = new Set<string>(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );
  const tmuxOnlyNames: string[] = [];
  for (const session of await listSessions()) {
    if (!session.name.startsWith("mu-")) continue;
    const name = session.name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    if (dbNames.has(name)) continue;
    tmuxOnlyNames.push(name);
  }
  const tmuxOnly = await Promise.all(
    tmuxOnlyNames.map((name) => summarizeWorkstream(db, { workstream: name })),
  );

  // Compose + sort + dedup-by-name (defensive; no overlap is possible
  // by construction since tmuxOnlyNames excludes every dbName).
  const seen = new Set<string>();
  const all: WorkstreamSummary[] = [];
  for (const ws of [...registeredEmpty, ...tmuxOnly]) {
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
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const parked = parkedStatus(db, opts.workstream);
  return {
    name: opts.workstream,
    tmuxSession,
    tmuxAlive: await sessionExists(tmuxSession),
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
 * Tear down a workstream: kill its tmux session and delete every DB row
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
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;

  // Pre-mutation snapshot (snap_design §EDGE CASES > WORKSTREAM
  // DESTROY). workstream=null because workstream-destroy snapshots
  // logically span every workstream in the DB (whole-DB backup;
  // anchoring to one name would lie about scope). If the snapshot
  // throws (disk full, perms), abort the destroy — better to refuse
  // than to delete irrecoverably.
  if (opts.suppressSnapshot !== true) {
    captureSnapshot(db, `workstream destroy ${opts.workstream}`, null);
  }

  // Pre-count the cascade victims so we can report them — SQLite's
  // changes() only reports rows directly affected by the last statement,
  // not cascade victims.
  const agentsBefore = countAgents(db, opts.workstream);
  const tasksBefore = countTasks(db, opts.workstream);
  const notesBefore = countNotes(db, opts.workstream);
  const edgesBefore = countEdges(db, opts.workstream);
  const workspacesBefore = listWorkspaces(db, opts.workstream);

  // Tmux first: if killSession throws we don't want the DB rows already
  // gone with no way to recover. (killSession is itself idempotent on
  // missing sessions — a real throw here is an unexpected tmux error.)
  const tmuxAliveBefore = await sessionExists(tmuxSession);
  if (tmuxAliveBefore) {
    await killSession(tmuxSession);
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
  // (e.g. an orphan tmux session that mu never observed),
  // changes() = 0 and we still report the killed tmux session
  // honestly.
  const result = db.prepare("DELETE FROM workstreams WHERE name = ?").run(opts.workstream);
  // The destroy event itself goes to workstream=null (machine-wide)
  // because the FK CASCADE we just triggered would otherwise wipe
  // it on the same statement. Visible via `mu log --all`.
  if (result.changes > 0 || tmuxAliveBefore) {
    emitEvent(
      db,
      null,
      `workstream destroy ${opts.workstream} (agents=${agentsBefore}, tasks=${tasksBefore}, edges=${edgesBefore}, notes=${notesBefore}, workspaces=${freedWorkspaces}/${workspacesBefore.length}, already_gone=${alreadyGoneWorkspaces}, tmux=${tmuxAliveBefore})`,
    );
  }

  return {
    killedTmux: tmuxAliveBefore,
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

// ─── exportWorkstream ──────────────────────────────────────────────────
//
// Thin sugar over `renderToBucket` (src/exporting.ts): one live
// workstream → one ExportSource → bucket render. The renderer holds
// every byte of layout knowledge; this wrapper just adapts the SDK
// reads (listTasks / getTaskEdges / listNotes / latestSeq) and
// emits the workstream-flavoured event.
//
// The on-disk shape is the v0.3 BUCKET layout (see src/exporting.ts):
//
//   <outDir>/
//     README.md / INDEX.md / manifest.json    # bucket-level
//     <workstream>/
//       README.md / INDEX.md / tasks/<id>.md  # per-source-ws
//
// Re-export against the same outDir is additive: a different `-w`
// adds a sibling subdir without touching the existing one. A re-run
// with the same `-w` refreshes that subdir (sha256 short-circuit).
//
// Anti-features (preserved from the originating design note):
//   - re-import: out of scope
//   - HTML/PDF: markdown-only
//   - embedded VCS: caller can `git init && git add . && git commit`
//   - cross-workstream merge: source-ws subdirs stay separate

export interface ExportWorkstreamOptions {
  workstream: string;
  /** Output directory (the bucket). Defaults to `./<workstream>/`
   *  in the cwd — i.e. the bucket and its single source-ws subdir
   *  share a name. */
  outDir?: string;
}

export interface ExportResult {
  outDir: string;
  /** Per-task files rewritten this call. */
  written: number;
  /** Per-task files sha256-skipped this call. */
  unchanged: number;
  /** Tasks present in a prior manifest that are no longer in the DB.
   *  Their .md stays on disk; a banner is added once. */
  preserved: number;
  manifestPath: string;
  manifest: ExportManifest;
  /** Per-source-ws manifest entry for this workstream — convenience
   *  for callers who only want one source's view. */
  source: ExportSourceManifest;
}

/**
 * Export one live workstream to a bucket directory. Idempotent +
 * additive: re-exporting the same workstream is sha256-skipped,
 * exporting a different workstream into the same bucket appends a
 * sibling subdir.
 *
 */
export function exportWorkstream(db: Db, opts: ExportWorkstreamOptions): ExportResult {
  const outDir = resolve(opts.outDir ?? join(process.cwd(), opts.workstream));
  const source = exportSourceForWorkstream(db, opts.workstream);
  const result = renderToBucket({
    sources: [source],
    bucketLabel: null,
    outDir,
  });
  const sourceManifest = result.manifest.sources[opts.workstream];
  if (!sourceManifest) {
    // Defensive: renderToBucket always inserts a manifest entry per
    // source it received. If this ever fires the renderer regressed.
    throw new Error(
      `exportWorkstream: renderer did not write a manifest entry for ${opts.workstream}`,
    );
  }
  emitEvent(
    db,
    opts.workstream,
    `workstream export ${opts.workstream} (out=${result.outDir}, tasks=${source.tasks.length}, written=${result.written}, unchanged=${result.unchanged}, preserved=${result.preserved})`,
  );
  return {
    outDir: result.outDir,
    written: result.written,
    unchanged: result.unchanged,
    preserved: result.preserved,
    manifestPath: result.manifestPath,
    manifest: result.manifest,
    source: sourceManifest,
  };
}
