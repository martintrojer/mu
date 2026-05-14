// mu — restore archived task graphs back into a fresh workstream.

import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "../db.js";
import { emitEvent } from "../logs.js";
import type { HasNextSteps, NextStep } from "../output.js";
import { captureSnapshot } from "../snapshots.js";
import {
  WorkstreamExistsError,
  WorkstreamNameInvalidError,
  ensureWorkstream,
  isValidWorkstreamName,
} from "../workstream.js";
import { resolveArchiveId } from "./core.js";

export class ArchiveSourceAmbiguousError extends Error implements HasNextSteps {
  override readonly name = "ArchiveSourceAmbiguousError";
  constructor(
    public readonly label: string,
    public readonly sources: readonly string[],
  ) {
    super(
      sources.length === 0
        ? `archive ${label} contains no source workstreams`
        : `archive ${label} requires --source <orig-ws-name>. Available: ${sources.join(", ")}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Inspect archive sources", command: `mu archive show ${this.label}` },
      ...this.sources.map((source) => ({
        intent: `Restore source workstream ${source}`,
        command: `mu archive restore ${this.label} --source ${source} --as <new-workstream>`,
      })),
    ];
  }
}

export interface RestoreArchiveOptions {
  sourceWorkstream?: string;
}

export interface RestoreArchiveResult {
  archiveLabel: string;
  sourceWorkstream: string;
  workstreamName: string;
  restoredTasks: number;
  restoredEdges: number;
  restoredNotes: number;
}

export function restoreArchive(
  db: Db,
  label: string,
  asWorkstream: string,
  opts: RestoreArchiveOptions = {},
): RestoreArchiveResult {
  const archiveId = resolveArchiveId(db, label);
  const sources = listSources(db, archiveId);
  if (!isValidWorkstreamName(asWorkstream)) throw new WorkstreamNameInvalidError(asWorkstream);

  const sourceWorkstream = opts.sourceWorkstream ?? sources[0];
  if (sourceWorkstream === undefined) throw new ArchiveSourceAmbiguousError(label, sources);
  if (opts.sourceWorkstream === undefined && sources.length > 1) {
    throw new ArchiveSourceAmbiguousError(label, sources);
  }
  if (opts.sourceWorkstream !== undefined && !sources.includes(opts.sourceWorkstream)) {
    throw new ArchiveSourceAmbiguousError(label, sources);
  }
  if (tryResolveWorkstreamId(db, asWorkstream) !== null) {
    throw new WorkstreamExistsError(asWorkstream);
  }

  captureSnapshot(db, `archive restore ${label} as ${asWorkstream}`, null);

  return db.transaction(() => {
    ensureWorkstream(db, asWorkstream);
    const wsId = resolveWorkstreamId(db, asWorkstream);

    const restoredTasks = db
      .prepare(
        `INSERT INTO tasks
           (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at)
         SELECT ?, original_local_id, title, status, impact, effort_days, NULL,
                original_created_at, original_updated_at
           FROM archived_tasks
          WHERE archive_id = ? AND source_workstream = ?
          ORDER BY id`,
      )
      .run(wsId, archiveId, sourceWorkstream).changes;

    const now = new Date().toISOString();
    const restoredEdges = db
      .prepare(
        `INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at)
         SELECT live_from.id, live_to.id, ?
           FROM archived_edges e
           JOIN archived_tasks arch_from ON arch_from.id = e.from_archived_id
           JOIN archived_tasks arch_to   ON arch_to.id   = e.to_archived_id
           JOIN tasks live_from ON live_from.workstream_id = ?
                               AND live_from.local_id = arch_from.original_local_id
           JOIN tasks live_to   ON live_to.workstream_id = ?
                               AND live_to.local_id = arch_to.original_local_id
          WHERE e.archive_id = ?
            AND arch_from.source_workstream = ?
            AND arch_to.source_workstream = ?`,
      )
      .run(now, wsId, wsId, archiveId, sourceWorkstream, sourceWorkstream).changes;

    const restoredNotes = db
      .prepare(
        `INSERT INTO task_notes (task_id, author, content, created_at)
         SELECT live.id, n.author, n.content, n.created_at
           FROM archived_notes n
           JOIN archived_tasks arch ON arch.id = n.archived_task_id
           JOIN tasks live ON live.workstream_id = ?
                          AND live.local_id = arch.original_local_id
          WHERE n.archive_id = ? AND arch.source_workstream = ?
          ORDER BY n.id`,
      )
      .run(wsId, archiveId, sourceWorkstream).changes;

    emitEvent(
      db,
      asWorkstream,
      `archive restore ${label} source=${sourceWorkstream} as ${asWorkstream} (tasks=${restoredTasks}, edges=${restoredEdges}, notes=${restoredNotes})`,
    );
    return {
      archiveLabel: label,
      sourceWorkstream,
      workstreamName: asWorkstream,
      restoredTasks,
      restoredEdges,
      restoredNotes,
    };
  })();
}

function listSources(db: Db, archiveId: number): string[] {
  return (
    db
      .prepare(
        `SELECT source_workstream AS name
           FROM archived_tasks
          WHERE archive_id = ?
          GROUP BY source_workstream
          ORDER BY source_workstream`,
      )
      .all(archiveId) as { name: string }[]
  ).map((row) => row.name);
}
