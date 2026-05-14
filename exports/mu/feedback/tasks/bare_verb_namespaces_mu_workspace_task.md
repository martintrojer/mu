---
id: "bare_verb_namespaces_mu_workspace_task"
workstream: "feedback"
status: CLOSED
impact: 12
effort_days: 0.1
roi: 120.00
owner: null
created_at: "2026-05-11T07:30:19.453Z"
updated_at: "2026-05-11T07:54:32.040Z"
blocked_by: []
blocks: []
---

# bare verb-namespaces (mu workspace / task / agent / archive / snapshot) print nothing and exit 0; should default to --help

## Notes (2)

### #1 by "π - mu", 2026-05-11T07:30:28.561Z

```
OBSERVED 2026-05-11 while orchestrating a wave in workstream feedback.

Bare verb-namespaces print nothing and exit 0:

  $ mu workspace
  $ echo $?
  0
  $ mu task
  $ echo $?
  0

Same for: mu agent, mu archive, mu snapshot.

EXPECTED: bare namespace prints `--help` for that namespace (commander does this by default if no default action is set). Useful when typing interactively — currently looks like the verb succeeded silently.

REPRO:
  $ mu workspace
  (no output, exit 0)

FIX: in src/cli.ts (commander wiring), each namespace subcommand should set `.action(() => program.commands.find(c => c.name() === "<ns>")?.help())` or, simpler, use commander `.action(function () { this.help(); })` on the parent so bare invocation prints help.

Or check if `program.showHelpAfterError(true)` / `.showSuggestionAfterError()` covers this.

Severity: low. Cosmetic / discoverability nit. No data loss.
```

### #2 by "worker-help-1", 2026-05-11T07:54:25.826Z

```
FIXED. Bare-namespace invocations (`mu workspace`, `mu task`, `mu agent`, `mu archive`, `mu snapshot`, `mu workstream`) now print the namespaces --help block.

Approach: argv preprocessing in `src/cli.ts` (`injectBareNamespaceHelp`). Detects when argv is exactly one token naming a top-level subcommand whose own `.commands.length > 0`, and appends `--help` before parseAsync. Wired into both the production main-entry AND `test/_runCli.ts` so the test harness exercises the same path.

Why argv preprocessing instead of `.action(function() { this.help(); })` on each namespace: attaching .action() makes commander treat `mu task bogus` as a positional arg to `task` (instead of routing to the unknown-subcommand lane that emitError + cli-validation-uniformity tests depend on). Argv preprocessing is surgical: it only fires when argv has *exactly* one token, so unknown-subcommand routing is unaffected.

Bare `mu` (mission control via cmdState mission=true) is unaffected — it is argv length 2 not 3.

New test: `test/cli-bare-namespace-help.test.ts` (6 cases, one per namespace). Asserts stdout/stderr contains `Usage: mu <ns>`, has a `Commands:` block, has at least one indented entry, and does not exit non-zero.

Validation: typecheck + lint + test (1158 passing, 66 files) + build all green.
```
