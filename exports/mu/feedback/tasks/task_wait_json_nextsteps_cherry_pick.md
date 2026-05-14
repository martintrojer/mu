---
id: "task_wait_json_nextsteps_cherry_pick"
workstream: "feedback"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-11T08:18:34.641Z"
updated_at: "2026-05-11T08:34:21.635Z"
blocked_by: []
blocks: []
---

# task wait --json nextSteps cherry-pick verify command is JS-specific (npm run ...)

## Notes (3)

### #1 by "π - gchatui", 2026-05-11T08:18:54.294Z

```
SEEN: 2026-05-11 in workstream gchatui.

`mu task wait <ids> --any --first --json --on-stall exit` returned a
nextSteps[1] with command:

  npm run typecheck && npm run lint && npm run test && npm run build

This is hardcoded for JS/TS projects. The first nextStep (cherry-pick)
is project-agnostic and useful, but step 2 should either:
  (a) be omitted (let the orchestrator decide how to verify), or
  (b) read a per-workstream "verify" command from config, or
  (c) try to detect the project type (cargo / uv / npm / poetry / make)
      and emit a sensible default, or
  (d) emit a generic placeholder like "<your project's test command>".

For this Python+uv repo I want:
  uv run ruff check . && uv run ruff format --check . && uv run ty check src && uv run pytest

REPRO:
  cd <any non-JS workstream>
  mu task wait <id> --first --json --on-stall exit | jq .nextSteps

PRIORITY: medium. Cosmetic — orchestrators ignore it — but signals
that mu was tested mostly on JS projects.
```

### #2 by "worker-cherrypick-1", 2026-05-11T08:34:13.015Z

```
FILES:
  src/cli/tasks/claim.ts (lines ~405, ~419: replaced hardcoded
    'npm run typecheck && npm run lint && npm run test && npm run build'
    with generic placeholder
    '<your project verify command — e.g. npm run test, cargo test, uv run pytest>'
    in both --first/--any and --all success branches).
  test/cli-task-wait-cross-ws.test.ts (line 144: assertion for the
    nextSteps verify hint changed from
    `command: stringContaining("typecheck")` to
    `intent: stringContaining("Verify")` — same intent string survives
    the option-D rewording, the command no longer contains "typecheck").
COMMANDS:
  npx biome check --write src/cli/tasks/claim.ts (sort + format) → exit 0
  npm run typecheck → exit 0
  npm run lint      → exit 0 (115 files, no fixes)
  npm run test      → exit 0 (1190 passed / 67 files)
  npm run build     → exit 0 (ESM + DTS)
FINDINGS:
  Source had two literal occurrences of the JS-toolchain command string
  (one for cherry-pick verify, one for --all merged-work verify). Both
  are emitted via the typed NextStep[] shape, so they survive into the
  --json output as `nextSteps[i].command`.
  Only one test referenced the literal: a partial substring check on
  "typecheck" in test/cli-task-wait-cross-ws.test.ts. The "intent"
  string ("Verify the cherry-pick" / "Verify the merged work") was
  preserved per the operator instruction, so I switched the assertion
  to match on intent instead — keeps the same test power without
  pinning the placeholder copy.
DECISION:
  Operator picked OPTION D (generic placeholder). Used the suggested
  wording verbatim:
    "<your project verify command — e.g. npm run test, cargo test, uv run pytest>"
  Reads cleanly in JSON; the angle-bracket placeholder makes it
  obvious to a human (and to an LLM orchestrator) that this is a
  template, not a literal command.
NEXT:
  None for this fix. If a future reporter asks for the smarter
  options (auto-detect by manifest file, per-workstream config, etc.)
  that's a separate roadmap entry — option D was deliberately the
  smallest fix that unbreaks the JS-only assumption.
VERIFIED:
  All four gates green:
    typecheck OK, lint OK, test 1190/1190, build OK.
  Spot-checked the new copy is present in src/cli/tasks/claim.ts at
  both call sites.
ODDITIES:
  Only one test asserted on the literal string — I expected more.
  No assertion on the --all branch's verify hint exists at all
  (the changed test covers the cross-ws --all path, which exercises
  the second branch); the --first branch is implicitly covered by
  the same NextStep emission pathway.
```

### #3 by "worker-cherrypick-1", 2026-05-11T08:34:21.635Z

```
CLOSE: all 4 green (typecheck/lint/test 1190 pass/build); nextSteps no longer hardcodes npm — replaced with '<your project verify command — e.g. npm run test, cargo test, uv run pytest>'; commit 72f7ff1
```
