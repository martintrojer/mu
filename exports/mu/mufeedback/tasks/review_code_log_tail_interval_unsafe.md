---
id: "review_code_log_tail_interval_unsafe"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-08T11:34:40.673Z"
updated_at: "2026-05-08T11:46:38.839Z"
blocked_by: []
blocks: []
---

# REVIEW: MU_LOG_TAIL_INTERVAL_MS=NaN/0/negative produces silent infinite-CPU loop

## Notes (1)

### #1 by "code-reviewer-1", 2026-05-08T11:34:40.789Z

```
FILES:
  src/cli.ts:2391 (the parse + use)

FINDINGS:

  const intervalMs = Number(process.env.MU_LOG_TAIL_INTERVAL_MS ?? 1000);

`Number("")` is 0; `Number("abc")` is NaN. Both flow into `setTimeout(r, intervalMs)`. Node's setTimeout treats NaN as 1ms (per HTML spec) and 0 as 1ms too — so a typo'd env var (`MU_LOG_TAIL_INTERVAL_MS=foo`) silently turns `mu log --tail` into a tight CPU-burning loop hitting the DB once per ms. Compare to other env-var parsers in the codebase that defend with NaN-checks:

  src/agents.ts defaultSpawnLivenessMs: validates parseInt + Number.isNaN + < 0
  src/tmux.ts  defaultSendDelayMs:      same pattern

WHY IT MATTERS: real DOS-by-typo. A user who sets MU_LOG_TAIL_INTERVAL_MS=2 (intending 2 seconds, getting 2ms) or MU_LOG_TAIL_INTERVAL_MS=2s (getting NaN = 1ms) will silently hammer SQLite at ~500 hz. Same shape as the env-var parsers that have already defended against this in spawn / send delays.

SUGGESTED FIX (~5 LOC): mirror defaultSpawnLivenessMs's pattern.

  function defaultLogTailIntervalMs(): number {
    const raw = process.env.MU_LOG_TAIL_INTERVAL_MS;
    if (raw === undefined) return 1000;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 50) return 1000;  // 50ms floor
    return parsed;
  }

A floor (50ms?) prevents the user from setting it lower than is reasonable to begin with.

ALTERNATIVES CONSIDERED:
  - "leave it; users will notice the burn": users won't if the burn doesn't show up on their dev box but does in CI. Defend at the parse site.

EVIDENCE: src/agents.ts:691-696 + src/tmux.ts:107-114 already follow the safe pattern; cmdLogTail diverges. One-line difference, one-line fix.
```
