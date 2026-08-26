#!/usr/bin/env -S npx tsx
// scripts/restore-pre1.0-archives.ts — carry pre-1.0 ARCHIVES into v9.
//
// Companion to `migrate-to-1.0.ts`, which REFUSES archives and tells you
// to drop them. That refusal is right in general and wrong in one
// specific case, which is the case this script handles.
//
// ─── WHY THE BLANKET REFUSAL IS TOO STRONG ────────────────────────────
//
// scripts/README.md argues a v8 archive cannot be reconstructed because
// v9's archive is a MARKER pinning a point in the ops log, and v8's
// `workstream destroy` deleted rows instead of writing tombstones, so
// the ops a marker would pin do not exist.
//
// Both halves are true. The conclusion does not follow, because v8's
// `archived_tasks` / `archived_edges` / `archived_notes` kept enough of
// each row to SYNTHESIZE those missing ops: source_workstream,
// original_local_id, title, status, impact, effort_days, and the
// original created/updated timestamps. So we do not need the deleted
// ops — we can mint them from the archive's own copy, in the same
// ops-not-rows way `migrate-to-1.0.ts` mints live ones, and then pin a
// marker immediately after. The marker then pins EXACTLY the state the
// archive recorded, because the ops beneath it are the archive.
//
// ─── WHERE IT IS EXACT AND WHERE IT IS NOT ────────────────────────────
//
// EXACT for a source workstream that does not exist live. The ops we
// mint are that workstream's entire history, the marker sits directly on
// top, and `mu archive export` reproduces the archived rows.
//
// APPROXIMATE for a source workstream that DOES exist live. A marker is
// a point in ONE shared log, so a marker written now necessarily pins
// the workstream's CURRENT state, not its state on the archive date.
// That is the README's objection, and here it is real. This script does
// not paper over it: it detects the overlap, compares the archived rows
// against the live ones FIELD BY FIELD, and refuses unless they agree
// (or you pass --allow-divergent). When they agree, "current state" and
// "archive-time state" are the same rows and the pin is honest.
//
// ─── ORDERING ─────────────────────────────────────────────────────────
//
// Same rule as the v8 importer: one global stream sorted by the source
// timestamp, tie-broken by entity rank then source id, with each HLC
// minted from that timestamp via `nextHlc`. Markers are emitted LAST,
// after every op they pin, so `nextHlc`'s monotonic counter guarantees
// marker.hlc > every archived op's hlc even where the wall clocks lie.
//
// USAGE
//   npx tsx scripts/restore-pre1.0-archives.ts <dir> --db <target.db>
//   ... --dry-run            plan and report, write nothing (DEFAULT-SAFE)
//   ... --label <l>          restore only this archive (repeatable)
//   ... --drop-events        do not carry archived_events into the log
//   ... --allow-divergent    proceed when a live row disagrees
//
// <dir> holds the `<label>.json` files dumped from the v8 DB with the
// shape { archive, archived_tasks, archived_edges, archived_notes,
// archived_events }.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyOp, type Op } from "../src/apply.js";
import { MARKER_ENTITY, MARKER_INTENT } from "../src/archives.js";
import { type Db, openDb } from "../src/db.js";
import { nextHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";

const IMPORT_INTENT = "migrate.v8-archive";
const LOG_INTENT = "migrate.v8-archive-log";
const IMPORT_ACTOR = "v8-archive-import";
const LOG_ENTITY = "event";

const RANK = { workstream: 0, task: 1, edge: 2, note: 3, log: 4, marker: 5 } as const;

class UsageError extends Error {}
class RefusalError extends Error {}

// ─── source shapes (v8 archived_* columns) ────────────────────────────

interface ArchiveRow {
  label: string;
  description: string | null;
  created_at: string;
  last_added_at: string | null;
}

interface ArchTask {
  id: number;
  source_workstream: string;
  original_local_id: string;
  title: string;
  status: string;
  impact: number | null;
  effort_days: number | null;
  owner_name: string | null;
  archived_at_status: string | null;
  archived_at: string;
  original_created_at: string;
  original_updated_at: string;
}

interface ArchEdge {
  from_archived_id: number;
  to_archived_id: number;
}

interface ArchNote {
  id: number;
  archived_task_id: number;
  author: string | null;
  content: string;
  created_at: string;
}

interface ArchEvent {
  id: number;
  source_workstream: string | null;
  source: string | null;
  payload: string;
  created_at: string;
}

interface ArchiveFile {
  archive: ArchiveRow;
  archived_tasks: ArchTask[];
  archived_edges: ArchEdge[];
  archived_notes: ArchNote[];
  archived_events: ArchEvent[];
}

interface Planned {
  entity: Op["entity"];
  key: string;
  payload: string;
  actor: string | null;
  intent: string;
  createdAt: string;
  rank: number;
  seq: number;
}

interface Args {
  dir: string;
  dbPath: string | undefined;
  labels: string[];
  dryRun: boolean;
  dropEvents: boolean;
  allowDivergent: boolean;
}

const USAGE = `usage: npx tsx scripts/restore-pre1.0-archives.ts <dir> [--db <target.db>]
                 [--dry-run] [--label <l>]... [--drop-events] [--allow-divergent]`;

function parseArgs(argv: readonly string[]): Args {
  let dir: string | undefined;
  let dbPath: string | undefined;
  const labels: string[] = [];
  let dryRun = false;
  let dropEvents = false;
  let allowDivergent = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--drop-events") dropEvents = true;
    else if (arg === "--allow-divergent") allowDivergent = true;
    else if (arg === "--db" || arg === "--label") {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--db") dbPath = next;
      else labels.push(next);
      i += 1;
    } else if (arg.startsWith("--")) throw new UsageError(`unknown flag: ${arg}`);
    else if (dir === undefined) dir = arg;
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  if (dir === undefined) throw new UsageError("missing <dir>");
  return { dir: resolve(dir), dbPath, labels, dryRun, dropEvents, allowDivergent };
}

// ─── loading ──────────────────────────────────────────────────────────

function loadArchives(dir: string, only: readonly string[]): ArchiveFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: ArchiveFile[] = [];
  for (const file of files) {
    const label = basename(file, ".json");
    if (only.length > 0 && !only.includes(label)) continue;
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new RefusalError(`${file}: not a JSON object`);
    }
    const rec = parsed as Partial<ArchiveFile>;
    if (!rec.archive || !Array.isArray(rec.archived_tasks)) {
      throw new RefusalError(`${file}: missing 'archive' or 'archived_tasks'`);
    }
    out.push({
      archive: rec.archive,
      archived_tasks: rec.archived_tasks,
      archived_edges: rec.archived_edges ?? [],
      archived_notes: rec.archived_notes ?? [],
      archived_events: rec.archived_events ?? [],
    });
  }
  return out;
}

// ─── preflight: the honest refusal ────────────────────────────────────

interface LiveTask {
  title: string;
  status: string;
  impact: number | null;
  effort_days: number | null;
}

interface Divergence {
  workstream: string;
  localId: string;
  field: string;
  live: unknown;
  archived: unknown;
}

/**
 * A marker pins the CURRENT state of a workstream. So for any source
 * workstream that already exists live, the pin is only honest if the
 * live rows still match what the archive recorded. Compare field by
 * field and report every disagreement; the caller refuses on a non-empty
 * result unless --allow-divergent.
 */
function findDivergences(db: Db, files: readonly ArchiveFile[]): Divergence[] {
  const out: Divergence[] = [];
  const get = db.prepare(
    `SELECT t.title, t.status, t.impact, t.effort_days
       FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.local_id = ?`,
  );
  for (const file of files) {
    for (const task of file.archived_tasks) {
      const live = get.get(task.source_workstream, task.original_local_id) as LiveTask | undefined;
      if (live === undefined) continue; // not live: the exact case, nothing to compare
      const archivedStatus = task.archived_at_status ?? task.status;
      const pairs: [string, unknown, unknown][] = [
        ["title", live.title, task.title],
        ["status", live.status, archivedStatus],
        ["impact", live.impact, task.impact],
        ["effort_days", live.effort_days, task.effort_days],
      ];
      for (const [field, l, a] of pairs) {
        if (l !== a) {
          out.push({
            workstream: task.source_workstream,
            localId: task.original_local_id,
            field,
            live: l,
            archived: a,
          });
        }
      }
    }
  }
  return out;
}

// ─── planning ─────────────────────────────────────────────────────────

function planArchive(file: ArchiveFile, dropEvents: boolean): Planned[] {
  const planned: Planned[] = [];
  const { archive } = file;

  // The archived rows carry no workstream row of their own, so mint one
  // per distinct source_workstream, dated to that workstream's earliest
  // task. `applyOp` would create the parent on demand anyway; doing it
  // explicitly means the workstream carries a real creation date rather
  // than inheriting whatever arrived first.
  const earliest = new Map<string, string>();
  for (const t of file.archived_tasks) {
    const prev = earliest.get(t.source_workstream);
    if (prev === undefined || t.original_created_at < prev) {
      earliest.set(t.source_workstream, t.original_created_at);
    }
  }
  let wsSeq = 0;
  for (const [name, createdAt] of [...earliest].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    wsSeq += 1;
    planned.push({
      entity: "workstream",
      key: name,
      payload: JSON.stringify({ name, created_at: createdAt }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      createdAt,
      rank: RANK.workstream,
      seq: wsSeq,
    });
  }

  // archived task id -> '<ws>/<local_id>', the natural key edges and
  // notes are rewritten onto.
  const keyOf = new Map<number, string>();
  for (const t of file.archived_tasks) {
    keyOf.set(t.id, `${t.source_workstream}/${t.original_local_id}`);
  }

  for (const t of file.archived_tasks) {
    const key = keyOf.get(t.id);
    if (key === undefined) continue;
    planned.push({
      entity: "task",
      key,
      // `archived_at_status` is the status the row had AT ARCHIVE TIME
      // and is what the marker should pin; `status` is the same value in
      // every row of this dump, but prefer the explicit one on principle.
      //
      // owner_name is deliberately absent: v9 ownership is an FK into the
      // machine-local `agents` table (src/apply.ts § NEVER_APPLY), so
      // there is nothing on this machine for a name to point at.
      payload: JSON.stringify({
        local_id: t.original_local_id,
        title: t.title,
        status: t.archived_at_status ?? t.status,
        impact: t.impact,
        effort_days: t.effort_days,
        created_at: t.original_created_at,
        updated_at: t.original_updated_at,
      }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      // created_at, not updated_at — same reason as the v8 importer: a
      // task edited after its notes were written must still sort ahead
      // of them, or `applyNotePut` drops the note as 'absent'.
      createdAt: t.original_created_at,
      rank: RANK.task,
      seq: t.id,
    });
  }

  let edgeSeq = 0;
  for (const e of file.archived_edges) {
    edgeSeq += 1;
    const from = keyOf.get(e.from_archived_id);
    const to = keyOf.get(e.to_archived_id);
    // v8 kept no timestamp on an archived edge. Date it to the later of
    // its two endpoints' creation, which is the earliest moment the edge
    // could have existed, so it never sorts ahead of a task it needs.
    if (from === undefined || to === undefined) continue;
    const fromTask = file.archived_tasks.find((t) => t.id === e.from_archived_id);
    const toTask = file.archived_tasks.find((t) => t.id === e.to_archived_id);
    if (fromTask === undefined || toTask === undefined) continue;
    const createdAt =
      fromTask.original_created_at > toTask.original_created_at
        ? fromTask.original_created_at
        : toTask.original_created_at;
    planned.push({
      entity: "edge",
      key: `${from}->${to}`,
      payload: JSON.stringify({ created_at: createdAt }),
      actor: IMPORT_ACTOR,
      intent: IMPORT_INTENT,
      createdAt,
      rank: RANK.edge,
      seq: edgeSeq,
    });
  }

  for (const n of file.archived_notes) {
    const taskKey = keyOf.get(n.archived_task_id);
    if (taskKey === undefined) continue;
    planned.push({
      entity: "note",
      key: `${taskKey}#${n.id}`,
      payload: JSON.stringify({
        author: n.author,
        content: n.content,
        created_at: n.created_at,
      }),
      // The note's real author, not the importer. Same call the v8
      // importer makes: attribution is data, not provenance.
      actor: n.author,
      intent: IMPORT_INTENT,
      createdAt: n.created_at,
      rank: RANK.note,
      seq: n.id,
    });
  }

  if (!dropEvents) {
    for (const ev of file.archived_events) {
      planned.push({
        entity: LOG_ENTITY,
        key: ev.source_workstream ?? "",
        payload: ev.payload,
        actor: ev.source,
        intent: LOG_INTENT,
        createdAt: ev.created_at,
        rank: RANK.log,
        seq: ev.id,
      });
    }
  }

  planned.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.seq - b.seq;
  });

  // Markers LAST, after everything they pin. Their wall time is the
  // archive's own date, but ordering does not depend on that: nextHlc is
  // monotonic, so a marker minted after the ops sorts after them even
  // when the archive predates a task's updated_at.
  let markerSeq = 0;
  for (const name of [...earliest.keys()].sort()) {
    markerSeq += 1;
    planned.push({
      entity: MARKER_ENTITY,
      key: `${archive.label}/${name}`,
      payload: JSON.stringify({ workstream: name, label: archive.label }),
      actor: IMPORT_ACTOR,
      // The REAL marker intent, not a migration one: this is a genuine
      // v9 marker and `mu archive list` reads it by intent.
      intent: MARKER_INTENT,
      createdAt: archive.last_added_at ?? archive.created_at,
      rank: RANK.marker,
      seq: markerSeq,
    });
  }

  return planned;
}

// ─── writing ──────────────────────────────────────────────────────────

interface WriteResult {
  opsWritten: number;
  opsChangedRows: number;
  groupId: string;
  elapsedMs: number;
}

function writeOps(db: Db, planned: readonly Planned[], groupId: string): WriteResult {
  const started = Date.now();
  const machineId = (
    db.prepare("SELECT machine_id AS m FROM machine_identity WHERE id = 1").get() as { m: string }
  ).m;

  const insertOp = db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, 'put', @payload, @createdAt)`,
  );

  let opsChangedRows = 0;

  // One transaction, capture-suppressed — identical reasoning to
  // `migrate-to-1.0.ts` § runImport: applying an op writes `tasks`, and
  // an unsuppressed capture trigger would mint a second op with a fresh
  // HLC describing an edit that never happened.
  const run = db.transaction(() => {
    withCaptureSuppressed(db, () => {
      for (const p of planned) {
        const wallMs = Date.parse(p.createdAt);
        const hlc = nextHlc(db, Number.isNaN(wallMs) ? Date.now() : wallMs);
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
        // Log lines and markers live in `ops` only — recording IS
        // applying them (src/apply.ts § applyDel, case 'marker').
        if (p.entity === LOG_ENTITY || p.entity === MARKER_ENTITY) continue;
        if (applyOp(db, op).changed) opsChangedRows += 1;
      }
    });
  });
  run();

  return {
    opsWritten: planned.length,
    opsChangedRows,
    groupId,
    elapsedMs: Date.now() - started,
  };
}

// ─── reporting ────────────────────────────────────────────────────────

function countBy(planned: readonly Planned[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of planned) out[p.entity] = (out[p.entity] ?? 0) + 1;
  return out;
}

export function runRestore(argv: readonly string[], say: (text: string) => void): number {
  const args = parseArgs(argv);
  const files = loadArchives(args.dir, args.labels);
  if (files.length === 0) throw new RefusalError(`no archive JSON files in ${args.dir}`);

  const db = args.dbPath === undefined ? openDb() : openDb({ path: args.dbPath });

  say("pre-1.0 archive restore");
  say(`  source  ${args.dir}`);
  say(`  target  ${args.dbPath ?? "(default DB)"}`);
  say(`  mode    ${args.dryRun ? "DRY RUN — nothing is written" : "WRITE"}`);
  say("");

  const live = new Set(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );

  for (const file of files) {
    const wsNames = [...new Set(file.archived_tasks.map((t) => t.source_workstream))].sort();
    const overlap = wsNames.filter((n) => live.has(n));
    say(`archive '${file.archive.label}' — ${file.archived_tasks.length} tasks`);
    say(`  workstreams : ${wsNames.length} (${overlap.length} already live)`);
    for (const n of wsNames) {
      const c = file.archived_tasks.filter((t) => t.source_workstream === n).length;
      say(`      ${live.has(n) ? "MERGE " : "CREATE"} ${n.padEnd(24)} ${c}`);
    }
    const owned = file.archived_tasks.filter((t) => t.owner_name !== null).length;
    if (owned > 0) say(`  NOT carried : ${owned} owner_name values (ownership is machine-local)`);
  }
  say("");

  const divergences = findDivergences(db, files);
  if (divergences.length > 0) {
    say(`DIVERGENCE — ${divergences.length} live field(s) disagree with the archive:`);
    for (const d of divergences.slice(0, 20)) {
      say(`  ${d.workstream}/${d.localId}.${d.field}: live=${d.live} archived=${d.archived}`);
    }
    if (divergences.length > 20) say(`  ... and ${divergences.length - 20} more`);
    say("");
    if (!args.allowDivergent) {
      throw new RefusalError(
        "A marker pins CURRENT state. Where live rows disagree with the archive,\n" +
          "the pin would misrepresent what was archived. Re-run with --allow-divergent\n" +
          "to accept that, or reconcile the live rows first.",
      );
    }
    say("  --allow-divergent: proceeding; these markers pin current state.");
    say("");
  } else {
    say("DIVERGENCE CHECK: ok — every overlapping live row matches the archive.");
    say("");
  }

  let total = 0;
  for (const file of files) {
    const planned = planArchive(file, args.dropEvents);
    const counts = countBy(planned);
    say(`plan '${file.archive.label}': ${planned.length} ops  ${JSON.stringify(counts)}`);
    total += planned.length;
    if (args.dryRun) continue;
    const groupId = `restore-v8-archive-${file.archive.label}-${randomUUID().slice(0, 8)}`;
    const res = writeOps(db, planned, groupId);
    say(
      `  written ${res.opsWritten} ops (${res.opsChangedRows} changed a row) in ${res.elapsedMs}ms`,
    );
    say(`  group   ${groupId}`);
  }

  say("");
  if (args.dryRun) {
    say(`DRY RUN complete — ${total} ops planned, 0 written.`);
    say("Re-run without --dry-run to apply.");
  } else {
    say(`DONE — ${total} ops written.`);
    say("NEXT");
    say("  mu archive list");
    say("  mu doctor --deep      # must report NO drift");
  }
  db.close();
  return 0;
}

function main(): void {
  try {
    process.exitCode = runRestore(process.argv.slice(2), (text) => {
      process.stdout.write(`${text}\n`);
    });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof RefusalError) {
      process.stderr.write(`REFUSED: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
