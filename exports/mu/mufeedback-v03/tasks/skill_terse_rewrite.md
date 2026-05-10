---
id: "skill_terse_rewrite"
workstream: "mufeedback-v03"
status: CLOSED
impact: 55
effort_days: 0.4
roi: 137.50
owner: "worker-3"
created_at: "2026-05-10T13:52:16.124Z"
updated_at: "2026-05-10T13:59:27.861Z"
blocked_by: []
blocks: []
---

# docs(SKILL): terse rewrite — keep load-bearing operator surface; drop historical artifacts, schema numbers, version-drift bullets

## Notes (1)

### #1 by π - mu, 2026-05-10T13:52:58.517Z

```
Terse rewrite of skills/mu/SKILL.md.

═══ TODAY'S STATE ═══

720 LOC. Has accreted across v0.2 + v0.3 waves. Mixes:
  - Canonical operator surface (verb list, dispatch loop, task-note contract, when-to-reach-for-mu) — KEEP all of this
  - Hard-earned dispatch lessons — KEEP, these earn their keep
  - Historical references (schema numbers, "post-v5", "v0.2 wave"...) — DROP
  - Removal-history bullets ("removed in v0.3", deprecated flag mentions) — DROP (CHANGELOG covers it)
  - Pillar-restating verbose intros — TIGHTEN

═══ WHAT'S LOAD-BEARING (KEEP, possibly tightened) ═══

  - Vocabulary section
  - When-to-reach-for-mu / when-NOT (decision matrix)
  - Mental model (one-workstream-one-tmux, DAG drives coordination, per-agent workspaces, name-by-role, pane border)
  - Orchestrator loop (1-6 steps)
  - Hard-earned dispatch lessons (every bullet hard-won; KEEP all)
  - Parallelisation decision table
  - Default workspace rule
  - Task note contract (FILES/COMMANDS/FINDINGS/DECISION/NEXT/VERIFIED/ODDITIES + the close-with-grounding pattern)
  - CLI verb list (one-liners)
  - Picking model + thinking effort
  - Reaper paragraph
  - Known limitations
  - SQL escape hatch — generic guidance only (NO specific column names; those drift)
  - Common patterns (plan + spawn, parallel heavy + audit, single-quote rule, status-not-truth, after-spawning-observe, sending-followon-work, tear-down-workstream)
  - In-pane (you-are-the-agent) section
  - DOs / DON'Ts
  - What mu is NOT
  - See also

═══ WHAT TO DROP (HISTORICAL / VERSION-DRIFTING) ═══

  - References to schema versions (v5, v6, v7) — operator doesn't need to know
  - References to "post-v5", "post-v0.3", any version-anchored tense
  - Removed-verb mentions ("formerly mu hud", "approve removed", etc) — CHANGELOG is the history
  - Specific column names in mu sql examples (drift fast); replace with "see mu doctor --json | jq .db.schema"
  - "Removed in v0.3" lists at any level
  - Long pillar-restating intros — tighten to one-liners
  - Multi-paragraph build-up before each pattern; one short setup line is enough
  - Cross-references to docs/VERB_AUDIT.md, docs/OUTPUT_LABELS_AUDIT.md (both removed)
  - The lengthy mu sql recipes (recursive CTE, rename example) — keep one short recipe + point at mu sql --help

═══ DELIVERABLE ═══

  Rewrite skills/mu/SKILL.md from 720 → ~400 LOC (rough target).
  Every bullet justifies its line count.
  Every example is current-state-only; no historical context.
  No schema numbers anywhere. No version anchors.
  Verb list stays comprehensive (don't drop verbs to hit the LOC target).
  Hard-earned dispatch lessons stay verbatim or tighter — never drop a lesson.

═══ VERIFICATION ═══

After rewrite:
  - grep "v[0-9]\." skills/mu/SKILL.md → matches only `v1.0` (the conceptual milestone) and 0 schema-version digits
  - grep -iE "(removed|deprecated|formerly|prior|legacy|migration)" → returns 0
  - Every verb in the CLI list still exists in the current --help (run mu --help to compare)
  - Every claim about flag behavior still matches mu <verb> --help
  - Diff vs current SKILL.md: load-bearing dispatch lessons + verb list + task-note contract bytes-identical OR tighter

═══ ANTI-FEATURES ═══

  - DON'T drop verbs from the verb list to hit a LOC target.
  - DON'T drop hard-earned dispatch lessons. Tighter wording OK; deletion not.
  - DON'T add new content beyond the current SKILL's surface.
  - DON'T leave schema numbers, "post-v5", or version-anchored phrasing anywhere.
  - DON'T break in-pane LLM compatibility — every example must run against current main.

═══ FINAL ACTION ═══

⚠️ git commit -am 'docs(SKILL): terse rewrite — drop historical/version drift; keep load-bearing operator surface'
   mu task close skill_terse_rewrite -w mufeedback-v03 --evidence 'SKILL: 720 → ~N LOC; no schema numbers; no version anchors; every verb + dispatch lesson preserved'
```
