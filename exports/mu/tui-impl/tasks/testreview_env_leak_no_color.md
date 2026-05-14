---
id: "testreview_env_leak_no_color"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.2
roi: 225.00
owner: "worker-2"
created_at: "2026-05-12T11:17:20.913Z"
updated_at: "2026-05-12T13:14:09.336Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# TEST REVIEW: global NO_COLOR mutations leak across test files

## Notes (2)

### #1 by "worker-3", 2026-05-12T11:17:27.673Z

```
FILES: test/agent-idle.test.ts:37-41; test/state-dispatch.test.ts:27-31; test/state-render.test.ts:24-29. Related helper: test/_setup.ts:37-46 only scrubs MU_* env vars.
FINDING: Three files set process.env.NO_COLOR = '1' at module load (two via vi.hoisted) and never restore it. In Vitest workers, multiple test files can share a process, so this global mutation can silently alter later tests that expect color detection defaults. The output.test.ts colorEnabled cases carefully isolate NO_COLOR/FORCE_COLOR/TERM with a local withEnv helper, but an earlier file in the same worker can still leave NO_COLOR behind and create order-dependent false failures or false confidence.
RECOMMENDED FIX: Move color disabling into per-test withEnv/afterEach restoration, or add NO_COLOR to a generalized test env scrubber that runs before each test file/test. Prefer importing output modules after the scoped env is set only in the tests that need colorless rendering, and restore the previous value in afterEach. Add a small guard test or setup hook that asserts known global env keys (NO_COLOR, TERM, FORCE_COLOR, TMUX_PANE, MU_SESSION) are clean unless explicitly opted in.
VERIFIED: audit only; no code changed.
```

### #2 by "worker-2", 2026-05-12T13:14:09.336Z

```
CLOSE: 9ff9ba9: NO_COLOR module-scope render tests restore env in afterAll; four greens passed
```
