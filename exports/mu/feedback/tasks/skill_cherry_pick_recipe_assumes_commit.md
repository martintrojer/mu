---
id: "skill_cherry_pick_recipe_assumes_commit"
workstream: "feedback"
status: CLOSED
impact: 12
effort_days: 0.2
roi: 60.00
owner: null
created_at: "2026-05-11T07:16:36.676Z"
updated_at: "2026-05-11T07:31:58.119Z"
blocked_by: []
blocks: []
---

# skill cherry-pick recipe assumes commit subject starts with task-id; workers don't

## Notes (2)

### #1 by "π - infer-rs", 2026-05-11T07:16:57.327Z

```
OBSERVED 2026-05-10 while orchestrating workstream infer-rs.

The skill's "Pipeline cherry-pick" recipe (under Common Patterns) is:

  res=$(mu task wait t1 t2 t3 -w ws --any --first --json --timeout 600 --on-stall exit)
  firing=$(jq -r .firing.qualifiedId <<<"$res")
  sha=$(mu workspace commits $worker -w ws --json \
          | jq -r --arg id "${firing#*/}" \
              '.items[] | select(.subject | startswith($id+":")) | .sha' | head -1)
  git cherry-pick $sha && cargo test --lib

The recipe assumes worker commit subjects START with `<task-id>:`. None of my 13 cherry-picks this session used that convention — workers wrote descriptive subjects like:

  "pulse: structural canonical formula keys (no String alloc on hot path)"
  "Pulse: model $builtins.hack_get_static_class for $static-class dispatch"
  "textual: O(1) offset_to_loc via line-start table"
  "Drop stale plusBad/plusOk skips from test_e2e_virt"

The `startswith($id+":")` filter would return no SHA on any of them. The recipe silently produces no cherry-pick (sha empty), then `git cherry-pick` fails with "fatal: empty commit set passed".

OPTIONS:
  1. Skill update: change the recipe to grab the worker's most recent commit unconditionally (which is what I did manually all session). The risk is the worker may have other unrelated commits — but workers in fresh workspaces do not, and that's the recommended pattern. Use:
       sha=$(mu workspace commits $worker -w ws --json | jq -r '.items[0].sha')
  2. Worker prompt convention: add to the FINAL ACTION block "git commit -am '<task-id>: <message>'" so subjects do start with task-id. This is doable and improves searchability later, but workers find it awkward (the task-id is often long: perf_replace_string_canonical_heap_attrs_stack), and humans cherry-picking later find the subject prefixes ugly.
  3. mu side: add `mu workspace tip <agent>` that just prints the most recent commit's SHA (or N) for direct piping. Or `mu task wait --first --pick-tip-of <agent>` that combines the wait and the SHA print.

CONTEXT: I had to use `cd $(mu workspace path X) && git log -1 --format=%H` for every cherry-pick this session. Worked but not what the skill recommends.

Severity: low-medium. Recipe-as-written is broken without subject-prefix discipline; recipe-as-actually-used (HEAD of workspace) works. Either update the skill or update the prompt convention.
```

### #2 by "worker-skill-1", 2026-05-11T07:31:52.216Z

```
FILES: skills/mu/SKILL.md (lines ~361-372 in the "Pipeline cherry-pick" recipe)

COMMANDS:
  grep -n "startswith\|cherry-pick\|subject\|task-id" skills/mu/SKILL.md
  npm run lint   # blocked: npm registry 503, but lint target is `src test/` (TS only); markdown edit is out-of-scope by design

FINDINGS:
- The only broken-assumption site is the Pipeline cherry-pick recipe (lines 361-368). No other place in SKILL.md filters by subject prefix or assumes a `<task-id>:` convention.
- Hits for "subject" elsewhere: only line 274, which describes `mu workspace commits`'s output format ("<sha> <subject>") — neutral.
- Hits for "task-id" elsewhere: only line 506 ("Don't use the `mu_` task-id prefix" — about reserved IDs, unrelated).
- The rule of thumb above the recipe (lines 155-170) already says one wait → one cherry-pick → one verify, and uses `firing.qualifiedId` only to print/log — no SHA filtering. Safe.
- Confirmed via src/cli/tasks/claim.ts that `firing.owner` is part of the JSON shape, so `jq -r .firing.owner` is the right extractor for the worker name.

DECISION: Implemented OPTION 1 (skill update). Replaced the SHA-extraction block with `sha=$(mu workspace commits $worker -w ws --json | jq -r '.items[0].sha')`. Also derive `$worker` from `.firing.owner` (previously the recipe used an undefined `$worker`). Added a 4-line comment explaining WHY (fresh single-purpose workspaces → HEAD is the task's commit; subject filter silently produces empty → cherry-pick fails with "empty commit set").

NEXT: none. Single-file doc fix.

VERIFIED:
- `git diff` shows only the intended ~6-line replacement inside the recipe block.
- No other SKILL.md sites match the broken pattern (audited via grep above).
- Lint not runnable here (npm registry 503), but lint scope = `src test/` so markdown edit is by definition a no-op for it.

ODDITIES:
- npm registry returning 503 for semver-7.8.0.tgz at audit time; not relevant to a docs-only commit but worth flagging if other workers hit the same.
- The previous recipe referenced an unbound `$worker` var. The new version derives it from `.firing.owner`, which is the documented JSON field per src/cli/tasks/claim.ts:457.
```
