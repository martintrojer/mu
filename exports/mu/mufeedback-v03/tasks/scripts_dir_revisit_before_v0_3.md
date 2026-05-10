---
id: "scripts_dir_revisit_before_v0_3"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: null
created_at: "2026-05-09T17:09:23.543Z"
updated_at: "2026-05-10T12:30:33.171Z"
blocked_by: []
blocks: ["remove_scripts_dir"]
---

# revisit before v0.3 release: prune scripts/ to active guards only (drop grep-v4-references; reconsider grep-name-without-workstream)

## Notes (1)

### #1 by π - mu, 2026-05-09T17:09:48.119Z

```
SURFACED post-v0.2: scripts/ holds 4 files, all active CI guards wired into `npm run lint`. Operator flagged for cleanup; orchestrator pushed back (the guards are doing real work). PARK the decision until the v0.3 release boundary; revisit then with a clearer view of how much they're catching.

═══ CURRENT CONTENTS ═══

  scripts/grep-name-without-workstream.sh + .allowlist  (250 + 78 LOC)
    Guards: bug_v5_name_clash_silent_misroute regression. Greps src/ for
    bare `WHERE local_id = ?` / `WHERE name = ?` / `WHERE slug = ?`
    SELECTs that aren't accompanied by a workstream filter.
    
  scripts/grep-v4-references.sh + .allowlist  (92 + 36 LOC)
    Guards: v5_prune_v4_fallback_branches regression. Greps src/ for
    "v4" / "backward-compat" mentions.

Both wired into:
  package.json:51 lint = biome + grep-name + grep-v4
  package.json:52 lint:guards = grep-name + grep-v4

═══ REVISIT QUESTIONS (at v0.3 release time) ═══

Q1. Has grep-v4-references caught anything since shipping?
  Check git log for any commit that triggered it post-shipping. If zero
  hits in N months: candidate to remove (its job is done; v5 is the only
  schema; no migration code can re-introduce v4 references).

Q2. Has grep-name-without-workstream caught anything since shipping?
  Same check. This guard is more load-bearing (the underlying invariant
  is permanent), but if zero hits + the type system is enforcing the
  shape adequately (signatures take workstream context), the runtime
  grep is belt-and-suspenders.

Q3. If both guards are removed, what's the smaller surface?
  Lint becomes biome-only. Faster CI; less mental overhead. The
  invariant moves from CI grep to "type signature reviewer".

Q4. If only one guard is kept (the v5-name one), where does it live?
  scripts/ is the right home for shell-based one-off-style guards.
  Moving to a TS test (test/_guards/no-unscoped-name-lookup.test.ts)
  would be more idiomatic but doubles the test runtime.

═══ RECOMMENDATION (provisional) ═══

At v0.3 release boundary:
  - Definitely remove grep-v4-references.{sh,allowlist} (~130 LOC).
    v4 is gone; the guard's job is over.
  - Keep grep-name-without-workstream.{sh,allowlist} unless evidence
    shows it has zero hits + type system catches the regression cleanly.
    Per-workstream uniqueness is a load-bearing v5 invariant; CI is the
    cheapest belt.
  - Consider moving grep-name guard into a TS test if its allowlist
    grows past a small fixed size (today: 78 LOC, manageable).

Estimated v0.3 cleanup commit: ~ -130 LOC + a CHANGELOG entry under Removed.

═══ ANTI-FEATURE GUARDRAIL ═══

  - Don't remove a guard "because it hasn't fired" without checking what
    landed since. A silent guard either means it's working or it's
    irrelevant; gather data first.
  - Don't add new shell guards if the same invariant can be enforced via
    types or biome rules.

═══ DECISION DEFERRED TO ═══

v0.3 release process. Re-claim this task when cutting the v0.3 release notes.
```
