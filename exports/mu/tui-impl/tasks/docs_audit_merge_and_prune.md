---
id: "docs_audit_merge_and_prune"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: "worker-2"
created_at: "2026-05-13T08:35:34.576Z"
updated_at: "2026-05-13T09:03:32.814Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# DOCS: full audit, merge overlapping pages, prune stale ones

## Notes (4)

### #1 by "π - mu", 2026-05-13T08:36:52.729Z

```
README revision sub-task (part of this audit):

1. Tone down bold "not bloated" / "tiny" / "minimal" claims.
   - The README leans hard on anti-bloat boasting. Cut it back. Let
     the LOC, dep count, and feature list speak for themselves.
   - Specifically: rewrite or delete any sentence whose load-bearing
     verb is "we don't have", "no daemon", "no config file", "no
     codegen", "no DSL" framed as a brag. The ROADMAP anti-feature
     pledges already cover this for contributors; the README should
     focus on what mu DOES, not what it isn't.

2. KEEP the "stay out of the model's way" thesis as the load-bearing
   idea. That one is correct and is the actual differentiator. It can
   stay bold and prominent.
   - Frame: mu doesn't try to be smart on behalf of the model. Tasks,
     workspaces, panes — the model drives, mu just persists state and
     coordinates handoffs.

3. Highlight the TUI prominently — it's the new flagship surface and
   the README currently barely mentions it.
   - Add a screenshot near the top (user will provide). The user has
     a screenshot ready; coordinate before shipping.
   - Brief blurb: `mu` (bare, no args) opens a 9-card dashboard
     covering agents, tracks, ready/in-progress/blocked tasks, recent
     activity, log tail, workspaces, doctor. Drill into any card
     fullscreen; '?' for keymap; read-only (yanks `mu` commands, never
     mutates).
   - Mouse + keyboard. `t` opens tuicr (alt-screen handoff).

4. While doing the audit, check for other docs that talk about the
   TUI as a future thing — it shipped. Update tense.
```

### #2 by "π - mu", 2026-05-13T08:37:43.725Z

```
Screenshot ready: docs/img/tui-dashboard.png (committed to repo).

Use it as the headline image in the README — recommend placing it
right after the one-liner / badges, BEFORE the install section, so
visitors see the dashboard before they read prose.

Suggested markdown:

  ![mu dashboard](docs/img/tui-dashboard.png)

  *`mu` (no args) — read-only dashboard: agents, tracks, ready /
  in-progress / blocked tasks, log tail, workspaces, doctor.*

Don't add lossy compression / thumbnail variants. The PNG is ~1.2MB
which is fine for a single hero image.
```

### #3 by "π - mu", 2026-05-13T08:51:09.486Z

```
TASK: full docs audit — merge overlapping pages, prune stale ones,
revise README.

VERBATIM USER MOTIVATION
> "we need to do a full docs audit and merge/prune docs"
> README: "removing bold statements about 'not being bloated' but
>  keeping the 'staying out of the models way' as a strong load
>  bearing idea. Also we need to highlight the tui."
> Screenshot ready at docs/img/tui-dashboard.png (already committed).

CURRENT STATE
- 8 docs files + 1 SKILL.md, 5142 lines total.
- README.md: 196 lines, leans hard on "no daemon / no config / no
  bloat" framing.
- docs/USAGE_GUIDE.md: 1899 lines (largest doc).
- docs/ARCHITECTURE.md: 519 lines.
- docs/VISION.md: 483 lines.
- docs/ROADMAP.md: 561 lines.
- docs/VOCABULARY.md: 365 lines.
- docs/HANDOVER.md: 461 lines (just added; orchestrator-only).
- docs/test-flakes-audit.md: 68 lines (one-off remediation log).
- skills/mu/SKILL.md: 590 lines (separate task is also touching this:
  skill_md_terseness_pass — DO NOT EDIT SKILL.md in this task to
  avoid conflicts).

WHAT TO DO

PART A — README revision (MUST do, highest priority)

1. Add the dashboard screenshot as the hero image, just after the
   one-liner / badges and BEFORE install:

       ![mu dashboard](docs/img/tui-dashboard.png)

       *`mu` (no args) — read-only dashboard: agents, tracks, ready /
       in-progress / blocked tasks, log tail, workspaces, doctor.*

2. Tone down anti-bloat boasting. Specifically scrub sentences whose
   load-bearing verb is "we don't have / no daemon / no config /
   no codegen / no DSL" framed as a brag. Let the LOC and dep count
   speak for themselves. Don't delete the anti-feature pledges
   themselves — they live in ROADMAP.md and are correct THERE for
   contributors. Just stop boasting about them in the README.

3. KEEP and strengthen the "stay out of the model's way" thesis.
   It is the load-bearing differentiator. Can be bold / prominent.
   Frame: mu doesn't try to be smart on behalf of the model. Tasks,
   workspaces, panes — the model drives, mu just persists state and
   coordinates handoffs. Workers reach for SKILL.md (linked from
   here) when they want the full ground truth.

4. Add a TUI section (not just a passing mention). It's the new
   flagship surface. Cover:
   - 9 cards (list them briefly)
   - Drill into any card fullscreen
   - `?` for keymap, mouse + keyboard
   - Read-only by design — yanks `mu` commands, never mutates
     (exception: `t` for tuicr alt-screen handoff)
   - --tui flag opt-in OR bare `mu` invocation
   Cross-link from the install / quick-start.

5. Audit any tense slip-ups: "the TUI will" / "we plan to add a
   dashboard" / etc — TUI shipped, fix tense.

PART B — Docs audit + merge/prune (next priority)

6. Read all 8 docs files end-to-end. For each, classify:
   - KEEP: still load-bearing, no significant overlap. (e.g.
     ARCHITECTURE.md, VOCABULARY.md, ROADMAP.md, VISION.md,
     HANDOVER.md.)
   - MERGE: substantially overlaps another doc; merge the unique
     content into the host and delete the smaller. Likely candidate:
     docs/test-flakes-audit.md (68 lines, one-off) → fold into
     ARCHITECTURE.md's testing section OR delete entirely if its
     remediation is now done (check the audit doc — if all clusters
     are CLOSED in the task DB, the audit is historical and can go).
   - PRUNE: outdated / stale-by-design content that no longer
     matches the current product. Delete with prejudice, but only
     after grepping the rest of the repo for inbound links and
     fixing them.
   - SPLIT: only if a single doc has genuinely become two
     concerns. Usually the wrong call — prefer merge.

7. USAGE_GUIDE.md is large (1899 lines). DO NOT split it. But scan
   for:
   - Sections that document removed verbs / flags
   - Examples that no longer match current output
   - Tense slips ("we will add" / "in a future version")
   - "What's NOT in 0.1.0" workaround entries that are now shipped
     (the AGENTS.md convention says these get removed when promoted)
   Fix what you find. This pass is targeted, not a rewrite.

8. Cross-link audit: every .md should link to its neighbours where
   relevant. README → SKILL.md, USAGE_GUIDE, ROADMAP, ARCHITECTURE.
   AGENTS.md → already does this; don't disturb.

9. Update CHANGELOG.md under [Unreleased] / Changed and Removed
   subsections describing what shifted.

PART C — Process

10. Make this MULTIPLE small commits, not one big one:
    - Commit 1: `docs: README — TUI hero image + screenshot`
    - Commit 2: `docs: README — drop anti-bloat boasting; sharpen
      "stay out of the model's way" thesis`
    - Commit 3: `docs: README — TUI section`
    - Commit 4 (per-doc): `docs: <FILE.md> — <what changed>`
    - Commit 5 (if applicable): `docs: prune stale test-flakes
      audit (clusters all CLOSED)`
    Each commit four-greens before moving to the next.

WIRING
- Touch: README.md, docs/*.md (except HANDOVER.md — leave it; just
  added; orchestrator-only).
- Do NOT touch: skills/mu/SKILL.md (handled by sibling task
  skill_md_terseness_pass — running in parallel).
- Do NOT touch: src/, test/.

COORDINATION WARNINGS
- Sibling task in flight on worker-3: skill_md_terseness_pass.
  It only touches skills/mu/SKILL.md. Should NOT conflict with this
  task as long as you stay out of skills/.
- The screenshot already exists at docs/img/tui-dashboard.png and
  is committed at sha 0c50384. Don't re-add it.

CONSTRAINTS
- Net LOC change: probably negative (pruning > additions).
- Hard cap: ≤ 200 LOC additions across all docs (excluding deletions).
  README will gain some lines for the TUI section + screenshot —
  that's expected.
- Per-commit four greens:
    npm run typecheck && npm run lint && npm run test:fast && npm run build
  Full `npm run test` once at the end.

OUT OF SCOPE
- Touching SKILL.md (sibling task)
- Touching src/, test/
- Renaming any verb / flag (file a separate task if you spot one)
- Adding a config file (anti-feature) or any new abstraction

DOCS TO UPDATE
- CHANGELOG.md → cumulative entry per commit.

VERIFY MANUALLY
- After README edits: render it (cat README.md | less, or open it in
  your tool of choice) and check the screenshot reference resolves
  and the tone reads right.
- After each doc prune: rg the deleted filename across the repo and
  fix any broken links.

⚠️ FINAL ACTION
When all parts done and four greens pass:

  mu task close docs_audit_merge_and_prune -w tui-impl --evidence \
    "<sha-range>: README revised + N docs audited; <list of merges/prunes>"

If the audit reveals a doc question you can't decide alone (e.g.
should we delete VOCABULARY.md and inline it into AGENTS.md?), DROP
A NOTE describing the question and the tradeoffs, then proceed with
the parts you CAN decide. Don't block on questions that require
user input.
```

### #4 by "worker-2", 2026-05-13T09:03:32.814Z

```
CLOSE: 5b1d5ec..db383ad: README revised + 8 docs audited; test-flakes audit collapsed to historical pointer; stale ARCH/USAGE/VISION/ROADMAP/VOCAB examples refreshed; four-greens + full test pass
```
