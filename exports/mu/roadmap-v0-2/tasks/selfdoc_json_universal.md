---
id: "selfdoc_json_universal"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 70
effort_days: 0.4
roi: 175.00
owner: null
created_at: "2026-05-08T06:40:24.242Z"
updated_at: "2026-05-08 06:41:25"
blocked_by: []
blocks: []
---

# Impl: --json works on every mu verb (write + read)

## Notes (2)

### #1 by null, 2026-05-08T06:40:24.348Z

```
Today --json is on every read verb (mu task list/show/next/ready/blocked/goals/owned-by/search/tree/notes, mu agent list/show, mu workstream list, mu workspace list, mu approve list, mu whoami/my-tasks/my-next, mu state, bare mu) and on FOUR write verbs after selfdoc_infra (mu task add/claim/release/close).

Gap: every other write/lifecycle verb is text-only. Inconsistent surface; agents scripting any of them have to fall back to parsing prose or eating the exit code blind.

Verbs missing --json:
  Tasks:
    - mu task open
    - mu task block
    - mu task unblock
    - mu task delete
    - mu task update
    - mu task reparent
    - mu task note            (returns "note #N appended" — N is useful!)
  Agents:
    - mu agent spawn          (returns pane id, agent row — useful!)
    - mu agent send
    - mu agent read           (already returns text; --json wraps with metadata)
    - mu agent close
    - mu agent free
    - mu agent attach
  Workstream:
    - mu workstream init      (returns session name — useful!)
    - mu workstream destroy   (returns counts in dry-run — VERY useful for scripting)
  Workspace:
    - mu workspace create     (returns the on-disk path — useful!)
    - mu workspace free
    - mu workspace path
  Approvals:
    - mu approve add          (returns the slug — VERY useful! today this is hand-parsed)
    - mu approve grant
    - mu approve deny
    - mu approve wait         (already exits 0/4/5; --json adds the timed-out info, the slug, etc)
  Misc:
    - mu sql                  (table output today; --json yields rows)
    - mu doctor               (structured report, dimensions/checks)
    - mu log (write form)
    - mu adopt                (already has --json; verify shape includes nextSteps)

Convention to commit to (matches selfdoc_infra):
  - Every verb accepts --json.
  - Success: emits one JSON object (or array for collection reads). Includes nextSteps when applicable.
  - Failure: typed error JSON to stderr (already works via emitError).
  - --json output is one line, no trailing newline beyond console.log.
  - Verbs that have no meaningful return value (e.g. mu agent send) emit { changed: bool, ...minimal_context, nextSteps }.
  - Verbs with side-effects on multiple entities (e.g. mu workstream destroy) emit a result summary with counts.

Implementation approach:
  - Pattern is set by selfdoc_infra. Each verb is ~5-10 LOC of opts.json branching.
  - For verbs whose human-output is multi-line tables, the JSON shape is the underlying SDK return value.
  - Tests: roundtrip a few representative verbs (write a small table; emit each shape; assert presence of nextSteps and exit code).

Acceptance:
  - Every program.command() accepts --json (audit via grep).
  - Every cmdXxx with --json emits valid JSON to stdout AND respects --json on errors via the existing emitError handler.
  - selfdoc_skill_cleanup can confidently say "every mu verb supports --json" without footnotes.

Why blocking selfdoc_skill_cleanup: SKILL.md needs to assert "every verb supports --json" once cleanup happens; we can not honestly say that today.

Estimated LOC: ~200 across cli.ts (mostly per-verb threading), no new infra needed.
```

### #2 by null, 2026-05-08T06:41:25.713Z

```
CLOSED as DUPLICATE of selfdoc_verbs_round2. Both touch the same code area (every remaining cmdXxx in src/cli.ts); user agreed (option C) to ship as a single commit.
```
