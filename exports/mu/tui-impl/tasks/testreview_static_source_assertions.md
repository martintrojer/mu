---
id: "testreview_static_source_assertions"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: "worker-2"
created_at: "2026-05-12T11:16:43.360Z"
updated_at: "2026-05-12T13:49:54.070Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# TEST REVIEW: replace static source assertions with behavior tests

## Notes (3)

### #1 by "worker-3", 2026-05-12T11:16:51.202Z

```
FILES: test/state-dispatch.test.ts:118-133; test/state-render.test.ts:281-418
FINDING: Static-source assertions stand in for behavior tests. state-dispatch reads ./src/cli/state.ts and regexes for absence of the old multi-workstream TUI guard plus a runTui(workstreams:) call. state-render recursively walks src/ and performs a local TypeScript AST audit of emitEvent payload syntax. These tests can pass while runtime behavior is broken (e.g. runTui called with the wrong object through an alias/wrapper, emitEvent payload built by a helper the local resolver cannot understand, or EVENT_VERB_PREFIXES/classifyEventVerb imported incorrectly at runtime), and they also fail on harmless refactors.
RECOMMENDED FIX: Replace state-dispatch's source grep with a behavioral seam: mock/lazy-inject runTui and assert cmdState/runCli(['state','--tui','-w','a,b']) calls it once with both resolved workstreams without blocking Ink. Replace the emitEvent source audit with behavior-level coverage around the exported event helpers or a small central emitEvent wrapper test that records emitted payloads from representative SDK verbs and verifies classifyEventVerb recognizes them. If an architectural invariant must remain static, move it to a dedicated lint/check script outside unit tests and keep one behavior test per runtime path.
VERIFIED: audit only; no code changed.
```

### #2 by "worker-2", 2026-05-12T13:49:41.460Z

```
FILES: test/state-dispatch.test.ts; test/state-render.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck (exit 0); npm run lint (exit 0); npm run test (exit 0; 123 files / 2032 tests); npm run build (exit 0); targeted npm test -- --run test/state-dispatch.test.ts test/state-render.test.ts (exit 0)
FINDINGS: Replaced source/AST assertions with runtime behaviour tests. state-dispatch now mocks runTui and drives runCli(['state','--tui','-w','ws,ws2']). state-render now drives representative SDK event emitters, captures agent_logs event payloads, and verifies classifyEventVerb recognises them.
DECISION: Kept parser roundtrip/false-positive tests, but removed source syntax audit so harmless refactors do not fail tests.
NEXT: none
VERIFIED: Commit 7666a3a; four greens passed.
ODDITIES: Full test suite prints existing agent-name convention hints; tests pass.
```

### #3 by "worker-2", 2026-05-12T13:49:54.070Z

```
CLOSE: 7666a3a: state-dispatch + state-render rewritten as behaviour tests
```
