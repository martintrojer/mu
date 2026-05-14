// mu — archives SDK hub.
//
// Cross-workstream archive implementation lives in the cohesive
// src/archives/ cluster. This root file preserves the public
// `import { ... } from "./archives.js"` surface.

export { addToArchive, removeFromArchive } from "./archives/addremove.js";
export {
  type AddToArchiveResult,
  type Archive,
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  type ArchiveSourceSummary,
  type ArchiveSummary,
  type ArchivedTaskRow,
  type RawArchiveRow,
  type RawArchivedTaskRow,
  type RemoveFromArchiveResult,
  archiveByLabel,
  assertValidArchiveLabel,
  isValidArchiveLabel,
  resolveArchiveId,
  rowFromArchive,
  rowFromArchivedTask,
  summarizeArchive,
  tryResolveArchiveId,
} from "./archives/core.js";
export { deleteArchive } from "./archives/delete.js";
export {
  type ArchiveSearchHit,
  type ListArchivedTasksOptions,
  type SearchArchivesOptions,
  createArchive,
  getArchive,
  listArchivedTasks,
  listArchives,
  searchArchives,
} from "./archives/query.js";
export {
  ArchiveSourceAmbiguousError,
  type RestoreArchiveOptions,
  type RestoreArchiveResult,
  restoreArchive,
} from "./archives/restore.js";
