// mu — archives, as MARKERS pinning points in the ops log.
//
// WHAT CHANGED FROM v1
//
// v1 archives were five tables (`archives`, `archived_tasks`,
// `archived_edges`, `archived_notes`, `archived_events`) holding a COPY
// of a column subset, plus verbs to create and destroy those rows. R1
// dropped all five. This module rebuilds the feature on the ops log,
// where it costs one row per archive:
//
//   mu archive add v0-3 -w ws        → ONE marker op (label, ws, hlc)
//   mu archive restore v0-3 --as r   → replay ws's ops up to that hlc,
//                                      under the new name
//
// Every v1 property survives, and each is load-bearing enough to state:
//
//   OUTLIVES DESTROY   `workstream destroy` writes TOMBSTONES; it does
//                      not erase history. The ops below the marker are
//                      still there, so an archive of a destroyed
//                      workstream still restores.
//   CROSS-WORKSTREAM   One label accumulates markers from many
//                      workstreams; `list` groups by label.
//   ADDITIVE           Markers are append-only by construction (they
//                      are ops). `lastAddedAt` is just MAX(hlc).
//   LOSSLESS RESTORE   Replaying ops reproduces every captured column,
//                      which is strictly MORE faithful than v1's
//                      column-subset copy.
//
// ┌─ LOAD-BEARING INVARIANT ────────────────────────────────────────┐
// │ MARKERS PIN THE LOG. Compaction must NEVER discard ops at or   │
// │ below a pinned marker's HLC. Nothing compacts today, but the    │
// │ moment something does, dropping ops under a marker silently     │
// │ empties the archive it promised to preserve — and the failure   │
// │ surfaces only when someone tries to restore, long after the     │
// │ data is gone. `pinnedHlcs()` exists so a future compactor has   │
// │ no excuse.                                                      │
// └─────────────────────────────────────────────────────────────────┘

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { nextHlc } from "./hlc.js";
import type { HasNextSteps, NextStep } from "./output.js";

/** Archive-label shape. Wider than a workstream name because labels
 *  routinely encode workstream + date + purpose (`auth-2026-q1`).
 *  Mirrors docs/VOCABULARY.md § archive label. */
const ARCHIVE_LABEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidArchiveLabel(label: string): boolean {
  return ARCHIVE_LABEL_RE.test(label);
}

/** The op entity every marker uses. Already in SYNCED_ENTITIES, so
 *  markers travel to peers with the ops they pin. */
export const MARKER_ENTITY = "marker";
export const MARKER_INTENT = "archive.add";

// ─── errors ───────────────────────────────────────────────────────────

export class ArchiveLabelInvalidError extends Error implements HasNextSteps {
  constructor(readonly label: string) {
    super(
      `invalid archive label ${JSON.stringify(label)}: must match ${ARCHIVE_LABEL_RE}. Labels are lowercase, start with a letter, and may contain digits, '_' and '-'.`,
    );
    this.name = "ArchiveLabelInvalidError";
  }
  errorNextSteps(): NextStep[] {
    return [{ intent: "List existing archives", command: "mu archive list" }];
  }
}

export class ArchiveNotFoundError extends Error implements HasNextSteps {
  constructor(readonly label: string) {
    super(`no archive labelled ${JSON.stringify(label)}`);
    this.name = "ArchiveNotFoundError";
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List archives on this machine", command: "mu archive list" },
      { intent: "Create one by adding a workstream", command: "mu archive add <label> -w <ws>" },
    ];
  }
}

/** Raised when `restore --as <name>` targets a name already in use. */
export class ArchiveRestoreTargetExistsError extends Error implements HasNextSteps {
  constructor(readonly targetName: string) {
    super(
      `cannot restore onto existing workstream ${JSON.stringify(targetName)}: restore creates a NEW workstream so the archive can be inspected beside the original`,
    );
    this.name = "ArchiveRestoreTargetExistsError";
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Restore under a different name",
        command: "mu archive restore <label> --as <new>",
      },
      { intent: "See what exists", command: "mu workstream list" },
    ];
  }
}

// ─── shapes ───────────────────────────────────────────────────────────

/** One marker: a label pinning one workstream at one point in the log. */
export interface ArchiveMarker {
  label: string;
  workstream: string;
  /** The pin. Ops with hlc <= this belong to the archive. */
  hlc: string;
  createdAt: string;
  actor: string | null;
}

/** A label, with every workstream it has accumulated. */
export interface ArchiveSummary {
  label: string;
  markers: ArchiveMarker[];
  /** MAX(hlc) across markers — "additive" needs no stored column. */
  lastAddedAt: string;
  workstreams: string[];
}

interface MarkerPayload {
  workstream: string;
  /** Denormalised so `list` needs no join, and so a marker read from a
   *  peer's segment is self-describing. */
  label: string;
}

// ─── add ──────────────────────────────────────────────────────────────

/**
 * Pin `workstream` at the current point in the log under `label`.
 *
 * Creating a label IS adding the first marker to it — there is no
 * separate `create`, because a label with no markers pins nothing and
 * would be a row that means nothing. Idempotence is deliberately NOT
 * enforced: adding twice pins two moments, which is the point of an
 * append-only marker (`v0-3` before and after a fix are both useful).
 */
export function addArchiveMarker(
  db: Db,
  opts: { label: string; workstream: string; actor?: string },
): ArchiveMarker {
  if (!isValidArchiveLabel(opts.label)) throw new ArchiveLabelInvalidError(opts.label);

  const payload: MarkerPayload = { workstream: opts.workstream, label: opts.label };
  const hlc = nextHlc(db);
  const createdAt = new Date().toISOString();
  const actor = opts.actor ?? "user";
  db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, (SELECT machine_id FROM machine_identity WHERE id = 1), ?, ?, ?, ?, ?, 'put', ?, ?)`,
  ).run(
    hlc,
    randomUUID(),
    actor,
    MARKER_INTENT,
    MARKER_ENTITY,
    // Natural key: '<label>/<workstream>'. Keeps one label's markers
    // adjacent under the ops (entity, key) index and stays readable
    // after the workstream is destroyed.
    `${opts.label}/${opts.workstream}`,
    JSON.stringify(payload),
    createdAt,
  );
  return { label: opts.label, workstream: opts.workstream, hlc, createdAt, actor };
}

// ─── list ─────────────────────────────────────────────────────────────

interface RawMarkerRow {
  hlc: string;
  key: string;
  payload: string;
  created_at: string;
  actor: string | null;
}

function readMarkers(db: Db, label?: string): ArchiveMarker[] {
  const rows = (
    label === undefined
      ? db
          .prepare(
            `SELECT hlc, key, payload, created_at, actor FROM ops
              WHERE entity = ? AND op = 'put' ORDER BY hlc ASC`,
          )
          .all(MARKER_ENTITY)
      : db
          .prepare(
            `SELECT hlc, key, payload, created_at, actor FROM ops
              WHERE entity = ? AND op = 'put' AND (key = ? OR key LIKE ? ESCAPE '\\')
              ORDER BY hlc ASC`,
          )
          .all(MARKER_ENTITY, label, `${label.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`)
  ) as RawMarkerRow[];

  const out: ArchiveMarker[] = [];
  for (const row of rows) {
    // Prefer the payload (self-describing, survives a key-format change);
    // fall back to parsing the key so a hand-written marker still reads.
    let parsed: Partial<MarkerPayload> = {};
    try {
      const v: unknown = JSON.parse(row.payload);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        parsed = v as Partial<MarkerPayload>;
      }
    } catch {
      parsed = {};
    }
    const slash = row.key.indexOf("/");
    const keyLabel = slash === -1 ? row.key : row.key.slice(0, slash);
    const keyWs = slash === -1 ? "" : row.key.slice(slash + 1);
    const resolvedLabel = parsed.label ?? keyLabel;
    const resolvedWs = parsed.workstream ?? keyWs;
    if (resolvedWs === "") continue;
    out.push({
      label: resolvedLabel,
      workstream: resolvedWs,
      hlc: row.hlc,
      createdAt: row.created_at,
      actor: row.actor,
    });
  }
  return out;
}

/** Every archive on this machine, newest-touched first. */
export function listArchives(db: Db): ArchiveSummary[] {
  const byLabel = new Map<string, ArchiveMarker[]>();
  for (const m of readMarkers(db)) {
    const list = byLabel.get(m.label);
    if (list === undefined) byLabel.set(m.label, [m]);
    else list.push(m);
  }
  const summaries: ArchiveSummary[] = [];
  for (const [label, markers] of byLabel) {
    summaries.push(summarise(label, markers));
  }
  return summaries.sort((a, b) => (a.lastAddedAt < b.lastAddedAt ? 1 : -1));
}

function summarise(label: string, markers: ArchiveMarker[]): ArchiveSummary {
  const last = markers.reduce((acc, m) => (m.hlc > acc ? m.hlc : acc), "");
  return {
    label,
    markers,
    lastAddedAt: last,
    workstreams: [...new Set(markers.map((m) => m.workstream))].sort(),
  };
}

/** One archive, or throw. */
export function getArchive(db: Db, label: string): ArchiveSummary {
  if (!isValidArchiveLabel(label)) throw new ArchiveLabelInvalidError(label);
  const markers = readMarkers(db, label).filter((m) => m.label === label);
  if (markers.length === 0) throw new ArchiveNotFoundError(label);
  return summarise(label, markers);
}

/**
 * The marker that defines what a label restores FOR ONE WORKSTREAM: the
 * most recent pin, since later markers supersede earlier ones for the
 * same workstream. Returns null when the label does not cover it.
 */
export function markerFor(db: Db, label: string, workstream: string): ArchiveMarker | null {
  const markers = getArchive(db, label).markers.filter((m) => m.workstream === workstream);
  return markers.reduce<ArchiveMarker | null>(
    (acc, m) => (acc === null || m.hlc > acc.hlc ? m : acc),
    null,
  );
}

/**
 * Every HLC pinned by a marker, for the compaction invariant.
 *
 * A compactor MUST NOT discard ops at or below any of these. Exported
 * (and unused in production today) on purpose: the invariant is written
 * down in code as well as in docs/VOCABULARY.md, so whoever builds
 * compaction trips over it rather than rediscovering it from a support
 * report about an empty archive.
 */
export function pinnedHlcs(db: Db): string[] {
  return [...new Set(readMarkers(db).map((m) => m.hlc))].sort();
}
