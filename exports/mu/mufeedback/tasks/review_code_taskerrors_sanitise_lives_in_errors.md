---
id: "review_code_taskerrors_sanitise_lives_in_errors"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-09T08:35:05.120Z"
updated_at: "2026-05-09T09:04:30.082Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: sanitiseTaskId lives in tasks/errors.ts but is a slug helper, not an error helper

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-09T08:35:25.449Z

```
FILES: src/tasks/errors.ts:36-58 (sanitiseTaskId), src/tasks.ts:163-235 (slugifyTitle / idFromTitle)

FINDINGS: sanitiseTaskId is a 23-line slug helper that lives in src/tasks/errors.ts. Its only caller is TaskIdInvalidError.errorNextSteps() (line 73), which uses it to suggest a sanitised id. The function itself isn't an error class, an error type, or part of any error contract — it's a pure string-mangler.

Meanwhile slugifyTitle in src/tasks.ts:198-228 does very nearly the same thing:
- Both lowercase the input.
- Both replace non-allowed chars with `_`.
- Both prefix `t_` if the result starts with non-letter or with `mu_`.
- Both apply hard caps (sanitise: 64; slugify: SLUG_HARD_CAP = 64).

The differences:
- slugifyTitle throws on empty input; sanitiseTaskId returns "task" as a default.
- slugifyTitle does a soft-cap word-boundary trim at SLUG_SOFT_CAP=40; sanitiseTaskId hard-truncates at 64.
- slugifyTitle is called by idFromTitle (the auto-id-from-title pipeline); sanitiseTaskId is only the error-message hint.

Per the skill: "Copy-pasted logic with small variations" — and the two could share a private helper. The home for sanitise should be src/tasks.ts (next to slugifyTitle), not src/tasks/errors.ts.

This is also a layering smell: src/tasks/errors.ts now imports nothing from "../tasks.js" but exports a helper that conceptually IS a task helper. Future bug: a third copy will land somewhere because nobody finds this one.

WHY IT MATTERS: 25. Smell, not a bug. Layering hygiene + future-drift risk. The sanitise function is a fine piece of code; it's just in the wrong file.

SUGGESTED FIX (~10 LOC):
1. Move sanitiseTaskId from src/tasks/errors.ts to src/tasks.ts (export it alongside slugifyTitle).
2. Have TaskIdInvalidError import sanitiseTaskId from "../tasks.js" (single-direction; errors.ts already has zero deps on tasks.ts so this is the first cross-edge — but it's the right direction since errors.ts depends on the domain, not vice versa).
3. Optionally factor the shared core (lowercase + non-alnum-replace + first-char-fix + reserved-prefix-fix) into a private helper used by both.

ALTERNATIVES CONSIDERED:
- Inline sanitiseTaskId into errorNextSteps. Costs error-class size; the function is genuinely worth its 5-line callable shape.
- Leave as-is and add a comment that sanitiseTaskId is "the error variant" of slugifyTitle. Doesn't address layering; just papers over.

EVIDENCE:
- src/tasks/errors.ts:36-58 (sanitiseTaskId definition) → only callsite at line 73 inside the same file.
- src/tasks.ts:198-228 (slugifyTitle definition) → near-identical lowercase/replace/prefix logic.
- Cross-edge: errors.ts imports HasNextSteps + NextStep from "../output.js" only.
```
