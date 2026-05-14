---
id: "hud_unify_workstream_flag"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: null
created_at: "2026-05-10T07:03:26.245Z"
updated_at: "2026-05-10T07:17:47.881Z"
blocked_by: []
blocks: []
---

# nit: mu hud — unify -w/--workstream and --workstreams into one variadic flag (drop --workstreams)

## Notes (1)

### #1 by "π - mu", 2026-05-10T07:04:42.416Z

```
Unify -w/--workstream and --workstreams on mu hud.

═══ THE FRICTION ═══

mu hud today has TWO flags for the same concept:
  -w, --workstream <name>      single (with auto-resolution chain)
  --workstreams <names...>     multi (variadic + parseCsvFlag)
  --all                        every workstream

The split is a wart. Once parseCsvFlag exists (cli_audit_plurality_uniformity, shipped) and -w is universally single, the cleanest shape is ONE flag that does both.

═══ THE TARGET SHAPE ═══

  mu hud -w X                 # single (today)
  mu hud -w X,Y               # multi via CSV (NEW; same flag)
  mu hud -w X -w Y            # multi via repeat (NEW; same flag)
  mu hud --all                # every workstream (kept; orthogonal sugar)
  mu hud                      # auto-resolve (today; falls back to single)

DROP --workstreams entirely. NO back-compat (operator's call: "never mind back compat" → "no i mean unify"). pre-1.0; --workstreams shipped <24h ago in the same v0.3 cycle, so no one but the orchestrator has used it.

═══ HOW THIS DIFFERS FROM CONVENTIONAL -w ═══

The cli_audit_plurality_uniformity decision was: "Single-value flags (-w, --by, --status, ...) STAY single. The convention only applies to flags with `<value...>` in their metavar."

That decision had a CARVE-OUT: hud is the one read-only multi-tenant verb. Today's hud has --workstreams as the multi flag because we wanted -w to keep its single-valued semantics on EVERY OTHER VERB.

The unification just acknowledges: hud's -w was always going to be the exception. Make the exception sit on the SAME flag and live with the per-verb metavar:

  Most verbs:  -w, --workstream <name>      single
  hud:         -w, --workstream <names...>  variadic + parseCsvFlag

Operators learn the "hud is different" rule once. Same flag name; the help text + metavar tells you which mode.

═══ EVALUATING THE CARVE-OUT ═══

PROs:
  + Surface area shrinks (one flag, not two on hud).
  + parseCsvFlag is reused exactly as it is everywhere else.
  + The "hud is the one multi-tenant verb" rule lives on the metavar (`<names...>`), not on the flag name.

CONs:
  - One verb's -w accepts repeats; every other verb's -w does not. Test discoverability via help is the cure: the metavar `<names...>` IS the signal (same convention from cli_audit_plurality_uniformity).
  - Documentation cost: one paragraph in USAGE_GUIDE clarifying that hud's -w is variadic.

Net: the surface shrinks more than the doc grows. Ship.

═══ DELIVERABLE ═══

1. src/cli/hud.ts:
   - Change `-w, --workstream <name>` to `-w, --workstream <names...>`.
   - Help text: "workstream(s) to render (repeat or comma-separate; or both; defaults to $MU_SESSION or current tmux session)".
   - Drop the `--workstreams <names...>` flag entirely.
   - Drop the `-w + --workstreams mutually exclusive` check.
   - Keep `--all` boolean (orthogonal; mutually exclusive with -w).
   - resolveWorkstream() in cmdHud: if opts.workstream is undefined or empty array → today's auto-resolution chain (single ws). If non-empty array, parseCsvFlag → string[] → if length 1, single-mode; else multi-mode.

2. Update existing tests:
   - test/hud-multi.test.ts (or wherever the multi-mode tests live): replace --workstreams flag with -w (or --workstream) repeated/CSV.
   - All tests that drove --workstreams must use -w now.

3. Update docs:
   - docs/USAGE_GUIDE.md: hud section: "-w accepts multiple values on hud (repeat or comma-separate). On every other verb, -w is single-valued." One short paragraph.
   - skills/mu/SKILL.md: hud bullet — drop the --workstreams mention; describe -w accepting multi.
   - CHANGELOG.md (v0.3 unreleased): one-line "mu hud: -w accepts multi (drops --workstreams; --all kept)".

4. NO migration shim. No "warn if --workstreams is used"; just remove the flag.

═══ NON-CHANGES ═══

- -w on every OTHER verb stays single. Don't touch them.
- --all stays. It's orthogonal sugar (no value to parse).
- The mu --workstream global option (passed through opts.workstream resolution) stays single-valued for every verb except hud. Hud reads its own opts via this.opts(); the global -w default-resolution chain still applies when no -w is given to hud.

═══ SCOPE ═══

~30 LOC of code (mostly deletions in src/cli/hud.ts). ~20 LOC of test churn. ~3 docs lines.

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close hud_unify_workstream_flag -w mufeedback-v03 --evidence 'unified -w accepts variadic on hud; --workstreams dropped; tests + docs updated'
```
