---
id: "tests_tui_convert_workspaces_commits_doctor"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.3
roi: 183.33
owner: "worker-3"
created_at: "2026-05-13T14:41:28.093Z"
updated_at: "2026-05-13T15:14:39.030Z"
blocked_by: ["tests_tui_capture_stream_seam_helper"]
blocks: ["testreview_tui_static_source_grep_pervasive"]
---

# TESTS: convert popups/{workspaces,commits,doctor} tests from source-grep to behaviour

## Notes (3)

### #1 by "π - mu", 2026-05-13T14:41:32.090Z

```
Sub-task of testreview_tui_static_source_grep_pervasive. See `mu task notes testreview_tui_static_source_grep_pervasive -w tui-impl` for the full split rationale.
```

### #2 by "worker-3", 2026-05-13T15:14:32.598Z

```
FILES: test/tui-popup-workspaces.test.ts, test/tui-popup-commits.test.ts, test/tui-popup-doctor.test.ts
COMMANDS: npx vitest run test/tui-popup-commits.test.ts --reporter=dot (failed then passed after expected filter prompt text fix); npx vitest run test/tui-popup-workspaces.test.ts --reporter=dot (failed then passed after waiting for commit rows); npx vitest run test/tui-popup-doctor.test.ts --reporter=dot (failed then passed after driving cursor to agents row); npx vitest run test/tui-popup-workspaces.test.ts test/tui-popup-commits.test.ts test/tui-popup-doctor.test.ts --reporter=dot (passed); npm run typecheck (passed after unused mock arg fix); npm run lint (failed format, fixed with biome --write, then passed); npm run test:fast (passed); npm run build (passed)
FINDINGS: Replaced popup behaviour source-greps with CaptureStream render tests using createInkInputStream/simulateInput. Remaining source reads are structural guards for app/key/layout wiring and import/read-only invariants.
DECISION: Mocked only VCS/workspace subprocess seams so Ink list/filter/yank/drill behaviour remains exercised without real git/tmux.
NEXT: none
VERIFIED: commit a821b73; typecheck + lint + test:fast + build green
```

### #3 by "worker-3", 2026-05-13T15:14:39.030Z

```
CLOSE: a821b73: 3 popup tests (workspaces/commits/doctor) converted to behaviour
```
