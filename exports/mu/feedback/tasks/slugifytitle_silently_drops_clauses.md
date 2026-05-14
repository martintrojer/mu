---
id: "slugifytitle_silently_drops_clauses"
workstream: "feedback"
status: CLOSED
impact: 15
effort_days: 0.3
roi: 50.00
owner: null
created_at: "2026-05-10T14:39:13.722Z"
updated_at: "2026-05-10T14:57:49.858Z"
blocked_by: []
blocks: []
---

# slugifyTitle silently drops clauses past 40 chars; truncated id can flip the meaning of a title

## Notes (2)

### #1 by "π - mu", 2026-05-10T14:39:47.662Z

```
OBSERVED 2026-05-10: dogfooded twice in the same session.

REPRO 1 (the task that triggered this filing):
  Title: "task list/show JSON omits localId; only top-level 'name' is exposed"
  Stripped slug (64 chars):
    task_list_show_json_omits_localid_only_top_level_name_is_exposed
  After SLUG_SOFT_CAP=40 word-boundary cut:
    task_list_show_json_omits_localid_only          <-- 38 chars
  Lost clause: "_top_level_name_is_exposed"
  Meaning shift: id now parses as "JSON only omits localId" (i.e. that's
    the only problem). The original was "JSON omits localId; only `name`
    is exposed" (i.e. localId missing AND name is doing double duty).
    Roughly opposite implications for the fix.

REPRO 2 (this task itself):
  Title: "slugifyTitle silently drops clauses past 40 chars; truncated id
          can flip the meaning of a title"
  Slug: slugifytitle_silently_drops_clauses
  Lost clause: "_past_40_chars_truncated_id_can_flip_the_meaning_of_a_title"
  i.e. the id describes only the symptom; the consequence is gone.

WHY IT'S A NIT (not a bug):
  - SLUG_SOFT_CAP exists for good reason (long ids ruin tables).
  - Cut-at-last-`_` is the right algorithm for word-boundary preservation.
  - But: there is no signal to the user that meaning was lost. The
    `Added task <slug>` line treats the truncated slug as canonical.
  - The downstream effect is that filing-agents (and reviewers reading
    `mu task list`) take the truncated slug as a fair summary of the
    title, and proceed to mis-frame the bug. We just watched that happen
    end-to-end while filing the sibling task.

INTERACTION WITH SIBLING NIT (task_list_show_json_omits_localid_only):
  When the agent did `mu task list ... --json | jq '.[0]'`, the JSON
  object returned has `name: "task_list_show_json_omits_localid_only"`.
  The visible identifier in JSON is the truncated slug, which itself
  reads as if `name` is the canonical handle. That nudged the agent's
  fix proposal toward "add `localId` ALONGSIDE `name`" rather than
  something stronger — the JSON it was looking at suggested `name` was
  already doing the job.

FIX OPTIONS (smallest first, all compat-safe):
  A. After truncation, if `slug.length < stripped.length`, print a
     one-line stderr hint on `mu task add`:
       hint: id 'foo_bar' truncated from 64-char slug; pass `<id>`
             positional explicitly to override.
     Zero behaviour change for scripts (stderr hint, exit 0).
  B. Promote the lost-clause case to a strict cut: when the cut drops
     >50% of the stripped slug, prefer a hash-suffix (`foo_bar_a3f1`)
     so two titles that share the first 40 chars don't collide silently.
     Higher risk (changes ids); probably not worth it.
  C. Document the soft cap in `mu task add --help` (currently silent).
     Cheap. Pairs well with A.

LIKELY SMALLEST FIX: A + C. ~20 LOC, no schema, no JSON shape change.

VERIFIED: both repros reproduced in this session; second repro is the
filing of THIS task, which lost ~60% of its title to the cut.
```

### #2 by "worker-3", 2026-05-10T14:57:31.335Z

```
FILES:
  src/tasks.ts (slugifyTitleVerbose + idFromTitleVerbose; slugifyTitle/idFromTitle now thin shims)
  src/cli/tasks/edit.ts (cmdTaskAdd: idFromTitleVerbose + stderr hint when truncated && !json)
  src/cli/tasks/wire.ts (mu task add description mentions ~40-char word-boundary cap + override)
  src/index.ts (re-export slugifyTitleVerbose / idFromTitleVerbose + result types)
  test/tasks-meta.test.ts (4 new slugifyTitleVerbose cases: short/long-cut/giant-word/t_-prefix)
  test/cli-task-add-truncation-hint.test.ts (4 new CLI cases via runCli)
  CHANGELOG.md (new bullet under [0.3.0] § Fixed)
COMMANDS:
  npm run typecheck    -> exit 0
  npm run lint         -> exit 0 (after one biome --write to collapse a 4-line signature)
  npm run test         -> 1049 pass, 1 unrelated flake (cli-task-wait.integration "cross-ws qualified refs" timed out at 30s; passes in isolation in 2.4s, no code touched there)
  npm run build        -> exit 0
  smoke: dogfooded the actual repro title -> stderr hint fires on the long, suppressed on "Build auth" and under --json, suppressed when an explicit <id> is passed
FINDINGS:
  Slugify algorithm itself is unchanged (no hash suffix, no prompt). slugifyTitleVerbose returns
  {slug, strippedLength, truncated}; truncated is true iff trimmed.length < stripped.length AFTER
  the t_ prefix correction, so digit-led-but-short titles do NOT trip the hint.
DECISION:
  Used the `idFromTitleVerbose` SDK helper from cmdTaskAdd directly rather than restructuring
  addTask's TaskRow return shape into an AddTaskResult wrapper. Smaller blast radius (no caller
  ripple, no test churn), same end behaviour the spec asked for: "surface ... so the CLI layer
  can print the hint." When the operator passed an explicit <id> positional, derivation.truncated
  is hard-coded false (they already chose the id by hand; the hint would be noise).
NEXT:
  None observed. Hint is plain text; if a future verb wants the same hint it can call
  idFromTitleVerbose directly. No promotion of options B (hash suffix) — too disruptive.
VERIFIED:
  - test/tasks-meta.test.ts > slugifyTitleVerbose: 4/4 green
  - test/cli-task-add-truncation-hint.test.ts: 4/4 green (covers stderr-hint, short-title-no-hint,
    explicit-id-no-hint, --json-suppression)
  - manual smoke on the dogfooded repro title produced the exact hint shape from the task note.
```
