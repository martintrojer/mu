---
id: "review_test_json_universal_regex_drift"
workstream: "mufeedback"
status: CLOSED
impact: 65
effort_days: 0.3
roi: 216.67
owner: null
created_at: "2026-05-08T11:22:44.475Z"
updated_at: "2026-05-08T13:06:39.255Z"
blocked_by: []
blocks: []
---

# REVIEW: cli-json-universal regex skips subcommand-group .action() calls silently

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:23:01.608Z

```
FILES: test/cli-json-universal.test.ts:33-50 ; src/cli.ts (every `.command(...)...action(...)` block)
WHAT THE TEST CLAIMS: 'every program.command() in src/cli.ts accepts --json' (file header + it('every verb accepts --json')).
WHAT IT ACTUALLY VERIFIES: a single regex `/\.command\(\s*"([^"]+)"\s*\)([\s\S]*?)\.action\(/g` extracts (verb, body) pairs; each body must contain the literal string `JSON_OPT` or `"--json"`. The sanity assertion is `verbs.length > 20`.
GAP: 1) Verbs whose .option() lives on a subcommand group (e.g. `program.command("task").command("list")...`) are matched as the OUTER name `task` only — the body of `task` may not contain `JSON_OPT` literally even if every leaf `task list/add/show/...` does. The non-greedy `[\s\S]*?` will halt at the FIRST `.action(` it finds, so a parent with no `.action()` is correctly skipped, but a parent that adds `.action(showHelp)` will hide every leaf from the audit. 2) A verb that builds its --json option through a helper named differently (e.g. `withJson(cmd)`) will fail the literal-string check despite being correct. 3) Refactoring `JSON_OPT` to a different identifier silently breaks the audit without breaking the audited behavior.
WHY IT MATTERS: This is meant to be the "drift guard" for v0.2's universal --json invariant. A regex audit on source text is one keystroke away from a false-pass. The test would still pass green if the helper renamed to `JSON_FLAG` while every verb genuinely supports --json — and would also pass if a new leaf verb was nested under a parent that absorbed the regex match.
SUGGESTED FIX: Drive the actual program: `const program = buildProgram(); for each leaf cmd in program.commands (recursing through .commands), assert opts include "json" or the verb name is in ALLOWLIST'. This catches the real invariant ("commander parsed --json") not a textual one. ~15 LOC.
```
