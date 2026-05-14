---
id: "review_repo_agent_list_all_dead_surface"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.15
roi: 300.00
owner: "worker-3"
created_at: "2026-05-12T11:14:34.093Z"
updated_at: "2026-05-12T12:50:50.465Z"
blocked_by: []
blocks: ["audit_cli_surface_for_human_agent_split", "feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW med: agent list --all surface is half-removed / broken

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:34.591Z

```
FILES: src/cli/agents.ts:222-230 and 653-659; src/agents/errors.ts:136; src/tmux.ts:75-79; docs/ARCHITECTURE.md:166.
FINDING: `cmdList` accepts `opts.all?: boolean` but never uses it, `mu agent list` does not wire an `--all` option, and typed nextSteps recommend `mu agent list -w *` / `mu agent list -w * --json`, which resolves as literal workstream `*` rather than an all-workstreams view. ARCHITECTURE also documents `mu agent list --all`.
RECOMMENDED FIX: Pick one surface. Prefer implementing `mu agent list --all` (or multi-workstream `-w` if that is the intended modern shape) and update cmdList JSON/human output accordingly. Otherwise delete the dead `all` option type and fix nextSteps/docs to point at a real command such as `mu workstream list` followed by scoped `mu agent list -w <ws>`.
```

### #2 by "worker-3", 2026-05-12T12:50:50.465Z

```
CLOSE: 360c1bf: repo cleanup bundle; typecheck/lint/test/build green
```
