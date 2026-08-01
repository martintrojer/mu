// mu — `mu archive export <label>`: the archived workstream as markdown.
//
// Deliberately NOT a second renderer. `src/exporting.ts` owns every byte
// of bucket layout (per-task files, sha256 skip, preserved-file banner,
// README + index), and `mu workstream export` already goes through it.
// This module's only job is to produce the `ExportSource` for a
// workstream that may no longer exist, then hand it over.
//
// HOW: replay to the marker in a SCRATCH workstream inside a transaction,
// build the ExportSource from it, then ROLL BACK. The replay machinery is
// `restoreArchive` + `applyOp`, so there is exactly one code path that
// knows how to reconstitute an archive, and export cannot drift from
// restore. Nothing is left behind — including no ops, because the
// rollback discards the capture rows too.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getArchive } from "../archives.js";
import { ArchiveNotFoundError } from "../archives.js";
import type { Db } from "../db.js";
import {
  type ExportSource,
  type RenderBucketResult,
  exportSourceForWorkstream,
  renderToBucket,
} from "../exporting.js";
import { restoreArchive } from "./restore.js";

export interface ExportArchiveOptions {
  label: string;
  /** Which pinned workstream, when the label covers several. */
  workstream?: string;
  outDir: string;
}

export interface ExportArchiveResult extends RenderBucketResult {
  label: string;
  sourceWorkstream: string;
}

/**
 * Render an archive to a markdown bucket.
 *
 * SYNCHRONOUS: the replay it wraps is synchronous for the op-context
 * reason (a per-connection temp table cannot be shared across
 * interleaved async scopes).
 */
export function exportArchive(db: Db, opts: ExportArchiveOptions): ExportArchiveResult {
  const summary = getArchive(db, opts.label);
  const sourceWorkstream = opts.workstream ?? summary.workstreams[0];
  if (sourceWorkstream === undefined) throw new ArchiveNotFoundError(opts.label);
  if (opts.workstream === undefined && summary.workstreams.length !== 1) {
    throw new ArchiveNotFoundError(
      `${opts.label} covers ${summary.workstreams.length} workstreams (${summary.workstreams.join(", ")}); pass -w to choose one`,
    );
  }

  // A scratch name no operator would pick, so a collision is impossible
  // even if a previous run died mid-transaction (it cannot leave a row —
  // the rollback is what cleans up — but the name still must not clash
  // with live work).
  const scratch = `zz-archive-export-${randomUUID().slice(0, 8)}`;

  const source = materialise(db, opts.label, sourceWorkstream, scratch);

  const rendered = renderToBucket({
    // Re-label every row to the ARCHIVED workstream. The scratch name is
    // an implementation detail of materialising, and renderTaskMarkdown
    // reads `task.workstreamName` per row for the frontmatter — so
    // renaming only the source would leak 'zz-archive-export-<uuid>' into
    // every exported file.
    sources: [
      {
        ...source,
        name: sourceWorkstream,
        tasks: source.tasks.map((t) => ({ ...t, workstreamName: sourceWorkstream })),
      },
    ],
    bucketLabel: opts.label,
    outDir: resolve(opts.outDir),
  });
  return { ...rendered, label: opts.label, sourceWorkstream };
}

/**
 * Replay the archive into `scratch`, read it, and roll back.
 *
 * The rollback is the whole trick: `mu archive export` must not mutate
 * anything, but reading an archive requires materialising it, because the
 * rows only exist as ops. A transaction that always throws gives us
 * "materialise, read, vanish" with no cleanup code to forget.
 */
function materialise(db: Db, label: string, workstream: string, scratch: string): ExportSource {
  let captured: ExportSource | null = null;
  const sentinel = `__mu_archive_export_rollback_${scratch}__`;
  try {
    db.transaction(() => {
      restoreArchive(db, { label, workstream, as: scratch });
      const source = exportSourceForWorkstream(db, scratch);
      // Deep-copy nothing: the rows are plain objects already detached
      // from the DB (better-sqlite3 returns values, not cursors), so they
      // remain valid after the rollback.
      captured = source;
      // Force the rollback. better-sqlite3 has no explicit rollback
      // inside .transaction(), so throwing is the documented way out.
      throw new Error(sentinel);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== sentinel) throw err;
  }
  if (captured === null) {
    throw new Error(`archive export: replay of ${label}/${workstream} produced no source`);
  }
  return captured;
}
