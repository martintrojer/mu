---
id: "agent_orphan_typed_verb_debate"
workstream: "mufeedback"
status: REJECTED
impact: 30
effort_days: 0.2
roi: 150.00
owner: null
created_at: "2026-05-09T05:29:44.532Z"
updated_at: "2026-05-09T05:32:42.803Z"
blocked_by: []
blocks: []
---

# DEBATE: typed verb / view for agent rows whose pane is gone (today: silently auto-pruned 'ghosts')

## Notes (2)

### #1 by π - mu, 2026-05-09T05:30:45.016Z

```
DEBATE: should mu surface "agent rows whose pane is gone" as a first-class concept, or is the current silent-auto-prune via reconcile the right answer?

═══ TERMINOLOGY (load-bearing — fix this BEFORE the design debate) ═══

User asked for "agent orphans = agents without a tmux pane". That phrase collides with mu's existing vocabulary, where the directionality is the OPPOSITE:

  docs/VOCABULARY.md:62  | adopt | The inverse of mu agent list's
                          'orphan' state | (orphan = pane exists, NO DB row)
  src/reconcile.ts:5     | 1. Prune ghost rows whose pane no longer exists
  src/reconcile.ts:7     | 3. Surface orphan panes that look like agents
                          but have no DB row.

Today's two states:
  - **ghost** : DB row exists, pane is gone           → auto-pruned
  - **orphan**: pane exists, NO DB row                → surfaced + adoptable

If we add a verb/view, we MUST NOT call it "agent orphan" — that name is taken. Candidates: agent_ghost / agent_dead / agent_stale / agent_pane_lost. "ghost" is already used in code; reusing it is the smallest delta.

═══ STATUS QUO (what mu does today) ═══

`reconcile()` (src/reconcile.ts) runs on every read-touching verb (mu state, mu agent list, mu hud, etc.) and:
  1. Walks `agents` rows; for each row, calls paneExists(pane_id).
  2. If pane is gone: deleteAgent(name) — the row vanishes silently. Counter `prunedGhosts` is bumped.
  3. The reaper (src/agents.ts) — actually src/reaper.ts — sees the agent's IN_PROGRESS tasks and reverts them to OPEN with a `[reaper]` note.
  4. mu state / mu agent list never SHOWS ghost rows; they're just gone by the time the report renders.
  5. There IS a workaround for "see them before they vanish": pass dryRun:true to reconcile (snap_undo_reconcile_destroys_recovered_agents shipped this exactly so cmdUndo could AVOID pruning). cmdUndo is currently the only consumer.

So the current contract is: ghost rows are an implementation detail. They live for at most one verb-invocation, then disappear. The user-visible signal is the `[reaper]` task note + the `task reap` event in agent_logs.

═══ FOR (the case for promoting it) ═══

1. **Discoverability.** Today there is no way to ask "did any of my agents die?" without grepping `mu log -w X --kind event | grep 'task reap'`. A typed `mu agent ghosts -w X` (or a `Ghost agents (N, will be pruned next reconcile)` section in `mu state` analogous to "Workspace orphans") would be honest about an internal state.

2. **Symmetry with workspace orphans.** v0.1 promoted workspace_orphans to a typed surface specifically because the silent-cleanup was confusing (mufeedback bug_workspace_orphan_not_in_state, closed). The argument applies to agents too: if we surface "on-disk dir without a DB row", we should consider surfacing "DB row without an on-disk pane" — they're the same shape of accidental-state.

3. **Workspace coupling.** When a ghost is pruned, the agent's vcs_workspace row used to cascade-delete with it (until snap_undo_reconcile_destroys_recovered_agents added dryRun). The interaction is subtle; making the ghost state visible would let the operator decide whether to free the workspace before the prune or keep it for forensics.

4. **Snapshot/undo interaction is now load-bearing.** v0.1 shipped mu undo, and the dryRun branch in reconcile exists precisely to NOT-prune during undo. That means mu already has TWO behaviours for ghosts (prune in normal verbs; don't-prune in undo). A typed surface would make this distinction first-class instead of a hidden flag.

5. **5-minute investment.** The substrate is already there: `reconcile(db, ws, { dryRun: true })` returns prunedGhosts count + (if we widen the result type) the names. A new verb `mu agent ghosts -w X` is ~30 LOC + 1 test.

═══ AGAINST (the case for leaving it alone) ═══

1. **No real-user friction filed.** This came out of a "let's add a thing" prompt, not a dogfood-pass note saying "I lost an agent and couldn't find it". The roadmap pledge: ≥2 real hits before promoting. Right now: 0.

2. **The reaper IS the surface.** When a pane dies mid-task, the operator finds out via:
     - The task's status flipping back to OPEN
     - A `[reaper] previous owner X gone` note on the task
     - A `task reap` event in agent_logs
   This is the right surface — task-centric, not agent-centric. The orchestrator's question is "what work is unblocked / needs reassignment?" not "which DB row is stale?"

3. **Auto-prune is the right default.** A ghost row that lingers can:
     - Hold an agents.name FK that blocks a re-spawn with the same name
     - Confuse `mu task claim --for X` (claims succeed against a name with no live pane)
     - Show up in `mu agent list` looking alive
   Surfacing them as "ghosts that you should clean up" would be MORE friction than the current "they're already gone by the time you look".

4. **Anti-feature pledge: no anticipatory abstraction.** The dryRun flag has ONE call site (cmdUndo). Adding a SECOND consumer (mu agent ghosts) would be a defensible promotion, but only if the use case is real. Right now it isn't.

5. **The vocab fight isn't free.** Adding "ghost" to docs/VOCABULARY.md, threading it through SKILL.md ("DOs", "If you ARE the agent"), and making sure operators don't confuse it with the existing "orphan" is real cognitive overhead for an internal-detail concept.

6. **mu state already shows enough.** The "Recent events" tail surfaces `task reap` events; the "In progress" table goes from N to N-1 when an agent dies. The signal exists; it just isn't packaged as "here are your dead agents".

═══ TIE-BREAKERS ═══

- **VISION pillar**: "Be small. Be typed. Ship the smallest thing that works." Argues AGAINST: the smallest thing already works (auto-prune + reaper note).
- **VOCABULARY rule**: "Source of truth for every word." Argues AGAINST adding a new term unless the gap is real.
- **Promotion criterion**: ≥2 real-user hits + fits in <300 LOC + no pillar refactor. Argues AGAINST: 0 hits today.
- **Symmetry argument** (workspace_orphans precedent): genuinely cuts the other way. Workspace orphans was promoted because users tripped on it twice. Agent ghosts haven't tripped anyone yet.

═══ RECOMMENDATION ═══

DEFER. The substrate is there (dryRun reconcile); the vocabulary is correct (ghost ≠ orphan); the auto-prune + reaper-note + task-reap-event covers the operator's actual question ("what work needs reassignment?"). The "see your dead agents" use case is theoretical until two real users hit it.

If/when promotion is justified, the smallest correct shape is:
  - VERB: `mu agent ghosts [-w X]` — runs reconcile in dryRun mode, prints the names + last-seen-pane-id + impacted IN_PROGRESS task count. JSON shape: { ghosts: [{ name, paneId, lastSeenAt, impactedTasks }] }.
  - STATE INTEGRATION: an extra dim line in `mu state` "Ghost agents (N — pruned on next list/state run)" if N > 0, similar to the workspace-orphans line.
  - NO new schema. ghost-ness is a JOIN of `agents` against `paneExists()`, not a stored column.
  - NO change to current auto-prune behaviour. The verb just LETS you peek before the next mutating reconcile.
  - NOT a typed error. Ghost-ness is informational, not an exception.

═══ ACTION ═══

This task's resolution is one of:
  (a) DEFER — close as REJECTED with rationale, file nothing. (Recommendation.)
  (b) DEFER until N=2 — close as DEFERRED, link to this debate for when the second real hit comes in.
  (c) PROMOTE — close this debate task, file `agent_ghosts_verb_impl` (impact ~30, effort ~0.2) with the spec from "RECOMMENDATION" above.

═══ NEXT ═══
Operator decides (a/b/c). This task is deliberately scoped as DEBATE only — no code change. If the operator picks (c), the impl task inherits the spec and verifies against the dryRun substrate added in snap_undo_reconcile_destroys_recovered_agents.
```

### #2 by π - mu, 2026-05-09T05:32:42.702Z

```
RESOLUTION: REJECTED (operator pick: (a)).

Rationale (mirrors the debate AGAINST column):
  - The reaper IS the surface. Operator's real question is task-centric ("what work needs reassignment?"), not agent-centric ("which DB row is stale?"). The existing [reaper] task note + task reap event in agent_logs answers it.
  - Auto-prune is the right default. Lingering ghost rows would block re-spawns under the same name and confuse claim --for.
  - 0 real-user hits today; promotion criterion (≥2) not met.
  - Vocabulary collision risk: "orphan" already means the opposite direction (pane exists, no DB row). If ever promoted later, the verb is mu agent ghosts (matches in-code prunedGhosts term), NOT mu agent orphans.

If a real user trips on this twice, reopen and use the spec in this task's first note (RECOMMENDATION block) as the smallest-correct shape.
```
