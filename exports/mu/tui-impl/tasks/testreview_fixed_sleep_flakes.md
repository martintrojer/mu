---
id: "testreview_fixed_sleep_flakes"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: "worker-3"
created_at: "2026-05-12T11:17:05.551Z"
updated_at: "2026-05-12T13:39:56.399Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# TEST REVIEW: replace fixed sleeps in real-tmux/export tests with polling or injected clocks

## Notes (3)

### #1 by "worker-3", 2026-05-12T11:17:15.931Z

```
FILES: test/verbs.integration.test.ts:146-157 and 160-174 and 207-215; test/tmux.integration.test.ts:145-155, 163-177, 184-196; test/cli-agent-kick.test.ts:358-373 and 404-409; export mtime gaps at test/exporting.test.ts:111-122, 151-168 and test/workstream.test.ts:819-835; wait-loop timing at test/tasks-wait.test.ts:110-117 and 230-245.
FINDING: The non-TUI suite still has fixed setTimeout sleeps to wait for tmux output/status, shell prompt readiness, kick foreground process setup, mtime granularity, and wait cadence. These are classic flaky patterns: under load a 200/300/600ms tmux sleep can be too short, while mtime sleeps can be too small on coarse filesystems or unnecessarily slow elsewhere. The repo already has pollUntil() and several good polling examples; these remaining sleeps are inconsistent with AGENTS.md's integration-test guidance.
RECOMMENDED FIX: Replace tmux/process sleeps with pollUntil predicates that observe the desired state (capturePane contains marker, listLiveAgents status is needs_input, foregroundPgid/comm is sleep, paneExists false). For sendToPane prompt readiness, poll capturePane for a shell prompt or use a deterministic shell command that prints a ready marker before accepting input. For export idempotency, prefer injecting a clock/mtime seam or assert sha/unchanged counters plus file content; if mtime is required, use a helper that waits until the filesystem timestamp can tick instead of hardcoding 25ms. For cadence tests, use fake timers or a controllable wait sleep seam that advances a fake clock.
VERIFIED: audit only; no code changed.
```

### #2 by "worker-3", 2026-05-12T13:39:54.895Z

```
FILES: test/verbs.integration.test.ts; test/tmux.integration.test.ts; test/cli-agent-kick.test.ts; CHANGELOG.md
COMMANDS: npx vitest run test/tmux.integration.test.ts test/verbs.integration.test.ts test/cli-agent-kick.test.ts (pass); npm run typecheck (pass); npm run lint (pass); npm run test (pass: 123 files / 2032 tests); npm run build (pass)
FINDINGS: Tmux/verbs integration tests still assumed fixed 200-600ms sleeps were enough for prompt/output/pane lifecycle propagation.
DECISION: Replaced sleeps only in scoped tmux/verbs integration files with pollUntil predicates over observed state: marker/output in capturePane, paneExists false/true, and status detection. Left export mtime and cadence sleeps untouched per task scope.
NEXT: None.
VERIFIED: Four greens passed after the commit changes: typecheck, lint, full test suite, build.
ODDITIES: A previous full-test attempt exposed an unrelated intermittent timeout in cli-task-wait.integration; the subsequent full npm run test passed clean.
```

### #3 by "worker-3", 2026-05-12T13:39:56.399Z

```
CLOSE: bfa68f4: tmux/verbs integration sleeps replaced with pollUntil; four greens passed
```
