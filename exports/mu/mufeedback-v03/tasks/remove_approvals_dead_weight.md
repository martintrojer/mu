---
id: "remove_approvals_dead_weight"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: null
created_at: "2026-05-10T08:10:55.549Z"
updated_at: "2026-05-10T08:28:22.934Z"
blocked_by: []
blocks: []
---

# REMOVE: mu approve verbs + approvals table — zero usage in 200+ task dogfood; anti-anticipatory pruning

## Notes (1)

### #1 by π - mu, 2026-05-10T08:11:38.866Z

```
REMOVE: mu approve verbs + approvals table.

═══ THE DECISION (operator) ═══

After ~200 tasks of dogfood across the v0.2 + v0.3 waves: zero `mu approve add` invocations recorded in the live mu.db. The verb namespace, the schema table, the SDK, the CLI wiring, and the documentation all sit unused.

Per mu's anti-feature pledge ('no anticipatory abstractions; no traits with zero implementors'), this surface qualifies for removal. The hooks can come back when a real second implementor surfaces.

═══ WHAT GETS REMOVED ═══

CODE:
  src/approvals.ts                    (365 LOC SDK)
  src/cli/approve.ts                  (341 LOC CLI)
  test/approvals.test.ts              (unit tests)
  Any test/cli-approve-*.test.ts file (CLI tests)

SCHEMA:
  approvals table from src/db.ts CURRENT_SCHEMA
  approvals from EXPECTED_TABLES
  Any approvals indexes
  CURRENT_SCHEMA_VERSION bumps to v7 (additive-removal: drops one table; existing v6 DBs need a one-shot DROP TABLE IF EXISTS approvals migration in applySchema)

WIRING:
  src/cli.ts: 
    - import { ... } from "./approvals.js" — remove
    - import { wireApproveCommands } from "./cli/approve.js" — remove
    - the wireApproveCommands(program, db) call — remove
    - "approval" entries in the entity-ref tables (resolveEntityRef map's "approval" key)
    - any classifyError mappings for approval-specific errors
  src/index.ts: drop re-exports of Approval types/SDK functions/error classes
  src/logs.ts: drop EVENT_VERB_PREFIXES entries for approval events ('approval add', 'approval granted', 'approval denied', 'approval timeout')
  src/workstream.ts: drop the approvals LEFT JOIN from listEmptyWorkstreams predicate (workstream is now 'empty' iff zero tasks/agents/vcs_workspaces; drop the approvals dimension)
  src/cli/workstream.ts: drop 'approvals' from the help text string for --empty
  src/cli/workstream.ts: drop the approvals counter from summarizeWorkstream's display if present

DOCS:
  skills/mu/SKILL.md: 
    - Remove the 5 approve verbs from the verb list
    - Remove the 'Gate on a human approval' pattern block
    - Remove any other approve mention
  docs/USAGE_GUIDE.md: remove the approvals section + any approve-related examples
  docs/VOCABULARY.md: drop 'approval' / 'approve' entries
  docs/VISION.md: 
    - Drop the 'Human-in-the-loop approvals' bullet from the pillars list
    - Drop the 'Approval primitives belong in the core' row from the audit table (or replace with 'Approval primitives REMOVED from core post-v0.3 wave: zero usage in 200+ task dogfood; promotion criterion not met. May return when a real second implementor surfaces.')
  docs/ROADMAP.md: 
    - Drop the 'Approval / policy rules engine' row from the deferred-features table (the parent feature is gone)
    - Drop the 'Subscription-based wakeups' entry's reference to mu approve wait
  docs/ARCHITECTURE.md: drop src/approvals.ts row from the module table; drop approvals from the schema overview
  CHANGELOG.md (v0.3 unreleased): NEW 'Removed' subsection with the full rationale

CI / SCRIPTS:
  scripts/grep-name-without-workstream.allowlist: drop any approvals-related allowlist entries
  Tests for things that test the approvals presence (e.g., 'expected_tables includes approvals'): update

═══ MIGRATION FOR EXISTING USER DBs ═══

Schema v6 → v7 is destructive (DROP TABLE approvals). The migration is in-process:
  - In applySchema, after the schema_version bump from v6 → v7, run `DROP TABLE IF EXISTS approvals`.
  - Per the AGENTS.md schema-rule: this is a non-additive change; bump CURRENT_SCHEMA_VERSION to 7.
  - No backup script (the data is per-the-DB-record empty; aggressive-migration applies — there's no real data to lose).

Operators with v6 DBs that DO have approvals rows (none observed but theoretically possible):
  - The DROP loses them. Document in CHANGELOG: 'If you have approvals rows you want to preserve, snapshot first via mu undo before upgrading.'
  - Schema floor stays at v5; pre-v5 DBs still throw SchemaTooOldError.

═══ TESTS ═══

  Update test/db.test.ts: EXPECTED_TABLES drops approvals; assert 14 tables (was 15); assert v7 schema; verify the v6→v7 migration drops the table.
  Update test/workstream-destroy-empty.test.ts: the predicate's approvals dimension is gone; existing tests should still pass (zero approvals was the steady state).
  Drop test/approvals.test.ts and any test/cli-approve-*.test.ts.
  Verify all other tests still pass (no test depended on approvals beyond its own file).

═══ DRY RUN ESTIMATE ═══

  -706 LOC src/ (approvals.ts + approve.ts deletions)
  ~-50 LOC test/ (approvals.test.ts deletion)
  ~+30 LOC src/db.ts (v6→v7 migration)
  ~-40 LOC docs (removed sections)
  Net ~-770 LOC + a CHANGELOG 'Removed' entry.

═══ ROLLBACK PLAN ═══

  git revert <removal-commit> if approvals friction surfaces in v0.4. Re-introduce v8 schema with the approvals table.

═══ ANTI-FEATURE GUARDRAILS ═══

  - DON'T leave the SDK + schema in place 'just in case'. Either it's used or it's not; this audit decides not.
  - DON'T deprecate-but-keep with a warning. Pre-1.0; zero downstream consumers; clean removal.
  - DON'T remove half (e.g., keep the schema, drop the verbs). All-or-nothing.
  - DON'T add a hook for 'maybe an extension reintroduces this'. Anti-anticipatory.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close remove_approvals_dead_weight -w mufeedback-v03 --evidence 'all approve verbs + approvals table removed; v6→v7 migration; docs scrubbed; tests updated'
```
