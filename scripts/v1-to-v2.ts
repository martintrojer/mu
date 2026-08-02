#!/usr/bin/env -S npx tsx
// scripts/v1-to-v2.ts — the mu 1.x → 2.0 data escape hatch.
//
// mu 2.0 is a CLEAN BREAK: `openDb` refuses every pre-v9 DB with
// `SchemaTooOldError` (exit 4), there is no in-process migration ladder,
// and `CURRENT_SCHEMA` carries no v8 knowledge. That decision stands.
// This is not a migration path — it is a SIDECAR the operator runs ONCE,
// by hand, against a COPY, to carry v1 task data into a fresh v9 DB.
//
// USAGE
//   npx tsx scripts/v1-to-v2.ts <v1.db>                  # writes <v1>.v2.db
//   npx tsx scripts/v1-to-v2.ts <v1.db> --out <new.db>
//   npx tsx scripts/v1-to-v2.ts <v1.db> --force          # overwrite target
//   npx tsx scripts/v1-to-v2.ts <v1.db> --drop-logs      # skip agent_logs
//   npx tsx scripts/v1-to-v2.ts <v1.db> --drop-archives  # proceed past archives
//
// See scripts/README.md for the full upgrade recipe (BACK UP FIRST).
//
// ─── THE LOAD-BEARING RULE: SYNTHESIZE OPS, DO NOT INSERT ROWS ────────
//
// In v9 the entity tables are a PROJECTION of the ops log. A row written
// behind the log is invisible to sync, unrecoverable by `mu rebuild`, and
// shows up as drift the moment `mu doctor --deep` runs. So this script
// never INSERTs into `tasks`/`task_edges`/`task_notes`/`workstreams`. It
// emits one `put` op per source row and lets `applyOp` — the SAME apply
// path sync ingest and rebuild use — materialise the tables. Whatever the
// merge rules do to the data, they do it here too, which is exactly the
// property that makes the result a first-class v9 DB rather than a
// look-alike.
//
// ─── ORDERING ─────────────────────────────────────────────────────────
//
// Ops are emitted in ONE global stream sorted by the source row's
// `created_at`, tie-broken by entity rank (workstream < task < edge <
// note < log) and then by source rowid. Two properties fall out:
//
//   CAUSALITY  a task's ops precede the edges and notes that reference
//              it, so `applyOp` never skips a child as 'absent'. Verified
//              against the real v1 DB: zero notes/edges predate their
//              task, zero tasks predate their workstream. If a future
//              source violates that, the preflight below says so and
//              refuses rather than silently dropping the child.
//   HONESTY    each op's HLC wall time is minted FROM the source
//              timestamp (`nextHlc(db, ms)`), so `mu log` reads like the
//              history actually happened instead of like 12000 edits in
//              one second. HLC monotonicity is preserved for free by
//              nextHlc's counter, so an out-of-order source timestamp
//              costs precision, never correctness.
//
// Every op shares ONE synthetic `group_id` with intent `migrate.v1`
// (`migrate.v1-log` for carried log lines), because it WAS one operator
// action. `mu log` therefore renders the import as an import, and
// `mu undo <group>` addresses it as one thing.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Op, applyOp } from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { nextHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";

// ─── what the import carries, and what it cannot ──────────────────────

/** Intent stamped on every entity op. Not a `CaptureIntent`: these ops
 *  did not come from a live edit and must not pretend to have. */
const IMPORT_INTENT = "migrate.v1";
/** Intent stamped on carried v1 `agent_logs` rows. */
const LOG_INTENT = "migrate.v1-log";
/** Actor for rows with no human author of their own. */
const IMPORT_ACTOR = "v1-import";

/** Entity used for carried log lines.
 *
 *  'event', NOT 'message'. 'message' is in SYNCED_ENTITIES and would
 *  ship v1 prose to every peer forever; 'event' is log-only, so
 *  `mu rebuild` copies it verbatim and `applyOp` is never asked to
 *  project it. Machine-local by construction, which is the honest
 *  status of a v1 log line. */
const LOG_ENTITY = "event";

/** The only source schema version this script understands. v8 is the
 *  final v1-series schema; anything older predates `machine_identity`
 *  and the surrogate-PK substrate and is not something we can claim to
 *  have tested. */
const SUPPORTED_SOURCE_VERSION = 8;

interface Args {
  source: string;
  out: string;
  force: boolean;
  dropLogs: boolean;
  dropArchives: boolean;
}

const USAGE = `usage: npx tsx scripts/v1-to-v2.ts <v1.db> [--out <new.db>] [--force]
                                            [--drop-logs] [--drop-archives]

  <v1.db>           the v8 source DB. Opened READ-ONLY; never modified.
  --out <new.db>    target path (default: <v1.db> with '.v2.db' suffix).
  --force           overwrite an existing target.
  --drop-logs       do not carry agent_logs into the ops log.
  --drop-archives   proceed even though the source has v1 archives,
                    which cannot be faithfully reconstructed.`;

/** Every refusal in this script. THROWN, not `process.exit`-ed, so the
 *  whole importer stays callable IN-PROCESS from
 *  test/v1-to-v2.integration.test.ts. A sidecar nobody can test is a
 *  sidecar nobody should trust, and `tsx` is deliberately NOT a
 *  dependency of this repo (the shebang goes through `npx`), so a test
 *  that shelled out would either add a dep or skip itself in CI.
 *  `runImporter` is the testable seam; `main` is the thin shell. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

function usage(message: string): never {
  throw new UsageError(message);
}

function parseArgs(argv: readonly string[]): Args {
  let source: string | undefined;
  let out: string | undefined;
  let force = false;
  let dropLogs = false;
  let dropArchives = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--force") {
      force = true;
    } else if (arg === "--drop-logs") {
      dropLogs = true;
    } else if (arg === "--drop-archives") {
      dropArchives = true;
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (next === undefined) usage("--out needs a path");
      out = next;
      i += 1;
    } else if (arg.startsWith("--")) {
      usage(`unknown flag: ${arg}`);
    } else if (source === undefined) {
      source = arg;
    } else {
      usage(`unexpected extra argument: ${arg}`);
    }
  }

  if (source === undefined) usage("missing <v1.db>");
  const sourcePath = resolve(source);
  const outPath = resolve(out ?? defaultTarget(sourcePath));
  return { source: sourcePath, out: outPath, force, dropLogs, dropArchives };
}

/** `/x/mu.db` -> `/x/mu.v2.db`; `/x/mu.db.v1` -> `/x/mu.db.v1.v2.db`. */
function defaultTarget(source: string): string {
  return source.endsWith(".db") ? `${source.slice(0, -3)}.v2.db` : `${source}.v2.db`;
}

// ─── source shapes ────────────────────────────────────────────────────

interface WsRow {
  id: number;
  name: string;
  created_at: string;
}
interface TaskRow {
  id: number;
  workstream: string;
  local_id: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  created_at: string;
  updated_at: string;
}
interface EdgeRow {
  from_key: string;
  to_key: string;
  created_at: string;
  rowid: number;
}
interface NoteRow {
  id: number;
  task_key: string;
  author: string | null;
  content: string;
  created_at: string;
}
interface LogRow {
  seq: number;
  workstream: string | null;
  source: string;
  kind: string;
  payload: string;
  created_at: string;
}

/** One op to synthesize, before an HLC is minted for it. */
interface Planned {
  entity: Op["entity"];
  key: string;
  payload: string;
  actor: string | null;
  intent: string;
  createdAt: string;
  /** Entity rank; the tie-break that keeps parents ahead of children. */
  rank: number;
  /** Source rowid; the final, fully deterministic tie-break. */
  seq: number;
}

const RANK = { workstream: 0, task: 1, edge: 2, note: 3, log: 4 } as const;

// ─── planning ─────────────────────────────────────────────────────────

function planOps(src: Db, dropLogs: boolean): Planned[] {
  const planned: Planned[] = [];

  const workstreams = src
    .prepare("SELECT id, name, created_at FROM workstreams ORDER BY created_at, id")
    .all() as WsRow[];
  for (const ws of workstreams) {
    planned.push({
      entity: "workstream",
      key: ws.name,
      // Mirrors CAPTURED_COLUMNS.workstreams exactly, so the op is
      // indistinguishable in shape from one a live `workstream init`
      // would have produced.
      payload: JSON.stringify({ name: ws.name, created_at: ws.created_at }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      createdAt: ws.created_at,
      rank: RANK.workstream,
      seq: ws.id,
    });
  }

  const tasks = src
    .prepare(
      `SELECT t.id AS id, w.name AS workstream, t.local_id, t.title, t.status,
              t.impact, t.effort_days, t.created_at, t.updated_at
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        ORDER BY t.created_at, t.id`,
    )
    .all() as TaskRow[];
  for (const task of tasks) {
    planned.push({
      entity: "task",
      key: `${task.workstream}/${task.local_id}`,
      // owner_id is deliberately ABSENT rather than null. Ownership is
      // an FK into the machine-local `agents` table, which does not come
      // across, so there is nothing to point at; emitting an explicit
      // null would claim the import RELEASED a claim it never saw.
      payload: JSON.stringify({
        local_id: task.local_id,
        title: task.title,
        status: task.status,
        impact: task.impact,
        effort_days: task.effort_days,
        created_at: task.created_at,
        updated_at: task.updated_at,
      }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      // created_at, NOT updated_at, even though the payload carries the
      // task's FINAL state. Ordering by updated_at would let a task
      // edited long after its notes were written sort AFTER them, and
      // `applyNotePut` skips a note whose parent task is absent — the
      // note would be silently dropped.
      createdAt: task.created_at,
      rank: RANK.task,
      seq: task.id,
    });
  }

  const edges = src
    .prepare(
      `SELECT wf.name || '/' || f.local_id AS from_key,
              wt.name || '/' || t.local_id AS to_key,
              e.created_at AS created_at,
              e.rowid       AS rowid
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id
         JOIN tasks t ON t.id = e.to_task_id
         JOIN workstreams wf ON wf.id = f.workstream_id
         JOIN workstreams wt ON wt.id = t.workstream_id
        ORDER BY e.created_at, e.rowid`,
    )
    .all() as EdgeRow[];
  for (const edge of edges) {
    planned.push({
      entity: "edge",
      key: `${edge.from_key}->${edge.to_key}`,
      payload: JSON.stringify({ created_at: edge.created_at }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      createdAt: edge.created_at,
      rank: RANK.edge,
      seq: edge.rowid,
    });
  }

  const notes = src
    .prepare(
      `SELECT n.id AS id, w.name || '/' || t.local_id AS task_key,
              n.author, n.content, n.created_at
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
         JOIN workstreams w ON w.id = t.workstream_id
        ORDER BY n.created_at, n.id`,
    )
    .all() as NoteRow[];
  for (const note of notes) {
    planned.push({
      entity: "note",
      // '#<v1 note id>' keeps the ORIGIN identity the note key format
      // expects. The id is this machine's v1 surrogate, which is exactly
      // what the key documents (src/apply.ts § applyNotePut).
      key: `${note.task_key}#${note.id}`,
      payload: JSON.stringify({
        author: note.author,
        content: note.content,
        created_at: note.created_at,
      }),
      // The note's own author, not the importer: attribution is real
      // data and losing it would be a silent downgrade.
      actor: note.author,
      intent: IMPORT_INTENT,
      createdAt: note.created_at,
      rank: RANK.note,
      seq: note.id,
    });
  }

  if (!dropLogs) {
    const logs = src
      .prepare(
        `SELECT l.seq AS seq, w.name AS workstream, l.source, l.kind, l.payload, l.created_at
           FROM agent_logs l
           LEFT JOIN workstreams w ON w.id = l.workstream_id
          ORDER BY l.created_at, l.seq`,
      )
      .all() as LogRow[];
    for (const log of logs) {
      planned.push({
        entity: LOG_ENTITY,
        // '' is the machine-wide sentinel (src/logs.ts § MACHINE_WIDE_KEY);
        // ops.key is NOT NULL.
        key: log.workstream ?? "",
        payload: log.payload,
        actor: log.source,
        // A distinct intent so `mu log` never presents imported v1 prose
        // as a typed 2.0 op. It renders as 'migrate v1-log', which is
        // exactly what it is.
        intent: LOG_INTENT,
        createdAt: log.created_at,
        rank: RANK.log,
        seq: log.seq,
      });
    }
  }

  planned.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.seq - b.seq;
  });
  return planned;
}

// ─── preflight ────────────────────────────────────────────────────────

interface SourceCounts {
  workstreams: number;
  tasks: number;
  task_edges: number;
  task_notes: number;
  agent_logs: number;
  agents: number;
  vcs_workspaces: number;
  snapshots: number;
  archives: number;
  workstream_sync: number;
  ownedTasks: number;
}

function countSource(src: Db): SourceCounts {
  const one = (sql: string): number => (src.prepare(sql).get() as { n: number }).n;
  return {
    workstreams: one("SELECT COUNT(*) AS n FROM workstreams"),
    tasks: one("SELECT COUNT(*) AS n FROM tasks"),
    task_edges: one("SELECT COUNT(*) AS n FROM task_edges"),
    task_notes: one("SELECT COUNT(*) AS n FROM task_notes"),
    agent_logs: one("SELECT COUNT(*) AS n FROM agent_logs"),
    agents: one("SELECT COUNT(*) AS n FROM agents"),
    vcs_workspaces: one("SELECT COUNT(*) AS n FROM vcs_workspaces"),
    snapshots: one("SELECT COUNT(*) AS n FROM snapshots"),
    archives: one("SELECT COUNT(*) AS n FROM archives"),
    workstream_sync: one("SELECT COUNT(*) AS n FROM workstream_sync"),
    ownedTasks: one("SELECT COUNT(*) AS n FROM tasks WHERE owner_id IS NOT NULL"),
  };
}

/** Causality violations the ordering rule cannot repair.
 *
 *  A note or edge whose `created_at` precedes its parent task's would
 *  sort ahead of the task and be skipped by `applyOp` as 'absent' —
 *  silent data loss, the one outcome this script must never produce. So
 *  it is a REFUSAL, not a warning. The real v1 DB has zero of these; the
 *  check exists because "zero on one DB" is not "zero on every DB". */
function causalityViolations(src: Db): string[] {
  const problems: string[] = [];
  const probe = (label: string, sql: string): void => {
    const n = (src.prepare(sql).get() as { n: number }).n;
    if (n > 0) problems.push(`${n} ${label}`);
  };
  probe(
    "task(s) created before their workstream",
    `SELECT COUNT(*) AS n FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
      WHERE t.created_at < w.created_at`,
  );
  probe(
    "note(s) created before their task",
    `SELECT COUNT(*) AS n FROM task_notes n JOIN tasks t ON t.id = n.task_id
      WHERE n.created_at < t.created_at`,
  );
  probe(
    "edge(s) created before an endpoint task",
    `SELECT COUNT(*) AS n FROM task_edges e
       JOIN tasks f ON f.id = e.from_task_id
       JOIN tasks t ON t.id = e.to_task_id
      WHERE e.created_at < MAX(f.created_at, t.created_at)`,
  );
  return problems;
}

/** Notes that will COLLAPSE under v2's grow-only note identity.
 *
 *  A v2 note is identified by (task, author, content) — see
 *  src/apply.ts § applyNotePut — because a note's surrogate id is
 *  assigned by whichever machine inserted it and is not portable. v1 had
 *  no such constraint, so byte-identical duplicate notes on one task
 *  merge into one row. That is the merge rule doing its job, not a bug
 *  in the import, but it changes a row count and must be REPORTED. */
function duplicateNotes(src: Db): number {
  const row = src
    .prepare(
      `SELECT COUNT(*) - COUNT(DISTINCT task_id || char(31) || COALESCE(author,'')
                                       || char(31) || content) AS n
         FROM task_notes`,
    )
    .get() as { n: number };
  return row.n;
}

// ─── the import ───────────────────────────────────────────────────────

interface ImportResult {
  opsWritten: number;
  opsChangedRows: number;
  groupId: string;
  machineId: string;
  targetRows: Record<string, number>;
  elapsedMs: number;
}

function runImport(target: Db, planned: readonly Planned[], groupId: string): ImportResult {
  const started = Date.now();
  const machineId = (
    target.prepare("SELECT machine_id AS m FROM machine_identity WHERE id = 1").get() as {
      m: string;
    }
  ).m;

  const insertOp = target.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, 'put', @payload, @createdAt)`,
  );

  let opsChangedRows = 0;

  // ONE transaction: a half-imported DB looks usable and is not.
  //
  // Capture-suppressed for the whole run, for the same reason
  // `rebuildInto` does it: applying an op writes to `tasks`, which would
  // fire the capture triggers and mint a SECOND op with a fresh HLC that
  // never happened. The log would then be roughly double the size and
  // describe an import that edited itself.
  const run = target.transaction(() => {
    withCaptureSuppressed(target, () => {
      for (const p of planned) {
        // Mint the HLC from the SOURCE timestamp, so `mu log` shows the
        // history at the times it happened. An unparsable timestamp
        // falls back to "now", which nextHlc's monotonic rule absorbs
        // without breaking order.
        const wallMs = Date.parse(p.createdAt);
        const hlc = nextHlc(target, Number.isNaN(wallMs) ? Date.now() : wallMs);
        const op: Op = {
          hlc,
          machineId,
          groupId,
          actor: p.actor,
          intent: p.intent,
          entity: p.entity,
          key: p.key,
          op: "put",
          payload: p.payload,
        };
        insertOp.run({
          hlc,
          machineId,
          groupId,
          actor: p.actor,
          intent: p.intent,
          entity: p.entity,
          key: p.key,
          payload: p.payload,
          createdAt: p.createdAt,
        });
        // Log-only entities have no portable table to project into;
        // recording the op IS applying them (same rule as rebuild).
        if (p.entity === LOG_ENTITY) continue;
        if (applyOp(target, op).changed) opsChangedRows += 1;
      }
    });
  });
  run();

  const targetRows: Record<string, number> = {};
  for (const table of ["workstreams", "tasks", "task_edges", "task_notes", "ops"]) {
    targetRows[table] = (
      target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  return {
    opsWritten: planned.length,
    opsChangedRows,
    groupId,
    machineId,
    targetRows,
    elapsedMs: Date.now() - started,
  };
}

// ─── reporting ────────────────────────────────────────────────────────

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function table(rows: readonly (readonly [string, string, string])[]): string {
  const widths = [0, 1, 2].map((col) =>
    rows.reduce((max, row) => Math.max(max, (row[col] ?? "").length), 0),
  );
  const line = (row: readonly [string, string, string]): string =>
    row
      .map((cell, i) => (i === 2 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return rows.map(line).join("\n");
}

// ─── the importer ──────────────────────────────────────────────

// ─── main ─────────────────────────────────────────────────────────────

/**
 * Run the import. Returns the process exit code and writes human output
 * through the caller-supplied `say`, so a test can capture it without
 * touching the real stdout. Throws `UsageError` on every refusal.
 */
export function runImporter(argv: readonly string[], say: (text: string) => void): number {
  const args = parseArgs(argv);

  if (!existsSync(args.source)) usage(`no such source DB: ${args.source}`);
  if (args.source === args.out) {
    usage("source and target are the same path; the import must write a NEW file");
  }
  if (existsSync(args.out) && sameFile(args.source, args.out)) {
    usage("source and target resolve to the same file; the import must write a NEW file");
  }
  if (existsSync(args.out)) {
    if (!args.force) {
      usage(`target already exists: ${args.out}\nre-run with --force to overwrite it`);
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${args.out}${suffix}`;
      if (existsSync(path)) unlinkSync(path);
    }
  }
  mkdirSync(dirname(args.out), { recursive: true });

  const sourceDigestBefore = sha256(args.source);

  // READ-ONLY. openDb's readonly path deliberately skips the schema
  // version gate (it only refuses to WRITE a pre-v9 DB), so the v9 SDK
  // can still read a v8 file — which is the whole reason this script can
  // reuse the SDK instead of hand-rolling a second SQLite layer.
  const src = openDb({ path: args.source, readonly: true });
  try {
    const version = (
      src.prepare("SELECT version AS v FROM schema_version WHERE id = 1").get() as
        | { v: number }
        | undefined
    )?.v;
    if (version !== SUPPORTED_SOURCE_VERSION) {
      usage(
        `source schema is v${version ?? "?"}; this importer only understands v${SUPPORTED_SOURCE_VERSION} (the final 1.x schema)`,
      );
    }

    const counts = countSource(src);

    const violations = causalityViolations(src);
    if (violations.length > 0) {
      usage(
        `REFUSING: the source violates the ordering this import depends on:\n  ${violations.join(
          "\n  ",
        )}\nA child row timestamped before its parent would be applied before the\nparent exists and silently dropped. Report this DB — it is a v1 bug.`,
      );
    }

    // ARCHIVES. v1 stored a COLUMN SUBSET of the archived rows; v2
    // archives are MARKERS pinning a point in the ops log. A marker can
    // only mean something when the ops it pins exist — and for the
    // motivating v1 case, an archive of a DESTROYED workstream, they
    // never will, because v1's destroy erased the rows rather than
    // writing tombstones. There is no honest reconstruction:
    //   * a marker over an import of the LIVE workstream would pin the
    //     CURRENT state, not the state at archive time — a lie;
    //   * restoring archived_tasks as a fresh workstream would silently
    //     turn an archive into live work.
    // So: refuse, name what would be lost, and make the operator opt in
    // to losing it. Never a half-archive.
    if (counts.archives > 0 && !args.dropArchives) {
      const labels = (
        src.prepare("SELECT label FROM archives ORDER BY label").all() as { label: string }[]
      ).map((r) => r.label);
      usage(
        [
          `REFUSING: the source has ${counts.archives} v1 archive(s): ${labels.join(", ")}`,
          "",
          "v1 archives cannot be faithfully carried into 2.0. v1 stored a column",
          "SUBSET of the archived rows; a v2 archive is a MARKER pinning a point in",
          "the ops log, and the ops an archive of a destroyed workstream would need",
          "do not exist — v1's destroy deleted rows instead of writing tombstones.",
          "Anything this script synthesized would pin the wrong moment.",
          "",
          "Options:",
          "  1. Export them from the v1 DB with mu 1.x BEFORE upgrading:",
          "       mu archive show <label> > <label>.txt",
          "  2. Re-run with --drop-archives to import tasks and drop the archives.",
          "  3. Keep the v1 DB (you should anyway) and read them with sqlite3.",
        ].join("\n"),
      );
    }

    const dupNotes = duplicateNotes(src);
    const planned = planOps(src, args.dropLogs);

    say("mu 1.x → 2.0 import");
    say(
      `  source  ${args.source}  (v${version}, READ-ONLY, sha256 ${sourceDigestBefore.slice(0, 12)}…)`,
    );
    say(`  target  ${args.out}`);
    say(`  ops to synthesize: ${planned.length}`);
    say("");

    const target = openDb({ path: args.out });
    let result: ImportResult;
    try {
      result = runImport(target, planned, `migrate-v1-${sourceDigestBefore.slice(0, 16)}`);
    } finally {
      target.close();
    }

    const sourceDigestAfter = sha256(args.source);

    say("CARRIED ACROSS");
    say(
      table([
        ["  what", "v1 rows", "v2 result"],
        ["  workstreams", String(counts.workstreams), String(result.targetRows.workstreams ?? 0)],
        ["  tasks", String(counts.tasks), String(result.targetRows.tasks ?? 0)],
        ["  task_edges", String(counts.task_edges), String(result.targetRows.task_edges ?? 0)],
        [
          "  task_notes",
          String(counts.task_notes),
          `${result.targetRows.task_notes ?? 0}${
            dupNotes > 0 ? ` (${dupNotes} byte-identical duplicate(s) merged)` : ""
          }`,
        ],
        [
          "  agent_logs",
          String(counts.agent_logs),
          args.dropLogs
            ? "DROPPED (--drop-logs)"
            : `${counts.agent_logs} log-only ops (intent=${LOG_INTENT})`,
        ],
      ]),
    );
    say("");
    say("NOT CARRIED ACROSS — these do not survive a machine, a schema, or both");
    say(
      table([
        ["  what", "v1 rows", "why"],
        ["  agents", String(counts.agents), "pane_id names a tmux pane that no longer exists"],
        ["  vcs_workspaces", String(counts.vcs_workspaces), "absolute paths; re-create per agent"],
        [
          "  snapshots",
          String(counts.snapshots),
          "table gone in v9; the .db files are still on disk",
        ],
        ["  workstream_sync", String(counts.workstream_sync), "superseded by sync_peers"],
        ["  task owners", String(counts.ownedTasks), "owner_id FKs into machine-local agents"],
        [
          "  archives",
          String(counts.archives),
          counts.archives > 0 ? "DROPPED (--drop-archives)" : "none in source",
        ],
      ]),
    );
    say("");
    say("RESULT");
    say(`  ops written      ${result.opsWritten} (one group: ${result.groupId})`);
    say(`  ops that changed a row  ${result.opsChangedRows}`);
    say(`  machine id       ${result.machineId}`);
    say(`  elapsed          ${result.elapsedMs}ms`);
    say(
      `  source unchanged ${sourceDigestBefore === sourceDigestAfter ? "YES" : "NO — THIS IS A BUG"}  (sha256 ${sourceDigestAfter.slice(0, 12)}…)`,
    );
    say("");
    say("NEXT");
    say("  1. Verify the projection matches the log:");
    say(`       MU_DB_PATH=${args.out} mu doctor --deep`);
    say("  2. Look at it:");
    say(`       MU_DB_PATH=${args.out} mu workstream list`);
    say("  3. Swap it in (KEEP the v1 DB — there is no path back):");
    say(`       mv ${args.out} "\${MU_DB_PATH:-$HOME/.local/state/mu/mu.db}"`);
    return sourceDigestBefore === sourceDigestAfter ? 0 : 1;
  } finally {
    src.close();
  }
}

/** True iff both paths name the same file on disk (symlinks, ./x vs x). */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

// ─── the shell ──────────────────────────────────────────────────

function main(): void {
  try {
    process.exitCode = runImporter(process.argv.slice(2), (text) => {
      process.stdout.write(`${text}\n`);
    });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  }
}

// Run ONLY when executed as a script. `import.meta.url` names this
// file; `process.argv[1]` names whatever node/tsx was pointed at. When
// the test imports `runImporter`, the two differ and nothing runs —
// without this, importing the module would immediately try to import
// the test runner's own argv as a v1 DB.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
