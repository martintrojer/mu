// mu — archive delete verb.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { resolveArchiveId } from "./core.js";

/**
 * Delete an archive and every row that references it. The FK
 * CASCADE chain (archives → archived_tasks → archived_edges /
 * archived_notes; archives → archived_events) cleans every row in
 * one statement.
 *
 * Idempotent: throws `ArchiveNotFoundError` rather than silently
 * succeeding on a missing label (operator confusion safeguard).
 */
export function deleteArchive(db: Db, label: string): void {
  const id = resolveArchiveId(db, label);
  db.prepare("DELETE FROM archives WHERE id = ?").run(id);
  emitEvent(db, null, `archive delete ${label}`);
}
