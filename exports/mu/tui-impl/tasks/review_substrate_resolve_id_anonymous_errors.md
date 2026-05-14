---
id: "review_substrate_resolve_id_anonymous_errors"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.25
roi: 200.00
owner: "worker-1"
created_at: "2026-05-13T12:41:50.770Z"
updated_at: "2026-05-13T13:26:59.746Z"
blocked_by: []
blocks: []
---

# REVIEW med: resolveTaskId/resolveAgentId throw fake-named Error, breaks instanceof exit-code map

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:41:52.196Z

```
FILE(S):
  src/db.ts:213-244 (resolveTaskId, resolveAgentId)

FINDING (non-idiomatic / brittleness):
  Both resolveTaskId and resolveAgentId construct an Error and
  patch its `.name` to a typed-error string instead of throwing
  the actual typed error class:

      export function resolveTaskId(db, workstreamId, localId): number {
        const row = db.prepare("SELECT id FROM tasks ...").get(...) as ...;
        if (!row) {
          const err = new Error(`no such task in workstream: ${localId}`);
          (err as Error & { name: string }).name = "TaskNotFoundError";
          throw err;
        }
        return row.id;
      }

  The comment justifies it as "avoiding an import cycle (workstream/
  agents/tasks all import from db.ts)". But `cli/handle.ts` checks
  `err instanceof TaskNotFoundError` to map exit codes — these
  pseudo-typed Errors will FAIL the instanceof check and fall
  through to the generic exit-1 path.

WHY IT'S A PROBLEM:
  - `cli/handle.ts` exit-code map (lines 235-240) uses
    `instanceof AgentNotFoundError / TaskNotFoundError`. A bare
    caller hitting the resolve helper directly (anything that
    bypasses the SDK wrappers in src/agents.ts / src/tasks.ts)
    will surface as a generic exit 1 instead of exit 3
    (not-found). Production currently hides this because every
    SDK entrypoint catches the resolve error and wraps it in
    the typed class — but the comment in db.ts says "a bare
    caller still gets a meaningful message", which is misleading
    about the exit-code contract.
  - Setting `.name` on Error to fake out instanceof is a code
    smell; future readers think the cast is meaningful.
  - The "import cycle" justification is a workaround for not
    being able to import the typed class from the leaf db.ts.
    The right fix is for the leaf module to NOT throw a typed
    error at all — it should return null/undefined and let the
    SDK callers throw the typed class.

PROPOSED FIX:
  Change resolveTaskId / resolveAgentId to RETURN null on miss
  (or rename to tryResolveTaskId / tryResolveAgentId, paralleling
  the existing tryResolveWorkstreamId). Move the typed-error
  throwing out to src/agents.ts and src/tasks/*.ts where the
  actual error classes live. There's no import cycle if db.ts
  only deals in primitive ids.

  This also lets `mu sql` & similar leaves use the resolver
  without surprise instanceof failures.

  ~30 LOC change, plus one regression test (the
  AgentNotFoundError thrown from a verb path goes to exit 3
  even when the row is missing for "wrong workstream" reasons
  rather than "wrong name").

EFFORT NOTE:
  Medium. Touch 2-3 callers in src/agents.ts + src/tasks/*.ts.
  Risk: the "fake name" trick may have hidden a callsite
  somewhere that's been silently exit-1'ing for months. Also
  worth grep-ing for any `as Error & { name: string }` cousins
  in tasks/*.ts.
```

### #2 by "worker-1", 2026-05-13T13:26:59.746Z

```
CLOSE: 42ac7c3: tryResolveTaskId / tryResolveAgentId return null on miss (renamed from resolveTaskId / resolveAgentId, dropped the 'as Error & { name: string }' name-patching trick); SDK callers in src/tasks/* and src/agents.ts already throw the typed TaskNotFoundError / AgentNotFoundError; docs/ARCHITECTURE.md SDK-boundary example refreshed; verb-exit regression test (test/cli-task-not-found-exit-code.test.ts) asserts mu task close <nonexistent> and mu agent show <nonexistent> exit 3 (human + JSON); four greens + bundle smoke confirmed exit=3 from real CLI
```
