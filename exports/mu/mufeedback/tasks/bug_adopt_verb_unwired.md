---
id: "bug_adopt_verb_unwired"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-09T11:11:43.174Z"
updated_at: "2026-05-09T11:30:09.627Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# BUG: `mu adopt` is dead code — cmdAdopt exported, no wireXxx registers it

## Notes (1)

### #1 by worker-mf-1, 2026-05-09T11:11:43.284Z

```
Surfaced incidentally during the verb audit (audit_verbs_typed_vs_sql). NOT a typed-vs-sql finding — a regression introduced during the wireXxxCommands refactor (commit f42e86d, 2026-05-08).

REPRO:
  $ node dist/cli.js adopt %15
  error: too many arguments. Expected 0 arguments but got 2.

Yet:
  $ grep -n "cmdAdopt\|adopt" src/cli/agents.ts | head
  346:export async function cmdAdopt(db: Db, paneOrTitle: string, opts: AdoptCliOpts): Promise<void> {
  ...
  $ grep -rnE "command\(.adopt" src/   # nothing

SDK function `adoptAgent` is still re-exported from src/index.ts (line 11). The CLI wrapper `cmdAdopt` (src/cli/agents.ts:346) is implemented and tested via test/verbs.test.ts. The verb is documented in docs/USAGE_GUIDE.md (line 365), referenced by skills/mu/SKILL.md (line 214), and advertised by `mu agent list` orphan-output (src/cli/agents.ts:203) and `mu undo`s scrollback hint.

ROOT CAUSE: The pre-refactor src/cli.ts had `.command("adopt <pane-or-title>")` registering it (verified via `git show e20af89^:src/cli.ts | grep adopt`). The refactor (f42e86d) extracted wireAgentCommands but only wired the `agent <verb>` subcommands; `adopt` was a TOP-LEVEL verb (matching its design — see commit e20af89 message "matching design; not `mu agent adopt`") and got dropped on the floor.

FIX (small): add a `wireAdoptCommand(program)` (or fold into wireSelfCommands) that registers:

  program
    .command("adopt <pane-or-title>")
    .description("Adopt an existing tmux pane as a managed agent")
    .option("--name <name>", "agent name (defaults to pane title)")
    .option("--cli <cli>", "agent CLI key", "pi")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (paneOrTitle: string) {
      const opts = (this as Command).opts() as AdoptCliOpts;
      return handle((db) => cmdAdopt(db, paneOrTitle, opts))();
    });

…and call it from buildProgram(). Also add an integration test that asserts `node dist/cli.js adopt --help` returns a help screen, not a top-level error.

GATE: typecheck + lint + test + build. CHANGELOG entry under Fixed.

EFFORT: ~1h (the cmd is implemented; this is wiring + a regression test + docs no-change).

PRIORITY: high impact (every doc + every skill mention is a broken promise; the orphan-list message advertises a verb that errors). Low effort. ROI ~300.
```
