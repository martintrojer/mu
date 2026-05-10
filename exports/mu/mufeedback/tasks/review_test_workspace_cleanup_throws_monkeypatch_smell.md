---
id: "review_test_workspace_cleanup_throws_monkeypatch_smell"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-09T08:32:40.912Z"
updated_at: "2026-05-09T10:04:46.620Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: workspace cleanup-on-throw test mutates the singleton noneBackend (cross-test leak risk)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:33:13.435Z

```
FILES: test/workspace.test.ts:441-491 ("createWorkspace cleanup on backend throw"); src/vcs.ts (noneBackend singleton export); src/workspace.ts:303-320 (createWorkspace try/catch around backend.createWorkspace).

WHAT THE TESTS CLAIM: Verifies that when backend.createWorkspace throws after creating a partial on-disk dir (the snap_dogfood Finding 4b case — cp -a interrupted by DRM-protected file), the SDK's outer try/catch removes the partial dir, clears any DB row, and the recovery path (a re-attempt with a working backend) succeeds without WorkspacePathNotEmptyError.

WHAT THEY ACTUALLY VERIFY: It does verify the cleanup. The actual coverage is real. BUT the technique is monkey-patching the live `noneBackend` singleton's createWorkspace via cast `(real as { createWorkspace: typeof flaky.createWorkspace }).createWorkspace = flaky.createWorkspace;` and restoring with a try/finally. Two concrete fragility issues:
  (1) If the test throws between the assignment and the try/finally restore (e.g. `await import(...)` rejection, `mkdtempSync` failure, `vi` instrumentation injecting a throw), the singleton stays patched. Subsequent tests in the same file or worker that use noneBackend silently get the broken backend. Vitest by default runs files in worker isolation but tests in the SAME file share the module graph; the workspace SDK tests later in this file (e.g. listWorkspaces, freeWorkspace, FK CASCADE tests at line 308+) run noneBackend.createWorkspace. They appear after this test in source order so vitest may execute them before or after depending on `concurrent` settings.
  (2) The test patches the real `noneBackend` rather than passing a custom backend. The `createWorkspace` SDK function accepts `opts.backend` as a string ("none"/"git"/"jj"/"sl") and resolves via `backendByName`, so there's no clean injection point. The "real" reproduction needs DI to be clean — but the inline justification says "backends are exported as singletons; mutating .createWorkspace is the simplest way to inject a transient failure." That's true; the cost is fragility.

GAP: The test PASSES today because no other test in workspace.test.ts runs concurrently with it inside the same describe block, and the finally clause is reliable for normal vitest flows. The risk is forward: someone adds a new test before/after this one that uses noneBackend in a parallel describe, or vitest's `--isolate=false` flag is set in CI for performance, and the singleton mutation leaks. Concretely: run `vitest run --no-isolate test/workspace.test.ts` and the FK CASCADE tests later in the file might see a flaky-backend if any concurrency reorder happens. Severity 50 — mainly maintenance, not behaviour.

WHY IT MATTERS: The cleanup path is genuinely covered (so this is a 50, not a 90). The smell to call out: testing "cleanup runs on backend throw" by monkey-patching a singleton is brittle, and a clean alternative exists today: src/workspace.ts's createWorkspace already does `opts.backend ? backendByName(opts.backend) : await detectBackend(...)`. Adding a small `opts.backendOverride?: VcsBackend` test seam (or exporting a `__setBackendForTests(name, override)` hook) lets the test stop mutating the singleton. Both options ~5 LOC; pick the one less invasive.

SUGGESTED FIX:
  Option A (cheapest, no source change): Wrap the test in beforeEach/afterEach that captures and restores noneBackend.createWorkspace at the describe boundary so an early throw doesn't leak. Add `expect.assertions(N)` so a swallowed throw still fails. ~6 LOC.
  Option B (cleanest, source change): Export a thin `setBackendForTests(name, backend)` helper in src/vcs.ts behind an `if (process.env.NODE_ENV === 'test')` guard (or inline `__test_only__` prefix). Test injects via the helper; restores in afterEach. ~10 LOC src + ~6 LOC test. Eliminates the cast.

EVIDENCE: test/workspace.test.ts:472-475 — `const orig = real.createWorkspace.bind(real); (real as { createWorkspace: typeof flaky.createWorkspace }).createWorkspace = flaky.createWorkspace; try { ... } finally { ... }` — this is the exact pattern. test/workspace.test.ts:485 onwards — the test's own recovery branch (re-attempt with working backend) requires the restore to have run; if anything inside the try block prevents the finally (process.exit, native abort, vitest --bail), the leak is total.
```
