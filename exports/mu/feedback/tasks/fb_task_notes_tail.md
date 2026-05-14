---
id: "fb_task_notes_tail"
workstream: "feedback"
status: CLOSED
impact: 30
effort_days: 0.2
roi: 150.00
owner: null
created_at: "2026-05-11T08:18:43.305Z"
updated_at: "2026-05-11T08:41:05.643Z"
blocked_by: []
blocks: []
---

# task notes --tail N to skim recent notes when spec is long

## Notes (3)

### #1 by "π - gchatui", 2026-05-11T08:19:26.839Z

```
SEEN: 2026-05-11 in workstream gchatui.

`mu task notes <id> -w <ws>` dumps every note ever attached to the
task, including the multi-screen pre-task SPEC I drop before
dispatching. To check "what did the worker actually report at
close?" I have to scroll through the spec.

DESIRED: `mu task notes <id> --tail N` (or `--last N`) that prints
just the last N notes. Pairs well with `--json` for scripting.

Bonus: `--since <iso8601>` to print only notes after a timestamp
(e.g. since the task was claimed). The claim event timestamp is
already in the events table; --since-claim would be sweet.

PRIORITY: low. Nice-to-have for orchestrator UX on long tasks.
```

### #2 by "worker-notestail-1", 2026-05-11T08:40:49.055Z

```
FILES:
  - src/logs.ts                            (+30 LOC: lastClaimEventAt helper for --since-claim)
  - src/tasks.ts                           (+~55 LOC: ListNotesOptions interface, listNotes 4th-arg)
  - src/cli/tasks/edit.ts                  (+~50 LOC: cmdTaskNotes validation + filter wiring)
  - src/cli/tasks/wire.ts                  (+~30 LOC: --tail/--last/--since/--since-claim options)
  - src/index.ts                           (+1 LOC: ListNotesOptions re-export)
  - test/cli-task-notes-filters.test.ts    (NEW, 14 tests, ~280 LOC)
  - docs/USAGE_GUIDE.md, docs/VOCABULARY.md, skills/mu/SKILL.md, CHANGELOG.md updated
COMMANDS:
  - npm run typecheck                       exit 0
  - npm run lint                            exit 0 (biome 116 files clean)
  - npm run test                            exit 0 (1204 tests pass; 14 new in cli-task-notes-filters)
  - npm run build                           exit 0
FINDINGS:
  - The SDK already had lastClaimActor (LIKE-with-escape pattern on agent_logs);
    lastClaimEventAt is a sibling that returns created_at instead of the actor.
  - listNotes(db, id, ws) is called from cmdTaskShow, exporting.ts, agents.test.ts.
    Adding optional 4th opts arg with all-undefined default preserves every caller.
  - Commander's parsePositiveNumber is float-permissive; cmdTaskNotes adds
    Number.isInteger check on top so --tail 1.5 also errors usage.
  - listNotes filter contract: opts.since (explicit) wins over sinceClaim at SDK
    layer (defensive). The CLI throws UsageError on --since + --since-claim before
    reaching the SDK so the user gets feedback at the surface they typed at.
DECISION:
  - --tail composes with --since/--since-claim; --since and --since-claim are
    mutually exclusive (both define a cutoff). Mirrors the spec verbatim.
  - --last is a thin alias for --tail (the feedback note suggested either name).
    If both supplied, --tail wins; merging happens in wire.ts (CLI concern).
  - When --since-claim resolves to no claim event in agent_logs, degrade to no
    filter (equivalent to --since-beginning) so the verb stays useful on
    un-claimed tasks. Spec called for this.
  - SQL: --since uses lexicographic > on ISO strings (matches the rest of the
    codebase); applied at query time. --tail is applied in JS (slice(-N)) after
    rows return — keeps the SQL one prepared statement vs N permutations.
  - --json keeps the {items, count} envelope per audit_json_envelope_uniformity.
NEXT:
  - None for this task. Future: --since-event <kind> generalised cutoff.
VERIFIED:
  - 14 new tests cover: --tail 1 / --tail 99 / --last alias / --tail 0 (exit 2)
    / --tail -1 (exit 2) / --since past / --since future / --since malformed
    (exit 2) / --since-claim with claim / --since-claim without claim / mutex
    (exit 2) / --json envelope shape / default unchanged / --tail composes
    with --since.
  - npm run typecheck && npm run lint && npm run test && npm run build all green.
ODDITIES:
  - Test seeds use 5ms sleeps between addNote calls because SQLite created_at is
    ms-precision and the filter is strict `>`; rapid inserts can land in the
    same ms and break ordering. Worth noting if anyone later tries to remove the
    sleeps.
```

### #3 by "worker-notestail-1", 2026-05-11T08:41:05.643Z

```
CLOSE: all 4 green; three new filters (--tail/--since/--since-claim) + 14 new tests; commit 5ecd7e4
```
