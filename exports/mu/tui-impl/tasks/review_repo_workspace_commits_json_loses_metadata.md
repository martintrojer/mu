---
id: "review_repo_workspace_commits_json_loses_metadata"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: "worker-3"
created_at: "2026-05-12T11:14:36.606Z"
updated_at: "2026-05-12T12:50:51.063Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW med: workspace commits --json drops baseRef/vcs/workspacePath

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:36.916Z

```
FILES: src/cli/workspace.ts:199-212; src/workspace.ts:748-803; docs/USAGE_GUIDE.md:225-226; CHANGELOG.md:1302-1322.
FINDING: `listCommitsForWorkspace()` returns `{vcs, baseRef, commits, workspacePath}`, and docs explicitly call out future/sibling metadata on the collection envelope. But `cmdWorkspaceCommits --json` emits only `emitJsonCollection(r.commits)`, so scripts lose the base ref and workspace path that the SDK computed.
RECOMMENDED FIX: Change the JSON shape to the collection envelope plus sibling metadata, e.g. `{items: r.commits, count: r.commits.length, vcs: r.vcs, baseRef: r.baseRef, workspacePath: r.workspacePath}`. Update tests/docs that still expect a bare `{items,count}` only shape for this verb.
```

### #2 by "worker-3", 2026-05-12T12:50:51.063Z

```
CLOSE: 360c1bf: repo cleanup bundle; typecheck/lint/test/build green
```
