// mu — spawnAgent + supporting helpers (resolveCliCommand,
// awaitSpawnLiveness, createOrReusePane, defaultSpawnLivenessMs,
// prestageWorkspace, finalizeAgentRow, rollbackSpawn).
//
// spawnAgent's flow is documented inline. The interesting bit is the
// `--workspace` cycle (workspace row FKs agent.name; agent row needs
// pane_id which needs workspace path as cwd) — see prestageWorkspace.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type AgentRow,
  deleteAgent,
  getAgent,
  insertAgent,
  isValidAgentName,
  pendingPaneIdFor,
  refreshAgentTitle,
} from "../agents.js";
import type { Db } from "../db.js";
import { detectPiStatus } from "../detect.js";
import { emitEvent } from "../logs.js";
import { type NextStep, isJsonMode } from "../output.js";
import {
  capturePane,
  enableMuPaneBordersForPane,
  killPane,
  listWindows,
  newSessionWithPane,
  newWindow,
  paneExists,
  sessionExists,
  setPaneTitle,
  sleep,
  splitWindow,
} from "../tmux.js";
import type { VcsBackendName } from "../vcs.js";
import { createWorkspace, freeWorkspace } from "../workspace.js";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
} from "./errors.js";
import { withSpawnLock } from "./spawn-lock.js";

/**
 * Smallest-unused-suffix naming convention for agent names: a role
 * (lowercase alpha + digits) followed by `-<n>` where `<n>` is one or
 * more digits. Examples that pass: `worker-1`, `reviewer-2`, `scout-12`.
 * Examples that warn: `worker-tests`, `alice`, `db-leader`, `x-y-1`.
 *
 * Source: feedback ws task fb_agent_naming_convention. The dogfood report
 * was operators (LLMs included) drifting to descriptive names like
 * `worker-tests` after a few spawns, breaking the convention silently.
 * The hint surfaced by `maybeWarnNonConventionalAgentName` is a lint, not
 * a rule — `isValidAgentName` still accepts the broader
 * `^[a-z][a-z0-9_-]{0,31}$` shape.
 */
const AGENT_NAME_CONVENTION_RE = /^[a-z][a-z0-9]*(?:-[0-9]+)$/;

/**
 * Stderr lint when an agent name doesn't match the smallest-unused-suffix
 * convention. Mirrors the slugify-truncation stderr hint in cmdTaskAdd
 * (commit 28a13af): stderr-only, exit 0, suppressed under --json so
 * machine consumers stay clean. The spawn already succeeded by the time
 * this runs — we're just nudging the operator toward `<role>-<n>`.
 */
function maybeWarnNonConventionalAgentName(name: string): void {
  if (AGENT_NAME_CONVENTION_RE.test(name)) return;
  if (isJsonMode()) return;
  process.stderr.write(
    `hint: agent name "${name}" does not match the smallest-unused-suffix convention (<role>-<n>; e.g. worker-1, reviewer-2). Accepted; consider renaming if you spawn additional workers.\n`,
  );
}

/**
 * Resolve the actual executable to launch in an agent's pane for a given
 * `cli`. Honours the env var `MU_<UPPER_CLI>_COMMAND` (e.g. `MU_PI_COMMAND=
 * pi-alt` makes `--cli pi` actually exec `pi-alt`). Falls back to the cli
 * name itself, which is what users expect when their `pi` binary is on
 * `$PATH` under that exact name.
 *
 * Used by `spawnAgent` to pick the spawned command, and by reconcile's
 * orphan detector so externally-spawned panes running the resolved binary
 * are still recognised as agents.
 */
export function resolveCliCommand(cli: string): string {
  const envName = envVarNameForCli(cli);
  const override = process.env[envName];
  return override && override.trim() !== "" ? override : cli;
}

/**
 * Compute the `MU_<UPPER_CLI>_COMMAND` env var name mu consults when
 * resolving `--cli <key>`. Hyphens in the cli key become underscores
 * (env var names can't contain `-`); this matches the operator-aliases
 * convention documented in the mu skill (e.g. `--cli pi-meta` →
 * `MU_PI_META_COMMAND`).
 */
export function envVarNameForCli(cli: string): string {
  return `MU_${cli.toUpperCase().replace(/-/g, "_")}_COMMAND`;
}

/**
 * Resolve `--cli <key>` to its actual command string AND tell the
 * caller whether the resolution came from a `MU_<UPPER_CLI>_COMMAND`
 * env var or fell through to the bare cli name. The CLI uses this to
 * surface env-var attribution in the spawn-success line so config
 * issues are visible without `mu agent show`
 * (fb_agent_spawn_no_validation, part C).
 */
export function resolveCliCommandWithSource(cli: string): {
  command: string;
  envVar: string;
  resolvedFromEnv: boolean;
} {
  const envVar = envVarNameForCli(cli);
  const override = process.env[envVar];
  if (override !== undefined && override.trim() !== "") {
    return { command: override, envVar, resolvedFromEnv: true };
  }
  return { command: cli, envVar, resolvedFromEnv: false };
}

// ─── Pre-flight PATH check (fb_agent_spawn_no_validation, part A) ──
//
// Operator typo'd `mu agent spawn worker-1 --cli pi-meta` on a host
// where `pi-meta` wasn't on PATH; the spawn appeared to succeed but
// the pane died with `command not found` and the existing 1.5s
// liveness check sometimes missed it (shells stay alive past a failed
// exec). Pre-flight the PATH resolution so a typo never:
//   1. creates an orphan workspace dir
//   2. creates an orphan tmux pane
//   3. inserts a half-spawned DB row
// The check fires AFTER `resolveCliCommand` so `MU_<UPPER>_COMMAND`
// overrides are honoured AND the diagnostic mentions the env var by
// name. Hookable via `setCommandResolverForTests` so the test suite
// can simulate "binary present" / "binary absent" without polluting
// the real PATH.

export interface CommandResolutionResult {
  ok: boolean;
  /** First whitespace-separated token of the command — the binary
   *  whose presence on PATH we checked. */
  binary: string;
  /** Absolute path of the resolved binary on PATH, when ok=true. */
  resolvedPath?: string;
}

export type CommandResolver = (command: string) => Promise<CommandResolutionResult>;

const execFileP = promisify(execFile);

/** Default resolver: shell-out to `command -v <binary>` (POSIX-portable
 *  equivalent of `which`). Returns ok=false when the lookup exits
 *  non-zero. Always returns the parsed `binary` field so the typed
 *  error can quote what we actually searched for. */
async function defaultCommandResolver(command: string): Promise<CommandResolutionResult> {
  const binary = parseFirstToken(command);
  if (binary === "") return { ok: false, binary };
  try {
    // `command -v` is the POSIX builtin lookup. Spawned via /bin/sh
    // -c so the builtin is available (it's not an external program).
    const { stdout } = await execFileP("/bin/sh", ["-c", `command -v -- ${shellQuote(binary)}`], {
      env: process.env,
    });
    const resolvedPath = stdout.trim();
    if (resolvedPath === "") return { ok: false, binary };
    return { ok: true, binary, resolvedPath };
  } catch {
    return { ok: false, binary };
  }
}

/** Single-quote a token for /bin/sh -c. Only used on the binary name,
 *  which `parseFirstToken` already restricted to a non-whitespace run
 *  — no embedded single-quotes expected. Escape defensively anyway. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** First whitespace-separated token of a command string ("pi-meta
 *  --no-solo" → "pi-meta"). Returns "" on an empty / whitespace-only
 *  input. */
function parseFirstToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "") return "";
  const match = trimmed.match(/^\S+/);
  return match ? match[0] : "";
}

let activeCommandResolver: CommandResolver = defaultCommandResolver;

/** Override the PATH resolver. Tests use this to simulate "binary
 *  absent" / "binary present" without depending on what's actually
 *  installed. Production callers should never touch this. */
export function setCommandResolverForTests(resolver: CommandResolver): void {
  activeCommandResolver = resolver;
}

/** Restore the default PATH resolver. */
export function resetCommandResolverForTests(): void {
  activeCommandResolver = defaultCommandResolver;
}

/**
 * Verify the first token of `command` resolves to a binary on PATH.
 * Public so tests can call it directly; spawnAgent calls it before
 * prestageWorkspace so a bad --cli never creates an orphan workspace.
 */
export async function checkCommandResolvable(command: string): Promise<CommandResolutionResult> {
  return activeCommandResolver(command);
}

export interface SpawnAgentOptions {
  name: string;
  workstream: string;
  /** Defaults to "pi". 0.1.0 only really supports "pi" but the column
   *  accepts any string for forward-compat with future multi-CLI support
   *  (claude/codex). */
  cli?: string;
  /** The actual command to run in the pane. Defaults to the cli value. */
  command?: string;
  /** Window name to group this agent under. Defaults to the agent's name
   *  (so each agent gets its own window). Multiple agents sharing a `tab`
   *  share a window with multiple panes. */
  tab?: string;
  /** "full-access" (default) or "read-only". The schema stores it; today
   *  the role isn't enforced (deferred to a future capabilities pass). */
  role?: string;
  /** Initial working directory for the spawned pane (`tmux -c <path>`).
   *  When `workspace: true` is passed, this is ignored — the workspace
   *  path is used instead. */
  cwd?: string;
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
  /** Auto-create a VCS workspace for this agent before spawning the
   *  pane and use the workspace path as cwd. Backend defaults to
   *  detection (jj > sl > git > none). */
  workspace?: boolean;
  /** Force a specific VCS backend (only meaningful with `workspace: true`). */
  workspaceBackend?: VcsBackendName;
  /** Optional ref to base the workspace on (only meaningful with
   *  `workspace: true`). Backend-specific. */
  workspaceFrom?: string;
  /** Project root the workspace branches from (only meaningful with
   *  `workspace: true`). Defaults to `process.cwd()`. */
  workspaceProjectRoot?: string;
}

/**
 * Spawn a new agent in its tmux pane and register it in the DB.
 *
 * Phases:
 *   1. Validate name + uniqueness.
 *   2. If --workspace: prestageWorkspace() (placeholder agent row +
 *      workspace dir + workspace row).
 *   3. createOrReusePane() in the workspace path (or opts.cwd).
 *   4. setPaneTitle + enableMuPaneBordersForPane.
 *   5. finalizeAgentRow() — patch placeholder pane_id to real (workspace
 *      path), or insert a fresh agent row (no-workspace path).
 *   6. awaitSpawnLiveness().
 *
 * Failure between any of (3)–(6) calls rollbackSpawn() to undo the
 * pane + row + workspace. The caller-visible error is preserved.
 */
export async function spawnAgent(db: Db, opts: SpawnAgentOptions): Promise<AgentRow> {
  if (!isValidAgentName(opts.name)) {
    throw new TypeError(
      `invalid agent name: ${JSON.stringify(opts.name)} (expected /^[a-z][a-z0-9_-]{0,31}$/)`,
    );
  }
  // Per-workstream uniqueness check: v5 allows the same agent name in
  // different workstreams. Scope the existence check to the spawn's
  // workstream so two operators spawning 'worker-1' in wsA and wsB
  // both succeed (bug_v5_name_clash_silent_misroute).
  if (getAgent(db, opts.name, opts.workstream) !== undefined) {
    throw new AgentExistsError(opts.name);
  }

  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const windowName = opts.tab ?? opts.name;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? resolveCliCommand(cli);

  // Pre-flight PATH resolution. Catches `--cli does-not-exist` (and
  // typos in `MU_<UPPER>_COMMAND` overrides) before any side effect.
  // See `checkCommandResolvable` / `AgentSpawnCliNotFoundError` for
  // the rationale; in short: prevents orphan workspace dirs + orphan
  // panes + half-spawned DB rows on a typo.
  //
  // We do NOT pre-flight an explicit `--command "..."` value: the
  // operator who passed --command gave us the literal string they
  // want spawned (often a wrapper like `pi-meta --no-solo` whose
  // first token IS on PATH but with arg-quoting that the resolver
  // would mis-parse; or a shell snippet like `bash -lc '...'`). For
  // those, the existing post-spawn liveness check is the safety net.
  if (opts.command === undefined) {
    const check = await checkCommandResolvable(command);
    if (!check.ok) {
      throw new AgentSpawnCliNotFoundError(cli, check.binary, envVarNameForCli(cli));
    }
  }

  // Workspace pre-stage. See `prestageWorkspace` for the FK-ordering
  // rationale. Returns the workspace path (used as the pane's cwd) or
  // undefined when --workspace wasn't requested.
  const workspacePathStr = opts.workspace ? await prestageWorkspace(db, opts, cli) : undefined;

  // Inject identity env vars into the pane so anything running inside
  // (pi extensions, claim-protocol scripts, status segments) can branch
  // on 'I am a mu-managed worker' without scraping pane titles or DB
  // lookups. Set via tmux `-e KEY=VALUE` (per-pane; doesn't pollute the
  // tmux server's global env).
  //
  // These are NOT exposed via SpawnAgentOptions — mu identity is not
  // user-tunable. Adding more keys here means every spawned pane sees
  // them automatically.
  const paneEnv: Record<string, string> = {
    MU_MANAGED_AGENT: "1",
    MU_AGENT_NAME: opts.name,
    MU_WORKSTREAM: opts.workstream,
  };

  const hasWorkspace = workspacePathStr !== undefined;

  // Single outer try wrapping every step that can throw AFTER the
  // workspace has been prestaged: pane create/reuse, pane title +
  // borders, agent-row finalize, liveness check. Earlier shape had
  // createOrReusePane outside the try, so a tmux failure (e.g. no
  // workstream session and tmux refusing to create one) left the
  // prestaged workspace dir + placeholder agent row behind as an
  // orphan — task agent_spawn_abort_leaves_orphan_workspace.
  //
  // paneId is undefined until createOrReusePane returns; rollbackSpawn
  // skips killPane in that case. The inner try/catches that previously
  // wrapped finalize and liveness were folded into this single catch
  // (clarity > belt-and-suspenders; rollbackSpawn is idempotent and
  // best-effort regardless).
  let paneId: string | undefined;
  let agent: AgentRow;
  try {
    // Cross-process critical section: the tmux topology check-then-act
    // (`sessionExists` → `new-session` / `new-window` / `split-window`)
    // plus the agent-row finalize. Serialised per tmux SESSION so a
    // parallel fan-out (`for n in …; do mu agent spawn … & done`) can't
    // race six `new-session -d -s mu-scratch` calls into
    // five-rolled-back-losers. Keyed on the session name: spawns into
    // different sessions never contend. See spawn-lock.ts.
    //
    // The liveness wait is deliberately OUTSIDE the lock: it is the slow
    // part (1.5s+), and holding the lock across it would serialise the
    // very parallelism the operator asked for. Once the row is inserted
    // and the lock released, the next spawn can build its own window
    // while this one waits.
    const created = await withSpawnLock(session, async () => {
      const pid = await createOrReusePane({
        session,
        windowName,
        command,
        cwd: workspacePathStr ?? opts.cwd,
        env: paneEnv,
      });
      await setPaneTitle(pid, opts.name);
      // Apply the mu pane border to the new window. Window-scoped option;
      // see enableMuPaneBorders docstring for why this is required per
      // window (and not just per session). Self-checks MU_BANNER_QUIET
      // and is best-effort — the border is decorative.
      await enableMuPaneBordersForPane(pid);
      const row = finalizeAgentRow(db, { opts, cli, paneId: pid, hasWorkspace });
      return { pid, row };
    });
    paneId = created.pid;
    agent = created.row;
    // Liveness check: wait briefly, then verify the pane is still alive.
    // Catches the silent-spawn-failure class of bugs where the CLI dies
    // immediately (lock conflict, bad credentials, etc.). On failure,
    // surface a typed error with whatever scrollback tmux still has.
    await awaitSpawnLiveness(paneId, opts.name);
  } catch (err) {
    await rollbackSpawn(db, opts.name, paneId, hasWorkspace, opts.workstream);
    if (hasWorkspace) attachOrphanCleanupHint(err, opts.name, opts.workstream);
    throw err;
  }
  emitEvent(
    db,
    opts.workstream,
    `agent spawn ${opts.name} (cli=${cli}, role=${opts.role ?? "full-access"}, pane=${paneId})`,
  );
  // Initial title push: the agent row is in 'spawning' state at this
  // point, which composeAgentTitle renders as bare name (no decoration
  // until the first detect cycle). Reconcile will re-push as soon as
  // the operator runs any status-reading verb.
  await refreshAgentTitle(db, opts.name, opts.workstream);
  // Lint-grade stderr nudge when the operator picked a name that
  // doesn't fit the <role>-<n> smallest-unused-suffix convention. The
  // spawn already succeeded; this is advice, not an error. Done LAST
  // so the hint trails the spawn's own stdout output and so a partial
  // failure (rolled back above) never emits it.
  maybeWarnNonConventionalAgentName(opts.name);
  return agent;
}

/**
 * Stage 1 of `--workspace` spawn: insert the agent row with a placeholder
 * pane id, then create the VCS workspace (whose row FKs the agent name).
 *
 * Why placeholder-first? `vcs_workspaces.agent` FK + ON DELETE CASCADE
 * means the workspace row needs an agents row to exist before we insert
 * it; but we can't insert agents without a pane_id (NOT NULL), and we
 * can't create the pane until we know the workspace's on-disk path
 * (used as cwd). The placeholder unblocks the cycle.
 *
 * The placeholder is a publicly-visible quirk — see `PENDING_PANE_PREFIX`
 * and the consumers it documents (refreshAgentTitle and reconcile's
 * pending-pane prune skip). The deeper fix (eliminate the placeholder
 * by reordering ws-dir → pane → atomic dual-insert) is filed as a
 * separate refactor; this shape is the established equilibrium.
 *
 * Throws after best-effort rollback (deleteAgent) if workspace creation
 * fails. Returns the workspace's on-disk path.
 */
async function prestageWorkspace(db: Db, opts: SpawnAgentOptions, cli: string): Promise<string> {
  insertAgent(db, {
    name: opts.name,
    workstream: opts.workstream,
    cli,
    paneId: pendingPaneIdFor(opts.name),
    status: "spawning",
    role: opts.role,
    tab: opts.tab ?? null,
  });
  try {
    const wsOpts: Parameters<typeof createWorkspace>[1] = {
      agent: opts.name,
      workstream: opts.workstream,
    };
    if (opts.workspaceBackend !== undefined) wsOpts.backend = opts.workspaceBackend;
    if (opts.workspaceFrom !== undefined) wsOpts.parentRef = opts.workspaceFrom;
    if (opts.workspaceProjectRoot !== undefined) wsOpts.projectRoot = opts.workspaceProjectRoot;
    const ws = await createWorkspace(db, wsOpts);
    return ws.path;
  } catch (err) {
    deleteAgent(db, opts.name, opts.workstream);
    throw err;
  }
}

/**
 * Stage 2 of spawn (after the real pane exists): either patch the
 * placeholder row to the real pane id (workspace path), or insert a
 * fresh agent row (no-workspace path). Throws if the patch UPDATE
 * silently affects no row (the placeholder row vanished mid-spawn —
 * historically the bug_agent_spawn_workspace_fk_failure class, now
 * patched by reconcile's pending-pane prune skip).
 */
function finalizeAgentRow(
  db: Db,
  args: { opts: SpawnAgentOptions; cli: string; paneId: string; hasWorkspace: boolean },
): AgentRow {
  const { opts, cli, paneId, hasWorkspace } = args;
  if (!hasWorkspace) {
    return insertAgent(db, {
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId,
      status: "spawning",
      role: opts.role,
      tab: opts.tab ?? null,
    });
  }
  // Scope the patch to the spawn's workstream so a same-named worker
  // in another workstream isn't repointed at this pane
  // (bug_v5_name_clash_silent_misroute).
  db.prepare(
    `UPDATE agents SET pane_id = ?, updated_at = ?
      WHERE name = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
  ).run(paneId, new Date().toISOString(), opts.name, opts.workstream);
  const row = getAgent(db, opts.name, opts.workstream);
  if (!row) throw new Error(`spawnAgent: agent vanished after workspace stage: ${opts.name}`);
  return row;
}

/**
 * Roll back a failed spawn. Idempotent and best-effort: every step
 * swallows its own errors so a partial-cleanup substrate (already-killed
 * pane, no agent row) never masks the original failure.
 *
 * `paneId` is `undefined` when createOrReusePane itself threw before
 * returning a pane id — there's nothing to kill. `hasWorkspace` is
 * `true` when prestageWorkspace succeeded; freeWorkspace is idempotent
 * on a missing workspace so calling it after a same-cycle failure is
 * safe. deleteAgent is also idempotent (no-op on a missing row).
 */
async function rollbackSpawn(
  db: Db,
  name: string,
  paneId: string | undefined,
  hasWorkspace: boolean,
  workstream: string,
): Promise<void> {
  if (paneId !== undefined) await killPane(paneId).catch(() => {});
  if (hasWorkspace) {
    // Scope cleanup to the spawn's workstream so a same-named worker
    // elsewhere isn't torn down by accident
    // (bug_v5_name_clash_silent_misroute).
    await freeWorkspace(db, name, { workstream }).catch(() => {});
  }
  deleteAgent(db, name, workstream);
}

/**
 * After a failed spawn that prestaged a workspace, augment the thrown
 * error with orphan-cleanup hints (`mu workspace orphans` +
 * `mu workspace free`). rollbackSpawn is best-effort — if the
 * freeWorkspace call inside it failed (rmdir blocked, vcs backend
 * refusing to remove a workspace with uncommitted state, etc.), the
 * dir survives and the operator needs to know how to clean it up.
 *
 * Uses the duck-typed `errorNextSteps()` convention (see
 * `hasNextSteps()` in src/output.ts) so this works whether the inner
 * error is a typed mu error already exposing nextSteps
 * (AgentDiedOnSpawnError) or a bare TmuxError / Error from
 * createOrReusePane that has none. Existing hints (if any) are
 * preserved and listed first; the orphan-cleanup hints are appended
 * so the diagnostic-first ordering of typed errors is kept.
 */
function attachOrphanCleanupHint(err: unknown, agent: string, workstream: string): void {
  if (typeof err !== "object" || err === null) return;
  const target = err as { errorNextSteps?: () => NextStep[] };
  const existing =
    typeof target.errorNextSteps === "function" ? target.errorNextSteps.bind(target) : null;
  const orphanHints: NextStep[] = [
    {
      intent: "Check for an orphan workspace dir (rollback is best-effort; may have failed)",
      command: `mu workspace orphans -w ${workstream}`,
    },
    {
      intent: "Free the workspace if it survived the rollback (idempotent on missing)",
      command: `mu workspace free ${agent} -w ${workstream}`,
    },
  ];
  target.errorNextSteps = () => [...(existing ? existing() : []), ...orphanHints];
}

/**
 * Default liveness window in milliseconds. 0 disables the check (useful
 * for fast tests that don't want to wait). Override via env var
 * `MU_SPAWN_LIVENESS_MS`.
 */
export function defaultSpawnLivenessMs(): number {
  const raw = process.env.MU_SPAWN_LIVENESS_MS;
  if (raw === undefined) return 1500;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 1500;
  return parsed;
}

/**
 * Curated list of patterns that indicate the spawned CLI hit a fatal
 * provider/auth error during startup and is now parked at an error
 * prompt instead of becoming a working agent. Source:
 * `agent_spawn_model_auth_failure_counts_as_live` in the feedback ws.
 *
 * Kept short and case-insensitive on purpose: every entry must match a
 * real, observed dogfood failure mode. Don't add patterns speculatively
 * — the false-positive cost is to roll back a healthy spawn, which the
 * operator then has to re-attempt without the scan (`MU_SPAWN_LIVENESS_MS=0`).
 *
 * Mitigation against scrollback noise from harmless prior-session text:
 * the caller (`awaitSpawnLiveness`) only scans the LAST `STARTUP_ERROR_TAIL_LINES`
 * lines of the capture taken right after the liveness sleep, so matches
 * naturally come from the CLI's first ~1.5s of output (the spawned
 * pane has had no time to scroll older content into view).
 */
const STARTUP_ERROR_PATTERNS: readonly RegExp[] = [
  /No API key found for [\w-]+/i,
  /Error: invalid API key/i,
  /Authentication failed/i,
  /401 Unauthorized/i,
  /Could not authenticate/i,
  // fb_agent_spawn_no_validation part B: post-spawn detection of the
  // "binary not found at exec time" failure mode. The pre-flight check
  // above catches the common typo BEFORE any side effect, but a few
  // edge cases still slip through and only surface in the pane:
  //   - `--command "..."` skips the pre-flight (operator opt-out).
  //   - PATH inside the spawned shell differs from PATH in mu's
  //     process (login shell rc files, /etc/paths.d, etc.).
  //   - Race: binary on PATH at spawn time, gone 1.5s later.
  //
  // Anchored to lines that LOOK like a shell error rather than prose
  // mentioning the marker (review_substrate_startup_err_patterns_too_broad):
  // require the marker at end-of-line, optionally followed by a single
  // `: <name>` token (the zsh form: `zsh: command not found: pi-meta`).
  // This still trips the canonical cases —
  //   `bash: pi-meta: command not found`
  //   `zsh: command not found: pi-meta`
  //   `sh: pi-meta: No such file or directory`
  // — but rejects banner prose like
  //   `I noticed earlier you saw 'command not found'`
  //   `type \`mu\` — command not found? install with …`
  // that previously triggered a full spawn rollback. The pre-flight
  // PATH check remains the deterministic safety net for typo'd `--cli`.
  /^(?:.*: )?(?:command not found|No such file or directory)(?::\s*\S+)?$/i,
];

/**
 * Number of trailing lines of the post-liveness scrollback to scan for
 * `STARTUP_ERROR_PATTERNS`. The capture is `lines: 50`; tailing the last
 * 30 keeps the scan focused on the spawned CLI's own startup output
 * (the pane is brand-new, so anything earlier than that is the shell
 * banner / our own command-line, both safe).
 */
const STARTUP_ERROR_TAIL_LINES = 30;

/**
 * Scan the tail of a freshly-captured pane buffer for known startup-
 * failure patterns. Returns the matched line on first hit, or undefined
 * if the buffer is clean.
 *
 * Exported for the test suite; not part of the SDK surface.
 */
export function detectSpawnStartupError(scrollback: string): string | undefined {
  const lines = scrollback.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - STARTUP_ERROR_TAIL_LINES));
  for (const line of tail) {
    for (const pattern of STARTUP_ERROR_PATTERNS) {
      if (pattern.test(line)) return line;
    }
  }
  return undefined;
}

async function awaitSpawnLiveness(paneId: string, agentName: string): Promise<void> {
  const ms = defaultSpawnLivenessMs();
  if (ms === 0) return;
  await sleep(ms);
  // Capture-pane first so we have something to attach to the error if the
  // pane is in the process of being torn down (the buffer survives a beat
  // longer than the pane's existence in some tmux builds).
  const scrollback = await capturePane(paneId, { lines: 50 }).catch(() => undefined);
  if (!(await paneExists(paneId))) {
    throw new AgentDiedOnSpawnError(agentName, paneId, scrollback);
  }
  // Pane is alive — but "alive" doesn't mean "working". Scan the tail of
  // the capture for known provider/auth startup errors
  // (agent_spawn_model_auth_failure_counts_as_live). The pane stays at
  // an error prompt forever otherwise, and the orchestrator only
  // discovers the dud minutes later when `mu task wait` stalls.
  if (scrollback !== undefined) {
    const matchedLine = detectSpawnStartupError(scrollback);
    if (matchedLine !== undefined) {
      throw new AgentSpawnStartupError(agentName, paneId, matchedLine, scrollback);
    }
  }
  // Readiness poll: wait until the CLI inside the pane reaches a
  // detectable state (needs_input / needs_permission / busy). This
  // prevents orchestrators from sending commands to agents that
  // haven't finished loading yet. Controlled by MU_SPAWN_READINESS_MS
  // (default 10s; 0 disables).
  await awaitSpawnReadiness(paneId, agentName);
}

/**
 * Default readiness budget in milliseconds. After the liveness check
 * passes, poll the pane's scrollback until the CLI reaches a detected
 * state (needs_input, needs_permission, or busy). 0 disables the
 * poll. Override via env var `MU_SPAWN_READINESS_MS`.
 *
 * The default is 10 000 ms (10 s) — generous enough for pi's typical
 * 2–5 s cold-start while not blocking forever if the CLI is unusually
 * slow. Orchestrators that know their agents start faster can lower
 * this; manual spawns where the user will see the pane anyway can
 * set it to 0.
 */
export function defaultSpawnReadinessMs(): number {
  const raw = process.env.MU_SPAWN_READINESS_MS;
  if (raw === undefined) return 10_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 10_000;
  return parsed;
}

/** Interval between readiness polls (ms). */
const READINESS_POLL_INTERVAL_MS = 250;

/**
 * Poll the pane until the pi status detector recognises it as having
 * reached a stable state (needs_input, needs_permission, or busy).
 * Returns silently when the pane becomes ready or the budget expires
 * (timeout is NOT an error — the agent may just be slow to start).
 *
 * If the pane disappears mid-poll, throws AgentDiedOnSpawnError.
 */
async function awaitSpawnReadiness(paneId: string, agentName: string): Promise<void> {
  const budgetMs = defaultSpawnReadinessMs();
  if (budgetMs === 0) return;

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const scrollback = await capturePane(paneId, { lines: 50 }).catch(() => undefined);
    if (!(await paneExists(paneId))) {
      throw new AgentDiedOnSpawnError(agentName, paneId, scrollback);
    }
    if (scrollback !== undefined) {
      const status = detectPiStatus(scrollback);
      // needs_input means the CLI has finished loading and is
      // waiting for a prompt — the most common "ready" state.
      // busy/needs_permission also count as ready (the CLI is
      // running and has rendered recognisable output).
      if (status === "needs_input" || status === "busy" || status === "needs_permission") {
        return;
      }
    }
    await sleep(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  // Budget exhausted — not an error, just a slow start. The agent
  // row is already committed; reconcile will pick up the status on
  // the next tick.
}

/**
 * Three cases, all returning a stable pane id:
 *   - session doesn't exist          → create session+window+pane in one shot
 *   - session exists, no such window → create a new window for this agent
 *   - session and window both exist  → split the window to add a pane
 */
async function createOrReusePane(opts: {
  session: string;
  windowName: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<string> {
  if (!(await sessionExists(opts.session))) {
    return newSessionWithPane(opts.session, {
      windowName: opts.windowName,
      command: opts.command,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  const windows = await listWindows(opts.session);
  const matching = windows.find((w) => w.name === opts.windowName);

  if (matching) {
    return splitWindow({
      target: `${opts.session}:${opts.windowName}`,
      command: opts.command,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  return newWindow({
    session: opts.session,
    name: opts.windowName,
    command: opts.command,
    cwd: opts.cwd,
    env: opts.env,
  });
}
