---
id: "remove_top_level_mu_adopt_alias_now_was"
workstream: "feedback"
status: CLOSED
impact: 8
effort_days: 0.1
roi: 80.00
owner: null
created_at: "2026-05-11T09:00:01.305Z"
updated_at: "2026-05-11T09:05:57.769Z"
blocked_by: []
blocks: []
---

# remove top-level mu adopt alias now (was deprecated in eaad4b7; nobody depends on it yet)

## Notes (3)

### #1 by "π - mu", 2026-05-11T09:00:18.801Z

```
CONTEXT: The `mu adopt` top-level alias was added in commit eaad4b7 (this session, ~1.5h ago) with the promise "removed in v0.5". The original task that motivated the rename (mu_adopt_should_be_mu_agent_adopt_for) explicitly considered OPTION 2 "hard-rename: drop mu adopt, only mu agent adopt" and called out:

  "Cleaner, but breaks any operator muscle memory or external automation. Per AGENTS.md anti-feature pledges minimalism, this might be preferred (no aliases) — operator decision."

OPERATOR DECISION (2026-05-11, immediately after eaad4b7 landed): drop the deprecation now. Rationale:
  1. The alias has existed for ~1.5h. Nobody depends on it.
  2. AGENTS.md anti-feature pledges: "no wrappers around wrappers", "be small". A deprecation alias on a 1.5h-old alias IS the wrapper-around-wrapper antipattern.
  3. v0.5 is hypothetical — until-vN guarantees we cannot keep are worse than no guarantee.

SCOPE:
  - Delete the second .command("adopt ...") block in src/cli/agents.ts (lines ~761-784, the "Deprecated alias: mu adopt" wiring).
  - Delete test/cli-adopt-deprecation.test.ts entirely (125 LOC).
  - Trim docs/USAGE_GUIDE.md line 567 — drop the "deprecated alias" parenthetical.
  - Trim docs/VOCABULARY.md line 73 — same.
  - Trim skills/mu/SKILL.md line 280 — same.
  - Trim docs/ARCHITECTURE.md line 248 if it still says "mu adopt".
  - Trim docs/ROADMAP.md lines 118+ — any reference to top-level "mu adopt" should now read "mu agent adopt" (preserve historical commit reference e20af89; just update the verb form).
  - Update CHANGELOG.md [Unreleased] section: rewrite the existing "mu agent adopt is the canonical form; mu adopt is deprecated" entry to read like a clean rename ("renamed mu adopt → mu agent adopt"), drop the "kept until v0.5" promise.
  - Anywhere else in the codebase grep "mu adopt" (excluding "mu agent adopt") finds something — fix it.

NO behavior change for `mu agent adopt` — it stays exactly as wired.

Severity: hygiene. Reduces verb surface area, removes a future-version promise we won t have to keep.
```

### #2 by "worker-dropalias-1", 2026-05-11T09:05:38.430Z

```
FILES:
  - src/cli/agents.ts (deleted second adopt block ~lines 761-784, removed isJsonMode import)
  - test/cli-adopt-deprecation.test.ts (deleted entirely, 125 LOC)
  - test/verbs-misc.test.ts (rewrote two adopt-wiring tests under `mu agent adopt`; added regression test that bare `mu adopt <pane>` is no longer wired; tweaked seed-comment wording)
  - docs/USAGE_GUIDE.md (dropped "deprecated alias" parenthetical at L567 and L758 legacy hint)
  - docs/VOCABULARY.md (dropped deprecated-alias clause from the `adopt` row)
  - skills/mu/SKILL.md (dropped the deprecated-alias parenthetical from the agents verb summary)
  - docs/ARCHITECTURE.md (s/mu adopt %15/mu agent adopt %15/ in reconcile algorithm)
  - docs/ROADMAP.md (rewrote SHIPPED-in-v0.2 heading + body to use `mu agent adopt` everywhere; preserved e20af89 commit ref)
  - CHANGELOG.md [Unreleased] (rewrote "deprecated" entry as a clean rename, no v0.5 promise; references both task ids)
COMMANDS:
  npm run typecheck  -> 0
  npm run lint       -> 0
  npm run test       -> 0 (1257 passed, 0 failed)
  npm run build      -> 0 (cli 432K, index 233K)
FINDINGS:
  - The first attempt at the regression test asserted /unknown command/i but commander's actual default behaviour for `mu adopt <pane>` (extra positional arg with no subcommand named adopt) surfaces as "too many arguments. Expected 0 arguments but got 2." The verb does NOT execute (good — no agent gets adopted) but the error message wording is "too many arguments" rather than "unknown command". Updated the regression test to accept either wording and to anchor on the behavioural outcome (verb does not execute, no agent row created).
  - exports/ contains historical archived task notes that mention "mu adopt"; left untouched per spec ("excluding 'mu agent adopt'") since they are immutable historical artefacts (CHANGELOG history rows pre-Unreleased likewise untouched).
DECISION:
  - Hard-removed the alias per operator decision in the spec. No deprecation hint, no fallthrough behaviour. Bare `mu adopt` errors out via commander's default arg-validation path.
  - Kept the regression test permissive on the exact error wording (commander could change it across versions; we only care that the verb doesn't execute).
NEXT:
  - none; scope was deliberately narrow per spec.
VERIFIED:
  - All four green: npm run typecheck && npm run lint && npm run test && npm run build (1257 tests pass).
  - Manual verification of behaviour change: the new test in test/verbs-misc.test.ts ("`mu adopt <pane>` (top-level, no `agent`) is no longer wired") asserts both that stderr matches /unknown command|too many arguments/i AND that getAgent(db, "worker-9", "auth") is undefined after the call.
  - mu agent adopt unchanged: existing wiring at src/cli/agents.ts ~lines 741-760 untouched; the (case 1-8) cmdAdopt unit tests still pass.
ODDITIES:
  - none.
```

### #3 by "worker-dropalias-1", 2026-05-11T09:05:57.769Z

```
CLOSE: all 4 green; mu adopt now errors via commander default (verb does not execute, no agent row created); mu agent adopt unchanged; commit 3682682
```
