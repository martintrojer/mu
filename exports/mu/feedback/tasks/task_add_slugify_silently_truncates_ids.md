---
id: "task_add_slugify_silently_truncates_ids"
workstream: "feedback"
status: CLOSED
impact: 8
effort_days: 0.1
roi: 80.00
owner: null
created_at: "2026-05-10T23:15:08.107Z"
updated_at: "2026-05-11T08:10:03.193Z"
blocked_by: []
blocks: []
---

# task add slugify silently truncates ids; tail -N hides the warning

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T23:15:20.181Z

```
OBSERVED 2026-05-10 in workstream feedback (this very session, multiple times):

REPRO:
  $ mu task add -w feedback --title "task close --evidence does not append the evidence as a final note" --impact 10 --effort-days 0.2
  hint: id 'task_close_evidence_does_not_append_the' truncated from a longer slug; pass <id> positional to override (mu task add <id> --title ... ).
  Added task task_close_evidence_does_not_append_the (id derived from title) (workstream=feedback, impact=10, effort=0.2)

The "hint:" line is informative but easy to miss when piping to `tail -3`/`tail -1` in scripted use, since the ACTUAL id is on the line right after. If I `mu task note <my-guessed-id>` afterwards, it silently fails (correctly returns "no such task") but the orchestrator who wrote the prompt expecting their own slug to win is now confused.

UX SUGGESTIONS:
  1. Print the truncation warning as `error:` if exit code is going to be 0; or print it on stderr explicitly. Currently it's stdout AND looks like info.
  2. Or: emit the warning AFTER the "Added task" line so `tail -N` captures it.
  3. Or: in --json mode, include `truncated: true` and `originalSlug: ...` on the response (already might be there — would need to check).
  4. Skill suggestion: warn orchestrators that auto-derived ids may be truncated; recommend always reading the actual id from `Added task <id>` rather than guessing.

Severity: very low; orchestrator-side prompt hygiene mostly. Caught all by myself this session and the recovery is "read the actual stdout, not just tail".
```

### #2 by "worker-jsonid-1", 2026-05-11T08:09:43.505Z

```
Suggestion #3 from the originating task note shipped: `mu task add --json` now includes top-level `truncated: true` and `originalSlug: "<full slug>"` siblings (NOT inside the `task` object) when auto-id derivation truncated the slug. Both fields are omitted when the operator passed an explicit `<id>` positional, and omitted when auto-derivation did not truncate (singleton-envelope convention from audit_json_envelope_uniformity: only emit optional fields when meaningful). SDK: SlugifyResult and IdFromTitleResult both gained an `originalSlug` field. Test impact: 3 new cases in test/cli-task-add-truncation-hint.test.ts (long auto-derived → truncated:true + originalSlug + prefix-of relation; short auto-derived → fields omitted; explicit <id> + long title → fields omitted). All four green: typecheck, lint, test (1155 pass), build.
```
