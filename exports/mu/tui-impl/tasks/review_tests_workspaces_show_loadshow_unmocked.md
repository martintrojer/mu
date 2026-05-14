---
id: "review_tests_workspaces_show_loadshow_unmocked"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-12T08:36:46.328Z"
updated_at: "2026-05-12T10:04:13.769Z"
blocked_by: []
blocks: []
---

# REVIEW low: workspaces popup shells out to git but loadShow path is untested

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:36:46.686Z

```
FILE + LINES:
  - src/cli/tui/popups/workspaces.tsx:215-238 (loadShow callback shelling out to git -C path show sha)
CATEGORY: weak-coverage
SEVERITY: low
FINDING: loadShow uses execFile to run `git -C <path> show <sha> --stat -p --color=never`. The capped output, the SHOW_MAX_CHARS truncation, and the error path all live in a useCallback that no test ever calls. test/tui-popup-workspaces.test.ts:107-117 only asserts that the SOURCE contains `"-C"`, `"show"`, `"--stat"`, `"-p"`, `"--color=never"`, `SHOW_MAX_CHARS = 100_000`, and `"truncated at"` — i.e., that the strings are present in the source code. A regression that:
   - swaps `--color=never` to `--color=always` (would inject ANSI into DrillScrollView).
   - drops `--stat`.
   - silently sets `maxBuffer: 100`.
…would all pass.
SUGGESTED FIX: extract loadShow's body to a pure async helper (e.g. `runGitShow(path, sha): Promise<{text, truncated, error}>`); test it against a real tiny git repo fixture (mkdtemp + git init + commit). Confirm: truncation kicks in at SHOW_MAX_CHARS; ANSI absent (`--color=never` honoured); error returns useful message.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T10:04:13.769Z

```
CLOSE: 5aa88c346be351411afa0d49235564915d521364: extracted loadShow to runGitShow in src/cli/tui/git-show.ts; new test/tui-git-show.test.ts drives a real mkdtemp+git fixture (truncation, ANSI absence, error path) plus an execFile stub pinning the arg vector; popup test now asserts wiring instead of literal flag strings; 4 greens
```
