---
id: "review_repo_git_dirty_check_dup"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: "worker-3"
created_at: "2026-05-12T11:14:39.005Z"
updated_at: "2026-05-12T12:50:51.372Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW low: git dirty detection has two parallel implementations

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:39.303Z

```
FILES: src/vcs.ts:467-472, 624-641, 700-707, 724-741.
FINDING: Git dirtiness is implemented twice: `listGitDirtyFiles()` parses `git status --porcelain`, while `isGitDirty()` runs `git diff`, `git diff --cached`, and `git ls-files --others`. `gitBackend.isClean()` and `rebaseTo()` use the former; `freeWorkspace(--commit)` uses the latter. The two definitions can drift on ignored/untracked/staged edge cases.
RECOMMENDED FIX: Delete `isGitDirty()` and have `freeWorkspace()` use `(await listGitDirtyFiles(path)).length > 0` before committing. One helper should define git dirty semantics for clean checks, rebase refusal, dirty decoration, and auto-commit.
```

### #2 by "worker-3", 2026-05-12T12:50:51.372Z

```
CLOSE: 360c1bf: repo cleanup bundle; typecheck/lint/test/build green
```
