---
id: "mu_adopt_should_be_mu_agent_adopt_for"
workstream: "feedback"
status: CLOSED
impact: 8
effort_days: 0.2
roi: 40.00
owner: null
created_at: "2026-05-11T07:39:59.436Z"
updated_at: "2026-05-11T08:21:45.218Z"
blocked_by: []
blocks: []
---

# mu adopt should be mu agent adopt for consistency with the agent-namespace verb cluster

## Notes (3)

### #1 by "π - mu", 2026-05-11T07:40:15.996Z

```
OBSERVED 2026-05-11 while scanning the verb surface.

CURRENT: `mu adopt <pane-or-title>` lives at the TOP level of the CLI, alongside `mu workstream`, `mu task`, `mu agent`, `mu workspace`, `mu archive`, `mu snapshot`, `mu state`, `mu sql`, `mu doctor`, `mu undo`, `mu log`.

EVERY other agent-lifecycle verb is under the `mu agent` namespace:
  mu agent spawn / send / read / show / list / close / free

`mu adopt` is conceptually `agent.adopt` (it registers an existing tmux pane as a managed agent — the inverse of `mu agent close`). It belongs under `mu agent adopt`.

REPRO:
  $ mu agent adopt --help
  (does not exist)
  $ mu adopt --help
  Usage: mu adopt [options] <pane-or-title>
  Register an existing tmux pane as a managed mu agent ...

WHY IT MATTERS:
  - Discoverability: an operator typing `mu agent <TAB>` (commander-completions) or scanning `mu agent --help` does not see adopt. The smaller namespace surface area `mu agent` should give already lists every other lifecycle verb; adopt is the odd one out.
  - Consistency: the codebase guideline AGENTS.md "src/cli/agents.ts" already groups adopt with the rest (look at `src/agents/adopt.ts` in the agents/ cluster — it sits next to spawn.ts and errors.ts). The CLI wiring just doesnt reflect the SDK layout.
  - The skill (skills/mu/SKILL.md line 263) and USAGE_GUIDE.md (line 564) document `mu adopt` as top-level. Renaming requires touching those too.

FIX OPTIONS:
  1. Add `mu agent adopt` as the canonical form. Keep `mu adopt` as a deprecated alias for one minor version. Update docs + skill + tests + nextSteps hints. ~30-line CLI patch + docs + tests.
  2. Hard-rename: drop `mu adopt`, only `mu agent adopt`. Cleaner, but breaks any operator muscle memory or external automation. Per AGENTS.md "anti-feature pledges" minimalism, this might be preferred (no aliases) — operator decision.

OUT OF SCOPE: every other top-level verb (state, sql, doctor, undo, log) is correctly top-level (cross-cutting / orchestration). Only adopt is misplaced.

Severity: low. Cosmetic / discoverability. No data loss, no functional bug. Cheap fix.
```

### #2 by "worker-rename-1", 2026-05-11T08:21:37.742Z

```
DONE: wired `mu agent adopt` as canonical inside wireAgentCommands (src/cli/agents.ts); kept top-level `mu adopt` as a deprecated alias that prints a one-line stderr hint (suppressed under --json) and self-describes as such in --help. Both routes call the same cmdAdopt handler — no duplication. Updated next-step hints (ClaimerNotRegisteredError, mu agent list orphan footer, mu undo reconcile note) and docs (USAGE_GUIDE.md ×4 sites, SKILL.md ×3 sites, VOCABULARY.md row, CHANGELOG.md Unreleased/Changed). Sister test surfaces in error-nextsteps.test.ts + tasks-lifecycle.test.ts updated to match. New test/cli-adopt-deprecation.test.ts (6 cases) covers: legacy form still works + emits hint to stderr-not-stdout; legacy --json suppresses hint; canonical form works + no hint; canonical --json envelope shape; legacy --help reads as deprecated alias; canonical --help carries the canonical description. typecheck/lint/test (1175 pass)/build all green.
```

### #3 by "worker-rename-1", 2026-05-11T08:21:45.218Z

```
CLOSE: all 4 green (typecheck + lint + 1175/1175 tests + build); both forms work (verified with node dist/cli.js adopt --help and node dist/cli.js agent adopt --help); deprecation hint on stderr (suppressed under --json); commit 999f195
```
