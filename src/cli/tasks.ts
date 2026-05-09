// mu — `mu task ...` cluster entry point.
//
// This file used to hold every cmdTask* implementation plus
// wireTaskCommands; at 1234 LOC it was past the AGENTS.md
// "refactor signal" of 800 LOC. The verb implementations now live in
// sibling files in this directory:
//
//   ./tasks/queries.ts    list / next / owned-by / my-tasks / my-next
//                         (the my-* helpers back `mu me tasks` /
//                         `mu me next`; `task blocked` / `goals` /
//                         `search` / `ready` were removed in
//                         audit_cleanups_post_schema_v5_wave)
//   ./tasks/lifecycle.ts  close / open / reject / defer
//   ./tasks/edit.ts       add / show / notes / note / update
//                         + unescapeNoteText / printNote
//   ./tasks/edges.ts      block / unblock / reparent / delete
//   ./tasks/claim.ts      claim / release / wait
//   ./tasks/tree.ts       tree
//   ./tasks/wire.ts       wireTaskCommands (Commander glue)
//
// Per the same anti-indirection policy that motivated
// `review_code_cli_tasks_re_export_indirection`, only the names that
// are actually imported by callers OUTSIDE the cluster live here as
// re-exports. Adding more would re-introduce dead surface.
//
//   wireTaskCommands       — src/cli.ts (buildProgram)
//   cmdMyNext / cmdMyTasks — src/cli/agents.ts (mu me next / mu me tasks)
//   unescapeNoteText       — test/unescape-note-text.test.ts

export { cmdMyNext, cmdMyTasks } from "./tasks/queries.js";
export { unescapeNoteText } from "./tasks/edit.js";
export { wireTaskCommands } from "./tasks/wire.js";
