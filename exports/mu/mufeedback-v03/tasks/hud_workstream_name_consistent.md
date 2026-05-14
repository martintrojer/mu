---
id: "hud_workstream_name_consistent"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-10T07:15:04.095Z"
updated_at: "2026-05-10T07:52:44.618Z"
blocked_by: []
blocks: []
---

# nit: mu hud — workstream column shows 'mu-X' in first table but bare 'X' in others; pick one

## Notes (2)

### #1 by "π - mu", 2026-05-10T07:15:24.161Z

```
mu hud — workstream name rendered inconsistently across tables.

═══ THE FRICTION (operator screenshot) ═══

  ┌───────────────────┬─────────┬...
  │ mu-roadmap-v0-3   │ 0 ready │...    ← first table: 'mu-X' (tmux session form)
  │ mu-mufeedback-v03 │ 0 ready │...
  └───────────────────┴─────────┴...
  ┌────────────────┬───┬...
  │ mufeedback-v03 │   │...               ← subsequent tables: bare 'X'
  │ roadmap-v0-3   │   │...
  └────────────────┴───┴...

The first table is the workstream-summary header (one row per workstream); subsequent tables (recent events / ready / etc.) get a leading workstream column added by hud_multi_workstream. The first uses the tmux-session form (mu-<name>) because that's what cmdHud's existing single-mode header rendered; the new multi-mode wrapper uses the bare name in the column it adds.

Fix: pick ONE consistent rendering for "workstream name in hud tables". They MUST match.

═══ DECISION ═══

Use the BARE workstream name everywhere in hud output. Reasoning:

1. The bare name is the canonical operator identifier. -w takes the bare name. mu workstream list / state / show all use the bare form. mu agent show, mu task show — bare. The DB stores bare. The tmux session name 'mu-X' is an implementation detail of how mu materializes a workstream into tmux; it shouldn't leak into operator-facing CLI output.

2. The 'mu-' prefix only matters when the operator runs raw tmux (`tmux a -t mu-<X>`); in that one place it's already documented. Everywhere else, bare.

3. Single-mode header today shows 'mu-X' because the original hud was a one-workstream verb and the header subtly doubled as a "tmux session you'd attach" hint. Once multi-mode exists, the column header is sorting/grouping by workstream — bare name only.

═══ DELIVERABLE ═══

1. src/cli/hud.ts: in the workstream-summary header table, render the workstream name as bare (drop the `mu-` prefix). Currently the cell value is constructed via `pc.bold(pc.cyan(`mu-${workstream}`))` (or similar). Change to `pc.bold(pc.cyan(workstream))`.
2. Verify single-mode (N=1) header now also shows bare. Test: `mu hud -w mufeedback-v03 --json` workstreamName field is unchanged (bare); the table-rendered cell now matches.
3. Update existing hud test snapshots / assertions that expected `mu-X` in the header cell.
4. NOTE: the tmux-attach hint in `mu agent attach` and similar verbs is a SEPARATE rendering decision; don't touch those (they correctly use 'mu-X' because they are LITERAL tmux commands).

═══ SCOPE ═══

Tiny: ~5 LOC of code, ~10 LOC of test churn (snapshot updates).

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close hud_workstream_name_consistent -w mufeedback-v03 --evidence 'bare workstream name in both tables; tests updated'
```

### #2 by "reaper", 2026-05-10T07:45:50.969Z

```
[reaper] previous owner worker-2 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```
