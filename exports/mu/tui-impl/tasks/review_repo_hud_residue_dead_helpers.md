---
id: "review_repo_hud_residue_dead_helpers"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.1
roi: 300.00
owner: "worker-3"
created_at: "2026-05-12T11:14:35.546Z"
updated_at: "2026-05-12T12:50:50.766Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW low: purge vestigial --hud comments and dead tmux sizing helper

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:35.924Z

```
FILES: src/cli/state.ts:3-36,132-133,475; src/tmux.ts:743-748 and 748-776; src/output.ts:24-32 and 129; src/tmux.ts:672-673.
FINDING: Non-TUI code still describes the removed `mu state --hud` mode as if it exists, keeps a `--lines` alias explicitly for `--hud` muscle memory, and exports `currentPaneSize()` whose docstring says it is used by `mu hud`. `rg currentPaneSize src test` shows no production caller (only SDK export/tests). This is vestigial surface/dead helper after the TUI replacement.
RECOMMENDED FIX: Update comments to the current static/full/mission/TUI reality, either remove the `-n/--lines` alias or rename its rationale to a generic `--events` alias, and delete `currentPaneSize()` + SDK export if no current production caller remains. If keeping it as public API, rewrite its docstring around an actual consumer.
```

### #2 by "worker-3", 2026-05-12T12:50:50.766Z

```
CLOSE: 360c1bf: repo cleanup bundle; typecheck/lint/test/build green
```
