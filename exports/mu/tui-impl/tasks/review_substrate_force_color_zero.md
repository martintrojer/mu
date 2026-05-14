---
id: "review_substrate_force_color_zero"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: "worker-2"
created_at: "2026-05-13T12:46:50.263Z"
updated_at: "2026-05-13T14:17:51.367Z"
blocked_by: []
blocks: []
---

# REVIEW low: MU_FORCE_COLOR=0 / FORCE_COLOR=0 force colour ON (inverse of chalk)

## Notes (3)

### #1 by "worker-1", 2026-05-13T12:46:50.600Z

```
FILE(S):
  src/output.ts:43-58 (colorEnabled)
  test/output.test.ts:64-122 (colorEnabled tests)

FINDING (non-idiomatic / surprising semantics):
  colorEnabled() treats every positive-direction env var with
  the same `!== undefined` predicate that NO_COLOR uses:

      if (process.env.NO_COLOR !== undefined) return false;
      if (process.env.MU_FORCE_COLOR !== undefined) return true;
      if (process.env.FORCE_COLOR !== undefined) return true;
      if (process.env.TMUX !== undefined) return true;

  NO_COLOR's any-defined-value semantics is correct (https://no-color.org).
  The other three are NOT — chalk and the FORCE_COLOR de-facto
  spec interpret `FORCE_COLOR=0` as "force OFF". Setting
  `MU_FORCE_COLOR=0` here turns colour ON, which contradicts
  every other tool the operator uses.

WHY IT'S A PROBLEM:
  - Operator workflow: a script disables colour with
    `MU_FORCE_COLOR=0 mu state` (mirrors `FORCE_COLOR=0 npm
    test`); mu surprises them with full colour output, the
    redirected log gains ANSI noise.
  - The existing test covers `MU_FORCE_COLOR=1` only (line 84-86);
    the `=0` case is not pinned, so the inconsistency hides.

PROPOSED FIX:
  Match chalk / supports-color semantics:

      function envForceTrue(key: string): boolean {
        const v = process.env[key];
        if (v === undefined) return false;
        // Treat "", "0", "false" as opt-out; everything else opts in.
        if (v === "" || v === "0" || v.toLowerCase() === "false") return false;
        return true;
      }

      ...
      if (envForceTrue("MU_FORCE_COLOR")) return true;
      if (envForceTrue("FORCE_COLOR")) return true;
      // TMUX is "is set" semantics intentionally — it's never `=0`
      // in real use; it's a tmux-injected env var with a path-like
      // value or unset.

  Add three test cases:
   - MU_FORCE_COLOR="0" → colorEnabled() === false
   - FORCE_COLOR="0"    → false (matches chalk)
   - MU_FORCE_COLOR="" + FORCE_COLOR="1" → true (one positive
     opt-in still wins over an empty MU_FORCE_COLOR)

EFFORT NOTE:
  Small (~15 LOC + 3 test cases). Risk: low — this is more
  permissive in the opt-out direction; a script that was relying
  on `MU_FORCE_COLOR=0` to KEEP colour was almost certainly
  written by mistake.
```

### #2 by "worker-2", 2026-05-13T14:17:45.456Z

```
FILES: src/output.ts; test/output.test.ts; CHANGELOG.md
COMMANDS: npm run test:fast -- test/output.test.ts (exit 0); npx biome check src/output.ts test/output.test.ts CHANGELOG.md (exit 0); npm run typecheck && npm run lint && npm run test:fast && npm run build (exit 0 after npm install restored missing deps); bundle smoke via env-isolated dist/cli.js colorStatus checks for MU_FORCE_COLOR=0 / FORCE_COLOR=0 / MU_FORCE_COLOR="" + FORCE_COLOR=1 (exit 0)
FINDINGS: colorEnabled used is-set semantics for MU_FORCE_COLOR/FORCE_COLOR, so =0 and empty string forced ANSI on.
DECISION: added envForceTrue for positive colour env vars only; NO_COLOR remains any-set opt-out and TMUX remains is-set semantics.
VERIFIED: 24 output tests pass; full fast tier 88 files / 1365 tests pass; typecheck/lint/build pass; bundle smoke confirms =0 outputs plain CLOSED while FORCE_COLOR=1 with empty MU_FORCE_COLOR emits ANSI.
ODDITIES: first fast-suite run failed because node_modules/ink was missing; npm install restored dependencies and rerunning four greens passed.
NEXT: none.
```

### #3 by "worker-2", 2026-05-13T14:17:51.367Z

```
CLOSE: bc53a9c: envForceTrue helper; MU_FORCE_COLOR=0 / FORCE_COLOR=0 now opt OUT; 3 test cases
```
