---
id: "adopt_impl"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-07T17:51:24.010Z"
updated_at: "2026-05-08 05:40:23"
blocked_by: ["adopt_design"]
blocks: ["adopt_docs", "bug_claim_fk_external_agent"]
---

# Impl: adoptAgent SDK + mu adopt verb + tests

## Notes (1)

### #1 by system, 2026-05-08T05:40:23.791Z

```
SHIPPED. Implementation: adoptAgent in src/agents.ts (~110 LOC including doc), PaneNotFoundError in src/tmux.ts (10 LOC), cmdAdopt + verb wiring in src/cli.ts (~70 LOC), 10 tests (8 unit mirroring design test cases + 2 integration with real tmux + raw splitWindow), USAGE_GUIDE § 6 'Adopt an existing tmux pane', SKILL.md 'Registration (1)' section, CHANGELOG entry. Live-dogfooded: spawned test agent, raw-tmux split-window into orphan, 'mu adopt %8166 -w roadmap-v0-2' adopted as 'experiment', 'mu adopt experiment' returned alreadyAdopted=true. Net ~190 LOC including tests; on-budget per design (200 LOC estimate). 494 tests pass.
```
