---
id: "remove_scripts_dir"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-10T12:30:03.962Z"
updated_at: "2026-05-10T12:34:05.269Z"
blocked_by: ["scripts_dir_revisit_before_v0_3"]
blocks: []
---

# REMOVE: scripts/ folder — drop CI grep guards (v4-references job done; name-without-workstream covered by v5 surrogate-id pattern)

## Notes (1)

### #1 by π - mu, 2026-05-10T12:30:24.924Z

```
REMOVE: scripts/ folder.

═══ THE DECISION (operator) ═══

Drop scripts/ entirely. The two CI grep guards live there:
  - grep-v4-references.sh: guards against v4 mentions sneaking back into src/. v4 is GONE; the migrator was deleted post-landing; any remaining v4 references are intentional historical (changelog). Job done.
  - grep-name-without-workstream.sh: guards bug_v5_name_clash_silent_misroute. The v5 surrogate-id pattern (every entity table has INTEGER id; per-workstream UNIQUE on name) makes the underlying invariant load-bearing at the SCHEMA level. The grep is belt-and-suspenders.

Per scripts_dir_revisit_before_v0_3 (the parent task, just opened): both guards' intended purpose is structurally satisfied. Time to remove.

═══ DELIVERABLE ═══

1. Delete: scripts/grep-v4-references.{sh,allowlist} + scripts/grep-name-without-workstream.{sh,allowlist} (4 files; ~250+78+92+36 LOC removed).
2. Delete: scripts/ directory itself (now empty).
3. package.json:
   - 'lint' currently is 'biome check src test && bash scripts/grep-name-without-workstream.sh && bash scripts/grep-v4-references.sh'. Strip the &&-chain to just 'biome check src test'.
   - 'lint:guards' (if defined) is removed entirely.
4. AGENTS.md: remove any mention of scripts/ / lint:guards / 'CI guards in scripts/' (search and prune).
5. CHANGELOG.md (v0.3 unreleased): add under ### Removed:
   'scripts/ directory + CI grep guards. grep-v4-references: job done (v4 migration code removed; remaining v4 mentions are intentional history). grep-name-without-workstream: invariant now structurally enforced by the v5 surrogate-id schema (per-workstream UNIQUE on name + INTEGER FKs). lint becomes biome-only.'
6. Verify: npm run typecheck && npm run lint (now biome-only) && npm run test && npm run build all green.

═══ ANTI-FEATURES ═══

  - DON'T leave one of the two guards 'just in case'. All-or-nothing per the parent task.
  - DON'T migrate the grep guards into TS tests (would double test runtime + duplicate the schema-level invariant).
  - DON'T add a deprecation period or a deprecation warning. Pre-1.0; the guards are dev-only.

═══ ROLLBACK ═══

git revert if either invariant regresses. The `git log --diff-filter=D scripts/` will surface the deleted files for recovery.

═══ FINAL ACTION ═══

⚠️ git commit -am 'remove scripts/: CI grep guards no longer needed (v4 gone; v5 schema enforces name uniqueness)' THEN mu task close remove_scripts_dir -w mufeedback-v03 --evidence 'scripts/ gone; lint = biome only; all green'
```
