#!/usr/bin/env node
// mu — command-line interface.
//
// 10 verbs + mission control, each registered via commander as a thin
// wrapper around the corresponding programmatic function in src/. The
// real work happens in agents.ts, tasks.ts, tracks.ts, db.ts, tmux.ts;
// this file is just argument parsing, output formatting, and error-to-
// exit-code translation.
//
// Layout: cli.ts is the wiring root. Pure rendering helpers live in
// `src/cli/format.ts`; typed-error → exit-code mapping + the `handle`
// wrapper live in `src/cli/handle.ts` (extracted by
// review_cli_ts_past_refactor_signal). cli.ts re-exports their public
// surface so existing tests + cli/* importers don't need to change
// import paths. The exit-code catalogue is documented at the top of
// `src/cli/handle.ts`.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";

import { AgentNotInWorkstreamError, type AgentRow, getAgentByPane } from "./agents.js";
import { wireAgentCommands, wireSelfCommands } from "./cli/agents.js";
import { wireArchiveCommands } from "./cli/archive.js";
import { wireDoctorCommand } from "./cli/doctor.js";
import {
  NameAmbiguousError,
  UsageError,
  emitParseError,
  findCommandForArgv,
  handle,
} from "./cli/handle.js";
import { wireLogCommand } from "./cli/log.js";
import { wireSnapshotCommands } from "./cli/snapshot.js";
import { wireSqlCommand } from "./cli/sql.js";
import { cmdState, wireStateCommands } from "./cli/state.js";
import { wireTaskCommands } from "./cli/tasks.js";
import { wireWorkspaceCommands } from "./cli/workspace.js";
import { wireWorkstreamCommands } from "./cli/workstream.js";
import type { Db } from "./db.js";
import {
  TASK_STATUS_LIST,
  TaskNotInWorkstreamError,
  type TaskRow,
  type TaskStatus,
  isTaskStatus,
} from "./tasks.js";
import { tmux } from "./tmux.js";
import { RESERVED_WORKSTREAM_PREFIX } from "./workstream.js";

// ─── Re-exports for downstream cli/* modules ──────────────────────────
//
// Pure rendering helpers and the typed-error catalogue live in
// `src/cli/format.ts` and `src/cli/handle.ts`; cli/* modules import
// them through `cli.ts` for ergonomic single-import lines.

export {
  IDLE_GLYPH,
  colorStatus,
  formatAgentsTable,
  formatReadyTable,
  formatTaskListTable,
  formatTracks,
  formatWorkspacesTable,
  formatWorkstreamsTable,
  printLogRow,
  relTime,
  statusIcon,
  truncate,
  truncateFront,
} from "./cli/format.js";
export { NameAmbiguousError, UsageError, classifyError, handle } from "./cli/handle.js";

// ─── Workstream resolution ─────────────────────────────────────────────

/**
 * Resolve the active workstream. Order:
 *   1. --workstream <name> flag
 *   2. $MU_SESSION env var
 *   3. Current tmux session name (with `mu-` prefix stripped)
 *
 * Throws UsageError if none of the above produce a name.
 */
export async function resolveWorkstream(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.MU_SESSION) return process.env.MU_SESSION;
  if (process.env.TMUX) {
    try {
      const name = (await tmux(["display-message", "-p", "#S"])).trim();
      if (name.startsWith(RESERVED_WORKSTREAM_PREFIX))
        return name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    } catch {
      // fall through
    }
  }
  throw new UsageError(
    "workstream required: pass --workstream <name>, set $MU_SESSION, or run inside an mu-<name> tmux session",
  );
}

/** Like resolveWorkstream but returns null instead of throwing on miss.
 *  Used by the read-permissive verbs (mu log, mu state, bare mu)
 *  where 'no workstream' is a legitimate state to render. */
export async function resolveOptionalWorkstream(): Promise<string | null> {
  try {
    return await resolveWorkstream(undefined);
  } catch {
    return null;
  }
}

// ─── Qualified entity refs (cross-workstream verb args) ────────────────
//
// Every verb that takes an entity name (mu task show <id>, mu agent
// send <name>, mu workspace path <agent>) accepts EITHER:
//   - bare `<name>`           → resolves via current workstream context
//   - qualified `<ws>/<name>` → resolves directly, no -w needed
// Implemented as a parse-at-CLI-entry helper so the SDK signatures
// stay workstream-explicit (no entity ref shape leaks below cli.ts).
// See verb_arg_qualified_workstream_name and the OUTPUT_LABELS_AUDIT.

export interface ParsedRef {
  /** Workstream prefix when the input was `<ws>/<name>`; undefined for
   *  bare names. */
  workstream?: string;
  /** The bare name (everything after the first '/' if qualified, else
   *  the whole input). */
  name: string;
}

/** Split `<ws>/<name>` on the FIRST '/'. Bare input → workstream=undefined.
 *  Names today are restricted to [a-z0-9_-] (slugify / agent name validator)
 *  so '/' is unambiguous: no entity name can contain it. */
export function parseQualifiedRef(raw: string): ParsedRef {
  const slash = raw.indexOf("/");
  if (slash === -1) return { name: raw };
  return { workstream: raw.slice(0, slash), name: raw.slice(slash + 1) };
}

/** Sync glue: parse a qualified ref and (if qualified) push the
 *  workstream onto opts.workstream. Throws UsageError when the caller
 *  passed BOTH `--workstream A` AND `B/<name>` and they disagree.
 *  Returns the bare name for downstream use. Mutates opts. */
export function applyQualifiedRef(raw: string, opts: { workstream?: string }): string {
  const parsed = parseQualifiedRef(raw);
  if (parsed.workstream === undefined) return raw;
  if (opts.workstream !== undefined && opts.workstream !== parsed.workstream) {
    throw new UsageError(
      `qualified ref ${JSON.stringify(raw)} (workstream=${parsed.workstream}) conflicts with --workstream ${opts.workstream}`,
    );
  }
  opts.workstream = parsed.workstream;
  return parsed.name;
}

/** Per-entity table+key+error mapping for findEntityWorkstreams /
 *  resolveEntityRef. Centralised so adding a new entity is one row. */
const ENTITY_TABLES = {
  task: { table: "tasks", keyCol: "local_id" },
  agent: { table: "agents", keyCol: "name" },
  // workspace: lookup is by agent name (vcs_workspaces has agent_id
  // FK; the operator-facing key is the agent name in `agents`).
  workspace: { table: "agents", keyCol: "name" },
} as const;

export type EntityKind = keyof typeof ENTITY_TABLES;

/** List the workstream names where `entity` exists. Used for ambiguity
 *  detection when the bare-name caller has no resolved -w context. */
export function findEntityWorkstreams(db: Db, kind: EntityKind, name: string): string[] {
  const { table, keyCol } = ENTITY_TABLES[kind];
  const rows = db
    .prepare(
      `SELECT ws.name AS workstream FROM ${table} t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ?
        ORDER BY ws.name`,
    )
    .all(name) as { workstream: string }[];
  return rows.map((r) => r.workstream);
}

/**
 * One-stop ref resolver for verbs taking an entity name + optional -w.
 *
 * Pipeline:
 *   1. Parse `<ws>/<name>` (qualified form) — sets opts.workstream
 *      from the prefix and returns the bare name.
 *   2. Resolve workstream from --workstream / $MU_SESSION / tmux
 *      session (the standard chain in resolveWorkstream).
 *   3. When no workstream resolves AND the bare name lives in ≥2
 *      workstreams: throw NameAmbiguousError listing the candidates.
 *      When it lives in exactly 1: use that workstream (still bare).
 *      When it lives in 0: rethrow the original UsageError so the
 *      operator sees the canonical 'workstream required' message.
 *
 * Returns `{ name, workstream }`. The verb then uses `name` for the
 * entity lookup and `workstream` for downstream SDK calls; opts.workstream
 * is mutated to match (so existing helpers like assertTaskInWorkstream
 * still work as the second-line check).
 */
export async function resolveEntityRef(
  db: Db,
  raw: string,
  opts: { workstream?: string },
  kind: EntityKind,
): Promise<{ name: string; workstream: string }> {
  const name = applyQualifiedRef(raw, opts);
  try {
    const workstream = await resolveWorkstream(opts.workstream);
    return { name, workstream };
  } catch (err) {
    // Bare-name + no resolved context: try ambiguity disambiguation.
    if (!(err instanceof UsageError)) throw err;
    const matches = findEntityWorkstreams(db, kind, name);
    if (matches.length >= 2) throw new NameAmbiguousError(name, matches, kind);
    if (matches.length === 1) {
      const only = matches[0];
      if (only !== undefined) {
        opts.workstream = only;
        return { name, workstream: only };
      }
    }
    throw err;
  }
}

/** Standard --status validation: case-insensitive, returns the
 *  canonical TaskStatus or throws UsageError naming every legal
 *  value. Centralised so adding a status updates every CLI surface
 *  at once (the OPEN | IN_PROGRESS | CLOSED list used to drift
 *  across `mu task list --status`, `mu task wait --status`, the
 *  --help text, and error messages). Source list lives in
 *  src/tasks.ts as TASK_STATUS_LIST. */
export function parseStatusOption(raw: string, flag = "--status"): TaskStatus {
  const upper = raw.toUpperCase();
  if (!isTaskStatus(upper)) {
    throw new UsageError(`${flag} must be one of ${TASK_STATUS_LIST} (got ${JSON.stringify(raw)})`);
  }
  return upper;
}

/** Multi-status flag parser for the `--status <s...>` shape used by
 *  `mu task list / task next / approve list` (per
 *  task_list_multi_status_union). Composes parseCsvFlag (repeat OR
 *  comma-separated OR mix) with per-element parseStatusOption
 *  validation, then dedups case-insensitively (parseStatusOption
 *  upper-cases). Returns `undefined` when the flag is absent or
 *  resolves to an empty array — semantically "no filter", matching
 *  today's no-`--status` shape. Throws UsageError naming the offending
 *  element on the first invalid value (so the operator sees which one
 *  failed, not just "some value was wrong"). */
export function parseStatusesOption(
  values: readonly string[] | undefined,
  flag = "--status",
): TaskStatus[] | undefined {
  const fragments = parseCsvFlag(values);
  if (fragments.length === 0) return undefined;
  const seen = new Set<TaskStatus>();
  const out: TaskStatus[] = [];
  for (const raw of fragments) {
    const status = parseStatusOption(raw, flag);
    if (seen.has(status)) continue;
    seen.add(status);
    out.push(status);
  }
  return out;
}

// ─── Self-resolution (current pane → AgentRow) ─────────────────────────

/**
 * Resolve "the agent running this process" by reading `$TMUX_PANE` and
 * looking up the matching agent row. Returns null when `$TMUX_PANE` is
 * unset or the pane isn't a managed agent — the lenient variant used
 * by verbs that have a sensible fallback (the calling agent name when
 * resolvable, else a generic 'user' / 'orchestrator'). `resolveSelf`
 * wraps this with the strict throwing variant for verbs that genuinely
 * require a managed-pane caller.
 */
export function resolveSelfOptional(db: Db): AgentRow | null {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return null;
  return getAgentByPane(db, paneId) ?? null;
}

/**
 * Strict variant of `resolveSelfOptional`: throws UsageError with a
 * helpful message if `$TMUX_PANE` is unset or the pane isn't a
 * managed agent. Used by `mu me` / `mu me tasks` / `mu me next` to give
 * an LLM-in-a-pane zero-config self-identification. Lives in cli.ts
 * so cli/agents.ts and cli/tasks.ts can both import it without a
 * lateral cli/* dependency.
 */
export function resolveSelf(db: Db): AgentRow {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) {
    throw new UsageError(
      "$TMUX_PANE is not set; this verb only works inside an mu-spawned tmux pane (or any tmux pane, but the pane has to be a managed agent)",
    );
  }
  const agent = resolveSelfOptional(db);
  if (!agent) {
    throw new UsageError(
      `pane ${paneId} is not a managed agent. Use \`mu agent list\` to see managed panes, or \`mu agent spawn\` to register a new one.`,
    );
  }
  return agent;
}

// ─── Shared SDK-CLI bridge helpers (used by cli/*.ts) ──────────────
//
// These were extracted from inline-with-task-verbs in cli.ts; the
// task verbs moved to src/cli/tasks.ts but the helpers stay here so
// every cli/*.ts module can import them from one canonical location.

function roiOf(t: TaskRow): number {
  return t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
}

export function byRoiDesc(a: TaskRow, b: TaskRow): number {
  return roiOf(b) - roiOf(a);
}

// ─── Task list --sort ──────────────────────────────────────────────
//
// Four keys; default is `roi` (preserves prior behaviour). The two
// time-based keys (`recency` = updated_at DESC, `age` = created_at ASC)
// are the surface for "what did I touch most recently" and "what's
// gone stale" — neither was queryable before. `id` is the boring
// tiebreaker default for `mu task list` (local_id ASC).
export const TASK_SORT_KEYS = ["roi", "recency", "age", "id"] as const;
export type TaskSortKey = (typeof TASK_SORT_KEYS)[number];

export function isTaskSortKey(s: string): s is TaskSortKey {
  return (TASK_SORT_KEYS as readonly string[]).includes(s);
}

export function parseSortOption(raw: string, flag = "--sort"): TaskSortKey {
  if (!isTaskSortKey(raw)) {
    throw new UsageError(
      `${flag} must be one of ${TASK_SORT_KEYS.join(" | ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/** Sort a copy of `tasks` by `key`. Pure (does not mutate input). */
export function sortTasks(tasks: readonly TaskRow[], key: TaskSortKey): TaskRow[] {
  const out = tasks.slice();
  switch (key) {
    case "roi":
      return out.sort(byRoiDesc);
    case "recency":
      // updated_at DESC: most-recently-touched first.
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "age":
      // created_at ASC: oldest first ("what's gone stale").
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "id":
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Which timestamp basis the table's relative-time column should use
 *  for the active sort, or `null` if no time column should be shown. */
export function relTimeBasisForSort(key: TaskSortKey): "updatedAt" | "createdAt" | null {
  if (key === "recency") return "updatedAt";
  if (key === "age") return "createdAt";
  return null;
}

/**
 * Decorate a TaskRow (or array of them) with a computed `roi` field for
 * JSON output. ROI is a CLI-rendering concern (the table view computes
 * it inline; see formatTaskListTable) but JSON consumers were getting
 * raw rows with no ROI at all, which broke `mu task next --json | jq
 * 'sort_by(.roi)'` and similar. We keep `TaskRow` itself ROI-free so
 * the SDK contract stays minimal; the decorator lives only in the JSON
 * emit path.
 *
 * `roi` is a plain JSON number when finite; for effortDays=0 the field
 * is omitted (JSON has no Infinity literal and `null` would be a lie).
 * Callers can detect the infinity case via `effortDays === 0`.
 */
function withRoi<T extends TaskRow>(task: T): T & { roi?: number } {
  if (task.effortDays > 0) {
    return { ...task, roi: task.impact / task.effortDays };
  }
  return task;
}

export function withRoiAll<T extends TaskRow>(tasks: T[]): (T & { roi?: number })[] {
  return tasks.map(withRoi);
}

// ─── Workstream-scope assertions ──────────────────────────────────────

/**
 * Generic workstream-scope assertion. The two typed wrappers
 * (`assertAgentInWorkstream`, `assertTaskInWorkstream`) share this
 * shape: SELECT the `workstream` column from `<table>` WHERE
 * `<keyCol>` = key, and if the row exists with a non-matching
 * workstream throw a typed `*NotInWorkstreamError`. No-op when
 * `expectedWs` is undefined or the row doesn't exist (downstream
 * handlers raise the matching `*NotFoundError`).
 *
 * Doing the lookup directly via raw SQL (rather than through the
 * typed `getAgent` / `getTask`) keeps the helper decoupled from
 * each row's full schema — it only ever needs the one column. The
 * typed errors are constructed by `errFactory` so each caller keeps
 * its specific error class and exit-code mapping.
 */
export function assertEntityInWorkstream<E extends Error>(
  db: Db,
  table: string,
  keyCol: string,
  keyVal: string,
  expectedWs: string | undefined,
  errFactory: (keyVal: string, expectedWs: string, actualWs: string | null) => E,
): void {
  if (!expectedWs) return;
  // v5: per-scope unique TEXT names mean a bare
  // `WHERE keyCol = ? LIMIT 1` could pick the wrong workstream's row
  // and falsely raise NotInWorkstreamError when the expected workstream
  // ALSO has a row of this name (bug_v5_name_clash_silent_misroute).
  // Fast path: if a row exists in the expected workstream, we're done.
  const inScope = db
    .prepare(
      `SELECT 1 AS hit FROM ${table} t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ? AND ws.name = ?
        LIMIT 1`,
    )
    .get(keyVal, expectedWs) as { hit: number } | undefined;
  if (inScope) return;
  // Slow path: name doesn't exist in expected ws — check whether it
  // exists anywhere else so we can raise the typed mismatch error
  // (rather than letting downstream raise the generic NotFoundError).
  // Pick any other workstream's row deterministically.
  const elsewhere = db
    .prepare(
      `SELECT ws.name AS workstream FROM ${table} t
         LEFT JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.${keyCol} = ?
        ORDER BY ws.name
        LIMIT 1`,
    )
    .get(keyVal) as { workstream: string | null } | undefined;
  if (elsewhere) {
    throw errFactory(keyVal, expectedWs, elsewhere.workstream);
  }
}

/**
 * Sister of `assertTaskInWorkstream` for verbs that target an agent
 * by name. Agent names are per-workstream unique
 * (`UNIQUE(workstream_id, name)` in src/db.ts), so the same name can
 * exist in multiple workstreams; `-w` is the scope check that turns a
 * wrong-target verb into a clear `AgentNotInWorkstreamError` (exit 4)
 * instead of silently operating on a same-named agent in another
 * workstream. No-op when `workstream` is undefined or the agent
 * doesn't exist (downstream handler raises `AgentNotFoundError`).
 */
export function assertAgentInWorkstream(
  db: Db,
  agentName: string,
  workstream: string | undefined,
): void {
  // agents.workstream is NOT NULL in the schema, so `actual` is
  // never null in practice; the `?? "—"` is defence-in-depth for the
  // typed-error contract (which expects a non-null actual).
  assertEntityInWorkstream(
    db,
    "agents",
    "name",
    agentName,
    workstream,
    (n, exp, actual) => new AgentNotInWorkstreamError(n, exp, actual ?? "—"),
  );
}

/**
 * Sister of `assertAgentInWorkstream` for verbs that target a single
 * task by ID. Globally-unique task IDs mean these verbs could ignore
 * the flag, but accepting it gives the operator a sanity check ("yes,
 * I think this task is in that workstream") and raises a clear
 * `TaskNotInWorkstreamError` instead of silently acting on the task
 * they didn't mean. No-op when `workstream` is undefined or the task
 * doesn't exist (downstream handler raises `TaskNotFoundError`).
 */
export function assertTaskInWorkstream(
  db: Db,
  taskId: string,
  workstream: string | undefined,
): void {
  // tasks.workstream is NOT NULL in the schema; see assertAgentInWorkstream.
  assertEntityInWorkstream(
    db,
    "tasks",
    "local_id",
    taskId,
    workstream,
    (id, exp, actual) => new TaskNotInWorkstreamError(id, exp, actual ?? "—"),
  );
}

// ─── Numeric arg parser (for --impact, --effort-days) ────────────────

export function parsePositiveNumber(value: string): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive number, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseImpact(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || n > 100) {
    throw new InvalidArgumentError(`expected 1..100, got ${JSON.stringify(value)}`);
  }
  return n;
}

export function parseLines(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Parses a non-negative integer (0 is valid). Used for --since which
// uses 0 as the "replay everything" cursor.
export function parseNonNegativeInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// ─── Program definition ───────────────────────────────────────────────
//
// Three namespaces (`workstream`, `agent`, `task`) plus three top-level
// utilities (`sql`, `doctor`, and the bare `mu` mission-control default).
//
// Every flag is declared on the subcommand that consumes it — there is
// NO root --workstream that subcommands inherit via optsWithGlobals(),
// which previously was the source of "flag at the wrong level" bugs.
//
// Bare `mu` (mission control) takes no flags. To target a different
// workstream than the one the current shell is in, use `MU_SESSION=foo
// mu` or `cd` into that workstream's tmux session.

// Reusable workstream flag declaration. Each subcommand that needs it
// gets its own copy via `.option(...WORKSTREAM_OPT)` so there is no
// cross-command leakage.
export const WORKSTREAM_OPT = [
  "-w, --workstream <name>",
  "workstream (defaults to $MU_SESSION or the current tmux session minus mu- prefix)",
] as const;

// Reusable --json flag for every read verb. Output shape is documented
// per-verb but follows a consistent pattern: collections → JSON arrays;
// single entities → JSON objects. Empty results print `[]` (collections)
// or `null` (single-entity reads with no match — currently none, since
// every "single" verb errors on miss). Pretty-printing is OFF; one
// document per line so output is grep/jq friendly.
export const JSON_OPT = ["--json", "emit machine-readable JSON instead of a table"] as const;

/**
 * Canonical multi-value-flag parser. Every commander variadic flag
 * (`--foo <vals...>`) in mu is post-processed through this helper so
 * the operator can use repeated-flag form, comma-separated form, or
 * any mix:
 *
 *   --foo a --foo b --foo c   → ["a", "b", "c"]
 *   --foo a,b,c               → ["a", "b", "c"]
 *   --foo a,b --foo c         → ["a", "b", "c"]
 *
 * Whitespace inside fragments is trimmed; empty fragments (consecutive
 * commas, leading/trailing comma, an entirely-empty value) are
 * dropped. Idempotent: the helper is safe to apply twice.
 *
 * Convention codified by cli_audit_plurality_uniformity (v0.3). See
 * docs/USAGE_GUIDE.md "CLI conventions".
 */
export function parseCsvFlag(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.flatMap((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Stable JSON output: one line, no trailing newline beyond console.log's.
 *  Exported so cli/*.ts modules can use the same single-source-of-truth
 *  formatter. */
export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Wrap a collection in mu's canonical `{items, count}` envelope.
 *  audit_json_envelope_uniformity: every collection-read verb (list,
 *  next, owned-by, notes, search, orphans, commits, ...) emits this
 *  shape so a future sibling field (`baseRef`, `totalAcrossPages`,
 *  ...) can be added without breaking every caller. Pre-1.0
 *  breaking versus the pre-audit bare-array shape.
 *
 *  Carve-out: `mu sql --json` keeps bare-array rows (it's the escape
 *  hatch; row shape is per-query, not part of the typed contract).
 *  `mu log --tail --json` keeps NDJSON (one object per line) since
 *  it's a stream, not a collection. */
export function emitJsonCollection<T>(items: readonly T[]): void {
  emitJson({ items, count: items.length });
}

/**
 * Read the package version from the shipped package.json. Works for
 * both source mode (src/cli.ts → ../package.json) and bundled mode
 * (dist/cli.js → ../package.json), since both layouts have package.json
 * exactly one directory up. Avoids hand-bumping a string literal in
 * code on every release.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("mu")
    .description(
      "Persistent crew of AI agents in tmux panes coordinated through a built-in task DAG.",
    )
    .version(readPackageVersion())
    .helpOption("-h, --help")
    // .showHelpAfterError() removed (audit_cli_validation_uniformity):
    // emitError() in handle.ts now owns help-on-error emission for both
    // commander mistakes and handler-thrown UsageErrors. Without this
    // removal, commander would print its own "\n<help>" appendix to
    // stderr before throwing CommanderError, leaving us with a duplicate
    // help dump (commander's then ours). We suppress commander's stderr
    // entirely in applyExitOverride below; this comment is the load-
    // bearing explanation of why we don't reach for showHelpAfterError().
    // Sort the Commands list (NOT the Options list) alphabetically in
    // every --help screen. Commander v14 inherits configureHelp via
    // copyInheritedSettings() when subcommands are created with
    // .command(), but we also walk the tree below for certainty —
    // future subcommand groups added via .addCommand() do not inherit.
    .configureHelp({ sortSubcommands: true })
    // Without this, `mu task list --json` would bind --json to the
    // program (where we declare it for the bare `mu --json` mission-
    // control case) instead of the `list` subcommand. With it,
    // options before a subcommand bind to the program; options after
    // bind to the subcommand. Subcommands inherit it automatically.
    .enablePositionalOptions()
    // Default action when no subcommand is given: mission control.
    // Workstream resolves via the standard chain (-w > $MU_SESSION >
    // current tmux session); when none of those resolve, falls back
    // to a workstreams-discovery view instead of erroring. Accepts
    // --json so scripts can drive the same picture programmatically.
    // Bare `mu` is an alias for `mu state --mission` (the stripped
    // 5-col glance card):
    // route through cmdState with mission=true so there's exactly one
    // implementation of the glance render. -w accepts the same
    // variadic shape every other render mode does.
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)",
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string[]; json?: boolean };
      return handle((db) => cmdState(db, { ...opts, mission: true }), this as Command)();
    });

  wireWorkstreamCommands(program);
  wireArchiveCommands(program);
  wireAgentCommands(program);
  wireSelfCommands(program);
  wireWorkspaceCommands(program);
  wireTaskCommands(program);
  wireLogCommand(program);
  wireStateCommands(program);
  wireSqlCommand(program);
  wireSnapshotCommands(program);
  wireDoctorCommand(program);
  applyAlphabeticalHelpSort(program);
  // audit_cli_validation_uniformity: every node in the command tree
  // must call exitOverride() so commander throws CommanderError
  // instead of calling process.exit() itself. Lets the parseAsync()
  // catch route every operator-error through emitError() with the
  // failing subcommand's --help (human) or `usage` JSON (--json).
  applyExitOverride(program);
  return program;
}

// Recursively set sortSubcommands on every command in the tree. Belt
// and braces over the root .configureHelp() call: guarantees the sort
// holds regardless of how a subcommand was attached (.command() vs
// .addCommand()) and regardless of inheritance behaviour across
// commander versions. Preserves any other help-configuration keys
// already set on a subcommand.
function applyAlphabeticalHelpSort(cmd: Command): void {
  cmd.configureHelp({ ...cmd.configureHelp(), sortSubcommands: true });
  for (const sub of cmd.commands) {
    applyAlphabeticalHelpSort(sub);
  }
}

/** Recursively call exitOverride() on every command in the tree.
 *  Without this, commander writes its error to stderr and calls
 *  process.exit() inline — we never see the error and our emitError()
 *  contract (--help on usage errors, --json envelopes, exit-2
 *  uniformity) doesn't apply.
 *
 *  We ALSO swallow commander's writeErr so commander never prints the
 *  unformatted "error: ..." / help combo before our handler runs. The
 *  captured text is discarded; emitError() re-emits message + help in
 *  mu's format. Help displays via --help still flow through writeOut
 *  (commander.helpDisplayed code, which classifyCommanderError maps to
 *  exit 0 with no further output). */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeOut: (s) => process.stdout.write(s),
    writeErr: () => {
      // Swallow commander's pre-throw stderr; emitError re-emits.
    },
  });
  for (const sub of cmd.commands) {
    applyExitOverride(sub);
  }
}

// ─── Entry point ───────────────────────────────────────────────────────

/** Bare verb-namespace invocations (`mu workspace`, `mu task`, …)
 *  used to print nothing and exit 0 because commander, given a parent
 *  with subcommands and no .action(), produces an empty render. We
 *  fix this BEFORE parseAsync rather than via .action() on each
 *  namespace because attaching .action() makes commander treat
 *  `mu task bogus` as a positional arg to `task` instead of routing
 *  it to the "unknown subcommand" lane (which other tests + emitError
 *  depend on). Surfaced by `bare_verb_namespaces_mu_workspace_task`.
 *
 *  Triggers when:
 *    - argv after the program name is exactly one token
 *    - that token names a top-level subcommand of `mu`
 *    - that subcommand itself has its own subcommands (i.e. it's a
 *      namespace, not a leaf verb)
 *  In that case we append `--help` so commander routes through its
 *  help printer. Bare `mu` (mission control) is unaffected because
 *  the slice has length 0.
 */
export function injectBareNamespaceHelp(
  program: Command,
  argv: readonly string[],
): readonly string[] {
  // argv is the full process.argv shape: [node, mu, ...userArgs].
  if (argv.length !== 3) return argv;
  const token = argv[2];
  if (token === undefined || token.startsWith("-")) return argv;
  const sub = program.commands.find((c) => c.name() === token || c.aliases().includes(token));
  if (!sub) return argv;
  if (sub.commands.length === 0) return argv;
  return [...argv, "--help"];
}

// When invoked as `mu …` from the shell, parse argv. When imported (e.g.
// from tests), do nothing — buildProgram() is exported for direct use.
//
// Symlink-safe: when installed via `npm install -g .` the `mu` binary
// is a symlink (`/opt/homebrew/bin/mu → .../dist/cli.js`). `process.argv[1]`
// is the symlink path as given; `import.meta.url` is Node's resolved
// path (symlinks followed). Compare resolved-to-resolved by realpath-
// ing argv[1] first — otherwise the entry-point check fails silently
// and `mu --version` produces no output.
if (isMainEntrypoint()) {
  const program = buildProgram();
  const argv = injectBareNamespaceHelp(program, process.argv);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // CommanderError (parse-time) lands here because every command in
    // the tree had .exitOverride() applied. Locate the deepest matching
    // subcommand from argv so emitError can render its --help (human)
    // or `usage` JSON (--json).
    const failingCmd = findCommandForArgv(program, argv.slice(2));
    const exitCode = emitParseError(err, failingCmd);
    process.exit(exitCode);
  }
}

function isMainEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const resolved = realpathSync(argv1);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    // realpath can fail for non-file argv[1]. Fall back to the naive
    // check, which works when no symlink is involved.
    return import.meta.url === pathToFileURL(argv1).href;
  }
}
