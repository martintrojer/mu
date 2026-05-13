// mu — task graph SDK hub.
//
// The concrete DAG implementation lives in the cohesive src/tasks/
// cluster. This root file preserves the public `import { ... } from
// "./tasks.js"` surface while keeping task edit / edge / query code in
// focused files.

export {
  type RawTaskNoteRow,
  type RawTaskRow,
  SELECT_NOTE_COLS,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskNoteRow,
  type TaskRow,
  lookupTaskAnyWorkstream,
  noteFromDb,
  rowFromDb,
  taskIdFor,
  touchTask,
} from "./tasks/core.js";
export {
  type BlockEdgeResult,
  type RemoveBlockEdgeResult,
  type ReparentTaskResult,
  type TaskEdgeWithStatus,
  type TaskEdges,
  type TaskEdgesWithStatus,
  addBlockEdge,
  getPrerequisites,
  getTaskEdges,
  getTaskEdgesWithStatus,
  removeBlockEdge,
  reparentTask,
  wouldCreateCycle,
} from "./tasks/edges.js";
export {
  type AddNoteOptions,
  type AddTaskOptions,
  type DeleteTaskOptions,
  type DeleteTaskResult,
  type UpdateTaskOptions,
  type UpdateTaskResult,
  type UpdateTaskScopeOption,
  addNote,
  addTask,
  deleteTask,
  updateTask,
} from "./tasks/edit.js";
export {
  type IdFromTitleResult,
  type SlugifyResult,
  idFromTitle,
  idFromTitleVerbose,
  isValidTaskId,
  sanitiseTaskId,
  slugifyTitle,
  slugifyTitleVerbose,
} from "./tasks/id.js";
export {
  type ListNotesOptions,
  type ListReadyOptions,
  type ListTasksOptions,
  type SearchTasksOptions,
  getTask,
  listBlocked,
  listGoals,
  listInProgress,
  listNotes,
  listReady,
  listRecentClosed,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
  searchTasks,
} from "./tasks/queries.js";

// Re-export status enum + helpers and error classes from the cluster
// modules. Public callers continue to `import { ... } from "./tasks.js"`
// regardless of which sub-file the symbol lives in.
export {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
  TaskAlreadyOwnedError,
  TaskClaimStaleWorkspaceError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
} from "./tasks/errors.js";
export {
  STATUSES_TERMINAL_OR_PARKED,
  TASK_STATUS_LIST,
  TASK_STATUSES,
  type TaskStatus,
  isTaskStatus,
} from "./tasks/status.js";
export {
  type ClaimResult,
  type ClaimTaskOptions,
  type ReleaseResult,
  type ReleaseTaskOptions,
  claimTask,
  releaseTask,
  resolveActorIdentity,
} from "./tasks/claim.js";
export {
  type CloseSkippedResult,
  type CloseTaskOptions,
  type EvidenceOption,
  type RejectDeferOptions,
  type RejectDeferResult,
  type SetStatusResult,
  closeTask,
  deferTask,
  evidenceSuffix,
  openTask,
  rejectTask,
  setTaskStatus,
} from "./tasks/lifecycle.js";
export {
  getWaitPollCount,
  resetWaitPollCount,
  setWaitSleepForTests,
  setWaitStuckWarnForTests,
  type TaskWaitOptions,
  type TaskWaitRef,
  type TaskWaitResult,
  type TaskWaitTaskState,
  waitForTasks,
} from "./tasks/wait.js";
