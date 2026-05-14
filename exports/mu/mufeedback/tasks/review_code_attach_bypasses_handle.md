---
id: "review_code_attach_bypasses_handle"
workstream: "mufeedback"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: null
created_at: "2026-05-08T11:31:57.315Z"
updated_at: "2026-05-08T11:51:35.402Z"
blocked_by: []
blocks: []
---

# REVIEW: cmdAttach bypasses handle() and reimplements error mapping

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-08T11:31:57.432Z

```
FILES:
  src/cli.ts:3548-3573 (cmdAttach + its CLI wiring inside the agent.command("attach") block, ~around line 3865)

FINDINGS: cmdAttach is the lone CLI command that opens its own DB AND has its own try/catch/exit dance, instead of going through `handle((db) => ...)` like every other verb. Look at the command wiring:

    .command("attach <name>")
    .action(async function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string };
      try {
        await cmdAttach(name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof AgentNotFoundError) {
          console.error(pc.red(`not found: ${msg}`));
          process.exit(3);
        }
        console.error(pc.red(`error: ${msg}`));
        process.exit(1);
      }
    });

Compare this to every OTHER verb which uses `return handle((db) => cmdX(db, opts))()`. Consequences:
  - mu agent attach does NOT support --json.
  - It does NOT honour errorNextSteps() on typed errors (so AgentNotFoundError, TmuxError, etc. lose their actionable nextSteps).
  - It does NOT classify errors uniformly — only AgentNotFoundError gets exit 3; everything else (including TmuxError which should be exit 5) gets exit 1.
  - It opens its own openDb() inside cmdAttach (cli.ts:3556) and finally-closes it, parallel to handle()'s own db lifecycle.

This is a regression versus the post-6115800 contract that "every CLI verb supports --json". The attach verb is the orphan that wasn't audited.

WHY IT MATTERS: real API hazard — a script that calls `mu agent attach worker-1 --json` gets human prose to stdout (not JSON), no nextSteps on errors, and exit code 1 instead of 5 on tmux failure. The whole "self-documenting output" thread (db... 6115800, 852574b) skipped this verb.

SUGGESTED FIX (~30 LOC):
  1. Refactor cmdAttach to take `(db, name, opts)` like every other cmdX.
  2. Add --json support: emit { agent, scrollback, attachCommand, nextSteps }.
  3. Wire it via `return handle((db) => cmdAttach(db, name, opts))()`.
  4. Add the standard nextSteps for attach: tmux a -t mu-<ws>, send work, etc.
  5. Drop the bespoke try/catch and the AgentNotFoundError special case.

ALTERNATIVES CONSIDERED:
  - "deprecate attach, it's a thin wrapper around tmux a + capture": verb is documented as "trivially useful" in the section header (cli.ts:3198) and shows up in skill examples. Not a deletion candidate today.

EVIDENCE: grep "attach" CHANGELOG.md — verb predates the --json universalisation. git log -p src/cli.ts -- 6115800 | grep -A3 "attach" — the universalisation commit didn't touch cmdAttach. Documented in src/cli.ts:3199 ("not in MVP §'9 verbs' but trivially useful") — its 'trivial' status is exactly why it got missed in the audit.
```
