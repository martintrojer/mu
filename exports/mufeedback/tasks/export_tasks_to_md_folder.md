---
id: "export_tasks_to_md_folder"
workstream: "mufeedback"
status: CLOSED
impact: 65
effort_days: 0.7
roi: 92.86
owner: "worker-mf-2"
created_at: "2026-05-09T08:10:36.999Z"
updated_at: "2026-05-09T10:51:30.382Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# feat: mu workstream export → idempotent md/ folder of task files (preserve before destroy)

## Notes (1)

### #1 by π - mu, 2026-05-09T08:11:25.145Z

````
USE CASE: a workstream's task graph + notes IS the project memory — durable history of what was decided and why. Today destroying a workstream auto-snapshots the DB, but that's binary, not human-readable, and tied to mu. Operators want to PRESERVE the conversation as plain markdown OUTSIDE mu before destroying — for code review, for project handoff, for grep, for git-checked-in artifacts.

Two motivating moments from this very session:
  1. snap_dogfood and its 4 follow-up tasks (cross_workstream_claim_for, workspace_create_partial_dir_on_failure, snap_undo_reconcile_destroys_recovered_agents) — closing roadmap-v0-2 destroys all that hard-won design context unless someone manually exports.
  2. mufeedback has 50+ closed tasks with rich notes; the only way to read them post-destroy is `mu undo` then `mu sql` — round-trip through a binary archive.

PROPOSED VERB

  mu workstream export -w <ws> [--out <dir>]   # default --out ./<ws>/
  
  Writes:
    <out>/README.md                 # workstream summary: name, dates, task counts
    <out>/tasks/<localId>.md        # one file per task; full task surface
    <out>/INDEX.md                  # table of all tasks: id | status | impact/effort/ROI | title | one-line summary
    <out>/manifest.json             # machine-readable manifest for re-import sanity (schema, snapshot id at export time, list of files)

PER-TASK FILE SHAPE (`<out>/tasks/<localId>.md`):

  ---
  id: cross_workstream_claim_for
  workstream: roadmap-v0-2
  status: CLOSED
  impact: 60
  effort_days: 0.3
  roi: 200
  owner: worker-1
  created_at: 2026-05-08T14:21:21.992Z
  updated_at: 2026-05-08T14:39:33.010Z
  closed_at: 2026-05-08T14:39:07Z
  evidence: shipped: ...
  blocked_by: [snap_dogfood]
  blocks: []
  ---
  
  # mu task claim --for <agent> succeeds when <agent> is in a different workstream than the task
  
  ## Notes (3)
  
  ### #357 by π - mu, 2026-05-08T14:15:36
  
  ...note content verbatim, markdown-safe...
  
  ### #367 by worker-1, 2026-05-08T14:38:50
  ...

INVARIANTS (THE LOAD-BEARING ASKS)

  IDEMPOTENT: re-running `mu workspace export -w X --out same-dir` overwrites EXISTING files but does NOT delete files for tasks that no longer exist (preserves the operator's manual edits or git history). Tasks that DO exist get their .md regenerated; if content is byte-identical, no write (mtime preserved).

  NEW TASKS APPEAR: re-export after `mu task add foo` writes a new tasks/foo.md.

  CHANGED NOTES APPEAR: re-export after `mu task note bar "..."` rewrites tasks/bar.md with the new note appended. The diff against the previous export is minimal (one new ### #N section).

  STATUS CHANGES APPEAR: re-export after `mu task close baz` updates the frontmatter's status + closed_at + evidence.

  DELETED TASKS PRESERVED: if `mu task delete qux` happens, the tasks/qux.md file STAYS (operator can git-blame it). manifest.json marks it "deleted_at" so re-import would warn. (For 0.1: just leave the .md alone with a markdown banner "> Deleted from DB on <ts>".)

  WORKS DURING DESTRUCTION: `mu workstream destroy` should auto-call `mu workstream export --out <state-dir>/exports/<ws>-<ts>/` BEFORE the destroy snapshot so the export is captured one beat before pane-kill. The auto-export path should NOT silently fail destroy on export error (warn + proceed).

ANTI-FEATURES (not in this task)

  - Re-import. Out of scope for v0.1. The export is for human/git consumption, not round-trip. (If we ever want re-import, the manifest.json gives us a hook.)
  - HTML/PDF/anything-not-markdown. Markdown is enough. Operators can pandoc.
  - Embedded VCS. The output dir is just a dir; user can `git init && git add . && git commit -m "<ws> snapshot"` themselves.
  - Cross-workstream merging. One workstream per export call.
  - Streaming/incremental: just rewrite. Write speed is irrelevant for our scale.

WHERE TO LOOK / IMPLEMENT

  src/workstream.ts                     — exportWorkstream() SDK alongside existing destroy/list/etc
  src/cli/workstream.ts                 — wire `mu workstream export -w X [--out <dir>]` verb
  src/cli/workstream.ts (cmdDestroy)    — pre-destroy hook to call exportWorkstream into a default state-dir path; --no-export to opt out
  test/workstream.test.ts (or new test/workstream-export.test.ts)
                                         — idempotence: export twice → file set unchanged; export → add note → export → exactly one file changed (the noted task) and diff is exactly the new note section; export → delete task → export → file STILL EXISTS with banner

  No schema change. Just READ + WRITE files.

CONSIDERATIONS

  - markdown-safety for note content: notes contain code blocks, ``` fences, --- separators. Wrap each note's body in a 4-backtick fence (or use indented code blocks) so the user's literal triple-fence content survives.
  - filename safety: localId is already [a-z0-9_-]; safe as filename.
  - --out default: ./<ws>/ in cwd. If the dir exists, just write into it (idempotent). If a file exists with the right name but is a directory, error loud.
  - manifest.json schema: { workstream, exported_at, mu_version, tasks: [{id, sha256_of_md, deleted_at?}], events_seq_at_export } — sha256 lets a re-export skip the write if unchanged (mtime-preserve).

GATE: typecheck + lint + test + build green. ~150-200 LOC + ~80 LOC tests.

PROMOTION CRITERION CHECK
  This is a NEW VERB on a permanent shape. Does it meet the bar?
  - Real-user friction: ≥2 hits this session alone (snap_dogfood preservation; mufeedback's own task graph). YES.
  - Substrate ready: pure read+write over existing schema; no migration, no interface change. YES.
  - Fits in <300 LOC: yes (~250 budget). YES.
  Promotion approved.

NEXT
  No follow-up tasks YET. After shipping, watch for:
    - "I want to re-import" → file workstream_export_reimport
    - "I want git auto-commit" → DEFER (operator can do it; not mu's layer)
    - "destroy is too aggressive when export fails" → fix the warn-but-proceed semantics
````
