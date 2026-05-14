---
id: "skill_md_terseness_pass"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: "worker-3"
created_at: "2026-05-13T08:35:35.421Z"
updated_at: "2026-05-13T08:49:25.325Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# DOCS: SKILL.md terseness pass — cut filler, keep signal

## Notes (2)

### #1 by "π - mu", 2026-05-13T08:43:18.360Z

```
TASK: SKILL.md terseness pass — cut filler, keep signal.

VERBATIM USER MOTIVATION
> "another pass making sure SKILL.md is terse and to the point."

CURRENT STATE
- skills/mu/SKILL.md is 590 lines.
- It's the file the LLM running INSIDE an agent pane sees on every
  session start (via the skills system). Every line costs context
  budget across every agent invocation, on every machine using mu.
- Terseness here has compounding payoff: we tighten once, every
  worker on every project everywhere gets cheaper.

WHAT TO DO

1. Read skills/mu/SKILL.md end-to-end first. Do NOT delete content
   blindly. The skill is dense with non-obvious traps that workers
   will get wrong without it.

2. Apply these reductions, in this order:
   a. **Delete pure filler** — sentences that say "this section
      explains X" before X, throat-clearing, "as mentioned above",
      transitional phrases, restated headings.
   b. **Collapse examples** — if three example invocations show the
      same concept, keep one. If a worked example duplicates what
      `mu <verb> --help` says, delete it (the skill already tells
      readers to trust --help).
   c. **Merge redundant warnings** — the same trap (e.g. "claim
      before send") is currently restated in multiple sections.
      Consolidate to one canonical statement plus pointers.
   d. **Convert prose to bullets** where bullets carry the same
      info in fewer tokens. But don't bullet-ize everything —
      narrative works better than bullets for "the wave loop".
   e. **Drop redundant cross-refs** — "see also section X.Y" lines
      where X.Y is the next section.
   f. **Trim the verb table** — many verbs are listed with a one-
      sentence description that just restates the verb name.
      Either add real signal (a gotcha, a default, an interaction)
      or delete the row (the verb is already in `mu --help`).

3. KEEP intact (these earned their lines through real worker
   confusion):
   - The loud "FINAL ACTION" block convention
   - claim-before-send rule
   - workspace-recreate-between-waves rule
   - --on-stall exit in non-interactive flows
   - release vs free distinction
   - cherry-pick: only NEW shas, not the whole worker range
   - The section explaining JSON output shapes
   - Anti-feature pledges (or pointer to ROADMAP.md)
   - The "trust mu --help over this skill" disclaimer

4. **Target: ≤ 400 lines** (from 590). Do NOT pad to hit a number;
   if you cleanly land at 350, ship at 350. If you can only get to
   430 without losing signal, ship at 430 and explain in the
   commit body.

5. Verify nothing critical was lost: skim the final file as if you
   were a worker arriving on a brand-new task. Could you still:
   - Spawn an agent? Send to it? Read it? Close it cleanly?
   - File a task, claim it, drop a note, close it with evidence?
   - Recover from a stalled wait?
   - Avoid the "/" send-keys trap, the bracketed-paste protocol?
   - Know when to use --workspace vs not?
   If any of those is now ambiguous, restore the relevant lines.

WIRING
- Touch only: skills/mu/SKILL.md
- Do NOT touch any other doc, code, or test in this task.

CONSTRAINTS
- LOC change: net negative. Final ≤ 400 lines preferred.
- Commit prefix: `docs:` (single commit).
- Suggested commit message:
    `docs: SKILL.md terseness pass — cut N lines (590 → M)`
- 4-greens: this only changes a markdown file under skills/. Run
  `npm run typecheck && npm run lint && npm run test:fast && npm run build`
  to confirm nothing accidentally broke. Full `npm run test` is
  optional for a docs-only change but cheap to run; do it.

OUT OF SCOPE
- Renaming verbs, changing CLI surface, editing src/, editing tests.
- Restructuring the skill into multiple files.
- Adding new content (this is a pruning pass).
- Touching the README or other docs.

DOCS TO UPDATE
- CHANGELOG.md → under [Unreleased] / Changed:
    "skills/mu/SKILL.md tightened: cut N filler lines, preserved
    all real worker-trap warnings."

BUNDLE CYCLE WARNING
- Not relevant for a docs-only change, but reflex check: do not
  introduce any import cycles. (You aren't touching code, so this
  is N/A; mentioned for completeness.)

⚠️ FINAL ACTION
When done and four greens pass:

  mu task close skill_md_terseness_pass -w tui-impl --evidence \
    "<sha>: SKILL.md 590 → <new-line-count> lines; <one-line summary of what was cut>"

If you genuinely cannot reduce below ~500 without losing signal,
DO NOT close — drop a note explaining what you tried and what
blocked further reduction, then ask for guidance.
```

### #2 by "worker-3", 2026-05-13T08:49:25.325Z

```
CLOSE: 823e289: SKILL.md 590 → 356 lines; cut filler, duplicate examples/warnings, and low-signal verb prose while preserving worker-trap guidance
```
