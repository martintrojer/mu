---
id: "review_code_destroy_freed_workspaces_double_count"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.05
roi: 700.00
owner: "worker-mf-4"
created_at: "2026-05-09T08:34:29.586Z"
updated_at: "2026-05-09T08:55:35.663Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: destroyWorkstream's freedWorkspaces counts already-gone-on-disk as freed

## Notes (1)

### #1 by code-reviewer-1, 2026-05-09T08:34:46.721Z

```
FILES: src/workstream.ts:285-301 (destroyWorkstream's per-workspace loop)

FINDINGS: The freedWorkspaces counter is incremented in two cases:

  if (result.removed) {
    freedWorkspaces += 1;
  } else {
    // Path was already gone (manual rm -rf); count as freed since
    // the user's intent ('not on disk anymore') is satisfied.
    freedWorkspaces += 1;
  }

Both branches do exactly the same thing — `freedWorkspaces += 1` always, regardless of whether removed was true. The if/else is dead control flow. The comment in the else branch is the real signal that a behaviour distinction WAS intended at design time but the implementation never branched.

The destroy CLI then prints `${result.freedWorkspaces}/${summary.workspaces}` (cli/workstream.ts:265). Two different real-world cases that the operator might want to distinguish:
  - "workspace was on disk, we cleanly removed it via the backend"
  - "workspace registry row existed, on-disk dir was already gone (manual rm or interrupted prior run)"
collapse to the same `freed` count today. The destroy never reports the second case.

Distinct from review_test_destroy_failed_workspaces_uncovered (which is about test coverage of failedWorkspaces); this is about the count semantics in the success path.

WHY IT MATTERS: 35. Mostly cosmetic — the existing test coverage doesn't catch it, and operators only see the count. But it's a smell: the if/else with two identical bodies is dead code that future readers will reflexively "fix" by removing the conditional, and at that point the design intent (which the comment narrates) is gone forever.

SUGGESTED FIX (~5 LOC):
Two options:
1. Collapse the dead conditional. Replace 9 lines with `freedWorkspaces += 1;`. Drop the comment entirely. Honest about current behaviour.
2. Actually distinguish: track `cleanlyRemoved` and `alreadyGone` separately. Print "Destroyed ws: ... workspaces=4 (3 freed, 1 already gone)/5". Requires extending DestroyResult; ~15 LOC + a CHANGELOG note.

Recommend option 1 for the day-budget; option 2 if any real operator has asked.

EVIDENCE:
- src/workstream.ts:288-296: explicit if/else with identical body.
- The comment text describes a behaviour distinction that the code doesn't actually make.
```
