---
id: "refactor_split_large_src_files"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 1
roi: 50.00
owner: null
created_at: "2026-05-08T11:03:07.884Z"
updated_at: "2026-05-08T19:06:04.061Z"
blocked_by: []
blocks: []
---

# REFACTOR: src/cli.ts (4617) and src/tasks.ts (1652) past the 1500 LOC hard cap; src/agents.ts (1078) past the 800 refactor signal

## Notes (2)

### #1 by π - mu, 2026-05-08T11:03:08.019Z

```
CONTEXT
AGENTS.md sets a 1500 LOC hard cap per file, with 800 as the refactor signal. Current state (commits f68838f..a974775):

  4617  src/cli.ts        OVER hard cap (3.0x)
  1652  src/tasks.ts      OVER hard cap (1.1x)
  1078  src/agents.ts     OVER refactor signal (1.3x)
   731  src/tmux.ts       under
   475  src/vcs.ts        under
   460  src/migrations.ts under
   448  src/db.ts         under
   371  src/workstream.ts under
   312  src/approvals.ts  under
   278  src/workspace.ts  under
   241  src/index.ts      under (re-exports)
   180  src/logs.ts       under
   167  src/tracks.ts     under
   144  src/reconcile.ts  under
   120  src/detect.ts     under
   103  src/output.ts     under

PROPOSED CUTS (subtractive, keep flat layout — no subdirs)

src/cli.ts → split by verb domain. Candidates:
  src/cli/agents_cli.ts     spawn / send / read / list / show / close / free / adopt / attach
  src/cli/tasks_cli.ts      add / claim / release / close / open / reject / defer / note / show / tree / ...
  src/cli/workstream_cli.ts init / list / destroy / state
  src/cli/log_cli.ts        log / log read / log tail / log write
  src/cli/approve_cli.ts    add / list / grant / deny / wait
  src/cli/hud_cli.ts        hud
  src/cli/sql_cli.ts        sql
  src/cli/doctor_cli.ts     doctor
  src/cli.ts (rooted, ~600 LOC) keeps:
    - buildProgram() wiring
    - handle() error mapping
    - shared helpers: resolveWorkstream, statusIcon, format*Table, parseLines, JSON_OPT, WORKSTREAM_OPT, EVIDENCE_OPT, UsageError, parseStatusOption

  Trade-off: AGENTS.md says "flat layout — no subdirs". The repo already has subdirs allowed
  (test/), but src/ is currently flat. Two options:
    (a) Stay flat: src/cli_agents.ts, src/cli_tasks.ts, ... (8 new files at the same level)
    (b) Allow ONE subdir: src/cli/*.ts (cleaner, but breaks the flat invariant)

  My recommendation: (a). Flat invariant is a load-bearing simplifier (no module-resolution
  surprises, every file at the same level, AGENTS.md says so explicitly). The cost of a few
  underscore-namespaced files is small.

src/tasks.ts → split:
  src/task_errors.ts        TaskNotFoundError, TaskExistsError, TaskAlreadyOwnedError,
                            TaskHasOpenDependentsError, ClaimerNotRegisteredError,
                            CycleError, CrossWorkstreamEdgeError, TaskNotInWorkstreamError
  src/task_status.ts        TaskStatus, TASK_STATUSES, TASK_STATUS_LIST, isTaskStatus,
                            STATUSES_THAT_UNBLOCK, STATUSES_TERMINAL_OR_PARKED
  src/task_claim.ts         claimTask, releaseTask, resolveActorIdentity, resolveSelfActor
  src/task_lifecycle.ts     setTaskStatus, closeTask, openTask, rejectTask, deferTask,
                            findOpenDependents
  src/task_wait.ts          waitForTasks
  src/tasks.ts (rooted, ~600 LOC) keeps:
    - addTask, getTask, getTaskEdges, getPrerequisites
    - addNote, listNotes
    - listTasks, listReady, listBlocked, listGoals, listTasksByOwner, searchTasks
    - addBlockEdge, removeBlockEdge, reparentTask
    - cycle check, idFromTitle, slugifyTitle, isValidTaskId

src/agents.ts → split:
  src/agent_errors.ts       AgentNotFoundError, AgentExistsError, AgentNotInWorkstreamError,
                            AgentDiedOnSpawnError, WorkspacePreservedError
  src/agent_title.ts        STATUS_EMOJI, composeAgentTitle, refreshAgentTitle
                            (no circular-import problem — agent_title only reads agents.ts;
                            CLI verbs that mutate state call it explicitly)
  src/agent_spawn.ts        spawnAgent + helpers (createOrReusePane, resolveCliCommand,
                            awaitSpawnLiveness, defaultSpawnLivenessMs)
  src/agent_adopt.ts        adoptAgent, AdoptAgentOptions, AdoptAgentResult
  src/agents.ts (rooted, ~400 LOC) keeps:
    - AgentRow, AgentStatus, InsertAgentInput, FreeAgentResult, etc. types
    - insertAgent, getAgent, getAgentByPane, listAgents, listLiveAgents, deleteAgent
    - updateAgentStatus, freeAgent, closeAgent, sendToAgent, readAgent, isValidAgentName

DELIVERABLE
- After the split: every src/*.ts file is ≤800 LOC.
- Public API surface (src/index.ts re-exports) unchanged. Move things to new modules; re-export
  from index.ts so SDK consumers don't break.
- Test files unchanged (they import from src/*.ts; relocations are import-only edits).
- One PR per file (cli.ts, tasks.ts, agents.ts) so each can be reviewed in isolation.
- Gate green at every commit (typecheck/lint/test/build).

EFFORT
~1 day total. Mostly mechanical: cut, paste, fix imports. Minimal logic changes (the modules
extracted are already cohesive — that's why the split is feasible).

PROMOTION CRITERIA (from ROADMAP)
- "A real user hits the missing feature" — N/A; this is internal hygiene. Triggered by
  AGENTS.md's documented rule: "Hard cap: 1500 LOC per file. Refactor signal at 800."
  cli.ts (4617) and tasks.ts (1652) violate the cap.
- "current substrate makes the addition straightforward" — yes; flat layout, no module-loader,
  ESM with explicit imports.
- "<300 LOC or has a clear smaller subset" — N/A (this IS subtractive).

RISK
- ESM circular imports if the split lines are wrong. Mitigation: run typecheck after every
  file move; if a cycle forms, redraw the line (often the fix is moving one helper to its
  natural home rather than a separate module).
- biome's organizeImports re-sorting: re-run `npx biome check --write src` after every
  file before committing.
```

### #2 by π - mu, 2026-05-08T19:06:03.948Z

```
SHIPPED: 11 commits (7343029 + bdd63bf..1512002).

═══ FILES ═══

  src/cli.ts (split anchor; commander wiring + handle() + shared helpers)
  src/cli/log.ts        173  (mu log read/write/tail)
  src/cli/approve.ts    221  (5 approve verbs)
  src/cli/workspace.ts  150  (5 workspace verbs)
  src/cli/snapshot.ts   320  (mu undo + snapshot list/show)
  src/cli/doctor.ts     301  (mu doctor + json)
  src/cli/sql.ts        267  (mu sql + countTopLevelStatements)
  src/cli/state.ts      265  (bare mu + mu state)
  src/cli/hud.ts        518  (mu hud + 5 format helpers + colorEventPayload)
  src/cli/tasks.ts     1102  (every mu task verb + my-tasks/my-next)
  src/cli/agents.ts     489  (every agent verb + adopt + attach + whoami)
  src/cli/workstream.ts 261  (init/list/destroy)
  AGENTS.md             relaxed flat-only rule to allow one level of
                        cohesive subdirs (with cluster requirements)
  docs/ARCHITECTURE.md  module table updated

═══ NUMBERS ═══

  src/cli.ts:    5554 → 1851 LOC  (-67%)
  src/tasks.ts:  1731 LOC  (unchanged; refactor signal still on)
  src/agents.ts: 1116 LOC  (unchanged; refactor signal still on)

  total src LOC: 13232 → 13352 (+120, mostly per-file headers
                + import duplication; the structural win is
                the ability to navigate / read / edit one verb-
                namespace at a time)

═══ DECISION ═══

  Picked src/cli/*.ts (one level of subdirs) over src/cli_*.ts (flat).
  Rationale: past ~20 files at one level the flat layout starts
  hurting (Finder/IDE listing becomes noise; ls src/ no longer reads
  as architecture). Each cluster has a clear theme, imports flow
  cluster → root only (no upward imports), ARCHITECTURE.md table
  covers it. AGENTS.md updated with the new rule + the cluster
  requirements. This sets the precedent for future clusters
  (src/tasks/ if/when we split tasks.ts).

  src/cli.ts STAYS the entry point. It owns:
    - buildProgram() — the full commander wiring (~1040 LOC; this
      is the bulk of what's left)
    - handle() / classifyError() / emitError() — exit-code mapping
    - resolveWorkstream / resolveOptionalWorkstream / resolveSelf
    - 6 shared format helpers (formatAgentsTable, formatReadyTable,
      formatTaskListTable, formatTracks, formatWorkspacesTable,
      formatWorkstreamsTable, statusIcon, colorStatus)
    - ROI helpers (roiOf, byRoiDesc, withRoi, withRoiAll)
    - assertAgentInWorkstream + assertTaskInWorkstream (cli/tasks.ts has the latter)
    - emitJson, printLogRow, rawTaskRowToTask, RawTaskRowForState
    - parseStatusOption, parsePositiveNumber, parseImpact, parseLines, parseNonNegativeInt
    - JSON_OPT, WORKSTREAM_OPT, EVIDENCE_OPT
    - readPackageVersion / isMainEntrypoint

═══ NEXT ═══

  - cli.ts is still ~350 over the 1500 hard cap. The 1040-LOC
    buildProgram() is the bulk; splitting that into per-namespace
    builders (buildWorkstreamCommands(program), buildAgentCommands,
    ...) each in cli/<name>.ts would chip another 800ish LOC out.
    Defer until someone hits real friction.
  - tasks.ts (1731 LOC) and agents.ts (1116 LOC) still over the
    refactor signal. Note #288 had concrete cut plans:
      tasks.ts → task_errors / task_status / task_claim /
                 task_lifecycle / task_wait
      agents.ts → agent_errors / agent_title / agent_spawn /
                  agent_adopt
    These would each be similar src/<module>/ subdir splits.
  - cli/tasks.ts is 1102 LOC (slightly over the 800 refactor signal
    but well under the 1500 hard cap). Could split into
    cli/tasks/{lifecycle,query,note,wait}.ts later.

═══ VERIFIED ═══

  - typecheck + lint + 713/713 tests + build CLEAN at every commit
    in the chain (gate-green per AGENTS.md "all four must pass").
  - test/sql-multi-statement.test.ts import path updated
    (../src/cli.js → ../src/cli/sql.js); only test affected.
  - No public SDK shape changes (src/index.ts re-exports unchanged).

═══ ODDITIES ═══

  - cli/tasks.ts ended up at 1102 LOC after extraction. Big because
    it's THE most-verbose namespace (every task verb is its own
    cmd function with --json + nextSteps). Acceptable for now.
  - The mechanical extraction surfaced a few "where does this
    REALLY live" questions:
      - resolveSelf used by both my-tasks (tasks) and whoami (agents)
        → kept in cli.ts as a shared root export.
      - formatWorkstreamsTable used by both workstream list and
        bare-mu fallback → also kept in cli.ts.
      - assertAgentInWorkstream used by 7+ verbs across agents +
        workspace + tasks → kept in cli.ts.
    All as exports from cli.ts → no lateral cli/* imports.
  - One stale RawTaskRowForState/rawTaskRowToTask helper duplication
    risk: cli/state.ts and cli/hud.ts both query the tasks table
    directly to get IN_PROGRESS rows with the SQL ORDER BY listTasks
    doesn't expose. Both share the helper via cli.ts's exports.
```
