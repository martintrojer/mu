---
id: "review_repo_unused_zod_dependency"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.05
roi: 700.00
owner: "worker-3"
created_at: "2026-05-12T11:14:33.030Z"
updated_at: "2026-05-12T12:50:56.093Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW low: remove unused zod dependency

## Notes (3)

### #1 by "worker-2", 2026-05-12T11:14:33.617Z

```
FILES: package.json:69; src/** search via `rg "from ['\"]zod|require\(['\"]zod|z\." src test package.json`.
FINDING: `zod` is listed in dependencies but has no import/use in src or test. This violates the ROADMAP/AGENTS anti-feature discipline around deps: every dependency should earn its keep.
RECOMMENDED FIX: Remove `zod` from package.json and lockfile; run `npm install` (or equivalent lockfile refresh), then typecheck/lint/test/build. If a future feature needs schema validation, re-add it in the same change that consumes it.
```

### #2 by "worker-3", 2026-05-12T12:50:50.133Z

```
CLOSE: 360c1bf: repo cleanup bundle; typecheck/lint/test/build green
```

### #3 by "worker-3", 2026-05-12T12:50:56.093Z

```
FILES: package.json; package-lock.json; src/agents/errors.ts; src/cli/agents.ts; src/cli/state.ts; src/cli/workspace.ts; src/output.ts; src/tmux.ts; src/vcs.ts; CHANGELOG.md; docs/ARCHITECTURE.md; docs/USAGE_GUIDE.md; related stale-comment test/source files.
COMMANDS: npm uninstall zod; npx biome check --write src test; npm run typecheck; npm run lint; npm run test; npm run build; git commit.
FINDINGS: zod was unused; agent-list --all existed only as stale docs/typing/hints; currentPaneSize had no callers and was HUD residue; workspace commits JSON dropped SDK metadata; git dirty checks were duplicated.
DECISION: one cleanup commit 360c1bf covering all five review tasks.
VERIFIED: typecheck, lint, test, and build all passed locally.
ODDITIES: mu task close ran after commit per final-action instructions.
```
