---
id: "workstream_init_name_rejected_mu"
workstream: "feedback"
status: CLOSED
impact: 10
effort_days: 0.1
roi: 100.00
owner: null
created_at: "2026-05-10T14:32:02.811Z"
updated_at: "2026-05-10T14:46:21.536Z"
blocked_by: []
blocks: []
---

# workstream init <name> rejected 'mu-feedback' silently (suggested 'feedback')

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T14:32:22.660Z

```
OBSERVED 2026-05-10:
  $ mu workstream init mu-feedback
  -> Next: Try a sanitized name (best guess) : mu workstream init feedback
     List existing workstreams         : mu workstream list

The command returned a Next: block but no clear error/warning explaining WHY mu-feedback was rejected. Skill doc explains in retrospect (every workstream creates tmux session `mu-<name>`, so `mu-mu-feedback` would be confusing/ambiguous), but as a user I had to guess.

UX SUGGESTIONS:
  1. Print an explicit one-line rationale on stderr, e.g.:
       error: workstream names cannot start with "mu-" (the tmux session is auto-prefixed mu-<name>; "mu-foo" would create "mu-mu-foo")
  2. Optionally promote the suggestion in the Next: block to the top so it reads as a fix, not just a hint.

Severity: low. VERIFIED: re-ran with the suggested name and it worked first try.

CROSS-REF: this filing itself triggered nit "mu task note silently fails when given a non-existent id" (separate task).
```

### #2 by "π - mu", 2026-05-10T14:46:21.426Z

```
FILES:
  src/workstream.ts:79-87 (errorNextSteps branched intent)
  test/error-nextsteps.test.ts:163-178 (regression)
  CHANGELOG.md (entry under 0.3.0 § Fixed)
COMMANDS:
  npm run typecheck && npm run lint && npm run test && npm run build
  -> all green; 57 files / 1042 tests pass.
DECISION: minimal change — branch the next-step intent ONLY (rationale
  in the message body and exit code unchanged). For the unambiguous
  mu-prefix case the action label now reads "Retry without the 'mu-'
  prefix" instead of "Try a sanitized name (best guess)". The
  regex/dot/colon branch keeps the hedge because the sanitiser really
  is guessing there.
NEXT:
  - none on this task; siblings tracked separately in feedback ws.
VERIFIED:
  Smoke: `MU_DB_PATH=/tmp/x.db node dist/cli.js workstream init mu-feedback`
  prints:
    error: invalid workstream name "mu-feedback": ...double-prefixed...
    Next:
      Retry without the 'mu-' prefix : mu workstream init feedback
      List existing workstreams      : mu workstream list
  exit 2.
ODDITIES: none. The fix is intentionally cosmetic; the WHY is "agents
  read action lines preferentially over rationale prose, and a hedge
  on the loud line under-sells a known-correct fix".
```
