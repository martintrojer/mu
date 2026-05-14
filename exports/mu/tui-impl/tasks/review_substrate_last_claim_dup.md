---
id: "review_substrate_last_claim_dup"
workstream: "tui-impl"
status: CLOSED
impact: 20
effort_days: 0.05
roi: 400.00
owner: "worker-2"
created_at: "2026-05-13T12:46:22.458Z"
updated_at: "2026-05-13T16:26:36.610Z"
blocked_by: []
blocks: []
---

# REVIEW low: lastClaimActor and lastClaimEventAt duplicate SQL+escape; extract helper

## Notes (3)

### #1 by "worker-1", 2026-05-13T12:46:22.799Z

```
FILE(S):
  src/logs.ts:280-296 (lastClaimActor)
  src/logs.ts:315-326 (lastClaimEventAt)

FINDING (duplication):
  lastClaimActor and lastClaimEventAt are byte-for-byte identical
  except for which column they SELECT and post-process. Both:
   - escape `localId` against LIKE wildcards
   - build the same `${CLAIM_EVENT_PREFIX}	${escaped}	%` pattern
   - resolve workstream id
   - run `SELECT <col> FROM agent_logs WHERE … ORDER BY seq DESC
     LIMIT 1`
   - return null on miss

  The only diff is `payload` vs `created_at` and the post-step
  (parseClaimEventActor vs identity).

WHY IT'S A PROBLEM:
  - 25+ LOC of duplicated SQL + escape + null-handling. A future
    bug in one (e.g. forgetting to escape a wildcard, or moving
    the workstream filter) silently affects only one of the two
    callers.
  - The escape regex `[\%_]` is identical in both — any
    refinement (e.g. covering `[`-style classes if SQLite ever
    adds them) needs to land in two places.
  - Both have nearly-identical comments ("Mirrors lastClaimActor's
    LIKE-with-escape pattern …").

PROPOSED FIX:
  Extract one helper:

      function lastClaimEvent(
        db: Db,
        workstream: string,
        localId: string,
      ): { payload: string; created_at: string } | null {
        const escaped = localId.replace(/[\%_]/g, (c) => `\${c}`);
        const pattern = `${CLAIM_EVENT_PREFIX}	${escaped}	%`;
        const wsId = tryResolveWorkstreamId(db, workstream);
        if (wsId === null) return null;
        const row = db.prepare(
          `SELECT payload, created_at FROM agent_logs
            WHERE workstream_id = ? AND kind = 'event' AND payload LIKE ? ESCAPE '\'
            ORDER BY seq DESC LIMIT 1`,
        ).get(wsId, pattern) as { payload: string; created_at: string } | undefined;
        return row ?? null;
      }

      export function lastClaimActor(...) {
        const row = lastClaimEvent(db, workstream, localId);
        return row ? parseClaimEventActor(row.payload) : null;
      }
      export function lastClaimEventAt(...) {
        return lastClaimEvent(db, workstream, localId)?.created_at ?? null;
      }

  Net deletion of ~15 LOC, single source of truth for the
  escape pattern.

EFFORT NOTE:
  Trivial (~20 LOC). Existing tests in test/logs.integration.test.ts
  cover both paths; refactor should keep them green untouched.
```

### #2 by "worker-2", 2026-05-13T16:26:34.244Z

```
FILES: src/logs.ts; CHANGELOG.md
COMMANDS: npm install (to restore missing deps); npm run typecheck; npm run lint; npm run test:fast; npm run build; node dist/cli.js --help
FINDINGS: lastClaimActor and lastClaimEventAt duplicated the same structured claim-event lookup; node_modules was initially incomplete so first test:fast failed on missing ink d.ts, fixed by npm install.
DECISION: extracted private lastClaimEvent(db, workstream, localId) returning {payload, created_at} | null; public helpers now only parse actor or return created_at.
VERIFIED: typecheck, lint, test:fast, build, and bundle smoke all pass.
ODDITIES: bundle smoke emitted mu help successfully.
```

### #3 by "worker-2", 2026-05-13T16:26:36.610Z

```
CLOSE: fdb1122: lastClaimEvent helper extracted; ~15 LOC saved; tests stay green
```
